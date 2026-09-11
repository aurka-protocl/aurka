import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  activityStatusSchema,
  activityTypeSchema,
  type ActivityStatus,
  type ActivityType,
  type SpaceRecord,
} from "@aurka/shared";
import {
  ActivityFeed,
  type ActivityFeedQuery,
} from "../components/ActivityFeed";
import { apiBaseUrl } from "../config";
import { userFacingError } from "../ui";

const ACTIVITY_TYPES = activityTypeSchema.options;
const ACTIVITY_STATUSES = activityStatusSchema.options;

function validOption<T extends string>(
  value: string | null,
  options: readonly T[],
): T | undefined {
  return value && options.includes(value as T) ? (value as T) : undefined;
}

function dateValue(timestamp: number | undefined): string {
  if (
    timestamp === undefined ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    return "";
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayBoundary(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined;
  const suffix = endOfDay ? "T23:59:59" : "T00:00:00";
  const timestamp = Math.floor(new Date(`${value}${suffix}`).getTime() / 1000);
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? timestamp
    : undefined;
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
      >
        {children}
      </select>
    </label>
  );
}

function SpaceFilter({
  value,
  spaces,
  onChange,
}: {
  readonly value: string;
  readonly spaces: readonly SpaceRecord[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block min-w-0 sm:col-span-2">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Space
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
      >
        <option value="">All Spaces</option>
        {spaces.map((space) => (
          <option key={space.identity.id} value={space.identity.id}>
            {space.identity.name}
          </option>
        ))}
        {value && !spaces.some((space) => space.identity.id === value) && (
          <option value={value}>Selected Space</option>
        )}
      </select>
    </label>
  );
}

function ActivityFilters({
  searchParams,
  spaces,
  onChange,
  onReset,
}: {
  readonly searchParams: URLSearchParams;
  readonly spaces: readonly SpaceRecord[];
  readonly onChange: (name: string, value: string) => void;
  readonly onReset: () => void;
}) {
  const type = validOption(searchParams.get("type"), ACTIVITY_TYPES) ?? "";
  const status =
    validOption(searchParams.get("status"), ACTIVITY_STATUSES) ?? "";
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">Filter activity</h2>
          <p className="mt-1 text-sm text-slate-400">
            Filter by Space, activity type, status, or date.
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-cyan-500 hover:text-white"
        >
          Clear filters
        </button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SpaceFilter
          value={
            searchParams.get("spaceId") ?? searchParams.get("positionId") ?? ""
          }
          spaces={spaces}
          onChange={(value) => onChange("spaceId", value)}
        />
        <FilterSelect
          label="Type"
          value={type}
          onChange={(value) => onChange("type", value)}
        >
          <option value="">All types</option>
          <option value="SWAP">Swaps</option>
          <option value="RULE_CHANGE">Rule changes</option>
          <option value="TRADING_STATUS">Trading status</option>
        </FilterSelect>
        <FilterSelect
          label="Status"
          value={status}
          onChange={(value) => onChange("status", value)}
        >
          <option value="">All statuses</option>
          <option value="PREPARED">Prepared</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="FAILED">Failed</option>
          <option value="ORPHANED">Orphaned</option>
        </FilterSelect>
        <label className="block min-w-0">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            From
          </span>
          <input
            type="date"
            value={dateValue(
              searchParams.get("from")
                ? Number(searchParams.get("from"))
                : undefined,
            )}
            onChange={(event) =>
              onChange(
                "from",
                String(dayBoundary(event.target.value, false) ?? ""),
              )
            }
            className="mt-1 block min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
          />
        </label>
        <label className="block min-w-0">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            To
          </span>
          <input
            type="date"
            value={dateValue(
              searchParams.get("to")
                ? Number(searchParams.get("to"))
                : undefined,
            )}
            onChange={(event) =>
              onChange(
                "to",
                String(dayBoundary(event.target.value, true) ?? ""),
              )
            }
            className="mt-1 block min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
          />
        </label>
      </div>
    </section>
  );
}

export default function History() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [spacesError, setSpacesError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    new AurkaClient({ baseUrl: apiBaseUrl })
      .listSpaces(100)
      .then((page) => {
        if (active) setSpaces(page.items);
      })
      .catch((error: unknown) => {
        if (active)
          setSpacesError(userFacingError(error, "Space names are unavailable"));
      });
    return () => {
      active = false;
    };
  }, []);

  const spaceId =
    searchParams.get("spaceId") ?? searchParams.get("positionId") ?? undefined;
  const type = validOption(searchParams.get("type"), ACTIVITY_TYPES) as
    ActivityType | undefined;
  const status = validOption(searchParams.get("status"), ACTIVITY_STATUSES) as
    ActivityStatus | undefined;
  const fromValue = searchParams.get("from");
  const toValue = searchParams.get("to");
  const from = fromValue ? Number(fromValue) : undefined;
  const to = toValue ? Number(toValue) : undefined;
  const activityQuery = useMemo<ActivityFeedQuery>(
    () => ({
      ...(spaceId ? { spaceId } : {}),
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(from !== undefined && Number.isSafeInteger(from) ? { from } : {}),
      ...(to !== undefined && Number.isSafeInteger(to) ? { to } : {}),
      limit: 20,
    }),
    [from, spaceId, status, to, type],
  );
  const filterKey = searchParams.toString();

  function updateFilter(name: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor");
    next.delete("positionId");
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next);
  }

  function resetFilters() {
    setSearchParams({});
  }

  return (
    <section className="space-y-6 text-slate-200">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Your activity
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">Activity</h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          Review offers, wallet requests, confirmed trades, and Space changes in
          one place. Pending and failed requests are kept separate from
          confirmed trades.
        </p>
      </div>

      <ActivityFilters
        searchParams={searchParams}
        spaces={spaces}
        onChange={updateFilter}
        onReset={resetFilters}
      />
      {spacesError && (
        <p className="text-sm text-amber-300">
          Space names are unavailable: {spacesError}. Activity remains readable,
          but the filter list could not be loaded.
        </p>
      )}
      <ActivityFeed
        key={filterKey}
        query={activityQuery}
        emptyMessage="No activity yet. Completed swaps and rule changes will appear here."
      />

      {spaceId && (
        <Link
          to="/spaces"
          className="inline-flex text-sm text-cyan-300 hover:text-cyan-200"
        >
          Browse Spaces
        </Link>
      )}
    </section>
  );
}
