import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  bindingConstraintLabel,
  findPortfolioAsset,
  formatBasisPoints,
  formatDecimalUnits,
  formatPrice,
  formatScaledBasisPoints,
  formatSnapshotAge,
  formatTokenAmount,
  formatValueAmount,
  parseTokenAmount,
  type AtomicSettlementIntent,
  type AssetSnapshot,
  type PortfolioSnapshot,
  type Position,
  type Quote,
} from "@aurka/shared";
import { CircleHelp, ShieldCheck } from "lucide-react";
import { appLinks } from "../config";

const client = new AurkaClient({ baseUrl: "/api" });
const DEMO_TRADER = "0x4444444444444444444444444444444444444444";
const emptyForm = {
  positionId: "",
  trader: "",
  traderInputToken: "",
  traderOutputToken: "",
  requestedValue: "",
  minimumTraderOutputValue: "0",
  nonce: "0",
};

interface TradeProps {
  readonly advanced?: boolean;
}

interface SwapPair {
  readonly input: AssetSnapshot;
  readonly output: AssetSnapshot;
}

interface GuidedForm {
  readonly inputToken: string;
  readonly outputToken: string;
  readonly amount: string;
}

interface GuidedQuoteResult {
  readonly intent: AtomicSettlementIntent;
  readonly quote: Quote;
  readonly solved: Awaited<ReturnType<AurkaClient["solve"]>>;
  readonly requestedInputAmount: string;
}

function demoSwapPair(position: Position | undefined): SwapPair | undefined {
  const assets = position?.currentPortfolio?.assets ?? [];
  const input = assets.find((asset) => asset.symbol.toUpperCase() === "WETH");
  const output = assets.find(
    (asset) =>
      asset.symbol.toUpperCase() === "USDC" &&
      asset.token.toLowerCase() !== input?.token.toLowerCase(),
  );
  return input && output ? { input, output } : undefined;
}

function constraintExplanation(constraint: string): string {
  const explanations: Record<string, string> = {
    TRANSACTION_CAP: "the source’s per-trade limit",
    AVAILABLE_BALANCE: "the source’s available balance",
    CAPACITY_EXHAUSTED: "the remaining directional capacity",
    MINIMUM_WEIGHT: "the minimum allocation rule",
    MAXIMUM_WEIGHT: "the maximum allocation rule",
    RISK_LIMIT: "the current risk limit",
    FEE_EXCEEDS_OUTPUT: "the fee relative to the output",
    PAUSED: "a paused asset rule",
    REQUESTED_AMOUNT: "your requested amount",
    NONE: "no additional limiting rule",
  };
  return explanations[constraint] ?? bindingConstraintLabel(constraint);
}

export default function Trade({ advanced = false }: TradeProps) {
  return advanced ? <AdvancedTrade /> : <GuidedSwap />;
}

