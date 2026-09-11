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
  type AgentProposalResponse,
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

type TradeStage =
  | "idle"
  | "quoting"
  | "quote"
  | "signing"
  | "prepared"
  | "submitting"
  | "confirmed"
  | "failed";

interface ForkState {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly forkBlock: number;
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
  readonly fork?: ForkState;
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
      `The fork service returned an invalid response (${response.status}).`,
    );
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : `Fork request failed (${response.status})`;
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

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function largestExactTokenAmount(
  requestedRaw: bigint,
  asset: Pick<AssetSnapshot, "decimals" | "price" | "priceDecimals">,
  valueDecimals: number,
): bigint {
  if (requestedRaw <= 0n) return 0n;
  const settlementScale = 10n ** BigInt(valueDecimals);
  const tokenAndPriceScale =
    10n ** BigInt(asset.decimals + asset.priceDecimals);
  const valueNumeratorPerRaw = BigInt(asset.price) * settlementScale;
  if (valueNumeratorPerRaw <= 0n) return requestedRaw;
  const exactStep =
    tokenAndPriceScale /
    greatestCommonDivisor(valueNumeratorPerRaw, tokenAndPriceScale);
  return (requestedRaw / exactStep) * exactStep;
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

function agentUnavailableLabel(
  code: Extract<AgentProposalResponse, { status: "UNAVAILABLE" }>["code"],
): string {
  switch (code) {
    case "MISSING_CONFIGURATION":
      return "Setup needed";
    case "AUTHENTICATION_REJECTED":
      return "The assistant could not connect securely";
    case "RATE_LIMITED":
      return "The assistant is busy";
    case "TIMEOUT":
      return "The check took too long";
    case "UNSUPPORTED_CAPABILITY":
      return "This assistant setup is not supported";
    case "PROVIDER_OUTAGE":
      return "The assistant is temporarily unavailable";
    case "MALFORMED_RESPONSE":
      return "Assistant response needs a retry";
    case "NETWORK_ERROR":
      return "The assistant could not be reached";
    case "CONCURRENCY_LIMIT":
      return "Another assistant request is running";
    case "TOOL_BUDGET_EXHAUSTED":
      return "The assistant needs a shorter request";
  }
}

function simulationLabel(status: string): string {
  switch (status) {
    case "SUCCEEDED":
      return "Ready to review";
    case "AUTHORIZATION_PENDING":
      return "Wallet approval needed";
    case "REVERTED":
      return "Would be rejected";
    case "STALE":
      return "Offer needs a refresh";
    default:
      return "Needs review";
  }
}

function pairsFor(position: Position | undefined): SwapPair[] {
  const assets = position?.currentPortfolio?.assets ?? [];
  const weth = assets.find((asset) => asset.symbol.toUpperCase() === "WETH");
  const usdc = assets.find((asset) => asset.symbol.toUpperCase() === "USDC");
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
  if (appMode === "fork" && source?.fork) return source.fork.timestamp;
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
    source.fork &&
    result.quote.capacityEpochId.toLowerCase() !==
      source.fork.capacity.id.toLowerCase()
  )
    return true;
  return false;
}

