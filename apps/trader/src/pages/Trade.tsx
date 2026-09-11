import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  bindingConstraintLabel,
  findPortfolioAsset,
  formatBasisPoints,
  formatGroupedDecimalUnits,
  formatPrice,
  formatScaledBasisPoints,
  formatSnapshotAge,
  formatTokenAmount,
  formatValueAmount,
  parseTokenAmount,
  delegatedAuthorizationTypedData,
  delegatedControlRequestHash,
  delegatedControlTypedData,
  delegatedRecoveryTypedData,
  type DelegatedSession,
  type DelegatedSessionPlan,
  type DelegatedStatus,
  type DelegatedControlAction,
  type AssetSnapshot,
  type AtomicSettlementIntent,
  type PortfolioSnapshot,
  type Position,
  type Quote,
  type SpaceRecord,
} from "@aurka/shared";
import { ShieldCheck } from "lucide-react";
import { apiBaseUrl, appMode, supportedChainId } from "../config";
import { spaceAdapter } from "../domain/spaces";
import {
  delegatedStateLabel,
  lifecycleLabel,
  shortAddress,
  userFacingError,
} from "../ui";
import { useWallet, WalletStateMessage } from "../wallet";

const client = new AurkaClient({ baseUrl: apiBaseUrl });
const DEMO_TRADER = "0x4444444444444444444444444444444444444444";
const ERC20_BALANCE_OF = "0x70a08231";
const ERC20_ALLOWANCE = "0xdd62ed3e";
const ERC20_APPROVE = "0x095ea7b3";
const OWNER_SIGNATURE_TIMEOUT_MS = 30_000;

type TypedDataWallet = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};

class OwnerWalletSignatureTimeout extends Error {
  readonly code = "OWNER_WALLET_SIGNATURE_TIMEOUT";

  constructor(description: string) {
    super(
      `Your browser wallet did not return the ${description} signature within 30 seconds. Check for a hidden wallet popup, then reject or finish it before trying again.`,
    );
    this.name = "OwnerWalletSignatureTimeout";
  }
}

async function requestOwnerSignature(
  provider: TypedDataWallet,
  address: string,
  typedData: unknown,
  description: string,
): Promise<string> {
  let timeout: number | undefined;
  try {
    const result = await Promise.race([
      provider.request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(typedData)],
      }),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          reject(new OwnerWalletSignatureTimeout(description));
        }, OWNER_SIGNATURE_TIMEOUT_MS);
      }),
    ]);
    if (typeof result !== "string")
      throw new Error(`Your wallet returned no ${description} signature.`);
    return result;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

type TradeStage =
  | "idle"
  | "quoting"
  | "quote"
  | "signing"
  | "prepared"
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
  readonly intent: AtomicSettlementIntent;
  readonly quote: Quote;
  readonly solved: Awaited<ReturnType<AurkaClient["solve"]>>;
  readonly requestedInputAmount: string;
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

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Trade request failed";
  if (/4001|rejected|denied|cancel/i.test(raw))
    return "The wallet rejected this request. Review the exact trade and try again when ready.";
  if (/transaction is still pending/i.test(raw))
    return "The transaction is still pending. Check Activity before trying again.";
  if (/transaction reverted/i.test(raw))
    return "The network rejected this trade. No completed trade is shown.";
  if (/source state changed|snapshot.*changed|quote expired/i.test(raw))
    return "The offer changed. Refresh it before trading.";
  return userFacingError(
    error,
    "Trade request failed. Review the Space and try again.",
  );
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

