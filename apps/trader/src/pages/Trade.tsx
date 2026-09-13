import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  adjustAssetAmountDown,
  formatDecimalUnits,
  formatTokenAmount,
  parseTokenAmount,
  type AssetSnapshot,
  type AtomicSettlementIntent,
  type Position,
  type Quote,
  type SpaceRecord,
} from "@aurka/shared";
import { apiBaseUrl, appMode } from "../config";
import { spaceAdapter } from "../domain/spaces";
import { displayAssetSymbol, userFacingError } from "../ui";
import { useWallet, WalletStateMessage } from "../wallet";

const client = new AurkaClient({ baseUrl: apiBaseUrl });
const DEMO_TRADER = "0x4444444444444444444444444444444444444444";
const ERC20_BALANCE_OF = "0x70a08231";
const ERC20_ALLOWANCE = "0xdd62ed3e";
const ERC20_APPROVE = "0x095ea7b3";

type TradeStage =
  | "idle"
  | "quoting"
  | "quote"
  | "signing"
  | "submitting"
  | "confirmed"
  | "failed";

interface TestnetState {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly testnetBlock: number;
  readonly integrationMode?: "real" | "fixture";
  readonly aquaKind?: string;
  readonly oracleKind?: string;
  readonly bob: string;
  readonly router: string;
  readonly usdc: string;
  readonly weth: string;
  readonly mocks: readonly string[];
  readonly position: Position;
  readonly block: string;
  readonly timestamp: number;
  readonly balances: Record<string, { usdc: string; weth: string }>;
  readonly capacity: {
    readonly id: string;
    readonly authorized: boolean;
    readonly baseline: string;
    readonly consumed: string;
  };
}

interface TradeSource {
  readonly space: SpaceRecord;
  readonly position: Position;
  readonly testnet?: TestnetState;
}