function typedIntent(intent: AtomicSettlementIntent, fork: ForkState) {
  const fields =
    "bytes32 intentId,bytes32 policyId,bytes32 positionIdHash,address trader,address traderInputToken,address traderOutputToken,uint256 requestedValue,uint256 minimumTraderOutputValue,bool exactInput,bool allowPartialFill,uint256 deadline,uint256 nonce,bytes32 balanceSnapshot,bytes32 priceSnapshot,bytes32 aquaStrategyHash";
  return {
    domain: {
      name: "AURKA Direct Settlement",
      version: "1",
      chainId: fork.chainId,
      verifyingContract: fork.router,
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
  const [agentPrompt, setAgentPrompt] = useState(
    "I want to exchange 1 WETH for USDC. Which available Space can accept it within its rules?",
  );
  const [agentCard, setAgentCard] = useState<AgentProposalResponse>();
  const [agentBusy, setAgentBusy] = useState(false);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const flowVersion = useRef(0);
  const nonce = useRef(Date.now());
  const agentRequest = useRef(0);
  const agentAbort = useRef<AbortController>();

  function cancelAgentRequest() {
    agentRequest.current += 1;
    agentAbort.current?.abort();
    agentAbort.current = undefined;
    setAgentBusy(false);
  }

  function invalidateQuote(clearConfirmation = true) {
    flowVersion.current += 1;
    setQuoteResult(undefined);
    setPrepared(undefined);
    setStage("idle");
    if (clearConfirmation) setConfirmed(undefined);
  }

  async function loadSource(id: string): Promise<TradeSource> {
    const space = await spaceAdapter.getSpace(id);
    if (!space.position)
      throw new Error("This Space is not active and has no holdings to trade.");
    if (appMode !== "fork") return { space, position: space.position };
    const fork = await getJson<ForkState>(
      apiPath(`/fork?spaceId=${encodeURIComponent(id)}`),
    );
    if (fork.position.id !== id)
      throw new Error("The selected Space is not available in this fork.");
    return { space, position: fork.position, fork };
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
      setSource(undefined);
      setSourceLoading(false);
      return;
    }
    let active = true;
    invalidateQuote();
    setSourceLoading(true);
    setSourceError(null);
    const refresh = async () => {
      try {
        const next = await loadSource(selectedSpaceId);
        if (active) {
          setSource(next);
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
        if (active) {
          setSource(undefined);
          setSourceError(friendlyError(requestError));
        }
      } finally {
        if (active) setSourceLoading(false);
      }
    };
    void refresh();
    if (appMode !== "fork")
      return () => {
        active = false;
      };
    const timer = window.setInterval(() => {
      void loadSource(selectedSpaceId)
        .then((next) => {
          if (active) setSource(next);
        })
        .catch((requestError: unknown) => {
          if (active && !source) setSourceError(friendlyError(requestError));
        });
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedSpaceId]);

  useEffect(() => {
    cancelAgentRequest();
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
    return () => {
      agentRequest.current += 1;
      agentAbort.current?.abort();
      agentAbort.current = undefined;
    };
  }, []);

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
    cancelAgentRequest();
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
    cancelAgentRequest();
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

  async function askAgent() {
    if (appMode === "fork" && wallet.status !== "connected")
      throw new Error("Connect your wallet before asking the live assistant.");
    cancelAgentRequest();
    const requestId = agentRequest.current;
    const controller = new AbortController();
    agentAbort.current = controller;
    setAgentBusy(true);
    setError(null);
    setAgentCard(undefined);
    try {
      const result = await client.agentPropose(
        {
          message: agentPrompt,
          trader: wallet.address ?? DEMO_TRADER,
          chainId: source?.position.chainId ?? supportedChainId,
          ...(selectedSpaceId ? { spaceId: selectedSpaceId } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted || requestId !== agentRequest.current)
        return;
      setAgentCard(result);
      if (result.status === "UNAVAILABLE")
        setStatus(
          result.code === "MISSING_CONFIGURATION"
            ? "The assistant is not available here — manual quotes remain available"
            : `${agentUnavailableLabel(result.code)} — try again or use a manual quote`,
        );
      else if (result.status === "CLARIFICATION")
        setStatus("Assistant needs a little more detail");
      else if (result.status === "READ_ONLY_ANSWER")
        setStatus("Current Space rules loaded — nothing was changed");
      else if (result.status === "UNSUPPORTED_ACTION")
        setStatus("Space rule changes belong in owner settings");
      else if (result.status === "BLOCKED")
        setStatus("Agent found a blocking rule — no trade was signed");
      else
        setStatus("Agent proposal ready — review before using the wallet flow");
    } catch (requestError) {
      if (!controller.signal.aborted && requestId === agentRequest.current)
        throw requestError;
    } finally {
      if (requestId === agentRequest.current) {
        agentAbort.current = undefined;
        setAgentBusy(false);
      }
    }
  }

  function useAgentProposal(
    card: Extract<AgentProposalResponse, { status: "READY" }>,
  ) {
    const input = card.quote.currentPortfolio.assets.find(
      (asset) =>
        asset.token.toLowerCase() === card.quote.traderInputToken.toLowerCase(),
    );
    if (!input) return;
    const output = card.quote.currentPortfolio.assets.find(
      (asset) =>
        asset.token.toLowerCase() ===
        card.quote.traderOutputToken.toLowerCase(),
    );
    if (!output) return;
    if (
      input.symbol.toUpperCase() !== "WETH" ||
      output.symbol.toUpperCase() !== "USDC"
    ) {
      setError(
        `The agent proposed ${input.symbol} → ${output.symbol}, but this deployment only has WETH → USDC capacity. The amount was not copied or reinterpreted.`,
      );
      setStatus("Agent direction is not executable on this deployment");
      return;
    }
    setPairKey(
      `${card.quote.traderInputToken.toLowerCase()}:${card.quote.traderOutputToken.toLowerCase()}`,
    );
    const requestedRaw = BigInt(card.proposal.traderInputAmount);
    const handoffRaw = largestExactTokenAmount(
      requestedRaw,
      input,
      card.quote.currentPortfolio.valueDecimals,
    );
    if (handoffRaw === 0n) {
      setError(
        `The agent amount is smaller than the smallest exactly representable ${input.symbol} settlement amount. Request a slightly larger amount.`,
      );
      setStatus("Agent amount could not be copied safely");
      return;
    }
    setAmount(formatTokenAmount(handoffRaw.toString(), input.decimals));
    selectSpace(card.selectedSpace.id);
    setStatus(
      handoffRaw === requestedRaw
        ? "Agent values copied — request a fresh quote before wallet approval"
        : `The assistant returned a partial offer; copied the largest exact ${input.symbol} amount (${formatTokenAmount(handoffRaw.toString(), input.decimals)}). Request a fresh quote before approval`,
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
      setSource(latest);
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
        appMode === "fork" ? wallet.address : (wallet.address ?? DEMO_TRADER);
      if (!trader)
        throw new Error(
          "Connect the counterparty wallet before requesting a fork quote.",
        );
      if (appMode === "fork" && latest.fork)
        await validateWallet(latest.fork, trader);
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

  async function validateWallet(fork: ForkState, expected: string) {
    const provider = wallet.provider;
    if (!provider)
      throw new Error("Connect an Ethereum wallet before signing.");
    if (!expected)
      throw new Error("Connect the counterparty wallet before trading.");
    const chainId = await provider.request({ method: "eth_chainId" });
    const accounts = await provider.request({ method: "eth_accounts" });
    const current = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof chainId !== "string" || BigInt(chainId) !== BigInt(fork.chainId))
      throw new Error(
        `Select the AURKA fork network (chain ${fork.chainId}) in your wallet.`,
      );
    if (
      typeof current !== "string" ||
      current.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error("Wallet account changed. Reconnect before continuing.");
    return provider;
  }

  async function waitForReceipt(
    fork: ForkState,
    hash: string,
  ): Promise<Receipt> {
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const response = await fetch(fork.rpcUrl, {
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
      if (body.error) throw new Error("Receipt lookup failed on the fork RPC.");
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
      `The transaction is still pending (${hash}). Check the fork before retrying.`,
    );
  }

  async function sendForkTransaction(
    fork: ForkState,
    transaction: TransactionRequest,
    expected: string,
    label: string,
  ): Promise<Receipt> {
    const provider = await validateWallet(fork, expected);
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
    localStorage.setItem("aurka:fork:lastTransaction", sent);
    setStatus(`${label}: submitted — waiting for confirmation`);
    return waitForReceipt(fork, sent);
  }

  async function signAndPrepare() {
    if (
      appMode !== "fork" ||
      !quoteResult ||
      !source?.fork ||
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
      setSource(latest);
      if (!latest.fork) throw new Error("Fork wallet state is unavailable.");
      const now = sourceClock(latest);
      if (quoteIsStale(quoteResult, latest, now))
        throw new Error("The offer changed. Refresh it before trading.");
      const expected = wallet.address;
      if (!expected)
        throw new Error("Connect your wallet before approving the trade.");
      let provider = await validateWallet(latest.fork, expected);
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
            data: `${ERC20_ALLOWANCE}${wordAddress(expected)}${wordAddress(latest.fork.router)}`,
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
        await sendForkTransaction(
          latest.fork,
          {
            chainId: latest.fork.chainId,
            to: inputAsset.token,
            data: `${ERC20_APPROVE}${wordAddress(latest.fork.router)}${wordAmount(input)}`,
            value: "0",
          },
          expected,
          `${inputAsset.symbol} allowance`,
        );
        assertVersion(version, walletRevision);
        provider = await validateWallet(latest.fork, expected);
      }
      assertVersion(version, walletRevision);
      setStatus("Review the exact trade in your wallet");
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [
          expected,
          JSON.stringify(typedIntent(quoteResult.intent, latest.fork)),
        ],
      });
      if (typeof signature !== "string")
        throw new Error("The wallet returned no intent signature.");
      assertVersion(version, walletRevision);
      const checked = await loadSource(selectedSpaceId);
      assertVersion(version, walletRevision);
      setSource(checked);
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
        latest.fork.router.toLowerCase()
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
      appMode !== "fork" ||
      !prepared ||
      !quoteResult ||
      !source?.fork ||
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
      setSource(latest);
      if (!latest.fork || !wallet.address)
        throw new Error("Fork wallet state is unavailable.");
      if (quoteIsStale(quoteResult, latest, sourceClock(latest)))
        throw new Error("The offer changed. Refresh it before trading.");
      const receipt = await sendForkTransaction(
        latest.fork,
        prepared,
        wallet.address,
        "Trade",
      );
      assertVersion(version, walletRevision);
      const refreshed = await loadSource(selectedSpaceId);
      setSource(refreshed);
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
          {appMode === "fork" ? "Test-network trade" : "Local demo trade"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Trade
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          Choose a Space, enter what you want to pay, and review what you would
          receive before approving. An offer is not a completed trade.
        </p>
      </header>

      {appMode === "fork" && source?.fork && (
        <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
          <strong>Selected network · test funds</strong>
          <p className="mt-1 text-amber-100/75">
            Chain {source.fork.chainId}. No production funds or mainnet trade is
            claimed.
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

      {appMode === "fork" && <WalletStateMessage />}

      <AgentAssistant
        prompt={agentPrompt}
        card={agentCard}
        busy={agentBusy}
        now={clock}
        onPrompt={setAgentPrompt}
        onAsk={() => run(askAgent)}
        onCancel={cancelAgentRequest}
        onUse={useAgentProposal}
      />

      {appMode === "fork" && (
        <DelegatedAgentPanel
          selectedSpaceId={selectedSpaceId}
          pair={pair}
          chainId={source?.position.chainId ?? supportedChainId}
          now={clock}
          wallet={wallet}
          fork={source?.fork}
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
                (appMode === "fork" && wallet.status !== "connected")
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

function AgentAssistant({
  prompt,
  card,
  busy,
  now,
  onPrompt,
  onAsk,
  onCancel,
  onUse,
}: {
  readonly prompt: string;
  readonly card: AgentProposalResponse | undefined;
  readonly busy: boolean;
  readonly now: number;
  readonly onPrompt: (value: string) => void;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onUse: (
    card: Extract<AgentProposalResponse, { status: "READY" }>,
  ) => void;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-violet-900/70 bg-violet-950/20 p-5 sm:p-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300">
          Live assistant
        </p>
        <h2 className="mt-1 text-xl font-semibold text-white">
          Find a feasible Space
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          Find a trade that fits a Space&apos;s rules. Review it before
          approving with your wallet.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          aria-label="Ask the live trade assistant"
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          rows={2}
          maxLength={1_000}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-violet-800 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-violet-500"
        />
        <button
          type="button"
          disabled={!busy && !prompt.trim()}
          onClick={busy ? onCancel : onAsk}
          className={`min-h-11 rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 ${busy ? "bg-slate-700 hover:bg-slate-600" : "bg-violet-700 hover:bg-violet-600"}`}
        >
          {busy ? "Cancel request" : "Ask agent"}
        </button>
      </div>
      <div
        className="flex flex-wrap gap-2"
        aria-label="Example assistant prompts"
      >
        {[
          "Find a small WETH → USDC trade",
          "Explain this Space's current rules",
          "Where can I edit this Space's rules?",
        ].map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPrompt(example)}
            className="rounded-full border border-violet-800/80 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-950/70"
          >
            {example}
          </button>
        ))}
      </div>
      {card?.status === "CLARIFICATION" && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-violet-800/70 bg-violet-950/40 p-3 text-sm text-violet-100"
        >
          <strong>Let&apos;s narrow that down</strong>
          <p>{card.reason}</p>
          <p className="text-violet-100/75">{card.nextAction}</p>
          {card.suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {card.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onPrompt(suggestion)}
                  className="rounded-full border border-violet-700 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-900/60"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {card?.status === "READ_ONLY_ANSWER" && (
        <section
          aria-label="Space rules answer"
          className="space-y-3 rounded-xl border border-cyan-800/70 bg-cyan-950/30 p-4"
        >
          <div>
            <p className="font-semibold text-cyan-100">
              {card.selectedSpace.name}&apos;s current rules
            </p>
            <p className="mt-1 text-sm leading-6 text-cyan-100/80">
              {card.answer}
            </p>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Summary label="Protection" value="Current Space rules" />
            <Summary
              label="Space limit"
              value={`${formatGroupedDecimalUnits(card.rules.maximumTransactionValue, card.rules.valueDecimals)} normalized value units`}
            />
            <Summary label="Network" value={`Chain ${card.rules.chainId}`} />
          </dl>
          <p className="text-xs leading-5 text-cyan-100/60">
            Limits use this Space&apos;s normalized settlement value; token
            amounts remain shown with their own symbols.
          </p>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-cyan-200/70">
              Allocation ranges
            </p>
            <ul className="mt-2 grid gap-1 text-sm text-slate-200 sm:grid-cols-2">
              {card.rules.assets.map((asset) => (
                <li key={asset.token}>
                  {asset.symbol}: {formatBasisPoints(asset.minimumWeightBps)}–
                  {formatBasisPoints(asset.maximumWeightBps)}
                </li>
              ))}
            </ul>
          </div>
          <Link
            to={`/spaces/${encodeURIComponent(card.selectedSpace.id)}/settings`}
            className="inline-flex rounded-lg border border-cyan-800 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-950/70"
          >
            Open Space settings
          </Link>
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">About this answer</summary>
            <p className="mt-2">
              This answer uses the selected Space&apos;s current rules. No rule
              or wallet change was requested.
            </p>
          </details>
        </section>
      )}
      {card?.status === "UNSUPPORTED_ACTION" && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-sm text-amber-100"
        >
          <strong>Rule changes use owner settings</strong>
          <p>{card.reason}</p>
          <p className="text-amber-100/75">{card.nextAction}</p>
          <Link
            to={card.settingsPath ?? "/spaces"}
            className="inline-flex rounded-lg border border-amber-700 px-3 py-2 text-sm text-amber-100 hover:bg-amber-950/70"
          >
            Open Space settings
          </Link>
        </div>
      )}
      {card?.status === "UNAVAILABLE" && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-sm text-amber-200"
        >
          <strong>{agentUnavailableLabel(card.code)}</strong>
          <p>{card.reason}</p>
          <p className="text-amber-100/75">
            Manual quote and wallet trading remain available.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onAsk}
              disabled={busy}
              className="rounded-lg border border-amber-700 px-3 py-2 text-sm text-amber-100 hover:bg-amber-950/70 disabled:opacity-50"
            >
              Try again
            </button>
            <span className="text-xs text-amber-100/60">
              Support code: {card.code}
            </span>
          </div>
        </div>
      )}
      {card?.status === "BLOCKED" && (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-200">
          <strong>Trade blocked by the current rules</strong>
          <p className="mt-1">{card.reason}</p>
          {card.nextAction && (
            <p className="mt-1 text-red-100/75">{card.nextAction}</p>
          )}
        </div>
      )}
      {card?.status === "READY" && (
        <section
          className="space-y-4 rounded-xl border border-violet-800/70 bg-slate-950/60 p-4"
          aria-label="Assistant offer"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-violet-100">
                {card.selectedSpace.name}
              </p>
              <p className="text-xs text-slate-500">
                Assistant proposal · wallet approval required
              </p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-xs ${card.simulation.status === "SUCCEEDED" ? "bg-emerald-950 text-emerald-200" : "bg-red-950 text-red-200"}`}
            >
              {simulationLabel(card.simulation.status)}
            </span>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Summary
              label="Pay"
              value={`${formatTokenAmount(card.proposal.traderInputAmount, card.quote.currentPortfolio.assets.find((asset) => asset.token.toLowerCase() === card.quote.traderInputToken.toLowerCase())?.decimals ?? 0)} ${card.quote.currentPortfolio.assets.find((asset) => asset.token.toLowerCase() === card.quote.traderInputToken.toLowerCase())?.symbol ?? "token"}`}
            />
            <Summary
              label="Receive after fees"
              value={`${formatTokenAmount(card.proposal.traderOutputAmount, card.quote.currentPortfolio.assets.find((asset) => asset.token.toLowerCase() === card.quote.traderOutputToken.toLowerCase())?.decimals ?? 0)} ${card.quote.currentPortfolio.assets.find((asset) => asset.token.toLowerCase() === card.quote.traderOutputToken.toLowerCase())?.symbol ?? "token"}`}
            />
            <Summary
              label="Fees"
              value={`${formatGroupedDecimalUnits(card.quote.fees.totalFeeAmount, card.quote.currentPortfolio.valueDecimals)} normalized value units · ${card.quote.fees.feeToken}`}
            />
            <Summary
              label="Reference price"
              value={`${formatPrice(card.quote.referencePrice, card.quote.referencePriceDecimals)} quote units per whole output token`}
            />
            <Summary
              label="Minimum received"
              value={`${formatGroupedDecimalUnits(card.minimumReceivedValue, card.quote.currentPortfolio.valueDecimals)} normalized value units`}
            />
            <Summary
              label="Rule check"
              value={
                card.quote.bindingConstraint === "NONE"
                  ? "Pass · within current rules"
                  : bindingConstraintLabel(card.quote.bindingConstraint)
              }
            />
            <Summary
              label="Expiry"
              value={`${Math.max(0, card.quote.expiresAt - now)}s remaining`}
            />
            <Summary
              label="Execution check"
              value={simulationLabel(card.simulation.status)}
            />
          </dl>
          <p className="text-sm leading-6 text-slate-300">{card.explanation}</p>
          <PortfolioPreview
            before={card.quote.currentPortfolio}
            after={card.quote.expectedPostTradePortfolio}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onUse(card)}
              className="rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-600"
            >
              Review this offer
            </button>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">Proposal details</summary>
              <p className="mt-1">
                Wallet approval is still required before any trade is submitted.
              </p>
            </details>
          </div>
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
  fork,
}: {
  readonly selectedSpaceId: string;
  readonly pair: SwapPair | undefined;
  readonly chainId: number;
  readonly now: number;
  readonly wallet: ReturnType<typeof useWallet>;
  readonly fork: ForkState | undefined;
}) {
  const [status, setStatus] = useState<DelegatedStatus>();
  const [session, setSession] = useState<DelegatedSession>();
  const [perTrade, setPerTrade] = useState("1");
  const [budget, setBudget] = useState("2");
  const [tradeCount, setTradeCount] = useState("1");
  const [slippage, setSlippage] = useState("50");
  const [message, setMessage] = useState(
    "Exchange one allowed input token amount within the reviewed session limits.",
  );
  const [recoveryAsset, setRecoveryAsset] = useState<"input" | "output">(
    "input",
  );
  const [recoveryAmount, setRecoveryAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    if (!fork || !pair || !wallet.address || !wallet.provider) {
      setBrowserBalances(undefined);
      return () => {
        active = false;
      };
    }
    const provider = wallet.provider;
    const address = wallet.address;
    const balanceData = `${ERC20_BALANCE_OF}${wordAddress(address)}`;
    const allowanceData = `${ERC20_ALLOWANCE}${wordAddress(address)}${wordAddress(fork.router)}`;
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
  }, [fork, pair?.key, wallet.address, wallet.provider, wallet.revision]);

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
    const signature = await wallet.provider.request({
      method: "eth_signTypedData_v4",
      params: [wallet.address, JSON.stringify(typedData)],
    });
    if (typeof signature !== "string")
      throw new Error("Your wallet returned no authorization signature.");
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
    const signature = await wallet.provider.request({
      method: "eth_signTypedData_v4",
      params: [wallet.address, JSON.stringify(typedData)],
    });
    if (typeof signature !== "string")
      throw new Error(
        "Your wallet returned no control authorization signature.",
      );
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

  async function runAction(action: () => Promise<DelegatedSession>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setSession(result);
      if (result.state === "STOPPED" || result.state === "REVOKE_PENDING") {
        await client
          .delegatedStatus()
          .then(setStatus)
          .catch(() => undefined);
      }
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
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
    const signature = await wallet.provider.request({
      method: "eth_signTypedData_v4",
      params: [wallet.address, JSON.stringify(typedData)],
    });
    if (typeof signature !== "string")
      throw new Error(
        "Your wallet returned no recovery authorization signature.",
      );
    return client.recoverDelegatedSession(session.id, {
      destination: wallet.address,
      assets,
      recoveryNonce,
      signature,
      idempotencyKey: `recovery:${session.id.slice(2, 18)}:${recoveryNonce.slice(2, 18)}`,
    });
  }

  const walletAddress = status?.wallet.address;
  return (
    <section className="space-y-4 rounded-2xl border border-amber-900/70 bg-amber-950/20 p-5 sm:p-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">
          Delegated agent wallet
        </p>
        <h2 className="mt-1 text-xl font-semibold text-white">
          Short session with explicit limits
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          You can authorize a separate agent wallet for a short, limited
          session. It is funded independently and cannot spend your wallet or
          change Space rules. It may only submit the reviewed pair within the
          limits you approve.
        </p>
      </div>
      {!status?.wallet.configured ? (
        <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-400">
          Delegated execution is not enabled for this test network. Browser
          wallet trading remains available.
        </p>
      ) : (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Summary
              label="Agent address"
              value={
                walletAddress ? shortAddress(walletAddress) : "Unavailable"
              }
            />
            <Summary
              label="Your wallet"
              value={
                wallet.address ? shortAddress(wallet.address) : "Not connected"
              }
            />
            <Summary
              label="Session status"
              value={status.wallet.enabled ? "Available" : "Unavailable"}
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
                  ? formatTokenAmount(status.wallet.balances.native, 18)
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
            <summary className="cursor-pointer">Wallet details</summary>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Agent wallet address</dt>
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
                <dd className="mt-1 text-slate-300">Chain {chainId}</dd>
              </div>
            </dl>
          </details>
          {!session ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-slate-300">
                Max input per trade
                <input
                  value={perTrade}
                  onChange={(event) => setPerTrade(event.target.value)}
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
                  onChange={(event) => setTradeCount(event.target.value)}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                />
              </label>
              <label className="text-sm text-slate-300">
                Slippage limit (basis points)
                <input
                  value={slippage}
                  onChange={(event) => setSlippage(event.target.value)}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-slate-100"
                />
              </label>
              <p className="text-xs leading-5 text-amber-100/70 sm:col-span-2">
                Review the pair, limits, and expiry before authorizing. Your
                wallet and the agent wallet remain separate; recovery stays
                available after stopping.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAction(authorize)}
                className="min-h-11 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 sm:col-span-2"
              >
                {busy ? "Authorizing…" : "Review and authorize session"}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
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
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={
                    busy ||
                    (session.state !== "AUTHORIZED" &&
                      session.state !== "ACTIVE")
                  }
                  onClick={() =>
                    void runAction(() =>
                      authorizeControl("START", message).then((authorization) =>
                        client.startDelegatedSession(session.id, {
                          message,
                          ...authorization,
                        }),
                      ),
                    )
                  }
                  className="rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {busy ? "Starting…" : "Start agent session"}
                </button>
                <button
                  type="button"
                  disabled={busy || session.state === "STOPPED"}
                  onClick={() =>
                    void runAction(() =>
                      authorizeControl("STOP").then((authorization) =>
                        client.stopDelegatedSession(session.id, authorization),
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
                    (session.state !== "AUTHORIZED" &&
                      session.state !== "ACTIVE")
                  }
                  onClick={() =>
                    void runAction(() =>
                      authorizeControl("APPROVE").then((authorization) =>
                        client.approveDelegatedSession(
                          session.id,
                          authorization,
                        ),
                      ),
                    )
                  }
                  className="rounded-lg border border-amber-800 px-4 py-2.5 text-sm font-medium text-amber-100 hover:bg-amber-950/50 disabled:opacity-50"
                >
                  Approve exact token allowance
                </button>
              </div>
              {(session.state === "STOPPED" ||
                session.state === "REVOKE_PENDING" ||
                session.state === "EXPIRED" ||
                session.state === "EXHAUSTED") && (
                <div className="space-y-3 rounded-xl border border-cyan-900/70 bg-cyan-950/20 p-4">
                  <p className="text-sm leading-6 text-cyan-100/80">
                    Recovery stays available after stopping. Recover one exact
                    token per approval; the agent cannot withdraw funds.
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
                    {busy ? "Recovering…" : "Recover test funds to your wallet"}
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
  readonly mode: "demo" | "fork";
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
      ) : mode === "fork" ? (
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