function GuidedSwap() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [form, setForm] = useState<GuidedForm>({
    inputToken: "",
    outputToken: "",
    amount: "200000",
  });
  const [result, setResult] = useState<GuidedQuoteResult | null>(null);
  const [prepared, setPrepared] = useState<Awaited<
    ReturnType<AurkaClient["execute"]>
  > | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [quoteNow, setQuoteNow] = useState(() => Math.floor(Date.now() / 1000));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    let active = true;
    setSourceLoading(true);
    setSourceError(null);
    client
      .listPositions(20)
      .then((response) => {
        if (!active) return;
        setPositions(response.items);
        setSelectedPositionId((current) =>
          response.items.some((position) => position.id === current)
            ? current
            : (response.items[0]?.id ?? ""),
        );
      })
      .catch((requestError: unknown) => {
        if (active)
          setSourceError(
            requestError instanceof Error
              ? requestError.message
              : "The liquidity source could not be loaded",
          );
      })
      .finally(() => {
        if (active) setSourceLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const position = positions.find(
    (candidate) => candidate.id === selectedPositionId,
  );
  const pair = demoSwapPair(position);
  const inputAsset = pair?.input;
  const outputAsset = pair?.output;
  const quoteExpired = result !== null && result.quote.expiresAt <= quoteNow;

  useEffect(() => {
    if (!pair) return;
    setForm((current) => {
      if (
        current.inputToken === pair.input.token &&
        current.outputToken === pair.output.token
      )
        return current;
      return {
        ...current,
        inputToken: pair.input.token,
        outputToken: pair.output.token,
      };
    });
  }, [pair?.input.token, pair?.output.token]);

  useEffect(() => {
    if (!result) return;
    setQuoteNow(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(
      () => setQuoteNow(Math.floor(Date.now() / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [result]);

  useEffect(() => {
    if (quoteExpired) {
      setPrepared(null);
      setReviewed(false);
    }
  }, [quoteExpired]);

  function invalidateQuote() {
    requestVersion.current += 1;
    setResult(null);
    setPrepared(null);
    setReviewed(false);
  }

  function updateForm(key: keyof GuidedForm, value: string) {
    invalidateQuote();
    setError(null);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function selectSource(positionId: string) {
    invalidateQuote();
    setError(null);
    setSelectedPositionId(positionId);
  }

  async function getQuote() {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setPrepared(null);
    setReviewed(false);
    try {
      if (!position || !pair || !position.currentPortfolio)
        throw new Error("This liquidity source has no current token snapshot");
      if (
        form.inputToken.toLowerCase() !== pair.input.token.toLowerCase() ||
        form.outputToken.toLowerCase() !== pair.output.token.toLowerCase()
      )
        throw new Error(
          "That token direction is not offered by this demo source",
        );
      const requestedInputAmount = parseTokenAmount(
        form.amount.trim(),
        pair.input.decimals,
      );
      if (requestedInputAmount === 0n)
        throw new Error("Enter an amount greater than zero");
      const intent = await client.prepareIntentFromTokenAmount({
        positionId: position.id,
        trader: DEMO_TRADER,
        traderInputToken: pair.input.token,
        traderOutputToken: pair.output.token,
        requestedTraderInputAmount: requestedInputAmount.toString(),
        minimumTraderOutputValue: "0",
        nonce: "0",
        deadline: Math.floor(Date.now() / 1000) + 300,
      });
      const quote = await client.quote(intent);
      const solved = await client.solve(intent);
      if (version === requestVersion.current)
        setResult({
          intent,
          quote,
          solved,
          requestedInputAmount: requestedInputAmount.toString(),
        });
    } catch (requestError: unknown) {
      if (version === requestVersion.current)
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Quote request failed",
        );
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  async function preparePreview() {
    if (!result || quoteExpired || !reviewed) return;
    const version = requestVersion.current;
    setPreparing(true);
    setError(null);
    try {
      const idempotencyKey = `demo-execute:${result.intent.intentId}`;
      const transaction = await client.execute(
        result.quote.intentHash,
        result.solved.proposalHash,
        undefined,
        idempotencyKey,
      );
      if (version === requestVersion.current) setPrepared(transaction);
    } catch (requestError: unknown) {
      if (version === requestVersion.current)
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unsigned preparation failed",
        );
    } finally {
      if (version === requestVersion.current) setPreparing(false);
    }
  }

  if (sourceLoading) {
    return (
      <div
        className="flex min-h-64 items-center justify-center text-slate-400"
        aria-live="polite"
      >
        Loading demo liquidity source…
      </div>
    );
  }

  if (sourceError) {
    return (
      <section
        className="mx-auto max-w-3xl space-y-5 text-slate-200"
        role="alert"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Local demo swap
        </p>
        <h1 className="text-3xl font-semibold text-white">Try a swap</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          A demo quote is unavailable because the liquidity source could not be
          loaded: {sourceError}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
        >
          Try again
        </button>
      </section>
    );
  }

  if (!position || !pair || !inputAsset || !outputAsset) {
    return (
      <section className="mx-auto max-w-3xl space-y-5 text-slate-200">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Local demo swap
        </p>
        <h1 className="text-3xl font-semibold text-white">Try a swap</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          No supported demo pair with current token metadata is available. Open
          the{" "}
          <a
            href={`${appLinks.treasury.replace(/\/+$/, "")}/holdings`}
            className="underline underline-offset-4"
          >
            treasury holdings page
          </a>{" "}
          to inspect another configured source.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6 text-slate-200">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Local demo swap
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          Try a swap
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-300">
          Choose what you pay and what you receive. AURKA will check the
          organization’s current rules and show a quote before any wallet
          authorization is possible.
        </p>
      </div>

      <section className="rounded-2xl border border-cyan-900/70 bg-cyan-950/30 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-cyan-100">
              Using {position.name}
            </p>
            <p className="mt-1 text-sm leading-6 text-cyan-100/75">
              This organization-owned liquidity source currently offers the{" "}
              {inputAsset.symbol} → {outputAsset.symbol} demo direction. Its
              balances and prices come from the read-only service snapshot.
            </p>
          </div>
        </div>
        {positions.length > 1 && (
          <label className="mt-4 block text-sm">
            <span className="font-medium text-slate-200">Liquidity source</span>
            <select
              aria-label="Liquidity source"
              value={selectedPositionId}
              onChange={(event) => selectSource(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-cyan-800 bg-slate-900 p-2.5 text-slate-100"
            >
              {positions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <form
        className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900/70 p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void getQuote();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-slate-200">You pay</span>
            <select
              aria-label="You pay token"
              value={form.inputToken}
              onChange={(event) => updateForm("inputToken", event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-slate-100"
            >
              <option value={inputAsset.token}>{inputAsset.symbol}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              {inputAsset.symbol} uses {inputAsset.decimals} decimal places in
              this source snapshot.
            </span>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-200">You receive</span>
            <select
              aria-label="You receive token"
              value={form.outputToken}
              onChange={(event) =>
                updateForm("outputToken", event.target.value)
              }
              className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-slate-100"
            >
              <option value={outputAsset.token}>{outputAsset.symbol}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              Only directions offered by the selected source are selectable.
            </span>
          </label>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-slate-200">Amount to pay</span>
          <div className="mt-1 flex items-center rounded-lg border border-slate-700 bg-slate-800 focus-within:border-cyan-500">
            <input
              required
              inputMode="decimal"
              autoComplete="off"
              aria-label="Amount to pay"
              value={form.amount}
              onChange={(event) => updateForm("amount", event.target.value)}
              placeholder="0"
              className="min-w-0 flex-1 bg-transparent p-2.5 text-slate-100 outline-none"
            />
            <span className="px-3 text-sm text-slate-400">
              {inputAsset.symbol}
            </span>
          </div>
          <span className="mt-1 block text-xs leading-5 text-slate-500">
            Enter a token amount. The service converts it to settlement value
            using this snapshot’s declared price and decimals; the UI does not
            invent an exchange rate or check a personal wallet balance.
          </span>
        </label>
        <button
          type="submit"
          disabled={loading || !form.amount.trim()}
          className="rounded-lg bg-cyan-600 px-5 py-3 font-medium text-white transition hover:bg-cyan-500"
        >
          {loading ? "Getting quote…" : "Get quote"}
        </button>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-900/70 bg-red-950/40 p-4 text-red-200"
        >
          {error} Enter a new amount or try again; your form input is still
          here.
        </p>
      )}

      {result && (
        <GuidedQuoteReview
          result={result}
          inputAsset={inputAsset}
          outputAsset={outputAsset}
          nowSeconds={quoteNow}
          expired={quoteExpired}
          reviewed={reviewed}
          prepared={prepared}
          preparing={preparing}
          onReviewed={setReviewed}
          onPrepare={() => void preparePreview()}
          onRefresh={() => void getQuote()}
        />
      )}

      <details className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5">
        <summary className="flex cursor-pointer items-center gap-2 font-medium text-slate-200">
          <CircleHelp className="h-4 w-4 text-slate-400" aria-hidden="true" />
          About this demo
        </summary>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          No wallet is connected, no private key is in the browser, and this
          page cannot broadcast a transaction. A public fixture address is used
          only to make deterministic demo commitments; it is not presented as
          your wallet. The optional unsigned preview is a developer artifact,
          not a submitted or confirmed swap.
        </p>
      </details>
    </section>
  );
}

function GuidedQuoteReview({
  result,
  inputAsset,
  outputAsset,
  nowSeconds,
  expired,
  reviewed,
  prepared,
  preparing,
  onReviewed,
  onPrepare,
  onRefresh,
}: {
  readonly result: GuidedQuoteResult;
  readonly inputAsset: AssetSnapshot;
  readonly outputAsset: AssetSnapshot;
  readonly nowSeconds: number;
  readonly expired: boolean;
  readonly reviewed: boolean;
  readonly prepared: Awaited<ReturnType<AurkaClient["execute"]>> | null;
  readonly preparing: boolean;
  readonly onReviewed: (value: boolean) => void;
  readonly onPrepare: () => void;
  readonly onRefresh: () => void;
}) {
  const executable = BigInt(result.solved.proposal.traderInputAmount);
  const requested = BigInt(result.requestedInputAmount);
  const remaining = requested > executable ? requested - executable : 0n;
  const partial = executable < requested;
  const feeAsset = findPortfolioAsset(
    result.quote.currentPortfolio,
    result.quote.fees.feeToken,
  );
  return (
    <section
      aria-labelledby="swap-review-heading"
      aria-live="polite"
      className="space-y-5 rounded-2xl border border-cyan-800/70 bg-slate-900 p-5 sm:p-6"
    >
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          {expired ? "Quote expired" : "Quote ready"}
        </p>
        <h2
          id="swap-review-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Review what would happen
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          This is a local-demo quote from the selected liquidity source. It is
          not signed, submitted, confirmed, or a claim that funds moved.
        </p>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Summary
          label="You pay (requested)"
          value={`${formatTokenAmount(result.requestedInputAmount, inputAsset.decimals)} ${inputAsset.symbol}`}
        />
        <Summary
          label="You pay (executable now)"
          value={`${formatTokenAmount(result.solved.proposal.traderInputAmount, inputAsset.decimals)} ${inputAsset.symbol}`}
        />
        <Summary
          label="You receive (expected)"
          value={`${formatTokenAmount(result.solved.proposal.traderOutputAmount, outputAsset.decimals)} ${outputAsset.symbol}`}
        />
        <Summary
          label="Fee"
          value={`${formatValueAmount(result.quote.fees.totalFeeAmount, result.quote.currentPortfolio.valueDecimals)} normalized settlement value units`}
        />
      </div>

      {partial && (
        <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-100">
          <h3 className="font-semibold">Partial fill</h3>
          <p className="mt-1">
            You asked to exchange{" "}
            {formatTokenAmount(
              result.requestedInputAmount,
              inputAsset.decimals,
            )}{" "}
            {inputAsset.symbol}. This source can execute{" "}
            {formatTokenAmount(
              result.solved.proposal.traderInputAmount,
              inputAsset.decimals,
            )}{" "}
            {inputAsset.symbol} now. The remaining{" "}
            {formatTokenAmount(remaining, inputAsset.decimals)}{" "}
            {inputAsset.symbol} is not included in this quote because of{" "}
            {constraintExplanation(result.quote.bindingConstraint)}.
          </p>
          <p className="mt-2 text-amber-200/80">
            Executable value:{" "}
            {formatValueAmount(
              result.quote.executableTraderInputAmount,
              result.quote.currentPortfolio.valueDecimals,
            )}{" "}
            settlement value units; source maximum under current rules:{" "}
            {formatValueAmount(
              result.quote.maximumSafeTraderInputAmount,
              result.quote.currentPortfolio.valueDecimals,
            )}{" "}
            settlement value units.
          </p>
        </div>
      )}

      {!partial && (
        <p className="rounded-xl border border-emerald-900/70 bg-emerald-950/30 p-4 text-sm leading-6 text-emerald-100">
          The full requested amount is executable under the current source
          snapshot. The quote is still subject to expiry and a later settlement
          check.
        </p>
      )}

      <div className="grid gap-2 rounded-xl border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300 sm:grid-cols-2">
        <p>
          <span className="text-slate-500">Limiting rule: </span>
          {bindingConstraintLabel(result.quote.bindingConstraint)}
        </p>
        <p>
          <span className="text-slate-500">Fee rate: </span>
          {formatScaledBasisPoints(result.quote.fees.totalFeeBpsScaled)}
        </p>
        <p>
          <span className="text-slate-500">Fee accounting: </span>
          {feeAsset?.symbol ?? "Output token"} output leg; fee value remains
          normalized settlement units, not a raw token quantity.
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
          {formatSnapshotAge(
            result.quote.currentPortfolio.observedAt,
            nowSeconds,
          )}
        </p>
        <p className={expired ? "text-amber-300" : "text-slate-300"}>
          <span className="text-slate-500">Expires: </span>
          {expired
            ? "Expired — refresh before preparing anything"
            : `${Math.max(0, result.quote.expiresAt - nowSeconds)}s remaining`}
        </p>
      </div>

      <PortfolioPreview
        before={result.quote.currentPortfolio}
        after={result.quote.expectedPostTradePortfolio}
      />

      <label className="flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4 text-sm leading-6 text-slate-300">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={expired}
          onChange={(event) => onReviewed(event.target.checked)}
          className="mt-1 h-4 w-4 accent-cyan-500"
        />
        <span>
          I reviewed the executable amount, expected receive amount, fee and
          limiting rule. I understand this is a preview, not a completed swap.
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!reviewed || expired || preparing}
          onClick={onPrepare}
          className="rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white transition hover:bg-cyan-500"
        >
          {preparing
            ? "Preparing unsigned preview…"
            : "Prepare unsigned preview"}
        </button>
        <button
          type="button"
          disabled={preparing}
          onClick={onRefresh}
          className="rounded-lg border border-slate-600 px-4 py-3 font-medium text-slate-200 hover:border-cyan-500"
        >
          Refresh quote
        </button>
      </div>

      {prepared && !expired && (
        <section className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4">
          <h3 className="font-semibold text-amber-100">
            Prepared — unsigned, not submitted
          </h3>
          <p className="mt-1 text-sm leading-6 text-amber-100/80">
            The service prepared calldata for the reviewed intent. No wallet
            signed it, no transaction was broadcast, and no funds moved.
          </p>
          <Link
            to="/activity"
            className="mt-3 inline-flex rounded-lg border border-amber-700 px-3 py-2 text-sm font-medium text-amber-100 hover:border-amber-400"
          >
            View this preparation in activity
          </Link>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-amber-100">
              Show transaction request
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto text-xs text-amber-100/70">
              {JSON.stringify(prepared.transactionRequest, null, 2)}
            </pre>
          </details>
        </section>
      )}

      <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
        <summary className="cursor-pointer font-medium text-slate-200">
          Technical quote details
        </summary>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          These identifiers help developers inspect the exact snapshot and
          commitments. They are managed internally for this demo.
        </p>
        <pre className="mt-3 max-h-72 overflow-auto text-xs text-slate-400">
          {JSON.stringify(
            {
              intentHash: result.quote.intentHash,
              proposalHash: result.solved.proposalHash,
              positionId: result.quote.currentPortfolio.positionId,
              capacityEpochId: result.quote.capacityEpochId,
              policyNonce: result.quote.policyNonce,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}

function AdvancedTrade() {
  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState<{
    intent: AtomicSettlementIntent;
    quote: Quote;
    solved: Awaited<ReturnType<AurkaClient["solve"]>>;
  } | null>(null);
  const [transaction, setTransaction] = useState<Awaited<
    ReturnType<AurkaClient["execute"]>
  > | null>(null);
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);
  const executionRequestKey = useRef<string | null>(null);
  const inputAsset = result
    ? findPortfolioAsset(
        result.quote.currentPortfolio,
        result.intent.traderInputToken,
      )
    : undefined;
  const outputAsset = result
    ? findPortfolioAsset(
        result.quote.currentPortfolio,
        result.intent.traderOutputToken,
      )
    : undefined;
  const feeAsset = result
    ? findPortfolioAsset(
        result.quote.currentPortfolio,
        result.quote.fees.feeToken,
      )
    : undefined;
  const labels: Record<keyof typeof form, string> = {
    positionId: "Position ID",
    trader: "Trader address",
    traderInputToken: "Input token address",
    traderOutputToken: "Output token address",
    requestedValue: "Requested value (settlement units)",
    minimumTraderOutputValue: "Minimum output value (settlement units)",
    nonce: "Intent nonce",
  };
  async function getQuote() {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setTransaction(null);
    setSignature("");
    executionRequestKey.current = null;
    try {
      const intent = await client.prepareIntent({
        ...form,
        deadline: Math.floor(Date.now() / 1000) + 300,
      });
      const quote = await client.quote(intent);
      const solved = await client.solve(intent);
      if (version === requestVersion.current)
        setResult({ intent, quote, solved });
    } catch (error) {
      if (version === requestVersion.current)
        setError(error instanceof Error ? error.message : "Quote failed");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  function updateForm(key: keyof typeof form, value: string) {
    requestVersion.current += 1;
    setForm((current) => ({ ...current, [key]: value }));
    setResult(null);
    setTransaction(null);
    setSignature("");
    executionRequestKey.current = null;
  }

  const fields = (Object.keys(form) as (keyof typeof form)[]).map((key) => (
    <label className="block" key={key}>
      {labels[key]}
      <input
        required
        className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-slate-100"
        value={form[key]}
        onChange={(event) => updateForm(key, event.target.value)}
      />
    </label>
  ));

  const quoteResult = result ? (
    <section
      aria-live="polite"
      className="space-y-4 rounded-2xl border border-cyan-800/70 bg-slate-900 p-5 sm:p-6"
    >
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Quote ready
        </p>
        <h3 className="mt-2 text-xl font-semibold text-white">
          Review this local-demo result
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          This is a quote and preparation preview. It is not signed, submitted,
          confirmed, or a claim that funds moved.
        </p>
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Summary
          label="You provide"
          value={formatProposalTokenAmount(
            result!.solved.proposal.traderInputAmount,
            inputAsset,
          )}
        />
        <Summary
          label="You receive (before any wallet action)"
          value={formatProposalTokenAmount(
            result!.solved.proposal.traderOutputAmount,
            outputAsset,
          )}
        />
        <Summary
          label="Executable value"
          value={`${formatValueAmount(
            result!.quote.executableTraderInputAmount,
            result!.quote.currentPortfolio.valueDecimals,
          )} settlement value units`}
        />
        <Summary
          label="Total fee"
          value={`${formatValueAmount(
            result!.quote.fees.totalFeeAmount,
            result!.quote.currentPortfolio.valueDecimals,
          )} settlement value units (${feeAsset?.symbol ?? "fee token"})`}
        />
        <Summary
          label="Treasury fee retained"
          value={`${formatValueAmount(
            result!.quote.fees.treasuryAmount,
            result!.quote.currentPortfolio.valueDecimals,
          )} settlement value units`}
        />
        <Summary
          label="Limiting rule"
          value={bindingConstraintLabel(result!.quote.bindingConstraint)}
        />
        <Summary
          label="Preparation state"
          value={result!.solved.simulation.status.replace("_", " ")}
        />
      </div>
      <div className="grid gap-2 rounded-xl border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300 sm:grid-cols-2">
        <p>
          <span className="text-slate-500">Reference price: </span>
          {formatDecimalUnits(
            result!.quote.referencePrice,
            result!.quote.referencePriceDecimals,
          )}{" "}
          quote units per whole {outputAsset?.symbol ?? "output token"}
        </p>
        <p>
          <span className="text-slate-500">Fee rate: </span>
          {formatScaledBasisPoints(
            result!.quote.fees.totalFeeBpsScaled,
          )} (base {formatBasisPoints(result!.quote.fees.baseFeeBps)})
        </p>
        <p>
          <span className="text-slate-500">Snapshot: </span>
          block {result!.quote.currentPortfolio.blockNumber} · observed{" "}
          {formatSnapshotAge(
            result!.quote.currentPortfolio.observedAt,
            Math.floor(Date.now() / 1000),
          )}
        </p>
        <p
          className={
            result!.quote.expiresAt <= Math.floor(Date.now() / 1000)
              ? "text-amber-300"
              : undefined
          }
        >
          <span className="text-slate-500">Quote expiry: </span>
          {result!.quote.expiresAt <= Math.floor(Date.now() / 1000)
            ? "Expired — request a new quote"
            : new Date(result!.quote.expiresAt * 1000).toLocaleString()}
        </p>
      </div>
      <PortfolioPreview
        before={result!.quote.currentPortfolio}
        after={result!.quote.expectedPostTradePortfolio}
      />
      <p className="text-sm text-amber-200">
        This preview uses the service’s authoritative calculation and matching
        snapshot. It is not a completed trade; the portfolio changes only after
        an actual settlement.
      </p>
      <details className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
        <summary className="cursor-pointer font-medium text-slate-200">
          Intent to authorize
        </summary>
        <pre className="mt-3 max-h-72 overflow-auto text-xs text-slate-400">
          {JSON.stringify(result!.intent, null, 2)}
        </pre>
      </details>
      <label className="block text-sm text-slate-300">
        Trader intent signature
        <input
          className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-slate-100"
          value={signature}
          onChange={(event) => {
            setSignature(event.target.value);
            setTransaction(null);
            executionRequestKey.current = null;
          }}
          placeholder="0x… (advanced developer testing only)"
        />
      </label>
      <button
        disabled={
          loading ||
          !signature ||
          result!.quote.expiresAt <= Math.floor(Date.now() / 1000)
        }
        onClick={() => void prepareTransaction()}
        className="rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white transition hover:bg-cyan-500"
      >
        Prepare transaction
      </button>
    </section>
  ) : null;

  async function prepareTransaction() {
    if (!result) return;
    setLoading(true);
    setError(null);
    try {
      setTransaction(
        await client.execute(
          result.quote.intentHash,
          result.solved.proposalHash,
          signature || undefined,
          (executionRequestKey.current ??= `execute:${result.intent.intentId}`),
        ),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Transaction preparation failed",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="max-w-2xl space-y-5 text-slate-200">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
        Developer preparation
      </p>
      <h1 className="text-3xl font-semibold text-white">Trade</h1>
      <p className="leading-7 text-slate-300">
        Request a quote for an existing position. Partial fills are allowed.
        Wallet submission is not connected. For the guided path, use{" "}
        <a href="/swap" className="text-cyan-300 underline underline-offset-4">
          Try a swap
        </a>
        .
      </p>
      <form
        className="space-y-3 rounded-2xl border border-slate-700 bg-slate-900/70 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void getQuote();
        }}
      >
        {fields}
        <button
          disabled={loading}
          className="rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white"
        >
          {loading ? "Working…" : "Get quote"}
        </button>
      </form>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-900/70 bg-red-950/40 p-4 text-red-200"
        >
          {error}
        </p>
      )}
      {result && quoteResult}
      {transaction && (
        <section className="rounded-2xl border border-amber-800/70 bg-amber-950/30 p-5">
          <h3>Unsigned transaction — not broadcast</h3>
          <pre className="mt-3 max-h-80 overflow-auto text-xs text-amber-100/70">
            {JSON.stringify(transaction.transactionRequest, null, 2)}
          </pre>
        </section>
      )}
    </div>
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
      <p className="text-slate-500">{label}</p>
      <p className="mt-1 break-words font-medium text-slate-100">{value}</p>
    </div>
  );
}

function formatProposalTokenAmount(
  amount: string,
  asset: ReturnType<typeof findPortfolioAsset>,
): string {
  if (!asset) return `${amount} raw token units (metadata unavailable)`;
  return `${formatTokenAmount(amount, asset.decimals)} ${asset.symbol}`;
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
        <h4 className="font-medium text-slate-100">
          Treasury before → expected after
        </h4>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Values are normalized settlement units at the quoted snapshot; token
          symbols do not establish a USD denomination.
        </p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">
            Portfolio value and allocation changes
          </caption>
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-4">Asset</th>
              <th className="py-2 pr-4">Before</th>
              <th className="py-2 pr-4">After</th>
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
