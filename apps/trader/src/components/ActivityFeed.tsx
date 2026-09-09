import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  formatGroupedDecimalUnits,
  type ActivityItem,
  type ActivityStatus,
  type ActivityType,
} from "@aurka/shared";
import { apiBaseUrl } from "../config";

export interface ActivityFeedQuery {
  readonly spaceId?: string;
  readonly positionId?: string;
  readonly chainId?: number;
  readonly type?: ActivityType;
  readonly status?: ActivityStatus;
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
}

const STATUS_LABELS: Record<ActivityStatus, string> = {
  PREPARED: "Prepared · unsigned, not submitted",
  PENDING: "Pending · submitted, awaiting receipt",
  CONFIRMED: "Confirmed record",
  FAILED: "Failed",
  ORPHANED: "Orphaned by a chain reorganization",
};

type ActivityChange = Extract<
  ActivityItem,
  { readonly type: "RULE_CHANGE" | "TRADING_STATUS" }
>;

const CHANGE_LABELS: Record<ActivityChange["eventType"], string> = {
  SPACE_CREATED: "Space created",
  SPACE_UPDATED: "Rules updated",
  SPACE_ACTIVATED: "Space activated",
  SPACE_PAUSED: "Trading paused",
  SPACE_RESUMED: "Trading resumed",
  SPACE_DEPLOYMENT_FAILED: "Space setup failed",
};

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function statusClass(status: ActivityStatus): string {
  return status === "CONFIRMED"
    ? "text-emerald-300"
    : status === "ORPHANED" || status === "FAILED"
      ? "text-amber-300"
      : "text-cyan-300";
}

function activityTime(item: ActivityItem): number {
  return item.occurredAt ?? item.submittedAt ?? 0;
}

function activityDate(item: ActivityItem): string {
  return new Date(activityTime(item) * 1000).toLocaleString();
}

