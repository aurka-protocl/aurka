import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";
import {
  bindingConstraintLabel,
  formatBasisPoints,
  formatGroupedDecimalUnits,
  formatPrice,
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
  spaceAdapter,
  spaceUrl,
  tradeUrl,
  type SpaceRecord,
} from "../domain/spaces";
import SpaceForm, { SpaceOwnerControls } from "./SpaceForm";
import { userFacingError } from "../ui";

const client = new AurkaClient({ baseUrl: apiBaseUrl });
type RiskPosition = Awaited<ReturnType<AurkaClient["getRiskPosition"]>>;

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
    return "Pricing needs renewal";
  if (space.identity.state === "REACTIVATION_REQUIRED")
    return "Reactivate trading";
  if (space.identity.state === "PAUSED") return "Trading paused";
  if (space.identity.state === "FAILED") return "Setup failed";
  if (space.identity.state === "PENDING") return "Setup pending";
  return "Draft";
}

function stateClass(space: SpaceRecord): string {
  return space.identity.state === "ACTIVE"
    ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
    : space.identity.state === "PAUSED" ||
        space.identity.state === "PRICING_NEEDS_RENEWAL" ||
        space.identity.state === "REACTIVATION_REQUIRED" ||
        space.identity.state === "FAILED"
      ? "border-amber-800 bg-amber-950/40 text-amber-300"
      : "border-slate-700 bg-slate-900 text-slate-300";
}

