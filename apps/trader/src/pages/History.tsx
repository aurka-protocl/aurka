import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  formatValueAmount,
  type ActivityItem,
  type Execution,
} from "@aurka/shared";

const STATUS_LABELS: Record<ActivityItem["status"], string> = {
  PREPARED: "Prepared · unsigned, not submitted",
  PENDING: "Pending · submitted, awaiting receipt",
  CONFIRMED: "Confirmed on chain",
  FAILED: "Failed",
  ORPHANED: "Orphaned by a chain reorganization",
};

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function ActivityCard({ item }: { readonly item: ActivityItem }) {
  const statusClass =
    item.status === "CONFIRMED"
      ? "text-emerald-300"
      : item.status === "ORPHANED" || item.status === "FAILED"
        ? "text-amber-300"
        : "text-cyan-300";
  return (
    <article className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-white">
            {item.traderInputSymbol ?? shortHash(item.traderInputToken)} →{" "}
            {item.traderOutputSymbol ?? shortHash(item.traderOutputToken)}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {new Date(
              (item.occurredAt ?? item.submittedAt) * 1000,
            ).toLocaleString()}
          </p>
        </div>
        <span className={`text-sm font-medium ${statusClass}`}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Requested value</dt>
          <dd className="text-slate-200">
            {item.requestedTraderInputValue} settlement value units
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Executed value</dt>
          <dd className="text-slate-200">
            {item.executedTraderInputValue === undefined
              ? "Not available"
              : `${item.executedTraderInputValue} settlement value units`}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Fee record</dt>
          <dd className="text-slate-200">
            {item.feeState === "EARNED" && item.earnedFee
              ? `${item.earnedFee.treasuryAmount} settlement value units retained by treasury`
              : item.feeState === "ESTIMATE" && item.estimatedFees
                ? `${formatValueAmount(
                    item.estimatedFees.treasuryAmount,
                    item.initialPortfolio?.valueDecimals ?? 0,
                  )} estimated value units · not earned`
                : item.status === "ORPHANED"
                  ? "Not counted as earned revenue"
                  : "No fee evidence recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Evidence</dt>
          <dd className="text-slate-200">
            {item.source === "CHAIN_EVENT"
              ? `Router events · block ${item.blockNumber ?? "unavailable"}`
              : "Service preparation record"}
          </dd>
        </div>
      </dl>

      {item.status === "ORPHANED" && (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          This event was removed from the canonical chain. It remains visible
          for audit context, but contributes zero to earned-fee totals.
        </p>
      )}

      <details className="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
        <summary className="cursor-pointer text-sm text-slate-300">
          Technical evidence
        </summary>
        <dl className="mt-3 space-y-2 break-all text-xs text-slate-500">
          <div>
            <dt className="inline text-slate-400">Activity ID: </dt>
            <dd className="inline">{item.id}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">
              {item.source === "CHAIN_EVENT"
                ? "Transaction hash: "
                : "Preparation ID: "}
            </dt>
            <dd className="inline">{item.transactionHash}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">Intent: </dt>
            <dd className="inline">{item.intentHash}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">Proposal: </dt>
            <dd className="inline">{item.proposalHash}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

export default function History() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hash, setHash] = useState("");
  const [execution, setExecution] = useState<Execution | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setActivityError(null);
    new AurkaClient({ baseUrl: "/api" })
      .listActivity({ limit: 20, cursor })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (active)
          setActivityError(
            error instanceof Error ? error.message : "Activity unavailable",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cursor]);

  async function lookup() {
    setLookupLoading(true);
    setLookupError(null);
    setExecution(null);
    try {
      setExecution(
        await new AurkaClient({ baseUrl: "/api" }).getExecution(hash),
      );
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  }

  return (
    <section className="space-y-6 text-slate-200">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Trader records
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">
          Swap activity
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          Browse local preparation records and canonical settlement evidence.
          Preparing an unsigned transaction is not a completed trade, and a
          quote fee is not earned revenue.
        </p>
      </div>

      {loading ? (
        <p aria-live="polite" className="text-slate-400">
          Loading activity…
        </p>
      ) : activityError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-900/70 bg-red-950/40 p-4 text-red-200"
        >
          Activity is unavailable: {activityError}
        </p>
      ) : items.length === 0 ? (
        <section className="rounded-2xl border border-slate-700 bg-slate-900 p-6">
          <h2 className="text-lg font-semibold text-white">No activity yet</h2>
          <p className="mt-2 max-w-2xl leading-7 text-slate-400">
            A quote alone does not create a settlement record or earned fee. Try
            the local swap flow to create an unsigned preparation, or return
            after a canonical settlement is indexed.
          </p>
          <Link
            to="/swap"
            className="mt-5 inline-flex rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white hover:bg-cyan-500"
          >
            Try a swap
          </Link>
        </section>
      ) : (
        <>
          <div className="space-y-4">
            {items.map((item) => (
              <ActivityCard key={item.id} item={item} />
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={!cursor}
              onClick={() => setCursor(undefined)}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm disabled:opacity-40"
            >
              First page
            </button>
            <button
              type="button"
              disabled={!nextCursor}
              onClick={() => setCursor(nextCursor ?? undefined)}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm disabled:opacity-40"
            >
              Next page
            </button>
          </div>
        </>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
        <h2 className="font-semibold text-white">Find a preparation by ID</h2>
        <p className="mt-1 text-sm text-slate-400">
          Hash lookup is a secondary developer tool; it does not replace the
          activity feed.
        </p>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          <label className="block min-w-0 flex-1">
            <span className="text-sm text-slate-300">Execution hash</span>
            <input
              required
              pattern="0x[0-9a-fA-F]{64}"
              className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-slate-100"
              value={hash}
              onChange={(event) => setHash(event.target.value)}
            />
          </label>
          <button
            disabled={lookupLoading}
            className="rounded-lg bg-slate-700 px-4 py-2.5 font-medium text-white"
          >
            {lookupLoading ? "Loading…" : "Look up"}
          </button>
        </form>
        {lookupError && (
          <p role="alert" className="mt-3 text-sm text-red-300">
            {lookupError}
          </p>
        )}
        {execution && (
          <p className="mt-4 text-sm text-slate-300">
            Preparation status:{" "}
            <span className="font-medium text-white">{execution.status}</span>
            {execution.revertReason ? ` · ${execution.revertReason}` : ""}
          </p>
        )}
      </section>
    </section>
  );
}