function ActivityEvidence({ item }: { readonly item: ActivityItem }) {
  return (
    <details className="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
      <summary className="cursor-pointer text-sm text-slate-300">
        Technical evidence
      </summary>
      <dl className="mt-3 space-y-2 break-all text-xs text-slate-500">
        <div>
          <dt className="inline text-slate-400">Activity ID: </dt>
          <dd className="inline">{item.id}</dd>
        </div>
        {"transactionHash" in item && item.transactionHash && (
          <div>
            <dt className="inline text-slate-400">Transaction hash: </dt>
            <dd className="inline">{item.transactionHash}</dd>
          </div>
        )}
        {item.evidence.receiptHash && (
          <div>
            <dt className="inline text-slate-400">Receipt hash: </dt>
            <dd className="inline">{item.evidence.receiptHash}</dd>
          </div>
        )}
        {item.blockNumber && (
          <div>
            <dt className="inline text-slate-400">Block: </dt>
            <dd className="inline">{item.blockNumber}</dd>
          </div>
        )}
        {item.evidence.blockHash && (
          <div>
            <dt className="inline text-slate-400">Block hash: </dt>
            <dd className="inline">{item.evidence.blockHash}</dd>
          </div>
        )}
        {item.type === "SWAP" && (
          <>
            <div>
              <dt className="inline text-slate-400">Intent: </dt>
              <dd className="inline">{item.intentHash}</dd>
            </div>
            <div>
              <dt className="inline text-slate-400">Proposal: </dt>
              <dd className="inline">{item.proposalHash}</dd>
            </div>
            {item.evidence.tradeEventId && (
              <div>
                <dt className="inline text-slate-400">Trade event: </dt>
                <dd className="inline">{item.evidence.tradeEventId}</dd>
              </div>
            )}
            {item.evidence.feeEventId && (
              <div>
                <dt className="inline text-slate-400">Fee event: </dt>
                <dd className="inline">{item.evidence.feeEventId}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </details>
  );
}

export function ActivityCard({
  item,
  compact = false,
}: {
  readonly item: ActivityItem;
  readonly compact?: boolean;
}) {
  if (item.type !== "SWAP") {
    const draftRecord = item.state === "DRAFT";
    return (
      <article
        className={`rounded-2xl border border-slate-700 bg-slate-900 ${compact ? "p-4" : "p-5"}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold text-white">
              {item.payload?.authority === "signed-metadata-only"
                ? "Name and draft saved"
                : CHANGE_LABELS[item.eventType]}
            </p>
            <p className="mt-1 text-sm text-slate-400">
              {item.spaceName ?? "Space"} · {activityDate(item)}
            </p>
          </div>
          <span className={`text-sm font-medium ${statusClass(item.status)}`}>
            {draftRecord
              ? "Saved draft · not a policy update"
              : STATUS_LABELS[item.status]}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">Action</dt>
            <dd className="text-slate-200">
              {draftRecord
                ? "Draft saved · not an active policy update"
                : item.type === "TRADING_STATUS"
                  ? "Trading status changed"
                  : "Policy rules changed"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Actor</dt>
            <dd className="break-all text-slate-200">
              {item.actor ? shortHash(item.actor) : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Resulting state</dt>
            <dd className="text-slate-200">{item.state ?? "Recorded"}</dd>
          </div>
        </dl>
        {item.status === "FAILED" && (
          <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
            The requested Space change failed; no successful rule or status
            update is implied.
          </p>
        )}
        {!compact && <ActivityEvidence item={item} />}
      </article>
    );
  }

  const decimals = item.initialPortfolio?.valueDecimals ?? 0;
  return (
    <article
      className={`rounded-2xl border border-slate-700 bg-slate-900 ${compact ? "p-4" : "p-5"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-white">
            {item.traderInputSymbol ?? shortHash(item.traderInputToken)} →{" "}
            {item.traderOutputSymbol ?? shortHash(item.traderOutputToken)}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {item.spaceName ?? "Space"} · {activityDate(item)}
          </p>
        </div>
        <span className={`text-sm font-medium ${statusClass(item.status)}`}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Requested value</dt>
          <dd className="text-slate-200">
            {formatGroupedDecimalUnits(
              item.requestedTraderInputValue,
              decimals,
            )}{" "}
            normalized settlement value
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Executed value</dt>
          <dd className="text-slate-200">
            {item.executedTraderInputValue === undefined
              ? "Not available"
              : `${formatGroupedDecimalUnits(item.executedTraderInputValue, decimals)} normalized settlement value`}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Fee record</dt>
          <dd className="text-slate-200">
            {item.feeState === "EARNED" && item.earnedFee
              ? `${formatGroupedDecimalUnits(item.earnedFee.treasuryAmount, decimals)} normalized settlement value retained by treasury`
              : item.feeState === "ESTIMATE" && item.estimatedFees
                ? `${formatGroupedDecimalUnits(item.estimatedFees.treasuryAmount, decimals)} estimated normalized settlement value · not earned`
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
        <div>
          <dt className="text-slate-500">Actor</dt>
          <dd className="break-all text-slate-200">
            {shortHash(item.actor ?? item.trader)}
          </dd>
        </div>
      </dl>

      {item.status === "ORPHANED" && (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          This event was removed from the canonical chain. It remains visible
          for audit context, but contributes zero to earned-fee totals.
        </p>
      )}
      {!compact && <ActivityEvidence item={item} />}
    </article>
  );
}

export function ActivityFeed({
  query,
  compact = false,
  emptyMessage = "No activity yet. Completed swaps and rule changes will appear here.",
  showPagination = true,
}: {
  readonly query: ActivityFeedQuery;
  readonly compact?: boolean;
  readonly emptyMessage?: string;
  readonly showPagination?: boolean;
}) {
  const {
    spaceId,
    positionId,
    chainId,
    type,
    status,
    from,
    to,
    limit = compact ? 3 : 20,
  } = query;
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setCursor(undefined);
  }, [chainId, from, limit, positionId, spaceId, status, to, type]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    new AurkaClient({ baseUrl: apiBaseUrl })
      .listActivity({
        ...(spaceId ? { spaceId } : {}),
        ...(positionId ? { positionId } : {}),
        ...(chainId === undefined ? {} : { chainId }),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        limit,
        ...(cursor ? { cursor } : {}),
      })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
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
  }, [
    chainId,
    cursor,
    from,
    limit,
    positionId,
    retry,
    spaceId,
    status,
    to,
    type,
  ]);

  if (loading)
    return (
      <p aria-live="polite" className="text-sm text-slate-400">
        Loading activity…
      </p>
    );
  if (error)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200"
      >
        <span>Activity is unavailable: {error}</span>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="rounded border border-red-800 px-2 py-1 hover:border-red-500"
        >
          Retry
        </button>
      </div>
    );
  if (items.length === 0)
    return <p className="text-sm text-slate-400">{emptyMessage}</p>;

  return (
    <>
      <div className="space-y-4">
        {items.map((item) => (
          <ActivityCard key={item.id} item={item} compact={compact} />
        ))}
      </div>
      {showPagination && (
        <div className="mt-4 flex flex-wrap gap-3">
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
      )}
    </>
  );
}

export function ActivityLink({ spaceId }: { readonly spaceId: string }) {
  return (
    <Link
      to={`/activity?spaceId=${encodeURIComponent(spaceId)}`}
      className="text-sm text-cyan-300 hover:text-cyan-200"
    >
      View full activity <span aria-hidden="true">→</span>
    </Link>
  );
}
