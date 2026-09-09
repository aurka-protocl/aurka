import { useEffect, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import {
  formatBasisPoints,
  formatSnapshotAge,
  formatTokenAmount,
  formatValueAmount,
  snapshotFreshness,
  type Position,
} from "@aurka/shared";
import { appMode } from "../config";
import {
  spaceAdapter,
  spaceUrl,
  tradeUrl,
  type SpaceRecord,
} from "../domain/spaces";
import ForkSpace from "./ForkSpace";

function decodeSpaceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  readonly children: (space: SpaceRecord) => React.ReactNode;
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
              ? requestError.message
              : "The requested Space does not exist",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey, spaceId]);

  if (loading)
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold text-white">Loading Space…</h1>
        <p aria-live="polite" className="text-slate-400">
          Reading the current Space state.
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
          We could not load “{spaceId ?? "unknown"}”. It may have been removed,
          or this environment does not expose it.
        </p>
        <button
          type="button"
          onClick={() => setRefreshKey((current) => current + 1)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-cyan-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
        </button>
      </section>
    );

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
          <p className="mt-4 text-sm text-slate-500">
            AURKA Space · chain {space.identity.chainId}
          </p>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight text-white">
            {space.identity.name}
          </h1>
        </div>
        <Link
          to={tradeUrl(space.identity.id)}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600"
        >
          Trade this Space <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
      <SpaceTabs space={space} />
      {children(space)}
    </section>
  );
}

function Freshness({ position }: { readonly position: Position }) {
  const snapshot = position.currentPortfolio;
  if (!snapshot)
    return (
      <p className="text-sm text-slate-400">
        Current holdings are unavailable.
      </p>
    );
  const now = Math.floor(Date.now() / 1000);
  const freshness = snapshotFreshness(
    snapshot.observedAt,
    now,
    position.policy.priceMaxAgeSeconds,
  );
  return (
    <p
      className={`text-sm ${freshness === "fresh" ? "text-emerald-300" : "text-amber-300"}`}
    >
      {freshness === "fresh" ? "Current snapshot" : "Stale snapshot"} · observed{" "}
      {formatSnapshotAge(snapshot.observedAt, now)} · block{" "}
      {snapshot.blockNumber}
    </p>
  );
}

export function SpaceOverview() {
  return (
    <SpacePage>
      {(space) => {
        const snapshot = space.position.currentPortfolio;
        return (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Portfolio value
                </p>
                <p className="mt-2 text-2xl font-semibold text-cyan-200">
                  {snapshot
                    ? `${formatValueAmount(snapshot.nav, snapshot.valueDecimals)} value units`
                    : "Unavailable"}
                </p>
                <Freshness position={space.position} />
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Trading boundary
                </p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatValueAmount(
                    space.position.policy.maximumTransactionValue,
                    0,
                  )}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  maximum value units per trade
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
                  rules checked at settlement
                </p>
              </div>
            </div>
            <div className="rounded-2xl border border-cyan-900/70 bg-cyan-950/30 p-5 sm:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
                What this Space does
              </p>
              <h2 className="mt-2 text-xl font-semibold text-white">
                Set trading boundaries once; review what changed.
              </h2>
              <p className="mt-3 max-w-3xl leading-7 text-slate-300">
                Other wallets can request an exchange against this Space. AURKA
                checks the resulting portfolio, transaction limit, price
                snapshot, and current authorization before settlement.
              </p>
              <Link
                to={spaceUrl(space.identity.id, "holdings")}
                className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg border border-cyan-700 px-4 py-2.5 text-sm font-medium text-cyan-100 hover:bg-cyan-900/50"
              >
                Review holdings &amp; rules{" "}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
            <dl className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Space owner</dt>
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
          </div>
        );
      }}
    </SpacePage>
  );
}