async function retryRequest<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await request();
    } catch (error: unknown) {
      lastError = error;
      if (attempt === 0)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

interface SwapPair {
  readonly key: string;
  readonly input: AssetSnapshot;
  readonly output: AssetSnapshot;
}

interface QuoteResult {
  readonly source: TradeSource;
  readonly intent: AtomicSettlementIntent;
  readonly quote: Quote;
  readonly solved: Awaited<ReturnType<AurkaClient["solve"]>>;
  readonly requestedInputAmount: string;
}

interface AmountAdjustment {
  readonly requestedAmount: string;
  readonly supportedAmount: string;
  readonly remainder: string;
  readonly increment: string;
}

interface TransactionRequest {
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly value: string;
}

interface Receipt {
  readonly hash: string;
  readonly block: string;
  readonly gas: string;
}

function decodeRouteId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function apiPath(path: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error(
      `The testnet service returned an invalid response (${response.status}).`,
    );
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : `Testnet request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function wordAddress(address: string): string {
  return address.slice(2).padStart(64, "0");
}

function wordAmount(amount: bigint): string {
  return amount.toString(16).padStart(64, "0");
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function formatFeePercentage(value: string): string {
  try {
    return `${formatDecimalUnits(BigInt(value), 20)}%`;
  } catch {
    return "—";
  }
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Swap request failed";
  if (/4001|rejected|denied|cancel/i.test(raw))
    return "The wallet rejected this request. Review the exact trade and try again when ready.";
  if (/transaction is still pending/i.test(raw))
    return "Your swap is still processing. Check Activity before trying again.";
  if (/transaction reverted/i.test(raw))
    return "The network rejected this swap. No completed swap is shown.";
  if (/no liquidity/i.test(raw)) return raw;
  if (/below the minimum executable amount/i.test(raw)) return raw;
  if (/amount|precision|decimal/i.test(raw))
    return "Enter a valid token amount using the supported decimals.";
  if (/source state changed|snapshot.*changed|quote expired/i.test(raw))
    return "The rate changed. Request an updated rate before continuing.";
  return userFacingError(
    error,
    "We couldn't complete the swap. Review the details and try again.",
  );
}

function errorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return undefined;
}

function pairsFor(position: Position | undefined): SwapPair[] {
  const assets = position?.currentPortfolio?.assets ?? [];
  const hasSymbol = (asset: AssetSnapshot, symbol: string): boolean =>
    asset.symbol
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .includes(symbol);
  const weth = assets.find((asset) => hasSymbol(asset, "WETH"));
  const usdc = assets.find((asset) => hasSymbol(asset, "USDC"));
  if (!weth || !usdc || weth.token.toLowerCase() === usdc.token.toLowerCase())
    return [];
  return [
    {
      key: `${weth.token.toLowerCase()}:${usdc.token.toLowerCase()}`,
      input: weth,
      output: usdc,
    },
  ];
}

function pairFor(
  position: Position | undefined,
  key?: string,
): SwapPair | undefined {
  const pairs = pairsFor(position);
  return pairs.find((pair) => pair.key === key) ?? pairs[0];
}

function hasSpaceLiquidity(position: Position | undefined): boolean {
  const assets = position?.currentPortfolio?.assets;
  // Unknown balances should not create a client-side blocker. The server is
  // still authoritative when a quote is requested.
  if (!assets) return true;
  return assets.some((asset) => BigInt(asset.balance) > 0n);
}

function sourceClock(source: TradeSource | undefined): number {
  if (appMode === "testnet" && source?.testnet) return source.testnet.timestamp;
  return Math.floor(Date.now() / 1000);
}

function statePart(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function portfolioStateKey(
  portfolio: Position["currentPortfolio"] | undefined,
): string {
  if (!portfolio) return "";
  return [
    statePart(portfolio.nav),
    statePart(portfolio.valueDecimals),
    ...portfolio.assets.map((asset) =>
      [
        statePart(asset.token).toLowerCase(),
        statePart(asset.balance),
        statePart(asset.decimals),
        statePart(asset.price),
        statePart(asset.priceDecimals),
        statePart(asset.value),
        statePart(asset.weightBps),
      ].join(":"),
    ),
  ].join("|");
}

function quoteIsStale(
  result: QuoteResult,
  source: TradeSource | undefined,
  now: number,
): boolean {
  if (!source?.position.currentPortfolio) return true;
  if (result.quote.expiresAt <= now) return true;
  if (source.position.policy.paused) return true;
  if (result.quote.policyNonce !== source.position.policy.nonce) return true;
  if (
    portfolioStateKey(result.quote.currentPortfolio) !==
    portfolioStateKey(source.position.currentPortfolio)
  )
    return true;
  if (
    source.testnet &&
    result.quote.capacityEpochId.toLowerCase() !==
      source.testnet.capacity.id.toLowerCase()
  )
    return true;
  return false;
}

function sourceCommittedByQuote(source: TradeSource, quote: Quote): TradeSource {
  if (!source.testnet) return source;
  const currentPortfolio = quote.currentPortfolio;
  return {
    ...source,
    position: {
      ...source.position,
      currentPortfolio,
    },
    testnet: {
      ...source.testnet,
      position: {
        ...source.testnet.position,
        currentPortfolio,
      },
      capacity: {
        ...source.testnet.capacity,
        id: quote.capacityEpochId,
        consumed: quote.consumedBefore,
      },
    },
  };
}

function typedIntent(intent: AtomicSettlementIntent, testnet: TestnetState) {
  const fields =
    "bytes32 intentId,bytes32 policyId,bytes32 positionIdHash,address trader,address traderInputToken,address traderOutputToken,uint256 requestedValue,uint256 minimumTraderOutputValue,bool exactInput,bool allowPartialFill,uint256 deadline,uint256 nonce,bytes32 balanceSnapshot,bytes32 priceSnapshot,bytes32 aquaStrategyHash";
  return {
    domain: {
      name: "AURKA Direct Settlement",
      version: "1",
      chainId: testnet.chainId,
      verifyingContract: testnet.router,
    },
    primaryType: "Intent",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Intent: fields.split(",").map((field) => {
        const [type, name] = field.split(" ");
        return { type, name };
      }),
    },
    message: intent,
  };
}

export default function Trade(): JSX.Element {
  const { spaceId: rawSpaceId } = useParams<{ spaceId: string }>();
  const routeSpaceId = decodeRouteId(rawSpaceId);
  return <TradeFlow routeSpaceId={routeSpaceId} />;
}

function TradeFlow({ routeSpaceId }: { readonly routeSpaceId?: string }) {
  const wallet = useWallet();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState(routeSpaceId ?? "");
  const [source, setSource] = useState<TradeSource>();
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pairKey, setPairKey] = useState("");
  const [amount, setAmount] = useState("0.0025");
  const [quoteResult, setQuoteResult] = useState<QuoteResult>();
  const [confirmed, setConfirmed] = useState<Receipt>();
  const [stage, setStage] = useState<TradeStage>("idle");
  const [status, setStatus] = useState("Enter an amount to see the rate");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const [walletInputBalance, setWalletInputBalance] = useState<bigint>();
  const unavailableSpaceIds = useRef(new Set<string>());
  const [amountAdjustment, setAmountAdjustment] = useState<AmountAdjustment>();
  const flowVersion = useRef(0);
  const nonce = useRef(Date.now());
  const sourceRef = useRef<TradeSource>();
  const quoteResultRef = useRef<QuoteResult>();
  const routedSelection = useRef(false);

  function publishSource(next: TradeSource) {
    sourceRef.current = next;
    setSource(next);
  }

  useEffect(() => {
    quoteResultRef.current = quoteResult;
  }, [quoteResult]);

  function invalidateQuote(clearConfirmation = true) {
    flowVersion.current += 1;
    setQuoteResult(undefined);
    setStage("idle");
    if (clearConfirmation) setConfirmed(undefined);
  }

  async function loadSource(id: string): Promise<TradeSource> {
    const cached =
      sourceRef.current?.space.identity.id === id
        ? sourceRef.current
        : undefined;
    const space =
      cached?.space ?? (await retryRequest(() => spaceAdapter.getSpace(id)));
    if (!space.position)
      throw new Error("This Space is not active and has no holdings to trade.");
    if (appMode !== "testnet") return { space, position: space.position };
    const testnet = await retryRequest(() =>
      getJson<TestnetState>(
        apiPath(`/testnet?spaceId=${encodeURIComponent(id)}`),
      ),
    );
    if (testnet.position.id !== id)
      throw new Error("The selected Space is not available in this testnet.");
    return { space, position: testnet.position, testnet };
  }

  useEffect(() => {
    let active = true;
    setPageError(null);
    spaceAdapter
      .listSpaces(100)
      .then((next) => {
        if (!active) return;
        setSpaces(next);
        if (routeSpaceId) {
          if (
            !next.some((candidate) => candidate.identity.id === routeSpaceId)
          ) {
            setPageError(
              "This Space isn't available. Choose an active Space to continue.",
            );
            setSelectedSpaceId("");
            return;
          }
          setSelectedSpaceId(routeSpaceId);
          return;
        }
        setSelectedSpaceId((current) =>
          next.some((candidate) => candidate.identity.id === current)
            ? current
            : (next.find((candidate) => candidate.identity.state === "ACTIVE")
                ?.identity.id ?? ""),
        );
      })
      .catch((requestError: unknown) => {
        if (active)
          setPageError(
            friendlyError(requestError) || "Spaces could not be loaded",
          );
      });
    return () => {
      active = false;
    };
  }, [routeSpaceId]);

  useEffect(() => {
    if (!selectedSpaceId) {
      sourceRef.current = undefined;
      setSource(undefined);
      setSourceLoading(false);
      return;
    }
    let active = true;
    let refreshInFlight = false;
    const preserveCurrentTrade = routedSelection.current;
    routedSelection.current = false;
    sourceRef.current = undefined;
    if (!preserveCurrentTrade) {
      setSource(undefined);
      invalidateQuote();
      setAmountAdjustment(undefined);
    }
    setSourceLoading(true);
    setSourceError(null);
    const refresh = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const next = await loadSource(selectedSpaceId);
        if (active) {
          publishSource(next);
          setPairKey((current) =>
            pairsFor(next.position).some(
              (candidate) => candidate.key === current,
            )
              ? current
              : (pairFor(next.position)?.key ?? ""),
          );
          setSourceError(null);
        }
      } catch (requestError: unknown) {
        // Once a valid source is displayed, keep it during transient RPC/API
        // failures. A polling hiccup must not turn the whole Trade page into
        // an unavailable state.
        if (active && sourceRef.current === undefined) {
          setSource(undefined);
          setSourceError(friendlyError(requestError));
        }
      } finally {
        refreshInFlight = false;
        if (active) setSourceLoading(false);
      }
    };
    void refresh();
    if (appMode !== "testnet")
      return () => {
        active = false;
      };
    const timer = window.setInterval(() => {
      // Keep the reviewed offer stable while the user is deciding. If chain
      // state changes, signAndPrepare performs one authoritative read and
      // transparently rebuilds the quote before asking for a signature.
      if (quoteResultRef.current === undefined) void refresh();
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedSpaceId]);

  useEffect(() => {
    const token = pairFor(source?.position, pairKey)?.input.token;
    if (
      appMode !== "testnet" ||
      !wallet.provider ||
      !wallet.address ||
      !token
    ) {
      setWalletInputBalance(undefined);
      return;
    }
    let active = true;
    void wallet.provider
      .request({
        method: "eth_call",
        params: [
          {
            to: token,
            data: `${ERC20_BALANCE_OF}${wordAddress(wallet.address)}`,
          },
          "latest",
        ],
      })
      .then((value) => {
        if (active && typeof value === "string")
          setWalletInputBalance(BigInt(value));
      })
      .catch(() => {
        if (active) setWalletInputBalance(undefined);
      });
    return () => {
      active = false;
    };
  }, [pairKey, source, wallet.address, wallet.provider, wallet.revision]);

  useEffect(() => {
    const hadPendingTrade = quoteResult !== undefined;
    invalidateQuote();
    setAmountAdjustment(undefined);
    setError(null);
    setStatus(
      wallet.status === "connected"
        ? hadPendingTrade
          ? "Account or network changed — request a new quote"
          : "Wallet connected"
        : "Connect a wallet when you are ready to trade",
    );
  }, [wallet.revision]);

  const sourceSnapshotHash = source?.position.currentPortfolio?.snapshotHash;
  useEffect(() => {
    if (amountAdjustment !== undefined) setAmountAdjustment(undefined);
    if (quoteResult !== undefined) {
      const sameSpace =
        source?.space.identity.id === quoteResult.source.space.identity.id;
      const samePortfolio =
        portfolioStateKey(source?.position.currentPortfolio) ===
        portfolioStateKey(quoteResult.quote.currentPortfolio);
      const sameCapacity =
        !source?.testnet ||
        source.testnet.capacity.id.toLowerCase() ===
          quoteResult.quote.capacityEpochId.toLowerCase();
      if (!(sameSpace && samePortfolio && sameCapacity))
        invalidateQuote(false);
    }
    // A new authoritative price/balance snapshot invalidates both a quote and
    // any earlier adjustment consent. Keep the quote when this is only the
    // refresh caused by routing to the Space that produced it.
  }, [pairKey, sourceSnapshotHash]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(sourceClock(source));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [source]);

  const pair = pairFor(source?.position, pairKey);
  const inputSymbol = pair ? displayAssetSymbol(pair.input.symbol) : "Token";
  const outputSymbol = pair ? displayAssetSymbol(pair.output.symbol) : "Token";
  const quoteExpired =
    quoteResult !== undefined && quoteResult.quote.expiresAt <= clock;
  const quoteStale =
    quoteResult !== undefined && quoteIsStale(quoteResult, source, clock);
  const noLiquidity =
    source?.position.currentPortfolio !== undefined &&
    !hasSpaceLiquidity(source.position);
  function updateAmount(value: string) {
    invalidateQuote();
    setAmountAdjustment(undefined);
    setError(null);
    setAmount(value);
  }

  function cancelQuoteReview() {
    invalidateQuote();
    setAmountAdjustment(undefined);
    setError(null);
    setStatus("Enter an amount to see the rate");
  }

  function assertVersion(version: number, walletRevision?: number) {
    if (version !== flowVersion.current)
      throw new Error(
        "The trade form changed during the request. Request a new quote.",
      );
    if (walletRevision !== undefined && walletRevision !== wallet.revision)
      throw new Error(
        "Account or network changed. Review and request a new quote.",
      );
  }

  async function requestQuote(
    acceptedAmount?: bigint,
    preferredSpaceId?: string,
  ) {
    if (!source || !pair)
      throw new Error("Swaps are temporarily unavailable. Try again shortly.");
    const version = ++flowVersion.current;
    setBusy(true);
    setStage("quoting");
    setError(null);
    setConfirmed(undefined);
    try {
      const trader =
        appMode === "testnet"
          ? wallet.address
          : (wallet.address ?? DEMO_TRADER);
      if (!trader) throw new Error("Connect your wallet before continuing.");
      const candidateIds = preferredSpaceId
        ? [preferredSpaceId]
        : routeSpaceId
          ? [routeSpaceId]
          : spaces
              .filter((candidate) => candidate.identity.state === "ACTIVE")
              .map((candidate) => candidate.identity.id);
      const ids = (candidateIds.length ? candidateIds : [selectedSpaceId]).filter(
        (id) => !unavailableSpaceIds.current.has(id),
      );
      let best: QuoteResult | undefined;
      let firstError: unknown;
      for (const id of ids) {
        try {
          const latest = await loadSource(id);
          assertVersion(version);
          const latestPair = pairFor(latest.position, pairKey);
          if (!latestPair)
            throw new Error(
              "No supported trading pair is available right now.",
            );
          if (!hasSpaceLiquidity(latest.position))
            throw new Error(
              "This Space has no liquidity. Fund the Space before requesting a swap.",
            );
          const requestedInputAmount =
            acceptedAmount ??
            parseTokenAmount(amount.trim(), latestPair.input.decimals);
          if (requestedInputAmount === 0n)
            throw new Error("Enter an amount greater than zero.");
          const valueDecimals =
            latest.position.currentPortfolio?.valueDecimals ?? 0;
          const adjustment = adjustAssetAmountDown(
            requestedInputAmount,
            latestPair.input,
            valueDecimals,
          );
          if (adjustment.supportedAmount === 0n) {
            setQuoteResult(undefined);
            setAmountAdjustment({
              requestedAmount: requestedInputAmount.toString(),
              supportedAmount: "0",
              remainder: adjustment.remainder.toString(),
              increment: adjustment.increment.toString(),
            });
            setStage("idle");
            setStatus("Edit the amount to continue");
            return;
          }
          if (adjustment.supportedAmount !== requestedInputAmount) {
            setQuoteResult(undefined);
            setAmountAdjustment({
              requestedAmount: requestedInputAmount.toString(),
              supportedAmount: adjustment.supportedAmount.toString(),
              remainder: adjustment.remainder.toString(),
              increment: adjustment.increment.toString(),
            });
            setStage("idle");
            setStatus("Review the adjusted amount before continuing");
            return;
          }
          if (appMode === "testnet" && latest.testnet)
            await validateWallet(latest.testnet, trader);
          const now = sourceClock(latest);
          const input = {
            positionId: latest.position.id,
            trader,
            traderInputToken: latestPair.input.token,
            traderOutputToken: latestPair.output.token,
            requestedTraderInputAmount: adjustment.supportedAmount.toString(),
            minimumTraderOutputValue: "0",
            nonce: String(++nonce.current),
            deadline: now + 300,
          };
          const initialIntent =
            await client.prepareIntentFromTokenAmount(input);
          const preview = await client.solve(initialIntent);
          assertVersion(version);
          // The signed intent commits to the net output that was reviewed.
          const intent = await client.prepareIntent({
            positionId: latest.position.id,
            trader,
            traderInputToken: latestPair.input.token,
            traderOutputToken: latestPair.output.token,
            requestedValue: initialIntent.requestedValue,
            minimumTraderOutputValue: preview.proposal.traderOutputValue,
            nonce: initialIntent.nonce,
            deadline: initialIntent.deadline,
          });
          const quote = await client.quote(intent);
          const solved = await client.solve(intent);
          const committedSource = sourceCommittedByQuote(latest, quote);
          const candidate: QuoteResult = {
            source: committedSource,
            intent,
            quote,
            solved,
            requestedInputAmount: requestedInputAmount.toString(),
          };
          if (
            !best ||
            BigInt(candidate.solved.proposal.traderOutputValue) >
              BigInt(best.solved.proposal.traderOutputValue)
          )
            best = candidate;
        } catch (candidateError) {
          if (
            errorCode(candidateError) === "STRATEGY_MISMATCH" ||
            /incompatible SwapVM strategy/i.test(
              candidateError instanceof Error ? candidateError.message : "",
            )
          )
            unavailableSpaceIds.current.add(id);
          firstError ??= candidateError;
        }
      }
      if (!best)
        throw firstError ?? new Error("No route is available right now.");
      assertVersion(version);
      publishSource(best.source);
      if (best.source.space.identity.id !== selectedSpaceId) {
        routedSelection.current = true;
        setSelectedSpaceId(best.source.space.identity.id);
      }
      setPairKey(pairFor(best.source.position, pairKey)?.key ?? pairKey);
      setQuoteResult(best);
      setAmountAdjustment(undefined);
      setStage("quote");
      setStatus("Best available rate found");
    } catch (requestError: unknown) {
      if (version === flowVersion.current) {
        setStage("failed");
        setError(friendlyError(requestError));
        setStatus("Rate unavailable — no swap was submitted");
      }
    } finally {
      if (version === flowVersion.current) setBusy(false);
    }
  }

  async function validateWallet(testnet: TestnetState, expected: string) {
    const provider = wallet.provider;
    if (!provider)
      throw new Error("Connect an Ethereum wallet before signing.");
    if (!expected)
      throw new Error("Connect the counterparty wallet before trading.");
    const chainId = await provider.request({ method: "eth_chainId" });
    const accounts = await provider.request({ method: "eth_accounts" });
    const current = Array.isArray(accounts) ? accounts[0] : undefined;
    if (
      typeof chainId !== "string" ||
      BigInt(chainId) !== BigInt(testnet.chainId)
    )
      throw new Error("Switch your wallet to Ethereum Sepolia to continue.");
    if (
      typeof current !== "string" ||
      current.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error("Wallet account changed. Reconnect before continuing.");
    return provider;
  }

  async function waitForReceipt(
    testnet: TestnetState,
    hash: string,
  ): Promise<Receipt> {
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const response = await fetch(testnet.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
      });
      const body = (await response.json()) as {
        readonly error?: unknown;
        readonly result?: {
          readonly status: string;
          readonly blockNumber: string;
          readonly gasUsed: string;
        } | null;
      };
      if (body.error)
        throw new Error("Receipt lookup failed on the testnet RPC.");
      if (body.result) {
        if (body.result.status !== "0x1")
          throw new Error(`The transaction reverted: ${hash}`);
        return {
          hash,
          block: BigInt(body.result.blockNumber).toString(),
          gas: BigInt(body.result.gasUsed).toString(),
        };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    throw new Error(
      `The transaction is still pending (${hash}). Check the testnet before retrying.`,
    );
  }

  async function sendTestnetTransaction(
    testnet: TestnetState,
    transaction: TransactionRequest,
    expected: string,
  ): Promise<Receipt> {
    const provider = await validateWallet(testnet, expected);
    setStatus("Waiting for wallet approval…");
    const sent = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: expected,
          to: transaction.to,
          data: transaction.data,
          value: hex(BigInt(transaction.value)),
        },
      ],
    });
    if (typeof sent !== "string")
      throw new Error("The wallet returned no transaction hash.");
    localStorage.setItem("aurka:testnet:lastTransaction", sent);
    setStatus("Swap submitted — waiting for confirmation…");
    return waitForReceipt(testnet, sent);
  }

  async function signAndPrepare() {
    if (!quoteResult || !source?.testnet || quoteExpired || quoteStale)
      throw new Error("Review a current offer before approval.");
    const version = flowVersion.current;
    const walletRevision = wallet.revision;
    setBusy(true);
    setStage("signing");
    setError(null);
    try {
      const latest = await loadSource(quoteResult.source.space.identity.id);
      assertVersion(version, walletRevision);
      publishSource(latest);
      if (!latest.testnet)
        throw new Error("The current trade details are unavailable.");
      const now = sourceClock(latest);
      if (quoteIsStale(quoteResult, latest, now))
        throw new Error(
          "The rate changed. Request an updated rate before continuing.",
        );
      const expected = wallet.address;
      if (!expected)
        throw new Error("Connect your wallet before approving the trade.");
      let provider = await validateWallet(latest.testnet, expected);
      const input = BigInt(quoteResult.solved.proposal.traderInputAmount);
      const inputAsset = latest.position.currentPortfolio?.assets.find(
        (asset) =>
          asset.token.toLowerCase() ===
          quoteResult.intent.traderInputToken.toLowerCase(),
      );
      if (!inputAsset)
        throw new Error("The latest balance changed. Review the trade again.");
      const balance = await provider.request({
        method: "eth_call",
        params: [
          {
            to: inputAsset.token,
            data: `${ERC20_BALANCE_OF}${wordAddress(expected)}`,
          },
          "latest",
        ],
      });
      if (typeof balance !== "string" || BigInt(balance) < input)
        throw new Error(
          `Your wallet does not have enough ${displayAssetSymbol(inputAsset.symbol)} for this swap.`,
        );
      const allowance = await provider.request({
        method: "eth_call",
        params: [
          {
            to: inputAsset.token,
            data: `${ERC20_ALLOWANCE}${wordAddress(expected)}${wordAddress(latest.testnet.router)}`,
          },
          "latest",
        ],
      });
      if (typeof allowance !== "string")
        throw new Error("The wallet allowance could not be read.");
      if (BigInt(allowance) < input) {
        setStatus(
          `Approve ${displayAssetSymbol(inputAsset.symbol)} in your wallet before continuing`,
        );
        await sendTestnetTransaction(
          latest.testnet,
          {
            chainId: latest.testnet.chainId,
            to: inputAsset.token,
            data: `${ERC20_APPROVE}${wordAddress(latest.testnet.router)}${wordAmount(input)}`,
            value: "0",
          },
          expected,
        );
        assertVersion(version, walletRevision);
        provider = await validateWallet(latest.testnet, expected);
      }
      assertVersion(version, walletRevision);
      setStatus("Confirm the swap in your wallet");
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [
          expected,
          JSON.stringify(typedIntent(quoteResult.intent, latest.testnet)),
        ],
      });
      if (typeof signature !== "string")
        throw new Error("The wallet returned no intent signature.");
      assertVersion(version, walletRevision);
      const checked = await loadSource(quoteResult.source.space.identity.id);
      assertVersion(version, walletRevision);
      publishSource(checked);
      if (quoteIsStale(quoteResult, checked, sourceClock(checked)))
        throw new Error(
          "The rate changed after signing. Request an updated rate before continuing.",
        );
      const result = await client.execute(
        quoteResult.quote.intentHash,
        quoteResult.solved.proposalHash,
        signature,
        `trade:${quoteResult.intent.intentId}`,
      );
      assertVersion(version, walletRevision);
      if (
        result.transactionRequest.to.toLowerCase() !==
        latest.testnet.router.toLowerCase()
      )
        throw new Error(
          "The service returned an unexpected settlement target.",
        );
      setStage("submitting");
      const receipt = await sendTestnetTransaction(
        latest.testnet,
        result.transactionRequest,
        expected,
      );
      assertVersion(version, walletRevision);
      const refreshed = await loadSource(quoteResult.source.space.identity.id);
      publishSource(refreshed);
      setConfirmed(receipt);
      setQuoteResult(undefined);
      setStage("confirmed");
      setStatus("Swap complete — your balances have been updated");
      window.dispatchEvent(
        new CustomEvent("aurka:trade-confirmed", {
          detail: {
            spaceId: refreshed.space.identity.id,
            transactionHash: receipt.hash,
          },
        }),
      );
    } catch (requestError: unknown) {
      const staleExecution =
        errorCode(requestError) === "INVALID_SNAPSHOT" ||
        errorCode(requestError) === "COMMITMENT_MISMATCH" ||
        /rate changed|price snapshot is stale|balance snapshot is stale|snapshot.*stale/i.test(
          requestError instanceof Error ? requestError.message : "",
        );
      if (version === flowVersion.current && staleExecution) {
        // A capacity/oracle renewal can land after the review was signed.
        // No swap was submitted, so transparently rebuild the quote instead
        // of presenting a false failed-trade state to the user.
        setError(null);
        setStage("quoting");
        setStatus("The rate changed — updating the offer…");
        await requestQuote(undefined, quoteResult.source.space.identity.id);
        return;
      }
      if (
        version === flowVersion.current &&
        errorCode(requestError) === "SIMULATION_FAILED"
      ) {
        // The exact check can race a newly mined allowance or a live
        // portfolio update. The signed intent was not submitted; refresh the
        // offer automatically so the user sees a current review instead of an
        // internal simulation error.
        setError(null);
        setStage("quoting");
        setStatus("Updating the rate…");
        await requestQuote();
        return;
      }
      if (version === flowVersion.current) {
        setStage("failed");
        setError(friendlyError(requestError));
        setStatus("Approval failed — no swap was submitted");
      }
    } finally {
      if (version === flowVersion.current) setBusy(false);
    }
  }

  function run(action: () => Promise<void>) {
    void action().catch((requestError: unknown) => {
      setError(friendlyError(requestError));
      setStage("failed");
      setStatus("Action failed — no swap was submitted");
    });
  }

  if (pageError)
    return (
      <section
        className="mx-auto max-w-3xl space-y-5 text-slate-200"
        role="alert"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Swap
        </p>
        <h1 className="text-3xl font-semibold text-white">Swap unavailable</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          {pageError}
        </p>
        <Link
          to="/trade"
          className="inline-flex rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white"
        >
          Try again
        </Link>
      </section>
    );

  if (sourceLoading)
    return (
      <div
        className="flex min-h-64 items-center justify-center text-slate-400"
        aria-live="polite"
      >
        Preparing the latest rate…
      </div>
    );

  if (sourceError)
    return (
      <section
        className="mx-auto max-w-3xl space-y-5 text-slate-200"
        role="alert"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Swap
        </p>
        <h1 className="text-3xl font-semibold text-white">Swap unavailable</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          {sourceError}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-200"
        >
          Try again
        </button>
      </section>
    );

  return (
    <section className="mx-auto max-w-3xl space-y-5 text-slate-200">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Swap
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Swap tokens
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          Choose the amount you want to sell and review exactly what you&apos;ll
          receive before confirming.
        </p>
      </header>

      {appMode === "testnet" && source?.testnet && (
        <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
          <strong>Testnet</strong>
        </div>
      )}

      {appMode === "testnet" && <WalletStateMessage />}

      {noLiquidity && (
        <section className="rounded-2xl border border-amber-800/70 bg-amber-950/30 p-5">
          <h2 className="font-semibold text-white">Fund this Space before trading</h2>
          <p className="mt-2 text-sm leading-6 text-amber-200">
            The latest Sepolia balances are zero. Add USDC or WETH to this
            Space, then request a new rate.
          </p>
        </section>
      )}

      {!source || !pair ? (
        <section className="rounded-2xl border border-amber-800/70 bg-amber-950/30 p-5 text-amber-200">
          <h2 className="font-semibold text-white">
            Swaps are temporarily unavailable
          </h2>
          <p className="mt-2 text-sm leading-6">
            We couldn&apos;t find a current rate for this swap. Please try again
            shortly.
          </p>
        </section>
      ) : (
        <>
          {!quoteResult && (
            <form
              className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900/70 p-5 sm:p-6"
              onSubmit={(event) => {
                event.preventDefault();
                run(requestQuote);
              }}
            >
              <div>
                <h2 className="text-xl font-semibold text-white">Swap tokens</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">
                  We&apos;ll check the available Spaces and find the best rate that
                  can complete this swap.
                </p>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-800 p-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Sell
                  </p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {inputSymbol}
                  </p>
                </div>
                <span className="text-xl text-slate-500" aria-hidden="true">
                  →
                </span>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Receive
                  </p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {outputSymbol}
                  </p>
                </div>
              </div>
              <label className="block text-sm">
                <span className="font-medium text-slate-200">Amount to sell</span>
                <div className="mt-1 flex items-center rounded-lg border border-slate-700 bg-slate-800 focus-within:border-cyan-500">
                  <input
                    required
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`Amount to sell in ${inputSymbol}`}
                    value={amount}
                    onChange={(event) => updateAmount(event.target.value)}
                    placeholder="0.0025"
                    min="0"
                    className="min-w-0 flex-1 bg-transparent p-2.5 text-slate-100 outline-none"
                  />
                  <span className="px-3 text-sm text-slate-400">
                    {inputSymbol}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                  <span>
                    {walletInputBalance === undefined
                      ? "Balance unavailable"
                      : `Balance: ${formatTokenAmount(walletInputBalance, pair.input.decimals)} ${inputSymbol}`}
                  </span>
                  <button
                    type="button"
                    disabled={walletInputBalance === undefined}
                    onClick={() =>
                      walletInputBalance !== undefined &&
                      updateAmount(
                        formatTokenAmount(
                          walletInputBalance,
                          pair.input.decimals,
                        ),
                      )
                    }
                    className="font-medium text-cyan-300 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Max
                  </button>
                </div>
              </label>
              <button
                type="submit"
                disabled={
                  busy ||
                  !amount.trim() ||
                  noLiquidity ||
                  (appMode === "testnet" && wallet.status !== "connected")
                }
                className="min-h-11 rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stage === "quoting" ? "Checking available Spaces…" : "Review swap"}
              </button>
            </form>
          )}

          {amountAdjustment && pair && (
            <AmountAdjustmentReview
              adjustment={amountAdjustment}
              inputAsset={pair.input}
              onUse={() => {
                const supported = BigInt(amountAdjustment.supportedAmount);
                if (supported === 0n) {
                  setAmountAdjustment(undefined);
                  setError(
                    "Enter an amount at or above the minimum executable amount.",
                  );
                  return;
                }
                setAmount(formatTokenAmount(supported, pair.input.decimals));
                setAmountAdjustment(undefined);
                run(() => requestQuote(supported));
              }}
              onEdit={() => {
                setAmountAdjustment(undefined);
                setError(null);
                setStatus("Edit the amount, then review the swap again");
              }}
            />
          )}

          {error && (
            <p
              role="alert"
              className="rounded-xl border border-red-900/70 bg-red-950/40 p-4 text-red-200"
            >
              {error}
            </p>
          )}
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-slate-400"
          >
            {status}
          </p>

          {quoteResult && (
            <QuoteReview
              result={quoteResult}
              inputAsset={pair.input}
              outputAsset={pair.output}
              now={clock}
              expired={quoteExpired}
              stale={quoteStale}
              stage={stage}
              busy={busy}
              mode={appMode}
              onSign={() => run(signAndPrepare)}
              onRequote={() => run(requestQuote)}
              onCancel={cancelQuoteReview}
            />
          )}
        </>
      )}

      {stage === "quoting" && (
        <div
          role="status"
          aria-live="polite"
          aria-modal="true"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/95 px-6 py-8 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm rounded-2xl border border-cyan-700/70 bg-slate-900 p-8 text-center shadow-2xl">
            <img
              src="/logo.png"
              alt="AURKA"
              className="mx-auto h-14 w-14 object-contain"
            />
            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
              AURKA
            </p>
            <h2 className="mt-3 text-xl font-semibold text-white">
              Checking available Spaces
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Finding the best Space that can complete this swap.
            </p>
            <div className="mx-auto mt-6 h-1.5 w-40 overflow-hidden rounded-full bg-slate-700">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-cyan-400" />
            </div>
          </div>
        </div>
      )}

      {confirmed && (
        <section
          className="space-y-3 rounded-2xl border border-emerald-800/70 bg-emerald-950/30 p-5"
          role="status"
        >
          <h2 className="text-lg font-semibold text-emerald-100">
            Swap complete
          </h2>
          <p className="text-sm leading-6 text-emerald-100/80">
            Your swap is complete. Your balances and activity have been updated.
          </p>
          <Link
            to={`/spaces/${encodeURIComponent(selectedSpaceId)}`}
            className="inline-flex min-h-10 items-center rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-600"
          >
            View balances
          </Link>
        </section>
      )}
    </section>
  );
}

function AmountAdjustmentReview({
  adjustment,
  inputAsset,
  onUse,
  onEdit,
}: {
  readonly adjustment: AmountAdjustment;
  readonly inputAsset: AssetSnapshot;
  readonly onUse: () => void;
  readonly onEdit: () => void;
}) {
  const symbol = displayAssetSymbol(inputAsset.symbol);
  const requested = BigInt(adjustment.requestedAmount);
  const supported = BigInt(adjustment.supportedAmount);
  const remainder = BigInt(adjustment.remainder);
  const minimum = BigInt(adjustment.increment);
  const belowMinimum = supported === 0n;
  return (
    <section
      aria-labelledby="amount-adjustment-heading"
      className="space-y-4 rounded-2xl border border-amber-800/70 bg-amber-950/30 p-5 sm:p-6"
    >
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">
          Amount review
        </p>
        <h2
          id="amount-adjustment-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          {belowMinimum
            ? "Choose a larger amount"
            : "Review the amount available to swap"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-amber-100/80">
          {belowMinimum
            ? `The current minimum executable amount is ${formatTokenAmount(minimum, inputAsset.decimals)} ${symbol}. No approval or signature has been requested.`
            : "This rate supports a slightly smaller amount. Nothing will be approved or signed until you accept it."}
        </p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Summary
          label="Requested amount"
          value={`${formatTokenAmount(requested, inputAsset.decimals)} ${symbol}`}
        />
        <Summary
          label="Amount available to swap"
          value={`${formatTokenAmount(supported, inputAsset.decimals)} ${symbol}`}
        />
        <Summary
          label="Remaining in your wallet"
          value={`${formatTokenAmount(remainder, inputAsset.decimals)} ${symbol}`}
        />
      </dl>
      <div className="flex flex-wrap gap-3">
        {!belowMinimum && (
          <button
            type="button"
            onClick={onUse}
            className="min-h-10 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600"
          >
            Use this amount
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="min-h-10 rounded-lg border border-amber-700 px-4 py-2.5 text-sm font-medium text-amber-100 hover:border-amber-400"
        >
          Edit amount
        </button>
      </div>
    </section>
  );
}

function QuoteReview({
  result,
  inputAsset,
  outputAsset,
  now,
  expired,
  stale,
  stage,
  busy,
  mode,
  onSign,
  onRequote,
  onCancel,
}: {
  readonly result: QuoteResult;
  readonly inputAsset: AssetSnapshot;
  readonly outputAsset: AssetSnapshot;
  readonly now: number;
  readonly expired: boolean;
  readonly stale: boolean;
  readonly stage: TradeStage;
  readonly busy: boolean;
  readonly mode: "demo" | "testnet";
  readonly onSign: () => void;
  readonly onRequote: () => void;
  readonly onCancel: () => void;
}) {
  const executable = BigInt(result.solved.proposal.traderInputAmount);
  const requested = BigInt(result.requestedInputAmount);
  const remaining = requested > executable ? requested - executable : 0n;
  const partial = executable < requested;
  const inputSymbol = displayAssetSymbol(inputAsset.symbol);
  const outputSymbol = displayAssetSymbol(outputAsset.symbol);
  const invalidReason = expired
    ? "This rate has expired. Request an updated rate before continuing."
    : stale
      ? "The rate changed. Request an updated rate before continuing."
      : undefined;
  return (
    <section
      aria-labelledby="swap-review-heading"
      aria-live="polite"
      className="space-y-5 rounded-2xl border border-cyan-800/70 bg-slate-900 p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
            {invalidReason ? "Rate needs an update" : "Rate found"}
          </p>
          <h2
            id="swap-review-heading"
            className="mt-2 text-xl font-semibold text-white"
          >
            Review your swap
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Check the final amounts before confirming in your wallet.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-300 hover:border-cyan-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {partial ? (
        <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-100">
          <strong>Available now.</strong> You asked to sell{" "}
          {formatTokenAmount(requested, inputAsset.decimals)} {inputSymbol}. We
          can complete {formatTokenAmount(executable, inputAsset.decimals)}{" "}
          {inputSymbol} now. The remaining{" "}
          {formatTokenAmount(remaining, inputAsset.decimals)} {inputSymbol}{" "}
          stays in your wallet because the available balance is limited right
          now.
        </div>
      ) : (
        <p className="rounded-xl border border-emerald-900/70 bg-emerald-950/30 p-4 text-sm leading-6 text-emerald-100">
          The full amount is available at this rate.
        </p>
      )}

      <dl className="grid gap-3 sm:grid-cols-2">
        <Summary
          label="You sell"
          value={`${formatTokenAmount(executable, inputAsset.decimals)} ${inputSymbol}`}
        />
        <Summary
          label="You receive"
          value={`${formatTokenAmount(result.solved.proposal.traderOutputAmount, outputAsset.decimals)} ${outputSymbol}`}
        />
        <Summary
          label="Fee"
          value={formatFeePercentage(result.quote.fees.totalFeeBpsScaled)}
        />
        <Summary
          label="Rate valid for"
          value={
            expired
              ? "Expired"
              : `${Math.max(0, result.quote.expiresAt - now)}s remaining`
          }
        />
      </dl>

      {invalidReason ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-800/70 bg-amber-950/30 p-4">
          <p className="flex-1 text-sm leading-6 text-amber-100">
            {invalidReason}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={onRequote}
            className="min-h-10 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            Get updated rate
          </button>
        </div>
      ) : mode === "testnet" ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onSign}
            className="min-h-11 rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {stage === "signing"
              ? "Waiting for wallet…"
              : stage === "submitting"
                ? "Confirming…"
                : "Confirm swap"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRequote}
            className="min-h-11 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-200 hover:border-cyan-500 disabled:opacity-50"
          >
            Get updated rate
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4">
          <p className="flex-1 text-sm leading-6 text-slate-300">
            Preview only. No transaction will be submitted.
          </p>
          <button
            type="button"
            onClick={onRequote}
            disabled={busy}
            className="min-h-10 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-200 hover:border-cyan-500 disabled:opacity-50"
          >
            Get updated rate
          </button>
        </div>
      )}
    </section>
  );
}

function Summary({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-slate-100">{value}</dd>
    </div>
  );
}
