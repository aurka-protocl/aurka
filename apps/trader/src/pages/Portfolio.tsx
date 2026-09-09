import { useEffect, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import {
  formatBasisPoints,
  formatSnapshotAge,
  formatTokenAmount,
  formatValueAmount,
  snapshotFreshness,
  type Position,
} from "@aurka/shared";
import { apiBaseUrl } from "../config";

export default function Portfolio() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const client = new AurkaClient({ baseUrl: apiBaseUrl });
    client
      .listPositions(20, cursor)
      .then((response) => {
        if (!active) return;
        setPositions(response.items);
        setNextCursor(response.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Request failed",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cursor, refreshKey]);

  if (loading) {
    return (
      <div
        className="flex min-h-64 items-center justify-center text-slate-400"
        aria-live="polite"
      >
        Loading treasury snapshots…
      </div>
    );
  }

  if (error) {
    return (
      <section className="space-y-4" role="alert">
        <h1 className="text-3xl font-semibold text-white">
          Treasury liquidity
        </h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          Holdings are unavailable because the local data service could not
          answer: {error}
        </p>
        <button
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
        >
          Try again
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-6 text-slate-200">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
            Treasury overview
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-white">
            Demo treasury liquidity
          </h1>
          <p className="mt-3 max-w-2xl leading-7 text-slate-400">
            This is an organization’s example liquidity source, not a personal
            trader portfolio or a connected wallet. Values retain their declared
            units; performance history is unavailable.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-cyan-500"
        >
          Refresh snapshot
        </button>
      </div>

      {positions.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
          <h2 className="font-semibold text-white">No treasury snapshots</h2>
          <p className="mt-2 text-slate-400">
            No configured liquidity source is available. Check System status or
            try refreshing when the local service is running.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {positions.map((position) => (
            <PositionCard key={position.id} position={position} />
          ))}
        </div>
      )}

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
    </div>
  );
}

function PositionCard({ position }: { readonly position: Position }) {
  const snapshot = position.currentPortfolio;
  const now = Math.floor(Date.now() / 1000);
  const freshness = snapshot
    ? snapshotFreshness(
        snapshot.observedAt,
        now,
        position.policy.priceMaxAgeSeconds,
      )
    : "unknown";

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-6">
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">{position.name}</h2>
          <p className="mt-1 text-sm text-slate-400">
            Organization-owned local example · read-only snapshot
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-slate-500">Portfolio value</p>
          <p className="text-xl font-semibold text-cyan-200">
            {snapshot
              ? `${formatValueAmount(snapshot.nav, snapshot.valueDecimals)} value units`
              : "Unavailable"}
          </p>
          {snapshot && (
            <p className="text-xs text-slate-500">
              scale {snapshot.valueDecimals} · no denomination established
            </p>
          )}
        </div>
      </div>

      {snapshot ? (
        <>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <span
              className={
                freshness === "fresh"
                  ? "text-emerald-300"
                  : freshness === "stale"
                    ? "text-amber-300"
                    : "text-slate-400"
              }
            >
              {freshness === "fresh"
                ? "Snapshot available"
                : freshness === "stale"
                  ? "Stale snapshot"
                  : "Freshness unavailable"}
            </span>
            <span className="text-slate-400">
              Observed {formatSnapshotAge(snapshot.observedAt, now)} · block{" "}
              {snapshot.blockNumber}
            </span>
          </div>
          {freshness === "stale" && (
            <p className="mt-3 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
              This snapshot is older than the policy’s declared price-age
              window. It remains visible as evidence, but should not be treated
              as current executable liquidity.
            </p>
          )}
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <caption className="sr-only">Holdings in {position.name}</caption>
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Asset</th>
                  <th className="py-2 pr-4">Balance</th>
                  <th className="py-2 pr-4">Value units</th>
                  <th className="py-2">Allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {snapshot.assets.map((asset) => (
                  <tr key={asset.token}>
                    <th className="py-3 pr-4 font-medium text-slate-200">
                      {asset.symbol}
                    </th>
                    <td className="py-3 pr-4 text-slate-300">
                      {formatTokenAmount(asset.balance, asset.decimals)}{" "}
                      <span className="text-xs text-slate-500">
                        (decimals {asset.decimals})
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-slate-300">
                      {formatValueAmount(asset.value, snapshot.valueDecimals)}
                    </td>
                    <td className="py-3 text-slate-300">
                      {formatBasisPoints(asset.weightBps)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-4 text-xs text-slate-500">
            <summary className="cursor-pointer">Snapshot provenance</summary>
            <p className="mt-2 break-all leading-5">
              Service portfolio snapshot · observedAt {snapshot.observedAt} ·
              block {snapshot.blockNumber} · snapshot hash{" "}
              {snapshot.snapshotHash}
            </p>
          </details>
        </>
      ) : (
        <p className="mt-4 text-slate-400">
          No portfolio snapshot was supplied by the configured source.
        </p>
      )}
    </section>
  );
}
