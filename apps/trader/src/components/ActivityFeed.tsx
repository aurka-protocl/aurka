import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  type ActivityItem,
  type ActivityStatus,
  type ActivityType,
} from "@aurka/shared";
import { apiBaseUrl } from "../config";
import { displayAssetSymbol, userFacingError } from "../ui";

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
  PREPARED: "Waiting for approval",
  PENDING: "Processing",
  CONFIRMED: "Complete",
  FAILED: "Failed",
  ORPHANED: "Reverted",
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
  SPACE_DEPLOYMENT_FAILED: "Space setup needs attention",
};

function stateLabel(value: string | undefined): string {
  if (!value) return "Recorded";
  return (
    {
      ACTIVE: "Ready to trade",
      DRAFT: "Draft",
      FAILED: "Setup failed",
      PAUSED: "Trading paused",
      PENDING: "Pending",
      REACTIVATION_REQUIRED: "Trading needs reactivation",
      PRICING_NEEDS_RENEWAL: "Price needs renewal",
      STRATEGY_MISMATCH: "Owner repair required",
    }[value] ?? "Recorded"
  );
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
            {draftRecord ? "Saved draft" : STATUS_LABELS[item.status]}
          </span>
        </div>
        <p className="mt-4 text-sm text-slate-300">
          {draftRecord
            ? "Your changes are saved and ready to review."
            : item.type === "TRADING_STATUS"
              ? `Trading status: ${stateLabel(item.state)}`
              : "Your Space rules were updated."}
        </p>
        {item.status === "FAILED" && (
          <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
            The requested Space change failed; no successful rule or status
            update is implied.
          </p>
        )}
      </article>
    );
  }

  return (
    <article
      className={`rounded-2xl border border-slate-700 bg-slate-900 ${compact ? "p-4" : "p-5"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-white">
            {displayAssetSymbol(item.traderInputSymbol ?? "Token")} →{" "}
            {displayAssetSymbol(item.traderOutputSymbol ?? "Token")}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {item.spaceName ?? "Space"} · {activityDate(item)}
          </p>
        </div>
        <span className={`text-sm font-medium ${statusClass(item.status)}`}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>

      <p className="mt-4 text-sm text-slate-300">
        {item.status === "CONFIRMED"
          ? "The swap was completed successfully."
          : item.status === "PENDING"
            ? "The swap is being confirmed."
            : item.status === "FAILED"
              ? "The swap was not completed."
              : "Review this swap before approving it."}
      </p>

      {item.status === "ORPHANED" && (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          This swap was reverted and did not complete.
        </p>
      )}
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
              ? userFacingError(requestError, "Activity is unavailable")
              : "Activity is unavailable",
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
        <span>We couldn't load activity. {error}</span>
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