function SpaceStatus({ space }: { readonly space: SpaceRecord }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${stateClass(space)}`}
      aria-label={`Space status: ${stateLabel(space)}`}
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
      setError("This Space URL is missing its identifier.");
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

  const refresh = () => setRefreshKey((current) => current + 1);

  if (loading)
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold text-white">Loading Space…</h1>
        <p aria-live="polite" className="text-slate-400">
          Reading the current Space state and holdings.
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
        <h1 className="text-3xl font-semibold text-white">Space not found</h1>
        <p className="max-w-xl rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 leading-6 text-amber-200">
          We could not load “{spaceId ?? "unknown"}”. Current holdings may be
          unavailable, so trading remains blocked.
        </p>
        <p className="text-sm text-slate-400">{error ?? "Unknown error"}</p>
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
            <p className="text-sm text-slate-500">AURKA Space</p>
            <SpaceStatus space={space} />
          </div>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight text-white">
            {space.identity.name}
          </h1>
        </div>
        {canTrade ? (
          <Link
            to={tradeUrl(space.identity.id)}
            title="Trade against this Space"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600"
          >
            Trade this Space{" "}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : space.identity.state === "ACTIVE" ? (
          <span className="inline-flex min-h-10 items-center rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200">
            Trading unavailable until current holdings are available
          </span>
        ) : space.identity.state === "PRICING_NEEDS_RENEWAL" ? (
          <span className="inline-flex min-h-10 items-center rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200">
            Pricing needs renewal before trading can resume
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
        Current holdings are unavailable · trading is blocked
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
      ? "Current holdings"
      : freshness === "stale"
        ? "Holdings need a refresh"
        : "Holdings status unavailable";
  return (
    <p
      className={`text-sm ${freshness === "fresh" ? "text-emerald-300" : "text-amber-300"}`}
      role={freshness === "fresh" ? undefined : "alert"}
    >
      {label} · updated {formatSnapshotAge(snapshot.observedAt, now)}
    </p>
  );
}

function normalizedValue(value: string, valueDecimals: number): string {
  return `${formatGroupedDecimalUnits(value, valueDecimals)} normalized settlement value`;
}

function allocationRows(snapshot: PortfolioSnapshot) {
  return snapshot.assets.map((asset) => (
    <div key={asset.token} className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-white">{asset.symbol}</span>
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
            Shared settlement feed filtered to this Space.
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
          Full holdings &amp; rules →
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
          <dt className="text-slate-500">Global per-trade cap</dt>
          <dd className="mt-1 font-semibold text-white">
            {formatGroupedDecimalUnits(
              position.policy.maximumTransactionValue,
              0,
            )}{" "}
            normalized settlement value
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Policy state</dt>
          <dd
            className={
              position.policy.paused
                ? "mt-1 font-semibold text-amber-300"
                : "mt-1 font-semibold text-emerald-300"
            }
          >
            {position.policy.paused
              ? "Paused"
              : "Trading allowed within Space rules"}
          </dd>
        </div>
      </dl>
      <ul className="mt-4 space-y-2 text-sm text-slate-300">
        {position.policy.assets.map((asset) => (
          <li key={asset.token} className="flex justify-between gap-3">
            <span>{asset.symbol}</span>
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
                  This Space has no active holdings yet
                </h2>
                <p className="max-w-2xl leading-7 text-slate-400">
                  The saved policy draft is durable, but holdings and trading
                  remain unavailable until activation is confirmed.
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
                    ? normalizedValue(snapshot.nav, snapshot.valueDecimals)
                    : "Unavailable"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Denomination is not automatically USD.
                </p>
                <div className="mt-3">
                  <Freshness position={position} />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Global per-trade cap
                </p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatGroupedDecimalUnits(
                    position.policy.maximumTransactionValue,
                    0,
                  )}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  normalized settlement value · all directions
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
                  balances and bounds read together
                </p>
              </div>
            </div>
            {snapshot ? (
              <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <h2 className="text-lg font-semibold text-white">
                  Current allocation
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Current allocation across the Space&apos;s holdings.
                </p>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  {allocationRows(snapshot)}
                </div>
              </section>
            ) : (
              <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-amber-200">
                Current holdings are unavailable; value and allocation are not
                shown as zero.
              </p>
            )}
            <RuleSummary position={position} />
            <RecentActivity spaceId={space.identity.id} />
            <details className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
              <summary className="cursor-pointer font-medium text-slate-300">
                Space identity details
              </summary>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Owner wallet</dt>
                  <dd className="mt-1 break-all text-slate-200">
                    {space.identity.ownerAddress}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Managed account</dt>
                  <dd className="mt-1 break-all text-slate-200">
                    {space.identity.treasuryAddress}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Network</dt>
                  <dd className="mt-1 text-slate-200">
                    Chain {space.identity.chainId}
                  </dd>
                </div>
              </dl>
            </details>
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
    position.policy.assets.find(
      (asset) => asset.symbol.toUpperCase() === symbol,
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
        ? `${formatGroupedDecimalUnits(asset.balance, asset.decimals)} ${asset.symbol}`
        : "Unavailable",
      value:
        asset && snapshot
          ? normalizedValue(asset.value, snapshot.valueDecimals)
          : "Unavailable",
      allocation: asset ? formatBasisPoints(asset.weightBps) : "Unavailable",
      range: `${formatBasisPoints(rule.minimumWeightBps)} – ${formatBasisPoints(rule.maximumWeightBps)}`,
      limit: `${formatGroupedDecimalUnits(position.policy.maximumTransactionValue, 0)} normalized settlement value`,
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
            <th className="px-5 py-3">Value</th>
            <th className="px-5 py-3">Current allocation</th>
            <th className="px-5 py-3">Allowed range</th>
            <th className="px-5 py-3">Transaction limit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map((row) => {
            const cell = cells(row);
            return (
              <tr key={row.rule.token}>
                <th className="px-5 py-4 font-medium text-white">
                  <span className="block">{row.rule.symbol}</span>
                  <details className="mt-1 text-xs font-normal text-slate-500">
                    <summary className="cursor-pointer">Token details</summary>
                    <span className="mt-1 block max-w-40 break-all">
                      {row.rule.token}
                    </span>
                  </details>
                </th>
                <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                  {cell.balance}
                </td>
                <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                  {cell.value}
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
                <h3 className="font-semibold text-white">{row.rule.symbol}</h3>
                <span className="text-right text-sm text-slate-300">
                  {cell.balance}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
                <div>
                  <dt className="text-slate-500">Value</dt>
                  <dd className="mt-1 text-slate-300">{cell.value}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Allocation</dt>
                  <dd className="mt-1 text-slate-300">{cell.allocation}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Allowed range</dt>
                  <dd className="mt-1 text-slate-300">{cell.range}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Transaction limit</dt>
                  <dd className="mt-1 text-slate-300">{cell.limit}</dd>
                </div>
              </dl>
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer">Token details</summary>
                <p className="mt-2 break-all">{row.rule.token}</p>
              </details>
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
                  "Directional capacity unavailable",
                )
              : "Directional capacity unavailable",
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
      <h2 className="text-lg font-semibold text-white">Executable capacity</h2>
      <p className="mt-1 text-sm leading-6 text-slate-400">
        The global cap applies to every trade. Executable capacity is
        direction-dependent and can be lower because of balances, allocation
        bounds, fees, and prior flow.
      </p>
      {!snapshot || freshness !== "fresh" ? (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          Directional capacity is unavailable while holdings are{" "}
          {freshness === "stale" ? "out of date" : "missing or unverified"}.
          Trading is blocked until current holdings are available.
        </p>
      ) : loading ? (
        <p aria-live="polite" className="mt-4 text-sm text-slate-400">
          Reading executable capacity…
        </p>
      ) : error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">
          <span>Capacity is unavailable: {error}</span>
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
            <dt className="text-slate-500">Direction</dt>
            <dd className="mt-1 font-semibold text-white">
              {pair?.input.symbol} → {pair?.output.symbol}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Remaining executable capacity</dt>
            <dd className="mt-1 font-semibold text-cyan-200">
              {formatGroupedDecimalUnits(
                capacity.remainingValue,
                snapshot.valueDecimals,
              )}{" "}
              normalized settlement value
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Consumed in this epoch</dt>
            <dd className="mt-1 text-slate-300">
              {formatGroupedDecimalUnits(
                capacity.consumedBefore,
                snapshot.valueDecimals,
              )}{" "}
              normalized settlement value
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Binding constraint</dt>
            <dd className="mt-1 text-slate-300">
              {bindingConstraintLabel(capacity.bindingConstraint)}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-500">Expires</dt>
            <dd className="mt-1 text-slate-300">
              {new Date(capacity.expiresAt * 1000).toLocaleString()}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function RiskEvidence({ positionId }: { readonly positionId: string }) {
  const [risk, setRisk] = useState<RiskPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    client
      .getRiskPosition(positionId)
      .then((next) => {
        if (active) setRisk(next);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? userFacingError(requestError, "Risk evidence unavailable")
              : "Risk evidence unavailable",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [positionId, retry]);

  if (loading)
    return (
      <p aria-live="polite" className="mt-5 text-sm text-slate-400">
        Loading risk certificate evidence…
      </p>
    );
  if (error)
    return (
      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
        <span>Risk evidence is unavailable: {error}</span>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="rounded border border-amber-800 px-2 py-1 hover:border-amber-500"
        >
          Retry
        </button>
      </div>
    );
  const certificate = risk?.certificate;
  return (
    <div className="mt-5 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      <h3 className="text-sm font-semibold text-slate-300">
        Risk certificate evidence
      </h3>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Effective source</dt>
          <dd className="mt-1 text-slate-300">
            {risk?.effective.source ?? "Unavailable"}
            {risk?.effective.mode ? ` · ${risk.effective.mode}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Certificate state</dt>
          <dd className="mt-1 text-slate-300">
            {risk?.certificateState ?? "NONE"}
            {certificate ? ` · ${certificate.riskMode}` : ""}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-slate-500">Certificate commitments</dt>
          <dd className="mt-1 break-all text-xs text-slate-400">
            {certificate
              ? `active bounds ${certificate.activeBoundsHash} · source digest ${certificate.sourceDigest}`
              : "No certificate recorded"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function AdvancedDetails({
  space,
  position,
  snapshot,
}: {
  readonly space: SpaceRecord;
  readonly position: Position;
  readonly snapshot?: PortfolioSnapshot;
}) {
  return (
    <details className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
      <summary className="cursor-pointer text-lg font-semibold text-white">
        Developer diagnostics and evidence
      </summary>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        Optional diagnostics, risk evidence, and protocol identifiers live here
        so the actionable Space state stays visible above.
      </p>
      <dl className="mt-5 grid gap-x-5 gap-y-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Source mode</dt>
          <dd className="mt-1 text-slate-200">
            {space.identity.mode === "fork"
              ? "Fork chain reader"
              : "Demo clock / local provider"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Risk controls</dt>
          <dd className="mt-1 text-slate-200">
            {position.riskMode}
            {position.riskMode === "NORMAL"
              ? " · no temporary tightening"
              : " · temporary tightening applies"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Policy nonce</dt>
          <dd className="mt-1 break-all text-slate-200">
            {position.policy.nonce}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Policy registry</dt>
          <dd className="mt-1 break-all text-slate-200">
            {position.policy.registry}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-slate-500">Fee model</dt>
          <dd className="mt-1 text-slate-200">
            Base {formatBasisPoints(position.policy.fee.baseFeeBps)} · maximum{" "}
            {formatBasisPoints(position.policy.fee.maximumFeeBps)} · treasury{" "}
            {position.policy.fee.treasuryFeeRecipient}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Snapshot block</dt>
          <dd className="mt-1 text-slate-200">
            {snapshot?.blockNumber ?? "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Snapshot observed at</dt>
          <dd className="mt-1 text-slate-200">
            {snapshot?.observedAt ?? "Unavailable"}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-slate-500">Portfolio snapshot hash</dt>
          <dd className="mt-1 break-all text-xs text-slate-300">
            {snapshot?.snapshotHash ?? "Unavailable"}
          </dd>
        </div>
      </dl>
      <RiskEvidence positionId={space.identity.id} />
      {snapshot && (
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <caption className="mb-2 text-left text-sm font-semibold text-slate-300">
              Oracle prices and token scales
            </caption>
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-4">Asset</th>
                <th className="py-2 pr-4">Price</th>
                <th className="py-2 pr-4">Raw balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {snapshot.assets.map((asset) => (
                <tr key={asset.token}>
                  <th className="py-2 pr-4 font-medium text-slate-300">
                    {asset.symbol} ({asset.decimals} decimals)
                  </th>
                  <td className="py-2 pr-4 text-slate-300">
                    {formatPrice(asset.price, asset.priceDecimals)} · price
                    scale {asset.priceDecimals}
                  </td>
                  <td className="break-all py-2 pr-4 text-slate-500">
                    {asset.balance}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-5 text-xs leading-5 text-slate-500">
        Values above use the snapshot’s declared normalized settlement
        denomination. A normalized value is not automatically USD. Block, nonce,
        hash, token decimals, and provider mode are retained as evidence.
      </p>
    </details>
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
                  Balances, allocation ranges, and the maximum trade are shown
                  together so you can see what this Space can accept.
                </p>
              </div>
              <button
                type="button"
                onClick={refresh}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-cyan-500"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
                holdings
              </button>
            </div>
            <HoldingsTable position={position} snapshot={snapshot} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-sm text-slate-500">Global per-trade cap</p>
                <p className="mt-2 text-lg font-semibold text-white">
                  {formatGroupedDecimalUnits(
                    position.policy.maximumTransactionValue,
                    0,
                  )}{" "}
                  normalized settlement value
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  This applies across directions. It is not the executable
                  maximum for every asset.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-sm text-slate-500">Policy state</p>
                <p
                  className={
                    position.policy.paused
                      ? "mt-2 text-lg font-semibold text-amber-300"
                      : "mt-2 text-lg font-semibold text-emerald-300"
                  }
                >
                  {position.policy.paused
                    ? "Paused"
                    : "Trading allowed within Space rules"}
                </p>
                <div className="mt-2">
                  <Freshness position={position} />
                </div>
              </div>
            </div>
            <CapacityPanel position={position} snapshot={snapshot} />
            <AdvancedDetails
              space={space}
              position={position}
              snapshot={snapshot}
            />
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
                holdings are current.
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
              Space identity and owner-authorized controls. The name, status,
              and chain remain visible above while you edit.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <p className="text-sm text-slate-500">Trading status</p>
            <p className="mt-1 font-semibold text-white">{stateLabel(space)}</p>
            <details className="mt-4 text-sm text-slate-400">
              <summary className="cursor-pointer font-medium text-slate-300">
                Space identity details
              </summary>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Space ID</dt>
                  <dd className="mt-1 break-all text-slate-200">
                    {space.identity.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Network</dt>
                  <dd className="mt-1 text-slate-200">
                    Chain {space.identity.chainId}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Owner wallet</dt>
                  <dd className="mt-1 break-all text-slate-200">
                    {space.identity.ownerAddress}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Managed account</dt>
                  <dd className="mt-1 break-all text-slate-200">
                    {space.identity.treasuryAddress}
                  </dd>
                </div>
              </dl>
            </details>
          </div>
          {space.failureReason && (
            <p className="rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">
              Space setup could not be confirmed. Review the form and try again.
            </p>
          )}
          {space.identity.state === "PRICING_NEEDS_RENEWAL" && (
            <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-200">
              This fixed-price Space no longer matches current normalized
              prices. Trading and agent proposals stay blocked. There is no
              renewal button: the owner/operator must pause, dock Aqua, withdraw
              the exact vault balances, and create a replacement Space with
              current pricing.
            </p>
          )}
          {!editing &&
            ["DRAFT", "PENDING", "FAILED"].includes(space.identity.state) && (
              <SpaceForm existing={space} embedded />
            )}
          {!editing && ["ACTIVE", "PAUSED"].includes(space.identity.state) && (
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
            appMode !== "fork" &&
            space.identity.state === "DRAFT" && (
              <p className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-6 text-slate-400">
                This draft has no holdings yet. Activation requires the recorded
                owner wallet.
              </p>
            )}
        </div>
      )}
    </SpacePage>
  );
}
