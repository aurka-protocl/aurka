import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";
import {
  formatBasisPoints,
  formatGroupedDecimalUnits,
  formatSnapshotAge,
  snapshotFreshness,
  type AssetBound,
  type AssetSnapshot,
  type DirectionalCapacity,
  type PortfolioSnapshot,
  type Position,
} from "@aurka/shared";
import { ActivityFeed, ActivityLink } from "../components/ActivityFeed";
import { apiBaseUrl, appMode } from "../config";
import {
  invalidateSpaceCache,
  spaceAdapter,
  spaceUrl,
  tradeUrl,
  type SpaceRecord,
} from "../domain/spaces";
import SpaceForm, { SpaceOwnerControls } from "./SpaceForm";
import { displayAssetSymbol, userFacingError } from "../ui";

const client = new AurkaClient({ baseUrl: apiBaseUrl });

function decodeSpaceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function currentFreshness(
  position: Position,
): ReturnType<typeof snapshotFreshness> {
  const snapshot = position.currentPortfolio;
  return snapshot
    ? snapshotFreshness(
        snapshot.observedAt,
        Math.floor(Date.now() / 1000),
        position.policy.priceMaxAgeSeconds,
      )
    : "unknown";
}

function stateLabel(space: SpaceRecord): string {
  if (space.identity.state === "ACTIVE") return "Trading active";
  if (space.identity.state === "PRICING_NEEDS_RENEWAL")
    return "Price update needed";
  if (space.identity.state === "STRATEGY_MISMATCH")
    return "Owner repair required";
  if (space.identity.state === "REACTIVATION_REQUIRED")
    return "Ready to reactivate";
  if (space.identity.state === "PAUSED") return "Trading paused";
  if (space.identity.state === "FAILED") return "Needs attention";
  if (space.identity.state === "PENDING") return "Setup in progress";
  return "Draft saved";
}

function stateClass(space: SpaceRecord): string {
  return space.identity.state === "ACTIVE"
    ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
    : space.identity.state === "PAUSED" ||
        space.identity.state === "PRICING_NEEDS_RENEWAL" ||
        space.identity.state === "STRATEGY_MISMATCH" ||
        space.identity.state === "REACTIVATION_REQUIRED" ||
        space.identity.state === "FAILED"
      ? "border-amber-800 bg-amber-950/40 text-amber-300"
      : "border-slate-700 bg-slate-900 text-slate-300";
}

