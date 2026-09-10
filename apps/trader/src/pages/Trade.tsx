import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  bindingConstraintLabel,
  findPortfolioAsset,
  formatBasisPoints,
  formatPrice,
  formatScaledBasisPoints,
  formatSnapshotAge,
  formatTokenAmount,
  formatValueAmount,
  parseTokenAmount,
  type AssetSnapshot,
  type AtomicSettlementIntent,
  type PortfolioSnapshot,
  type Position,
  type Quote,
  type SpaceRecord,
} from "@aurka/shared";
import { CircleHelp, ShieldCheck } from "lucide-react";
import { apiBaseUrl, appMode } from "../config";
import { spaceAdapter } from "../domain/spaces";
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

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Trade request failed";
  if (/4001|rejected|denied|cancel/i.test(raw))
    return "The wallet rejected this request. Review the exact trade and try again when ready.";
  return raw;
}

function pairFor(position: Position | undefined): SwapPair | undefined {
  const assets = position?.currentPortfolio?.assets ?? [];
  const input = assets.find((asset) => asset.symbol.toUpperCase() === "WETH");
  const output = assets.find(
    (asset) =>
      asset.symbol.toUpperCase() === "USDC" &&
      asset.token.toLowerCase() !== input?.token.toLowerCase(),
  );
  return input && output
    ? { key: `${input.token}:${output.token}`, input, output }
    : undefined;
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
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const flowVersion = useRef(0);
  const nonce = useRef(Date.now());

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
          setPairKey(pairFor(next.position)?.key ?? "");
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

  const pair = pairFor(source?.position);
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
      setSource(latest);
      const latestPair = pairFor(latest.position);
      if (!latestPair || latestPair.key !== pairKey)
        throw new Error(
          "The selected pair changed with the source snapshot. Choose it again.",
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
      setStatus("Quote ready — review the exact amounts before signing");
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
      throw new Error("Review a fresh quote before signing.");
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
        throw new Error(
          "The quote expired or source state changed. Request a new quote.",
        );
      const expected = wallet.address;
      if (!expected)
        throw new Error("Connect the counterparty wallet before signing.");
      let provider = await validateWallet(latest.fork, expected);
      const input = BigInt(quoteResult.solved.proposal.traderInputAmount);
      const balance = await provider.request({
        method: "eth_call",
        params: [
          {
            to: latest.fork.weth,
            data: `${ERC20_BALANCE_OF}${wordAddress(expected)}`,
          },
          "latest",
        ],
      });
      if (typeof balance !== "string" || BigInt(balance) < input)
        throw new Error(
          "The wallet does not have enough WETH for this executable fill.",
        );
      const allowance = await provider.request({
        method: "eth_call",
        params: [
          {
            to: latest.fork.weth,
            data: `${ERC20_ALLOWANCE}${wordAddress(expected)}${wordAddress(latest.fork.router)}`,
          },
          "latest",
        ],
      });
      if (typeof allowance !== "string")
        throw new Error("The wallet allowance could not be read.");
      if (BigInt(allowance) < input) {
        setStatus("WETH allowance required for the reviewed fill");
        await sendForkTransaction(
          latest.fork,
          {
            chainId: latest.fork.chainId,
            to: latest.fork.weth,
            data: `${ERC20_APPROVE}${wordAddress(latest.fork.router)}${wordAmount(input)}`,
            value: "0",
          },
          expected,
          "WETH allowance",
        );
        assertVersion(version, walletRevision);
        provider = await validateWallet(latest.fork, expected);
      }
      assertVersion(version, walletRevision);
      setStatus("Awaiting wallet approval for the exact reviewed trade");
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
          "Source state changed after signing. Request a new quote.",
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
      setStatus("Prepared — signed and simulated, not submitted");
    } catch (requestError: unknown) {
      if (version === flowVersion.current) {
        setStage("failed");
        setError(friendlyError(requestError));
        setStatus("Signing or preparation failed — no trade was submitted");
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
        throw new Error(
          "The quote expired or source state changed. Request a new quote.",
        );
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
        setStatus("Submission failed or is still pending — no success claimed");
      }
    } finally {
      if (version === flowVersion.current) setBusy(false);
    }
  }

  async function checkLastReceipt() {
    if (!source?.fork) throw new Error("Fork state is unavailable.");
    const last = localStorage.getItem("aurka:fork:lastTransaction");
    if (!last)
      throw new Error("No saved wallet transaction exists in this browser.");
    setBusy(true);
    setError(null);
    try {
      const receipt = await waitForReceipt(source.fork, last);
      const refreshed = await loadSource(selectedSpaceId);
      setSource(refreshed);
      setTransactionHash(last);
      setConfirmed(receipt);
      setStage("confirmed");
      setStatus("Saved transaction confirmed — Space data refreshed");
    } catch (requestError: unknown) {
      setError(friendlyError(requestError));
      setStatus("Receipt check failed — no success claimed");
    } finally {
      setBusy(false);
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
        Loading trade source…
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
          The selected Space could not provide a current trading snapshot:{" "}
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
          {appMode === "fork"
            ? "Wallet trade · fork test funds"
            : "Local demo trade"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Trade
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          Select a Space, review the amount AURKA can fill under its current
          rules, then decide whether to continue. A quote is not a trade.
        </p>
      </header>

      {appMode === "fork" && source?.fork && (
        <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
          <strong>Ethereum fork · test funds only</strong>
          <p className="mt-1 text-amber-100/75">
            Chain {source.fork.chainId} · fork block {source.fork.forkBlock} ·
            {source.fork?.aquaKind === "REAL_AQUA"
              ? "Real Aqua and Chainlink prices are read from the pinned mainnet fork."
              : "Aqua and oracle prices are explicitly mocked for the fixture fork."}
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
              This is the organization-owned asset pool whose rules will be
              checked. Your wallet is the counterparty, not the Space owner.
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
                {candidate.identity.state.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        {selectedSpace && (
          <p className="text-xs text-cyan-100/70">
            Selected: {selectedSpace.identity.name} · Space state{" "}
            {selectedSpace.identity.state}
          </p>
        )}
      </section>

      {appMode === "fork" && <WalletStateMessage />}

      {!source || !pair ? (
        <section className="rounded-2xl border border-amber-800/70 bg-amber-950/30 p-5 text-amber-200">
          <h2 className="font-semibold text-white">
            No supported pair is available
          </h2>
          <p className="mt-2 text-sm leading-6">
            This Space needs the configured WETH → USDC assets and a fresh
            source snapshot before it can be traded.
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
                The displayed precision comes from the selected token metadata.
                Input with unsupported fractional precision is rejected; it is
                never rounded silently into a different signed trade.
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
                <option value={pair.key}>
                  {pair.input.symbol} → {pair.output.symbol}
                </option>
              </select>
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
                {pair.input.symbol} uses {pair.input.decimals} decimals. Balance
                and price evidence are read from the same{" "}
                {appMode === "fork" ? "fork" : "demo"} snapshot.
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
            Confirmed on the fork
          </h2>
          <p className="text-sm leading-6 text-emerald-100/80">
            The receipt is confirmed. Holdings and Activity were read again
            after settlement; no confirmation is claimed for a quote or pending
            receipt.
          </p>
          <p className="break-all text-xs text-emerald-100/70">
            Transaction {transactionHash || confirmed.hash} · block{" "}
            {confirmed.block} · gas {confirmed.gas}
          </p>
          <Link
            to={`/spaces/${encodeURIComponent(selectedSpaceId)}`}
            className="inline-flex min-h-10 items-center rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-600"
          >
            Return to Space
          </Link>
        </section>
      )}

      {appMode === "fork" && source?.fork && (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(checkLastReceipt)}
          className="text-sm text-cyan-300 underline underline-offset-4 disabled:opacity-50"
        >
          Check last local receipt
        </button>
      )}

      <details className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5">
        <summary className="flex cursor-pointer items-center gap-2 font-medium text-slate-200">
          <CircleHelp className="h-4 w-4 text-slate-400" aria-hidden="true" />
          Environment and technical details
        </summary>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          {appMode === "fork"
            ? (source?.fork?.mocks.join("; ") ??
              "Fork integration details unavailable.")
            : "Local demo mode calculates a quote only. Wallet execution is unavailable here; no funds, signature, or submitted trade is claimed."}
        </p>
      </details>
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
      ? "The Space snapshot or policy changed. Request a fresh quote before continuing."
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
          This review uses the selected Space snapshot. It is not signed,
          submitted, or confirmed until the wallet states say so.
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
          Full fill: the requested amount is executable under this snapshot.
          Settlement still rechecks the current policy and price commitments.
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
          value={`${formatValueAmount(result.quote.fees.totalFeeAmount, result.quote.currentPortfolio.valueDecimals)} normalized value units · ${feeToken}`}
        />
        <Summary
          label="Binding rule"
          value={bindingConstraintLabel(result.quote.bindingConstraint)}
        />
        <Summary
          label="Treasury retained"
          value={`${formatValueAmount(result.quote.fees.treasuryAmount, result.quote.currentPortfolio.valueDecimals)} normalized value units`}
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
        <p>
          <span className="text-slate-500">Fee rate: </span>
          {formatScaledBasisPoints(result.quote.fees.totalFeeBpsScaled)}
        </p>
        <p>
          <span className="text-slate-500">Fee legs: </span>
          solver{" "}
          {formatTokenAmount(
            result.solved.proposal.solverFeeAmount,
            outputAsset.decimals,
          )}{" "}
          {outputAsset.symbol} · protocol{" "}
          {formatTokenAmount(
            result.solved.proposal.protocolFeeAmount,
            outputAsset.decimals,
          )}{" "}
          {outputAsset.symbol}
        </p>
        <p>
          <span className="text-slate-500">Reference price: </span>
          {formatPrice(
            result.quote.referencePrice,
            result.quote.referencePriceDecimals,
          )}{" "}
          quote units per whole {outputAsset.symbol}
        </p>
        <p>
          <span className="text-slate-500">Snapshot: </span>
          block {result.quote.currentPortfolio.blockNumber} · observed{" "}
          {formatSnapshotAge(result.quote.currentPortfolio.observedAt, now)}
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
                Prepared — the exact intent is signed and simulated, but no
                settlement transaction has been submitted.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={onSubmit}
                className="min-h-11 rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
              >
                {stage === "submitting" ? "Submitting…" : "Submit exact trade"}
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
                ? "Reviewing and signing…"
                : "Review and sign exact trade"}
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
            Execution is unavailable in Local demo mode. No wallet signature,
            submission, or balance change is claimed.
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
          Technical quote details
        </summary>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          Raw token units, normalized accounting and commitments are retained
          for inspection; displayed symbols do not imply a USD denomination.
        </p>
        <pre className="mt-3 max-h-72 overflow-auto text-xs text-slate-400">
          {JSON.stringify(
            {
              intentHash: result.quote.intentHash,
              proposalHash: result.solved.proposalHash,
              capacityEpochId: result.quote.capacityEpochId,
              policyNonce: result.quote.policyNonce,
              simulation: result.solved.simulation,
            },
            null,
            2,
          )}
        </pre>
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
          Space holdings: before → expected after
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Normalized values use the quoted snapshot denomination. The actual
          balances change only after a confirmed settlement.
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