function sourceClock(source: TradeSource | undefined): number {
  if (appMode === "testnet" && source?.testnet) return source.testnet.timestamp;
  return Math.floor(Date.now() / 1000);
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
    result.quote.currentPortfolio.snapshotHash.toLowerCase() !==
    source.position.currentPortfolio.snapshotHash.toLowerCase()
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
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState(routeSpaceId ?? "");
  const [source, setSource] = useState<TradeSource>();
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pairKey, setPairKey] = useState("");
  const [amount, setAmount] = useState("2");
  const [quoteResult, setQuoteResult] = useState<QuoteResult>();
  const [prepared, setPrepared] = useState<TransactionRequest>();
  const [confirmed, setConfirmed] = useState<Receipt>();
  const [transactionHash, setTransactionHash] = useState("");
  const [stage, setStage] = useState<TradeStage>("idle");
  const [status, setStatus] = useState("Choose a Space and request a quote");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const flowVersion = useRef(0);
  const nonce = useRef(Date.now());
  const sourceRef = useRef<TradeSource>();

  function publishSource(next: TradeSource) {
    sourceRef.current = next;
    setSource(next);
  }

  function invalidateQuote(clearConfirmation = true) {
    flowVersion.current += 1;
    setQuoteResult(undefined);
    setPrepared(undefined);
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
              "Space not found. Choose an available Space to trade.",
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
    sourceRef.current = undefined;
    setSource(undefined);
    invalidateQuote();
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
      void refresh();
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedSpaceId]);

  useEffect(() => {
    const hadPendingTrade = quoteResult !== undefined || prepared !== undefined;
    invalidateQuote();
    setError(null);
    setStatus(
      wallet.status === "connected"
        ? hadPendingTrade
          ? "Account or network changed — request a new quote"
          : "Wallet connected"
        : "Connect a wallet when you are ready to trade",
    );
  }, [wallet.revision]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(sourceClock(source));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [source]);

  const pair = pairFor(source?.position, pairKey);
  const availablePairs = pairsFor(source?.position);
  const quoteExpired =
    quoteResult !== undefined && quoteResult.quote.expiresAt <= clock;
  const quoteStale =
    quoteResult !== undefined && quoteIsStale(quoteResult, source, clock);
  const selectedSpace = spaces.find(
    (candidate) => candidate.identity.id === selectedSpaceId,
  );

  function selectSpace(id: string) {
    invalidateQuote();
    setError(null);
    setSelectedSpaceId(id);
    if (id) navigate(`/trade/${encodeURIComponent(id)}`);
  }

  function updateAmount(value: string) {
    invalidateQuote();
    setError(null);
    setAmount(value);
  }

  function updatePair(value: string) {
    invalidateQuote();
    setError(null);
    setPairKey(value);
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

  async function requestQuote() {
    if (!source || !pair || pair.key !== pairKey)
      throw new Error("Select an available Space and trading pair first.");
    const version = ++flowVersion.current;
    setBusy(true);
    setStage("quoting");
    setError(null);
    setPrepared(undefined);
    setConfirmed(undefined);
    try {
      const latest = await loadSource(selectedSpaceId);
      assertVersion(version);
      publishSource(latest);
      const latestPair = pairFor(latest.position, pairKey);
      if (!latestPair || latestPair.key !== pairKey)
        throw new Error(
          "The available trade direction changed. Choose it again.",
        );
      const requestedInputAmount = parseTokenAmount(
        amount.trim(),
        latestPair.input.decimals,
      );
      if (requestedInputAmount === 0n)
        throw new Error("Enter an amount greater than zero.");
      const trader =
        appMode === "testnet"
          ? wallet.address
          : (wallet.address ?? DEMO_TRADER);
      if (!trader)
        throw new Error(
          "Connect the counterparty wallet before requesting a testnet quote.",
        );
      if (appMode === "testnet" && latest.testnet)
        await validateWallet(latest.testnet, trader);
      const now = sourceClock(latest);
      const input = {
        positionId: latest.position.id,
        trader,
        traderInputToken: latestPair.input.token,
        traderOutputToken: latestPair.output.token,
        requestedTraderInputAmount: requestedInputAmount.toString(),
        minimumTraderOutputValue: "0",
        nonce: String(++nonce.current),
        deadline: now + 300,
      };
      const initialIntent = await client.prepareIntentFromTokenAmount(input);
      const preview = await client.solve(initialIntent);
      assertVersion(version);
      // The signed intent commits to the net output that was reviewed. This
      // protects a partial fill from becoming a different trade at signing.
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
      assertVersion(version);
      setQuoteResult({
        intent,
        quote,
        solved,
        requestedInputAmount: requestedInputAmount.toString(),
      });
      setStage("quote");
      setStatus("Offer ready — review the exact amounts before approval");
    } catch (requestError: unknown) {
      if (version === flowVersion.current) {
        setStage("failed");
        setError(friendlyError(requestError));
        setStatus("Quote failed — no trade was submitted");
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
      throw new Error(
        `Select the AURKA testnet network (chain ${testnet.chainId}) in your wallet.`,
      );
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
    label: string,
  ): Promise<Receipt> {
    const provider = await validateWallet(testnet, expected);
    setStatus(`${label}: awaiting wallet approval`);
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
    setTransactionHash(sent);
    localStorage.setItem("aurka:testnet:lastTransaction", sent);
    setStatus(`${label}: submitted — waiting for confirmation`);
    return waitForReceipt(testnet, sent);
  }

  async function signAndPrepare() {
    if (
      appMode !== "testnet" ||
      !quoteResult ||
      !source?.testnet ||
      quoteExpired ||
      quoteStale
    )
      throw new Error("Review a current offer before approval.");
    const version = flowVersion.current;
    const walletRevision = wallet.revision;
    setBusy(true);
    setStage("signing");
    setError(null);
    try {
      const latest = await loadSource(selectedSpaceId);
      assertVersion(version, walletRevision);
      publishSource(latest);
      if (!latest.testnet)
        throw new Error("Testnet wallet state is unavailable.");
      const now = sourceClock(latest);
      if (quoteIsStale(quoteResult, latest, now))
        throw new Error("The offer changed. Refresh it before trading.");
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
        throw new Error("The reviewed input token is not in the latest Space.");
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
          `The wallet does not have enough ${inputAsset.symbol} for this executable fill.`,
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
          `${inputAsset.symbol} allowance required for the reviewed fill`,
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
          `${inputAsset.symbol} allowance`,
        );
        assertVersion(version, walletRevision);
        provider = await validateWallet(latest.testnet, expected);
      }
      assertVersion(version, walletRevision);
      setStatus("Review the exact trade in your wallet");
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
      const checked = await loadSource(selectedSpaceId);
      assertVersion(version, walletRevision);
      publishSource(checked);
      if (quoteIsStale(quoteResult, checked, sourceClock(checked)))
        throw new Error(
          "The offer changed after signing. Refresh it before trading.",
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
      setPrepared(result.transactionRequest);
      setStage("prepared");
      setStatus("Offer approved — ready to submit");
    } catch (requestError: unknown) {
      if (version === flowVersion.current) {
        setStage("failed");
        setError(friendlyError(requestError));
        setStatus("Approval failed — no trade was submitted");
      }
    } finally {
      if (version === flowVersion.current) setBusy(false);
    }
  }

  async function submitTrade() {
    if (
      appMode !== "testnet" ||
      !prepared ||
      !quoteResult ||
      !source?.testnet ||
      quoteExpired ||
      quoteStale
    )
      throw new Error("The prepared trade is stale. Request a new quote.");
    const version = flowVersion.current;
    const walletRevision = wallet.revision;
    setBusy(true);
    setStage("submitting");
    setError(null);
    try {
      const latest = await loadSource(selectedSpaceId);
      assertVersion(version, walletRevision);
      publishSource(latest);
      if (!latest.testnet || !wallet.address)
        throw new Error("Testnet wallet state is unavailable.");
      if (quoteIsStale(quoteResult, latest, sourceClock(latest)))
        throw new Error("The offer changed. Refresh it before trading.");
      const receipt = await sendTestnetTransaction(
        latest.testnet,
        prepared,
        wallet.address,
        "Trade",
      );
      assertVersion(version, walletRevision);
      const refreshed = await loadSource(selectedSpaceId);
      publishSource(refreshed);
      setConfirmed(receipt);
      setPrepared(undefined);
      setQuoteResult(undefined);
      setStage("confirmed");
      setStatus("Trade confirmed — Space data and Activity are refreshed");
      window.dispatchEvent(
        new CustomEvent("aurka:trade-confirmed", {
          detail: { spaceId: selectedSpaceId, transactionHash: receipt.hash },
        }),
      );
    } catch (requestError: unknown) {
      if (version === flowVersion.current) {
        setStage("failed");
        setError(friendlyError(requestError));
        setStatus("Trade is pending or failed — no success is claimed");
      }
    } finally {
      if (version === flowVersion.current) setBusy(false);
    }
  }

  function run(action: () => Promise<void>) {
    void action().catch((requestError: unknown) => {
      setError(friendlyError(requestError));
      setStage("failed");
      setStatus("Action failed — no trade was submitted");
    });
  }

  if (pageError)
    return (
      <section
        className="mx-auto max-w-3xl space-y-5 text-slate-200"
        role="alert"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Trade
        </p>
        <h1 className="text-3xl font-semibold text-white">Space not found</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          {pageError}
        </p>
        <Link
          to="/spaces"
          className="inline-flex rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white"
        >
          Choose a Space
        </Link>
      </section>
    );

  if (sourceLoading)
    return (
      <div
        className="flex min-h-64 items-center justify-center text-slate-400"
        aria-live="polite"
      >
        Loading current Space information…
      </div>
    );

  if (sourceError)
    return (
      <section
        className="mx-auto max-w-3xl space-y-5 text-slate-200"
        role="alert"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Trade
        </p>
        <h1 className="text-3xl font-semibold text-white">Trade unavailable</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          The selected Space could not provide current holdings: {sourceError}
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
          {appMode === "testnet" ? "Test-network trade" : "Local demo trade"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Trade
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          Choose a Space, enter what you want to pay, and review what you would
          receive before approving. An offer is not a completed trade.
        </p>
      </header>

      {appMode === "testnet" && source?.testnet && (
        <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
          <strong>Selected network · test funds</strong>
          <p className="mt-1 text-amber-100/75">
            Chain {source.testnet.chainId}. No production funds or mainnet trade
            is claimed.
          </p>
        </div>
      )}

      <section className="space-y-4 rounded-2xl border border-cyan-900/70 bg-cyan-950/25 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-cyan-100">
              Choose the Space
            </p>
            <p className="mt-1 text-sm leading-6 text-cyan-100/75">
              This organization-owned Space sets the limits for the trade. Your
              wallet pays and receives the assets.
            </p>
          </div>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-slate-200">Space</span>
          <select
            aria-label="Space"
            value={selectedSpaceId}
            onChange={(event) => selectSpace(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-cyan-800 bg-slate-900 p-2.5 text-slate-100"
          >
            <option value="">Select a Space</option>
            {spaces.map((candidate) => (
              <option
                key={candidate.identity.id}
                value={candidate.identity.id}
                disabled={candidate.identity.state !== "ACTIVE"}
              >
                {candidate.identity.name} ·{" "}
                {lifecycleLabel(candidate.identity.state)}
              </option>
            ))}
          </select>
        </label>
        {selectedSpace && (
          <p className="text-xs text-cyan-100/70">
            Selected: {selectedSpace.identity.name} ·{" "}
            {lifecycleLabel(selectedSpace.identity.state)}
          </p>
        )}
      </section>

      {appMode === "testnet" && <WalletStateMessage />}

      {appMode === "testnet" && (
        <DelegatedAgentPanel
          selectedSpaceId={selectedSpaceId}
          pair={pair}
          chainId={source?.position.chainId ?? supportedChainId}
          now={clock}
          wallet={wallet}
          testnet={source?.testnet}
        />
      )}

      {!source || !pair ? (
        <section className="rounded-2xl border border-amber-800/70 bg-amber-950/30 p-5 text-amber-200">
          <h2 className="font-semibold text-white">
            No supported pair is available
          </h2>
          <p className="mt-2 text-sm leading-6">
            This Space needs the configured USDC and WETH assets and current
            holdings before it can be traded.
          </p>
        </section>
      ) : (
        <>
          <form
            className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900/70 p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              run(requestQuote);
            }}
          >
            <div>
              <h2 className="text-xl font-semibold text-white">
                Request a quote
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-400">
                Enter the token amount you want to pay. AURKA checks the Space
                limits and token precision before asking for approval.
              </p>
            </div>
            <label className="block text-sm">
              <span className="font-medium text-slate-200">Trading pair</span>
              <select
                aria-label="Trading pair"
                value={pairKey}
                onChange={(event) => updatePair(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-slate-100"
              >
                {availablePairs.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.input.symbol} → {candidate.output.symbol}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs leading-5 text-slate-500">
                Available directions are set by this Space. The selected
                direction is never changed for you.
              </span>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-slate-200">Amount to pay</span>
              <div className="mt-1 flex items-center rounded-lg border border-slate-700 bg-slate-800 focus-within:border-cyan-500">
                <input
                  required
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={`Amount to pay in ${pair.input.symbol}`}
                  value={amount}
                  onChange={(event) => updateAmount(event.target.value)}
                  placeholder="0"
                  className="min-w-0 flex-1 bg-transparent p-2.5 text-slate-100 outline-none"
                />
                <span className="px-3 text-sm text-slate-400">
                  {pair.input.symbol}
                </span>
              </div>
              <span className="mt-1 block text-xs leading-5 text-slate-500">
                Your balance and the Space&apos;s current holdings are checked
                before approval.
              </span>
            </label>
            <button
              type="submit"
              disabled={
                busy ||
                !amount.trim() ||
                (appMode === "testnet" && wallet.status !== "connected")
              }
              className="min-h-11 rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {stage === "quoting" ? "Getting quote…" : "Get quote"}
            </button>
          </form>

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
              prepared={prepared}
              busy={busy}
              mode={appMode}
              onSign={() => run(signAndPrepare)}
              onSubmit={() => run(submitTrade)}
              onRequote={() => run(requestQuote)}
            />
          )}
        </>
      )}

      {confirmed && (
        <section
          className="space-y-3 rounded-2xl border border-emerald-800/70 bg-emerald-950/30 p-5"
          role="status"
        >
          <h2 className="text-lg font-semibold text-emerald-100">
            Trade confirmed
          </h2>
          <p className="text-sm leading-6 text-emerald-100/80">
            The test-network receipt is confirmed. Holdings and Activity were
            refreshed after settlement.
          </p>
          <details className="text-xs text-emerald-100/70">
            <summary className="cursor-pointer">Transaction details</summary>
            <p className="mt-2 break-all">
              Transaction {transactionHash || confirmed.hash} · block{" "}
              {confirmed.block} · gas {confirmed.gas}
            </p>
          </details>
          <Link
            to={`/spaces/${encodeURIComponent(selectedSpaceId)}`}
            className="inline-flex min-h-10 items-center rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-600"
          >
            Return to Space
          </Link>
        </section>
      )}
    </section>
  );
}

function DelegatedAgentPanel({
  selectedSpaceId,
  pair,
  chainId,
  now,
  wallet,
  testnet,
}: {
  readonly selectedSpaceId: string;
  readonly pair: SwapPair | undefined;
  readonly chainId: number;
  readonly now: number;
  readonly wallet: ReturnType<typeof useWallet>;
  readonly testnet: TestnetState | undefined;
}) {
  const [status, setStatus] = useState<DelegatedStatus>();
  const [session, setSession] = useState<DelegatedSession>();
  const [perTrade, setPerTrade] = useState("1");
  const [budget, setBudget] = useState("2");
  const [tradeCount, setTradeCount] = useState("1");
  const [slippage, setSlippage] = useState("50");
  const [message, setMessage] = useState(
    "Run one trade within the approved session limits.",
  );
  const [recoveryAsset, setRecoveryAsset] = useState<"input" | "output">(
    "input",
  );
  const [recoveryAmount, setRecoveryAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState<
    "wallet-signature" | "service" | "operation"
  >("operation");
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [browserBalances, setBrowserBalances] = useState<{
    readonly native: string;
    readonly inputToken: string;
    readonly outputToken: string;
    readonly inputAllowance: string;
  }>();

  useEffect(() => {
    let active = true;
    client
      .delegatedStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setStatus(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!testnet || !pair || !wallet.address || !wallet.provider) {
      setBrowserBalances(undefined);
      return () => {
        active = false;
      };
    }
    const provider = wallet.provider;
    const address = wallet.address;
    const balanceData = `${ERC20_BALANCE_OF}${wordAddress(address)}`;
    const allowanceData = `${ERC20_ALLOWANCE}${wordAddress(address)}${wordAddress(testnet.router)}`;
    const quantity = (value: unknown): string => {
      if (typeof value !== "string")
        throw new Error("Wallet balance was malformed");
      return BigInt(value).toString();
    };
    void Promise.all([
      provider.request({
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
      provider.request({
        method: "eth_call",
        params: [{ to: pair.input.token, data: balanceData }, "latest"],
      }),
      provider.request({
        method: "eth_call",
        params: [{ to: pair.output.token, data: balanceData }, "latest"],
      }),
      provider.request({
        method: "eth_call",
        params: [{ to: pair.input.token, data: allowanceData }, "latest"],
      }),
    ])
      .then(([native, inputToken, outputToken, inputAllowance]) => {
        if (active)
          setBrowserBalances({
            native: quantity(native),
            inputToken: quantity(inputToken),
            outputToken: quantity(outputToken),
            inputAllowance: quantity(inputAllowance),
          });
      })
      .catch(() => {
        if (active) setBrowserBalances(undefined);
      });
    return () => {
      active = false;
    };
  }, [testnet, pair?.key, wallet.address, wallet.provider, wallet.revision]);

  useEffect(() => {
    setSession(undefined);
    setWizardOpen(false);
    setError(null);
  }, [selectedSpaceId, pair?.key]);

  function nonce(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  async function authorize(): Promise<DelegatedSession> {
    if (!status?.wallet.configured || !status.wallet.address)
      throw new Error(
        "Delegated execution is not available in this environment.",
      );
    if (!pair || !selectedSpaceId)
      throw new Error("Choose an eligible Space and pair first.");
    if (!wallet.address || wallet.status !== "connected")
      throw new Error("Connect your wallet to authorize this session.");
    if (
      !status.ownerAddress ||
      wallet.address.toLowerCase() !== status.ownerAddress.toLowerCase()
    )
      throw new Error(
        "The connected wallet is not the configured owner for this Privy agent. Connect the configured owner wallet before authorizing the agent.",
      );
    const inputAmount = parseTokenAmount(perTrade.trim(), pair.input.decimals);
    const cumulativeAmount = parseTokenAmount(
      budget.trim(),
      pair.input.decimals,
    );
    const plan: DelegatedSessionPlan = {
      ownerAddress: wallet.address,
      chainId,
      allowedSpaceIds: [selectedSpaceId],
      traderInputToken: pair.input.token,
      traderOutputToken: pair.output.token,
      perTradeInputAmount: inputAmount.toString(),
      cumulativeInputBudget: cumulativeAmount.toString(),
      maxTradeCount: Number(tradeCount),
      slippageBps: Number(slippage),
      expiresAt: now + 15 * 60,
      sessionNonce: nonce(),
    };
    const typedData = delegatedAuthorizationTypedData(
      plan,
      status.wallet.address,
    );
    if (!wallet.provider)
      throw new Error("Connect your wallet before authorizing.");
    setBusyPhase("wallet-signature");
    const signature = await requestOwnerSignature(
      wallet.provider,
      wallet.address,
      typedData,
      "session authorization",
    );
    setBusyPhase("service");
    return client.authorizeDelegatedSession({
      plan,
      agentWallet: status.wallet.address,
      signature,
    });
  }

  async function authorizeControl(
    action: DelegatedControlAction,
    requestMessage = "",
  ) {
    if (
      !session ||
      !status?.wallet.address ||
      !wallet.address ||
      !wallet.provider
    )
      throw new Error("Connect your wallet before controlling the agent.");
    const expiresAt = Math.min(session.plan.expiresAt, now + 120);
    if (expiresAt <= now)
      throw new Error(
        "The delegated session control authorization has expired.",
      );
    const controlNonce = nonce();
    const requestHash = delegatedControlRequestHash(requestMessage);
    const typedData = delegatedControlTypedData(
      session.plan,
      session.id,
      status.wallet.address,
      action,
      requestHash,
      controlNonce,
      expiresAt,
    );
    setBusyPhase("wallet-signature");
    const signature = await requestOwnerSignature(
      wallet.provider,
      wallet.address,
      typedData,
      "control authorization",
    );
    setBusyPhase("service");
    return {
      authorization: {
        sessionId: session.id,
        ownerAddress: wallet.address,
        agentWallet: status.wallet.address,
        chainId: session.plan.chainId,
        action,
        requestHash,
        nonce: controlNonce,
        expiresAt,
        signature,
      },
      idempotencyKey: `control:${action.toLowerCase()}:${session.id.slice(2, 18)}:${controlNonce.slice(2, 18)}`,
    };
  }

  async function runAction(
    action: () => Promise<DelegatedSession>,
    nextStep?: number,
  ) {
    setBusy(true);
    setBusyPhase("operation");
    setError(null);
    try {
      const result = await action();
      setSession(result);
      if (nextStep !== undefined) setWizardStep(nextStep);
      await client
        .delegatedStatus()
        .then(setStatus)
        .catch(() => undefined);
    } catch (requestError) {
      setError(friendlyError(requestError));
      if (session) {
        await client
          .delegatedSession(session.id)
          .then(setSession)
          .catch(() => undefined);
        await client
          .delegatedStatus()
          .then(setStatus)
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
      setBusyPhase("operation");
    }
  }

  async function refreshDelegatedStatus() {
    setStatusBusy(true);
    try {
      setStatus(await client.delegatedStatus());
      setError(null);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setStatusBusy(false);
    }
  }

  async function recover(): Promise<DelegatedSession> {
    if (!session || !pair || !wallet.address || !wallet.provider)
      throw new Error("Connect your wallet before recovering funds.");
    if (!status?.wallet.address)
      throw new Error("The delegated wallet identity is unavailable.");
    const selected = recoveryAsset === "input" ? pair.input : pair.output;
    if (!recoveryAmount.trim())
      throw new Error("Enter one positive test-fund recovery amount.");
    const assets = [
      {
        token: selected.token,
        amount: parseTokenAmount(
          recoveryAmount.trim(),
          selected.decimals,
        ).toString(),
      },
    ];
    const recoveryNonce = nonce();
    const typedData = delegatedRecoveryTypedData(
      session.plan,
      session.id,
      status.wallet.address,
      wallet.address,
      assets,
      recoveryNonce,
    );
    setBusyPhase("wallet-signature");
    const signature = await requestOwnerSignature(
      wallet.provider,
      wallet.address,
      typedData,
      "recovery authorization",
    );
    setBusyPhase("service");
    return client.recoverDelegatedSession(session.id, {
      destination: wallet.address,
      assets,
      recoveryNonce,
      signature,
      idempotencyKey: `recovery:${session.id.slice(2, 18)}:${recoveryNonce.slice(2, 18)}`,
    });
  }

  const walletAddress = status?.wallet.address;
  const allowanceReady =
    session !== undefined &&
    status?.wallet.balances !== undefined &&
    BigInt(status.wallet.balances.inputAllowance) >=
      BigInt(session.plan.perTradeInputAmount);
  const allowancePending =
    !allowanceReady &&
    session?.lastResult?.startsWith("Agent allowance submitted") === true;
  const ownerMatchesAgent =
    wallet.address !== null &&
    status?.ownerAddress !== undefined &&
    status.ownerAddress !== null &&
    wallet.address.toLowerCase() === status.ownerAddress.toLowerCase();
  const ownerReady = ownerMatchesAgent;

  function openWizard() {
    setError(null);
    setWizardStep(
      session ? (session.state === "AUTHORIZED" && !allowanceReady ? 3 : 4) : 1,
    );
    setWizardOpen(true);
  }

  return (
    <>
      <section className="space-y-4 rounded-2xl border border-amber-900/70 bg-amber-950/20 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">
              Privy delegated agent
            </p>
            <h2 className="mt-1 text-xl font-semibold text-white">
              Run a guarded trade
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
              A separate Privy wallet can run only the Space, token pair, and
              limits that you approve. It cannot spend your wallet or change
              Space rules.
            </p>
          </div>
          <span className="rounded-full border border-amber-800 px-2.5 py-1 text-xs text-amber-200">
            {status === undefined
              ? "Checking Privy…"
              : status.wallet.configured && status.wallet.enabled
                ? "Available"
                : "Needs setup"}
          </span>
        </div>
        {status === undefined ? (
          <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-400">
            Checking the configured Privy wallet and policy. This can take a few
            seconds on the first request.
          </p>
        ) : !status.wallet.configured ? (
          <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-400">
            The Privy delegated wallet is not available on this test-network
            service. Browser-wallet trading remains available.
          </p>
        ) : (
          <>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <Summary
                label="Agent wallet"
                value={
                  walletAddress ? shortAddress(walletAddress) : "Unavailable"
                }
              />
              <Summary
                label="Network"
                value={`Sepolia · chain ${status.wallet.chainId}`}
              />
              <Summary
                label="Running sessions"
                value={String(status.activeSessions)}
              />
            </dl>
            {wallet.status !== "connected" && (
              <p className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-sm text-amber-100">
                Connect the owner wallet first. It signs the exact limits; the
                Privy agent wallet signs and submits the guarded trade.
              </p>
            )}
            {wallet.status === "connected" &&
              status.ownerAddress !== undefined &&
              status.ownerAddress !== null &&
              !ownerMatchesAgent && (
                <p className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm leading-6 text-red-200">
                  The connected wallet ({shortAddress(wallet.address ?? "")}) is
                  not the configured owner for this Privy agent (
                  {shortAddress(status.ownerAddress)}). Connect that wallet
                  before signing. The Space owner can be a different address;
                  the selected Space is included in the agent's scope.
                </p>
              )}
            <button
              type="button"
              disabled={
                !status.wallet.enabled ||
                wallet.status !== "connected" ||
                !ownerReady ||
                !pair ||
                !selectedSpaceId
              }
              onClick={openWizard}
              className="min-h-11 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {session ? "Continue delegated session" : "Open setup wizard"}
            </button>
            {session && (
              <p className="text-xs text-amber-100/70">
                Current session: {delegatedStateLabel(session.state)} · scoped
                to {selectedSpaceId} and the displayed pair.
              </p>
            )}
            <p className="text-xs leading-5 text-slate-500">
              Multiple sessions can be scoped independently, but this deployment
              uses one Privy agent wallet and serializes its transactions. Use
              separate Privy wallets for truly parallel agents.
            </p>
          </>
        )}
      </section>
      {wizardOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delegated-wizard-heading"
            className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-amber-800/80 bg-slate-950 shadow-2xl shadow-black/60"
          >
            <div className="flex items-start justify-between gap-4 border-b border-amber-900/70 bg-amber-950/40 px-5 py-4 sm:px-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">
                  Delegated execution wizard
                </p>
                <h2
                  id="delegated-wizard-heading"
                  className="mt-1 text-xl font-semibold text-white"
                >
                  Privy agent session
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close delegated execution wizard"
                onClick={() => setWizardOpen(false)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
              >
                Close
              </button>
            </div>
            <div className="border-b border-slate-800 px-5 py-3 sm:px-6">
              <div className="grid grid-cols-4 gap-1 text-center text-[11px] sm:text-xs">
                {[
                  "1 · Review",
                  "2 · Authorize",
                  "3 · Allowance",
                  "4 · Run",
                ].map((label, index) => (
                  <span
                    key={label}
                    className={`rounded-md px-2 py-1.5 ${wizardStep === index + 1 ? "bg-amber-700/70 text-white" : "bg-slate-900 text-slate-500"}`}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                {wizardStep === 1
                  ? "Review the Space, pair, and limits before signing."
                  : wizardStep === 2
                    ? "Your owner wallet signs the exact session permissions."
                    : wizardStep === 3
                      ? "Privy approves only the displayed input amount for the router."
                      : "Start one guarded trade, then inspect the result before running another."}
              </p>
            </div>
            <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
              <section className="space-y-4 rounded-2xl border border-amber-900/70 bg-amber-950/20 p-5 sm:p-6">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">
                    Session details
                  </p>
                  <h2 className="mt-1 text-xl font-semibold text-white">
                    Review each permission before it is used
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-400">
                    The owner wallet approves a short session. Then the
                    configured Privy wallet approves its input allowance and
                    runs the trade.
                  </p>
                </div>
                {!status?.wallet.configured ? (
                  <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-400">
                    Delegated execution is not enabled for this test network.
                    Browser wallet trading remains available.
                  </p>
                ) : (
                  <>
                    <dl className="grid gap-2 text-sm sm:grid-cols-2">
                      <Summary
                        label="Agent address"
                        value={
                          walletAddress
                            ? shortAddress(walletAddress)
                            : "Unavailable"
                        }
                      />
                      <Summary
                        label="Your wallet"
                        value={
                          wallet.address
                            ? shortAddress(wallet.address)
                            : "Not connected"
                        }
                      />
                      <Summary
                        label="Session status"
                        value={
                          status.wallet.enabled ? "Available" : "Unavailable"
                        }
                      />
                      <Summary
                        label={`Agent ${pair?.input.symbol ?? "input"} balance`}
                        value={
                          status.wallet.balances && pair
                            ? formatTokenAmount(
                                status.wallet.balances.inputToken,
                                pair.input.decimals,
                              )
                            : "Not read"
                        }
                      />
                      <Summary
                        label={`Your ${pair?.input.symbol ?? "input"} balance`}
                        value={
                          browserBalances && pair
                            ? formatTokenAmount(
                                browserBalances.inputToken,
                                pair.input.decimals,
                              )
                            : "Not read"
                        }
                      />
                      <Summary
                        label={`Agent ${pair?.output.symbol ?? "output"} balance`}
                        value={
                          status.wallet.balances && pair
                            ? formatTokenAmount(
                                status.wallet.balances.outputToken,
                                pair.output.decimals,
                              )
                            : "Not read"
                        }
                      />
                      <Summary
                        label={`Your ${pair?.output.symbol ?? "output"} balance`}
                        value={
                          browserBalances && pair
                            ? formatTokenAmount(
                                browserBalances.outputToken,
                                pair.output.decimals,
                              )
                            : "Not read"
                        }
                      />
                      <Summary
                        label="Agent gas balance"
                        value={
                          status.wallet.balances
                            ? formatTokenAmount(
                                status.wallet.balances.native,
                                18,
                              )
                            : "Not read"
                        }
                      />
                      <Summary
                        label="Your gas balance"
                        value={
                          browserBalances
                            ? formatTokenAmount(browserBalances.native, 18)
                            : "Not read"
                        }
                      />
                      <Summary
                        label={`Agent ${pair?.input.symbol ?? "input"} router allowance`}
                        value={
                          status.wallet.balances && pair
                            ? formatTokenAmount(
                                status.wallet.balances.inputAllowance,
                                pair.input.decimals,
                              )
                            : "Not read"
                        }
                      />
                      <Summary
                        label={`Your ${pair?.input.symbol ?? "input"} allowance`}
                        value={
                          browserBalances && pair
                            ? formatTokenAmount(
                                browserBalances.inputAllowance,
                                pair.input.decimals,
                              )
                            : "Not read"
                        }
                      />
                    </dl>
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer">
                        Wallet details
                      </summary>
                      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                        <div>
                          <dt className="text-slate-500">
                            Agent wallet address
                          </dt>
                          <dd className="mt-1 break-all text-slate-300">
                            {walletAddress ?? "Unavailable"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Permission record</dt>
                          <dd className="mt-1 break-all text-slate-300">
                            {status.wallet.policyFingerprint ?? "Unavailable"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Network</dt>
                          <dd className="mt-1 text-slate-300">
                            Chain {chainId}
                          </dd>
                        </div>
                      </dl>
                    </details>
                    {!session ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 sm:col-span-2">
                          <p className="text-sm font-semibold text-amber-100">
                            Step 1–2 · Review and authorize
                          </p>
                          <p className="mt-1 text-xs leading-5 text-amber-100/70">
                            These limits are the complete permission. The owner
                            wallet will sign them once; the Privy wallet cannot
                            go beyond them.
                          </p>
                        </div>
                        <label className="text-sm text-slate-300">
                          Max input per trade
                          <input
                            value={perTrade}
                            onChange={(event) =>
                              setPerTrade(event.target.value)
                            }
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                          />
                        </label>
                        <label className="text-sm text-slate-300">
                          Total input budget
                          <input
                            value={budget}
                            onChange={(event) => setBudget(event.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                          />
                        </label>
                        <label className="text-sm text-slate-300">
                          Number of trades
                          <input
                            value={tradeCount}
                            onChange={(event) =>
                              setTradeCount(event.target.value)
                            }
                            inputMode="numeric"
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                          />
                        </label>
                        <label className="text-sm text-slate-300">
                          Slippage limit (basis points)
                          <input
                            value={slippage}
                            onChange={(event) =>
                              setSlippage(event.target.value)
                            }
                            inputMode="numeric"
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                          />
                        </label>
                        <p className="text-xs leading-5 text-amber-100/70 sm:col-span-2">
                          Review the pair, limits, and expiry before
                          authorizing. Your wallet and the agent wallet remain
                          separate; recovery stays available after stopping.
                        </p>
                        <p className="rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs leading-5 text-slate-300">
                          The next request opens in your connected Ethereum
                          wallet. Privy does not sign this step: the connected
                          wallet must be the owner configured for this agent and
                          must be on Sepolia.
                        </p>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setWizardStep(2);
                            void runAction(authorize, 3);
                          }}
                          className="min-h-11 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 sm:col-span-2"
                        >
                          {busy
                            ? busyPhase === "wallet-signature"
                              ? "Waiting for your wallet signature…"
                              : busyPhase === "service"
                                ? "Submitting authorization…"
                                : "Working…"
                            : "Authorize session"}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-3">
                          <p className="text-sm font-semibold text-amber-100">
                            Step 3 · Approve the Privy allowance
                          </p>
                          <p className="mt-1 text-xs leading-5 text-amber-100/70">
                            The agent wallet must approve the settlement router
                            for one per-trade input amount before it can run.
                          </p>
                          <p className="mt-2 text-sm text-slate-200">
                            Current allowance:{" "}
                            {pair && status.wallet.balances
                              ? formatTokenAmount(
                                  status.wallet.balances.inputAllowance,
                                  pair.input.decimals,
                                )
                              : "Not read"}{" "}
                            {pair?.input.symbol ?? "input token"} · required:{" "}
                            {pair
                              ? formatTokenAmount(
                                  session.plan.perTradeInputAmount,
                                  pair.input.decimals,
                                )
                              : "Not read"}{" "}
                            {pair?.input.symbol ?? "input token"}
                          </p>
                          {allowancePending && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-100/75">
                              <span>
                                The allowance transaction was submitted. Wait
                                for Sepolia confirmation, then refresh the
                                status.
                              </span>
                              <button
                                type="button"
                                disabled={statusBusy}
                                onClick={() => void refreshDelegatedStatus()}
                                className="rounded-md border border-amber-700 px-2 py-1 text-amber-100 hover:bg-amber-950/60 disabled:opacity-50"
                              >
                                {statusBusy ? "Refreshing…" : "Refresh status"}
                              </button>
                            </div>
                          )}
                        </div>
                        <dl className="grid gap-2 text-sm sm:grid-cols-2">
                          <Summary
                            label="Session"
                            value={delegatedStateLabel(session.state)}
                          />
                          <Summary
                            label="Budget remaining"
                            value={`${formatTokenAmount(session.remainingInputBudget, pair?.input.decimals ?? 0)} ${pair?.input.symbol ?? "token"}`}
                          />
                          <Summary
                            label="Expiry"
                            value={`${Math.max(0, session.plan.expiresAt - now)}s remaining`}
                          />
                          <Summary
                            label="Trades"
                            value={`${session.tradeCount}/${session.plan.maxTradeCount}`}
                          />
                          <Summary
                            label="Latest result"
                            value={session.lastResult ?? "No activity yet"}
                          />
                        </dl>
                        <textarea
                          value={message}
                          onChange={(event) => setMessage(event.target.value)}
                          rows={2}
                          maxLength={1_000}
                          className="w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-slate-100"
                          aria-label="Optional agent request"
                        />
                        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                          <button
                            type="button"
                            disabled={
                              busy ||
                              !allowanceReady ||
                              (session.state !== "AUTHORIZED" &&
                                session.state !== "ACTIVE")
                            }
                            onClick={() =>
                              void runAction(
                                () =>
                                  authorizeControl("START", message).then(
                                    (authorization) =>
                                      client.startDelegatedSession(session.id, {
                                        message,
                                        ...authorization,
                                      }),
                                  ),
                                4,
                              )
                            }
                            className="rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                          >
                            {busy ? "Running…" : "Run one guarded trade"}
                          </button>
                          {!allowanceReady && (
                            <p className="text-xs leading-5 text-amber-100/70 sm:max-w-xs">
                              Approve the exact allowance below before running
                              the agent.
                            </p>
                          )}
                          <button
                            type="button"
                            disabled={busy || session.state === "STOPPED"}
                            onClick={() =>
                              void runAction(() =>
                                authorizeControl("STOP").then((authorization) =>
                                  client.stopDelegatedSession(
                                    session.id,
                                    authorization,
                                  ),
                                ),
                              )
                            }
                            className="rounded-lg border border-red-800 px-4 py-2.5 text-sm font-medium text-red-200 hover:bg-red-950/50 disabled:opacity-50"
                          >
                            Stop and revoke
                          </button>
                          <button
                            type="button"
                            disabled={
                              busy ||
                              allowanceReady ||
                              allowancePending ||
                              (session.state !== "AUTHORIZED" &&
                                session.state !== "ACTIVE")
                            }
                            onClick={() =>
                              void runAction(
                                () =>
                                  authorizeControl("APPROVE").then(
                                    (authorization) =>
                                      client.approveDelegatedSession(
                                        session.id,
                                        authorization,
                                      ),
                                  ),
                                4,
                              )
                            }
                            className={
                              allowanceReady
                                ? "rounded-lg border border-amber-800 px-4 py-2.5 text-sm font-medium text-amber-100 hover:bg-amber-950/50 disabled:opacity-50"
                                : "rounded-lg border border-amber-500 bg-amber-950/50 px-4 py-2.5 text-sm font-medium text-amber-100 hover:bg-amber-950/50 disabled:opacity-50"
                            }
                          >
                            {allowanceReady
                              ? "Allowance approved"
                              : allowancePending
                                ? "Waiting for allowance confirmation…"
                                : "Approve exact token allowance"}
                          </button>
                          {session.state === "RECONCILIATION_REQUIRED" && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void runAction(
                                  () =>
                                    authorizeControl("RECONCILE").then(
                                      (authorization) =>
                                        client.reconcileDelegatedSession(
                                          session.id,
                                          authorization,
                                        ),
                                    ),
                                  4,
                                )
                              }
                              className="rounded-lg border border-cyan-800 px-4 py-2.5 text-sm font-medium text-cyan-100 hover:bg-cyan-950/50 disabled:opacity-50"
                            >
                              Reconcile pending transaction
                            </button>
                          )}
                        </div>
                        {(session.state === "STOPPED" ||
                          session.state === "REVOKE_PENDING" ||
                          session.state === "EXPIRED" ||
                          session.state === "EXHAUSTED") && (
                          <div className="space-y-3 rounded-xl border border-cyan-900/70 bg-cyan-950/20 p-4">
                            <p className="text-sm leading-6 text-cyan-100/80">
                              Recovery stays available after stopping. Recover
                              one exact token per approval; the agent cannot
                              withdraw funds.
                            </p>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="text-sm text-slate-300">
                                Token
                                <select
                                  value={recoveryAsset}
                                  onChange={(event) =>
                                    setRecoveryAsset(
                                      event.target.value as "input" | "output",
                                    )
                                  }
                                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                                >
                                  <option value="input">
                                    {pair?.input.symbol ?? "input"}
                                  </option>
                                  <option value="output">
                                    {pair?.output.symbol ?? "output"}
                                  </option>
                                </select>
                              </label>
                              <label className="text-sm text-slate-300">
                                Amount
                                <input
                                  value={recoveryAmount}
                                  onChange={(event) =>
                                    setRecoveryAmount(event.target.value)
                                  }
                                  placeholder="0"
                                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                                />
                              </label>
                            </div>
                            <button
                              type="button"
                              disabled={busy || !wallet.address}
                              onClick={() => void runAction(recover)}
                              className="rounded-lg border border-cyan-800 px-4 py-2.5 text-sm font-medium text-cyan-100 hover:bg-cyan-950/50 disabled:opacity-50"
                            >
                              {busy
                                ? "Recovering…"
                                : "Recover test funds to your wallet"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {error && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-900/70 bg-red-950/40 p-3 text-sm text-red-200"
                  >
                    {error}
                  </p>
                )}
              </section>
            </div>
          </section>
        </div>
      )}
    </>
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
  prepared,
  busy,
  mode,
  onSign,
  onSubmit,
  onRequote,
}: {
  readonly result: QuoteResult;
  readonly inputAsset: AssetSnapshot;
  readonly outputAsset: AssetSnapshot;
  readonly now: number;
  readonly expired: boolean;
  readonly stale: boolean;
  readonly stage: TradeStage;
  readonly prepared: TransactionRequest | undefined;
  readonly busy: boolean;
  readonly mode: "demo" | "testnet";
  readonly onSign: () => void;
  readonly onSubmit: () => void;
  readonly onRequote: () => void;
}) {
  const executable = BigInt(result.solved.proposal.traderInputAmount);
  const requested = BigInt(result.requestedInputAmount);
  const remaining = requested > executable ? requested - executable : 0n;
  const partial = executable < requested;
  const invalidReason = expired
    ? "This quote has expired. Request a fresh quote before continuing."
    : stale
      ? "The offer changed. Refresh it before trading."
      : undefined;
  const feeAsset = findPortfolioAsset(
    result.quote.currentPortfolio,
    result.quote.fees.feeToken,
  );
  const feeToken = feeAsset?.symbol ?? outputAsset.symbol;
  return (
    <section
      aria-labelledby="swap-review-heading"
      aria-live="polite"
      className="space-y-5 rounded-2xl border border-cyan-800/70 bg-slate-900 p-5 sm:p-6"
    >
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          {invalidReason ? "Quote needs attention" : "Quote ready"}
        </p>
        <h2
          id="swap-review-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Review what would happen
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Review the amounts, fee, limit, and expiry. Nothing is signed or
          submitted until you approve the next step.
        </p>
      </div>

      {partial ? (
        <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-100">
          <strong>Partial fill.</strong> You asked to pay{" "}
          {formatTokenAmount(requested, inputAsset.decimals)}{" "}
          {inputAsset.symbol}. AURKA can fill{" "}
          {formatTokenAmount(executable, inputAsset.decimals)}{" "}
          {inputAsset.symbol} now. The unfilled{" "}
          {formatTokenAmount(remaining, inputAsset.decimals)}{" "}
          {inputAsset.symbol} remains with you because{" "}
          {constraintExplanation(result.quote.bindingConstraint)}.
        </div>
      ) : (
        <p className="rounded-xl border border-emerald-900/70 bg-emerald-950/30 p-4 text-sm leading-6 text-emerald-100">
          Full fill: the requested amount fits the current Space rules. The
          network checks the rules again before settlement.
        </p>
      )}

      <dl className="grid gap-3 sm:grid-cols-2">
        <Summary
          label="You pay (filled)"
          value={`${formatTokenAmount(executable, inputAsset.decimals)} ${inputAsset.symbol}`}
        />
        <Summary
          label="You receive (net)"
          value={`${formatTokenAmount(result.solved.proposal.traderOutputAmount, outputAsset.decimals)} ${outputAsset.symbol}`}
        />
        <Summary
          label="Fee"
          value={`${formatGroupedDecimalUnits(result.quote.fees.totalFeeAmount, result.quote.currentPortfolio.valueDecimals)} normalized value units · ${feeToken}`}
        />
        <Summary
          label="Binding rule"
          value={bindingConstraintLabel(result.quote.bindingConstraint)}
        />
        <Summary
          label="Treasury retained"
          value={`${formatGroupedDecimalUnits(result.quote.fees.treasuryAmount, result.quote.currentPortfolio.valueDecimals)} normalized value units`}
        />
        <Summary
          label="Expiry"
          value={
            expired
              ? "Expired"
              : `${Math.max(0, result.quote.expiresAt - now)}s remaining`
          }
        />
      </dl>

      <div className="grid gap-2 rounded-xl border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300 sm:grid-cols-2">
        <p className="sm:col-span-2">
          Fees and limits use this Space&apos;s normalized settlement value.
          They are not a USD denomination.
        </p>
      </div>

      <PortfolioPreview
        before={result.quote.currentPortfolio}
        after={result.quote.expectedPostTradePortfolio}
      />

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
            Re-quote
          </button>
        </div>
      ) : mode === "testnet" ? (
        <div className="flex flex-wrap items-center gap-3">
          {prepared ? (
            <>
              <p className="w-full rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-100">
                Approved — the exact trade is ready to submit. No transaction
                has been submitted yet.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={onSubmit}
                className="min-h-11 rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
              >
                {stage === "submitting" ? "Submitting…" : "Submit trade"}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onSign}
              className="min-h-11 rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              {stage === "signing"
                ? "Waiting for wallet…"
                : "Approve exact trade"}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onRequote}
            className="min-h-11 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-200 hover:border-cyan-500 disabled:opacity-50"
          >
            Re-quote
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4">
          <p className="flex-1 text-sm leading-6 text-slate-300">
            This local demo prepares offers for review only. It does not submit
            transactions or claim a balance change.
          </p>
          <button
            type="button"
            onClick={onRequote}
            disabled={busy}
            className="min-h-10 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-200 hover:border-cyan-500 disabled:opacity-50"
          >
            Re-quote
          </button>
        </div>
      )}

      <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
        <summary className="cursor-pointer font-medium text-slate-200">
          Offer details
        </summary>
        <dl className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Fee rate</dt>
            <dd className="mt-1">
              {formatScaledBasisPoints(result.quote.fees.totalFeeBpsScaled)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Fee breakdown</dt>
            <dd className="mt-1">
              {formatTokenAmount(
                result.solved.proposal.solverFeeAmount,
                outputAsset.decimals,
              )}{" "}
              {outputAsset.symbol} solver ·{" "}
              {formatTokenAmount(
                result.solved.proposal.protocolFeeAmount,
                outputAsset.decimals,
              )}{" "}
              {outputAsset.symbol} protocol
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Reference price</dt>
            <dd className="mt-1">
              {formatPrice(
                result.quote.referencePrice,
                result.quote.referencePriceDecimals,
              )}{" "}
              quote units per whole {outputAsset.symbol}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Data age</dt>
            <dd className="mt-1">
              Updated{" "}
              {formatSnapshotAge(result.quote.currentPortfolio.observedAt, now)}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function constraintExplanation(constraint: string): string {
  const explanations: Record<string, string> = {
    TRANSACTION_CAP: "the Space’s per-trade limit",
    AVAILABLE_BALANCE: "the Space’s available balance",
    CAPACITY_EXHAUSTED: "the remaining directional capacity",
    MINIMUM_WEIGHT: "the minimum allocation rule",
    MAXIMUM_WEIGHT: "the maximum allocation rule",
    RISK_LIMIT: "the current risk limit",
    FEE_EXCEEDS_OUTPUT: "the fee relative to the output",
    PAUSED: "the Space is paused",
    REQUESTED_AMOUNT: "the requested amount",
    NONE: "no additional limiting rule",
  };
  return (
    explanations[constraint] ?? constraint.toLowerCase().replace(/_/g, " ")
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

function PortfolioPreview({
  before,
  after,
}: {
  readonly before: PortfolioSnapshot;
  readonly after: PortfolioSnapshot;
}) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-4">
      <div>
        <h3 className="font-medium text-slate-100">
          Space holdings: current → expected after
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Expected holdings change only after a confirmed settlement. Values use
          this Space&apos;s normalized settlement units, not USD.
        </p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">
            Space holdings before and after the quoted trade
          </caption>
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-4">Asset</th>
              <th className="py-2 pr-4">Before</th>
              <th className="py-2 pr-4">Expected after</th>
              <th className="py-2">Allocation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {before.assets.map((asset) => {
              const next = findPortfolioAsset(after, asset.token);
              if (!next) return null;
              const difference = BigInt(next.value) - BigInt(asset.value);
              return (
                <tr key={asset.token}>
                  <th className="py-2 pr-4 font-medium text-slate-200">
                    {asset.symbol}
                  </th>
                  <td className="py-2 pr-4 text-slate-300">
                    {formatValueAmount(asset.value, before.valueDecimals)}
                  </td>
                  <td className="py-2 pr-4 text-slate-300">
                    {formatValueAmount(next.value, after.valueDecimals)}{" "}
                    <span className="text-xs text-slate-500">
                      ({formatValueAmount(difference, before.valueDecimals)})
                    </span>
                  </td>
                  <td className="py-2 text-slate-300">
                    {formatBasisPoints(asset.weightBps)} →{" "}
                    {formatBasisPoints(next.weightBps)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