function SpaceStatus({ space }: { readonly space: SpaceRecord }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${stateClass(space)}`}
      aria-label={`Trading status: ${stateLabel(space)}`}
    >
      {stateLabel(space)}
    </span>
  );
}

function SpaceTabs({ space }: { readonly space: SpaceRecord }) {
  const tabs = [
    { label: "Overview", section: "overview" as const },
    { label: "Holdings & rules", section: "holdings" as const },
    { label: "Settings", section: "settings" as const },
  ];
  return (
    <nav
      aria-label={`${space.identity.name} sections`}
      className="flex gap-1 overflow-x-auto border-b border-slate-800"
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.section}
          to={spaceUrl(space.identity.id, tab.section)}
          end={tab.section === "overview"}
          className={({ isActive }) =>
            `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition ${
              isActive
                ? "border-cyan-400 text-white"
                : "border-transparent text-slate-400 hover:border-slate-600 hover:text-slate-200"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

function SpacePage({
  children,
}: {
  readonly children: (
    space: SpaceRecord,
    refresh: () => void,
  ) => React.ReactNode;
}) {
  const { spaceId: rawSpaceId } = useParams<{ spaceId: string }>();
  const spaceId = decodeSpaceId(rawSpaceId);
  const [space, setSpace] = useState<SpaceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    if (!spaceId) {
      setLoading(false);
      setError("This Space link is incomplete.");
      return () => {
        active = false;
      };
    }
    spaceAdapter
      .getSpace(spaceId)
      .then((next) => {
        if (active) setSpace(next);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? userFacingError(
                  requestError,
                  "The requested Space could not be loaded",
                )
              : "The requested Space could not be loaded",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey, spaceId]);

  const refresh = () => {
    if (spaceId) invalidateSpaceCache(spaceId);
    setRefreshKey((current) => current + 1);
  };

  if (loading)
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold text-white">Loading Space…</h1>
        <p aria-live="polite" className="text-slate-400">
          Reading the latest balances and trading status.
        </p>
      </section>
    );
  if (error || !space)
    return (
      <section className="space-y-4" role="alert">
        <Link
          to="/spaces"
          className="inline-flex items-center gap-2 text-sm text-cyan-300 hover:text-cyan-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Spaces
        </Link>
        <h1 className="text-3xl font-semibold text-white">Space unavailable</h1>
        <p className="max-w-xl rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 leading-6 text-amber-200">
          We couldn't load this Space. Balances may be temporarily unavailable,
          so trading is paused until it is safe to continue.
        </p>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-cyan-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
        </button>
      </section>
    );

  const canTrade =
    space.identity.state === "ACTIVE" &&
    !!space.position &&
    currentFreshness(space.position) === "fresh";

  return (
    <section className="space-y-6 text-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/spaces"
            className="inline-flex items-center gap-2 text-sm text-cyan-300 hover:text-cyan-200"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All Spaces
          </Link>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <p className="text-sm text-slate-500">Space</p>
            <SpaceStatus space={space} />
          </div>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight text-white">
            {space.identity.name}
          </h1>
        </div>
        {canTrade ? (
          <Link
            to={tradeUrl(space.identity.id)}
            title="Open swaps for this Space"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600"
          >
            Trade this Space{" "}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : space.identity.state === "ACTIVE" ? (
          <span className="inline-flex min-h-10 items-center rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200">
            Trading unavailable until balances are current
          </span>
        ) : space.identity.state === "PRICING_NEEDS_RENEWAL" ? (
          <span className="inline-flex min-h-10 items-center rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200">
            Price update needed before trading can resume
          </span>
        ) : space.identity.state === "STRATEGY_MISMATCH" ? (
          <span className="inline-flex min-h-10 items-center rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200">
            Owner repair required before trading can resume
          </span>
        ) : null}
      </div>
      <SpaceTabs space={space} />
      {children(space, refresh)}
    </section>
  );
}

function Freshness({ position }: { readonly position: Position }) {
  const snapshot = position.currentPortfolio;
  if (!snapshot)
    return (
      <p className="text-sm text-amber-300">
        Balances are unavailable · trading is paused
      </p>
    );
  const now = Math.floor(Date.now() / 1000);
  const freshness = snapshotFreshness(
    snapshot.observedAt,
    now,
    position.policy.priceMaxAgeSeconds,
  );
  const label =
    freshness === "fresh"
      ? "Balances are up to date"
      : freshness === "stale"
        ? "Balances need a refresh"
        : "Balance status unavailable";
  return (
    <p
      className={`text-sm ${freshness === "fresh" ? "text-emerald-300" : "text-amber-300"}`}
      role={freshness === "fresh" ? undefined : "alert"}
    >
      {label} · updated {formatSnapshotAge(snapshot.observedAt, now)}
    </p>
  );
}

function allocationRows(snapshot: PortfolioSnapshot) {
  return snapshot.assets.map((asset) => (
    <div key={asset.token} className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-white">
          {displayAssetSymbol(asset.symbol)}
        </span>
        <span className="text-slate-300">
          {formatBasisPoints(asset.weightBps)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-cyan-500"
          style={{ width: `${Math.min(100, Number(asset.weightBps) / 100)}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  ));
}

function RecentActivity({ spaceId }: { readonly spaceId: string }) {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Recent activity</h2>
          <p className="mt-1 text-sm text-slate-400">
            Recent swaps and updates from this Space.
          </p>
        </div>
        <ActivityLink spaceId={spaceId} />
      </div>
      <div className="mt-4">
        <ActivityFeed
          query={{ spaceId, limit: 3 }}
          compact
          showPagination={false}
          emptyMessage="No activity has been recorded for this Space yet."
        />
      </div>
    </section>
  );
}

function RuleSummary({ position }: { readonly position: Position }) {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Trading rules</h2>
          <p className="mt-1 text-sm text-slate-400">
            Limits this Space applies to every trade.
          </p>
        </div>
        <Link
          to={spaceUrl(position.id, "holdings")}
          className="text-sm text-cyan-300 hover:text-cyan-200"
        >
          View holdings →
        </Link>
        <Link
          to={spaceUrl(position.id, "settings")}
          className="text-sm text-cyan-300 hover:text-cyan-200"
        >
          Edit Space →
        </Link>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Maximum trade size</dt>
          <dd className="mt-1 font-semibold text-white">
            {formatGroupedDecimalUnits(
              position.policy.maximumTransactionValue,
              0,
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Trading status</dt>
          <dd
            className={
              position.policy.paused
                ? "mt-1 font-semibold text-amber-300"
                : "mt-1 font-semibold text-emerald-300"
            }
          >
            {position.policy.paused ? "Paused" : "Trading available"}
          </dd>
        </div>
      </dl>
      <ul className="mt-4 space-y-2 text-sm text-slate-300">
        {position.policy.assets.map((asset) => (
          <li key={asset.token} className="flex justify-between gap-3">
            <span>{displayAssetSymbol(asset.symbol)}</span>
            <span>
              {formatBasisPoints(asset.minimumWeightBps)} –{" "}
              {formatBasisPoints(asset.maximumWeightBps)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SpaceOverview() {
  return (
    <SpacePage>
      {(space) => {
        if (!space.position)
          return (
            <div className="space-y-5">
              <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">
                  {stateLabel(space)}
                </p>
                <h2 className="text-2xl font-semibold text-white">
                  This Space is not active yet
                </h2>
                <p className="max-w-2xl leading-7 text-slate-400">
                  Your settings are saved, but balances and trading remain
                  unavailable until setup is confirmed.
                </p>
                <Link
                  to={spaceUrl(space.identity.id, "settings")}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white"
                >
                  Continue setup{" "}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </section>
            </div>
          );
        const position = space.position;
        const snapshot = position.currentPortfolio;
        return (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Portfolio value
                </p>
                <p className="mt-2 text-2xl font-semibold text-cyan-200">
                  {snapshot
                    ? snapshot.assets
                        .map(
                          (asset) =>
                            `${displayAssetSymbol(asset.symbol)} ${formatGroupedDecimalUnits(asset.balance, asset.decimals)}`,
                        )
                        .join(" · ")
                    : "Unavailable"}
                </p>
                <div className="mt-3">
                  <Freshness position={position} />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Maximum trade size
                </p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatGroupedDecimalUnits(
                    position.policy.maximumTransactionValue,
                    0,
                  )}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  Applies to every swap
                </p>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Managed assets
                </p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {snapshot?.assets.length ?? "—"}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  Included in this Space
                </p>
              </div>
            </div>
            {snapshot ? (
              <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <h2 className="text-lg font-semibold text-white">
                  Current allocation
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Current balance distribution across the Space.
                </p>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  {allocationRows(snapshot)}
                </div>
              </section>
            ) : (
              <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-amber-200">
                Current balances are unavailable. Try refreshing before trading.
              </p>
            )}
            <RuleSummary position={position} />
            <RecentActivity spaceId={space.identity.id} />
          </div>
        );
      }}
    </SpacePage>
  );
}

function findTradingPair(
  position: Position,
): { input: AssetBound; output: AssetBound } | undefined {
  const find = (symbol: string) =>
    position.policy.assets.find((asset) =>
      asset.symbol
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .includes(symbol),
    );
  const input = find("WETH") ?? position.policy.assets[0];
  const output =
    find("USDC") ??
    position.policy.assets.find((asset) => asset.token !== input?.token);
  return input && output ? { input, output } : undefined;
}

function HoldingsTable({
  position,
  snapshot,
}: {
  readonly position: Position;
  readonly snapshot?: PortfolioSnapshot;
}) {
  const rows = position.policy.assets.map((rule) => ({
    rule,
    asset: snapshot?.assets.find(
      (candidate) => candidate.token.toLowerCase() === rule.token.toLowerCase(),
    ),
  }));
  const cells = (row: {
    rule: AssetBound;
    asset: AssetSnapshot | undefined;
  }) => {
    const { rule, asset } = row;
    return {
      balance: asset
        ? `${formatGroupedDecimalUnits(asset.balance, asset.decimals)} ${displayAssetSymbol(asset.symbol)}`
        : "Unavailable",
      allocation: asset ? formatBasisPoints(asset.weightBps) : "Unavailable",
      range: `${formatBasisPoints(rule.minimumWeightBps)} – ${formatBasisPoints(rule.maximumWeightBps)}`,
      limit: formatGroupedDecimalUnits(
        position.policy.maximumTransactionValue,
        0,
      ),
    };
  };
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900">
      <table className="hidden min-w-full text-left text-sm md:table">
        <caption className="sr-only">
          Holdings and rules for {position.name}
        </caption>
        <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-5 py-3">Asset</th>
            <th className="px-5 py-3">Balance</th>
            <th className="px-5 py-3">Allocation</th>
            <th className="px-5 py-3">Target range</th>
            <th className="px-5 py-3">Trade limit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map((row) => {
            const cell = cells(row);
            return (
              <tr key={row.rule.token}>
                <th className="px-5 py-4 font-medium text-white">
                  <span className="block">
                    {displayAssetSymbol(row.rule.symbol)}
                  </span>
                </th>
                <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                  {cell.balance}
                </td>
                <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                  {cell.allocation}
                </td>
                <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                  {cell.range}
                </td>
                <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                  {cell.limit}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="divide-y divide-slate-800 md:hidden">
        {rows.map((row) => {
          const cell = cells(row);
          return (
            <article key={row.rule.token} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-white">
                  {displayAssetSymbol(row.rule.symbol)}
                </h3>
                <span className="text-right text-sm text-slate-300">
                  {cell.balance}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
                <div>
                  <dt className="text-slate-500">Allocation</dt>
                  <dd className="mt-1 text-slate-300">{cell.allocation}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Target range</dt>
                  <dd className="mt-1 text-slate-300">{cell.range}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Trade limit</dt>
                  <dd className="mt-1 text-slate-300">{cell.limit}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CapacityPanel({
  position,
  snapshot,
}: {
  readonly position: Position;
  readonly snapshot?: PortfolioSnapshot;
}) {
  const pair = useMemo(() => findTradingPair(position), [position]);
  const [capacity, setCapacity] = useState<DirectionalCapacity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const freshness = currentFreshness(position);
  useEffect(() => {
    let active = true;
    setCapacity(null);
    setError(null);
    if (!pair || !snapshot || freshness !== "fresh") {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    client
      .getCapacity(position.id, pair.input.token, pair.output.token)
      .then((next) => {
        if (active) setCapacity(next);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? userFacingError(
                  requestError,
                  "Swap availability is temporarily unavailable",
                )
              : "Swap availability is temporarily unavailable",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [freshness, pair, position.id, position.updatedAt, retry, snapshot]);

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
      <h2 className="text-lg font-semibold text-white">Swap availability</h2>
      <p className="mt-1 text-sm leading-6 text-slate-400">
        See how much is currently available for the most common swap in this
        Space.
      </p>
      {!snapshot || freshness !== "fresh" ? (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          Swap availability is unavailable while balances are not current.
          Trading is paused until they are available.
        </p>
      ) : loading ? (
        <p aria-live="polite" className="mt-4 text-sm text-slate-400">
          Checking swap availability…
        </p>
      ) : error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">
          <span>Swap availability is temporarily unavailable. {error}</span>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="rounded border border-red-800 px-2 py-1 hover:border-red-500"
          >
            Retry
          </button>
        </div>
      ) : capacity ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Swap</dt>
            <dd className="mt-1 font-semibold text-white">
              {pair ? displayAssetSymbol(pair.input.symbol) : "Token"} →{" "}
              {pair ? displayAssetSymbol(pair.output.symbol) : "Token"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Available now</dt>
            <dd className="mt-1 font-semibold text-cyan-200">
              {formatGroupedDecimalUnits(
                capacity.remainingValue,
                snapshot.valueDecimals,
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-500">Available until</dt>
            <dd className="mt-1 text-slate-300">
              {new Date(capacity.expiresAt * 1000).toLocaleString()}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

export function SpaceHoldings() {
  return (
    <SpacePage>
      {(space, refresh) => {
        if (!space.position)
          return (
            <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-amber-200">
              Holdings are not available until this Space is activated.
            </p>
          );
        const position = space.position;
        const snapshot = position.currentPortfolio;
        return (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold text-white">
                  Holdings &amp; rules
                </h2>
                <p className="mt-2 max-w-3xl leading-7 text-slate-400">
                  See the balances, target ranges, and swap limits for this
                  Space.
                </p>
              </div>
              <button
                type="button"
                onClick={refresh}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-cyan-500"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
                balances
              </button>
            </div>
            <HoldingsTable position={position} snapshot={snapshot} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-sm text-slate-500">Maximum trade size</p>
                <p className="mt-2 text-lg font-semibold text-white">
                  {formatGroupedDecimalUnits(
                    position.policy.maximumTransactionValue,
                    0,
                  )}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  This applies to every swap.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-sm text-slate-500">Trading status</p>
                <p
                  className={
                    position.policy.paused
                      ? "mt-2 text-lg font-semibold text-amber-300"
                      : "mt-2 text-lg font-semibold text-emerald-300"
                  }
                >
                  {position.policy.paused ? "Paused" : "Trading available"}
                </p>
                <div className="mt-2">
                  <Freshness position={position} />
                </div>
              </div>
            </div>
            <CapacityPanel position={position} snapshot={snapshot} />
            {space.identity.state === "ACTIVE" &&
            currentFreshness(position) === "fresh" ? (
              <Link
                to={tradeUrl(space.identity.id)}
                title="Trade against this Space"
                className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600"
              >
                Trade this Space{" "}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            ) : (
              <p className="rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
                Trading is unavailable until this Space is active and its
                balances are current.
              </p>
            )}
          </div>
        );
      }}
    </SpacePage>
  );
}

export function SpaceSettings() {
  const [editing, setEditing] = useState(false);
  return (
    <SpacePage>
      {(space, refresh) => (
        <div className="space-y-5">
          <div>
            <h2 className="text-2xl font-semibold text-white">Settings</h2>
            <p className="mt-2 max-w-3xl leading-7 text-slate-400">
              Manage the Space name, trading status, and rules.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <p className="text-sm text-slate-500">Trading status</p>
            <p className="mt-1 font-semibold text-white">{stateLabel(space)}</p>
          </div>
          {space.failureReason && (
            <p className="rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">
              Space setup could not be confirmed. Review the form and try again.
            </p>
          )}
          {space.identity.state === "PRICING_NEEDS_RENEWAL" && (
            <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-200">
              This Space needs an updated price before trading can resume.
              Create a new Space with current settings to continue.
            </p>
          )}
          {space.identity.state === "STRATEGY_MISMATCH" && (
            <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-200">
              This Space was created with an incompatible strategy encoding and
              cannot be repaired by refreshing prices. Pause it, recover the
              exact vault balances with the owner wallet, then create a new
              Space with a fresh identity.
            </p>
          )}
          {!editing &&
            ["DRAFT", "PENDING", "FAILED"].includes(space.identity.state) && (
              <SpaceForm existing={space} embedded />
            )}
          {!editing &&
            ["ACTIVE", "PAUSED", "STRATEGY_MISMATCH"].includes(
              space.identity.state,
            ) && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-100 hover:border-cyan-500"
            >
              Edit Space
            </button>
          )}
          {editing && <SpaceForm existing={space} embedded />}
          {!editing && space.identity.state !== "DRAFT" ? (
            <SpaceOwnerControls space={space} onChanged={refresh} />
          ) : null}
          {!editing &&
            appMode !== "testnet" &&
            space.identity.state === "DRAFT" && (
              <p className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-6 text-slate-400">
                This draft has no balances yet. Activation requires the wallet
                that created the Space.
              </p>
            )}
        </div>
      )}
    </SpacePage>
  );
}
