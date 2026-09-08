import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import type { ActivityItem, FeeSummary, Position } from "@aurka/shared";

const STATUS_LABELS: Record<ActivityItem["status"], string> = {
  PREPARED: "Prepared · unsigned, not submitted",
  PENDING: "Pending · submitted, awaiting receipt",
  CONFIRMED: "Confirmed on chain",
  FAILED: "Failed",
  ORPHANED: "Orphaned by a chain reorganization",
};

function ActivityRow({ item }: { readonly item: ActivityItem }) {
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
          <h2 className="text-lg font-semibold text-white">
            {item.traderInputSymbol ?? "Input token"} →{" "}
            {item.traderOutputSymbol ?? "Output token"}
          </h2>
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
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Executed value</dt>
          <dd className="text-slate-200">
            {item.executedTraderInputValue ?? "Not available"} settlement value
            units
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Treasury fee</dt>
          <dd className="text-slate-200">
            {item.earnedFee
              ? `${item.earnedFee.treasuryAmount} settlement value units · confirmed`
              : item.estimatedFees
                ? "Estimate only · not earned"
                : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Evidence</dt>
          <dd className="text-slate-200">
            {item.source === "CHAIN_EVENT"
              ? `Block ${item.blockNumber ?? "unavailable"}`
              : "Service preparation"}
          </dd>
        </div>
      </dl>
      {item.status === "ORPHANED" && (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          Removed from the canonical chain; excluded from earned-fee totals.
        </p>
      )}
      <details className="mt-4 text-xs text-slate-500">
        <summary className="cursor-pointer text-sm text-slate-300">
          Technical evidence
        </summary>
        <p className="mt-2 break-all">
          Activity {item.id} · transaction/preparation {item.transactionHash}
        </p>
      </details>
    </article>
  );
}

function FeePanel({ summary }: { readonly summary: FeeSummary | null }) {
  if (!summary) return null;
  return (
    <section className="rounded-2xl border border-violet-900/70 bg-violet-950/30 p-5 sm:p-6">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300">
        Earned fees
      </p>
      <h2 className="mt-2 text-xl font-semibold text-white">
        Confirmed treasury fee shares
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-300">
        Only paired, canonical settlement events count. Amounts are normalized
        settlement value units and are kept separate by fee token; they are not
        presented as dollars or added across unlike tokens.
      </p>
      {summary.items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-sm text-slate-400">
          No confirmed settlement fee evidence is available for this treasury.
          Quotes and unsigned preparations contribute zero earned fees.
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {summary.items.map((item) => (
            <div
              key={item.feeToken}
              className="rounded-xl border border-slate-700 bg-slate-950/60 p-4"
            >
              <p className="font-medium text-white">
                {item.feeTokenSymbol ?? "Fee token"}
              </p>
              <p className="mt-2 text-2xl font-semibold text-violet-200">
                {item.treasuryAmount} value units
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Retained by treasury · {item.settlementCount} confirmed
                settlement
                {item.settlementCount === 1 ? "" : "s"}
              </p>
              <p className="mt-3 break-all text-xs text-slate-500">
                {item.feeToken}
              </p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">
        Coverage:{" "}
        {summary.coveredFrom === null
          ? "none"
          : `${summary.coveredFrom}–${summary.coveredTo}`}{" "}
        · {summary.confirmedSettlementCount} qualifying settlement event pair
        {summary.confirmedSettlementCount === 1 ? "" : "s"}
      </p>
    </section>
  );
}

export default function Executions() {
  const [position, setPosition] = useState<Position | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [summary, setSummary] = useState<FeeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const client = new AurkaClient({ baseUrl: "/api" });
    Promise.all([client.listPositions(1), client.listActivity({ limit: 20 })])
      .then(async ([positions, activity]) => {
        if (!active) return;
        const selected = positions.items[0] ?? null;
        setPosition(selected);
        setItems(activity.items);
        if (selected) setSummary(await client.getFeeSummary(selected.id));
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Activity unavailable",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading)
    return (
      <p aria-live="polite" className="text-slate-400">
        Loading treasury activity…
      </p>
    );
  if (error)
    return (
      <section role="alert" className="space-y-4 text-slate-200">
        <h1 className="text-3xl font-semibold text-white">Activity</h1>
        <p className="rounded-xl border border-red-900/70 bg-red-950/40 p-4 text-red-200">
          Treasury activity is unavailable: {error}
        </p>
      </section>
    );

  return (
    <section className="space-y-6 text-slate-200">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300">
          Treasury records
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">Activity</h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          See what the local treasury has prepared and what canonical settlement
          evidence confirms. A quote or unsigned transaction never counts as a
          completed trade or earned fee.
        </p>
      </div>

      {position && <FeePanel summary={summary} />}
      {items.length === 0 ? (
        <section className="rounded-2xl border border-slate-700 bg-slate-900 p-6">
          <h2 className="text-lg font-semibold text-white">No activity yet</h2>
          <p className="mt-2 max-w-2xl leading-7 text-slate-400">
            There are no stored preparations or canonical settlement events for
            this local example. Activity will appear here when evidence exists.
          </p>
          <Link
            to="/holdings"
            className="mt-5 inline-flex rounded-lg bg-violet-600 px-4 py-3 font-medium text-white hover:bg-violet-500"
          >
            View holdings and rules
          </Link>
        </section>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