export function SpaceHoldings() {
  return (
    <SpacePage>
      {(space) => {
        const snapshot = space.position.currentPortfolio;
        return (
          <div className="space-y-5">
            <div>
              <h2 className="text-2xl font-semibold text-white">
                Holdings &amp; rules
              </h2>
              <p className="mt-2 max-w-3xl leading-7 text-slate-400">
                These are the holdings and hard boundaries used to decide
                whether a requested trade can settle. Current allocation is
                evidence, not a promise that market prices remain fixed.
              </p>
            </div>
            {snapshot ? (
              <div className="overflow-x-auto rounded-2xl border border-slate-700 bg-slate-900">
                <table className="min-w-full text-left text-sm">
                  <caption className="sr-only">
                    Holdings and rules for {space.identity.name}
                  </caption>
                  <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-3">Asset</th>
                      <th className="px-5 py-3">Balance</th>
                      <th className="px-5 py-3">Value units</th>
                      <th className="px-5 py-3">Current allocation</th>
                      <th className="px-5 py-3">Allowed range</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {snapshot.assets.map((asset) => {
                      const rule = space.position.policy.assets.find(
                        (candidate) =>
                          candidate.token.toLowerCase() ===
                          asset.token.toLowerCase(),
                      );
                      return (
                        <tr key={asset.token}>
                          <th className="whitespace-nowrap px-5 py-4 font-medium text-white">
                            {asset.symbol}
                          </th>
                          <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                            {formatTokenAmount(asset.balance, asset.decimals)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                            {formatValueAmount(
                              asset.value,
                              snapshot.valueDecimals,
                            )}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                            {formatBasisPoints(asset.weightBps)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-slate-300">
                            {rule
                              ? `${formatBasisPoints(rule.minimumWeightBps)} – ${formatBasisPoints(rule.maximumWeightBps)}`
                              : "Not configured"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-amber-200">
                Holdings are not available from the configured source.
              </p>
            )}
            <dl className="grid gap-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Per-trade cap</dt>
                <dd className="mt-1 text-lg font-semibold text-white">
                  {formatValueAmount(
                    space.position.policy.maximumTransactionValue,
                    0,
                  )}{" "}
                  value units
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Policy state</dt>
                <dd
                  className={
                    space.position.policy.paused
                      ? "mt-1 text-lg font-semibold text-amber-300"
                      : "mt-1 text-lg font-semibold text-emerald-300"
                  }
                >
                  {space.position.policy.paused
                    ? "Paused"
                    : "Open under hard rules"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-slate-500">Snapshot freshness</dt>
                <dd className="mt-1">
                  <Freshness position={space.position} />
                </dd>
              </div>
            </dl>
            <Link
              to={tradeUrl(space.identity.id)}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600"
            >
              Preview a trade{" "}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        );
      }}
    </SpacePage>
  );
}

export function SpaceSettings() {
  return (
    <SpacePage>
      {(space) => (
        <div className="space-y-5">
          <div>
            <h2 className="text-2xl font-semibold text-white">Settings</h2>
            <p className="mt-2 max-w-3xl leading-7 text-slate-400">
              Identity and authority details for this Space. Governance editing
              is intentionally limited to the local fork controls when that
              environment is active.
            </p>
          </div>
          <dl className="grid gap-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Space ID</dt>
              <dd className="mt-1 break-all text-slate-200">
                {space.identity.id}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Chain</dt>
              <dd className="mt-1 text-slate-200">{space.identity.chainId}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Owner</dt>
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
          {appMode === "fork" ? (
            <ForkSpace owner spaceId={space.identity.id} embedded />
          ) : (
            <p className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-6 text-slate-400">
              This demo Space is read-only. No wallet action is requested just
              to inspect its identity or rules.
            </p>
          )}
        </div>
      )}
    </SpacePage>
  );
}

export function SpaceTradeRedirect() {
  const { spaceId: rawSpaceId } = useParams<{ spaceId: string }>();
  const spaceId = decodeSpaceId(rawSpaceId);
  return spaceId ? <ForkSpace spaceId={spaceId} /> : <SpaceTradePicker />;
}

function SpaceTradePicker() {
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    spaceAdapter
      .listSpaces(1)
      .then((spaces) => setTarget(spaces[0]?.identity.id ?? null))
      .catch((requestError: unknown) =>
        setError(
          requestError instanceof Error
            ? requestError.message
            : "No Space is available",
        ),
      );
  }, []);
  return (
    <section className="space-y-4">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
        Trade
      </p>
      <h1 className="text-3xl font-semibold text-white">Choose a Space</h1>
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-red-200"
        >
          Trade is unavailable: {error}
        </p>
      ) : !target ? (
        <p aria-live="polite" className="text-slate-400">
          Finding a Space for this trade…
        </p>
      ) : (
        <Link to={tradeUrl(target)} className="text-cyan-300 underline">
          Continue to the available Space
        </Link>
      )}
    </section>
  );
}
