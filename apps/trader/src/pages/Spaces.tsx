import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Boxes, RefreshCw } from "lucide-react";
import {
  formatSnapshotAge,
  formatValueAmount,
  snapshotFreshness,
} from "@aurka/shared";
import { appMode } from "../config";
import { spaceAdapter, spaceUrl, type SpaceRecord } from "../domain/spaces";
import { useWallet } from "../wallet";

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function SpaceCard({ space }: { readonly space: SpaceRecord }) {
  const snapshot = space.position?.currentPortfolio;
  const now = Math.floor(Date.now() / 1000);
  const freshness = snapshot
    ? snapshotFreshness(
        snapshot.observedAt,
        now,
        space.position?.policy.priceMaxAgeSeconds,
      )
    : "unknown";
  const stateClass =
    space.identity.state === "ACTIVE"
      ? "border-emerald-800 bg-emerald-950/30 text-emerald-300"
      : space.identity.state === "PAUSED"
        ? "border-amber-800 bg-amber-950/30 text-amber-300"
        : space.identity.state === "FAILED"
          ? "border-red-800 bg-red-950/30 text-red-300"
          : "border-slate-700 bg-slate-950 text-slate-300";
  return (
    <article className="min-w-0 rounded-2xl border border-slate-700 bg-slate-900 p-5 transition hover:border-cyan-700 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl bg-cyan-950/70 p-2.5 text-cyan-300">
            <Boxes className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold text-white">
              {space.identity.name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {space.identity.ownerAddress
                ? `Owner ${shortAddress(space.identity.ownerAddress)} · `
                : ""}
              chain {space.identity.chainId}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">
          {space.identity.state}
        </span>
      </div>

      <dl className="mt-6 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">
            Portfolio value
          </dt>
          <dd className="mt-1 font-semibold text-cyan-200">
            {snapshot
              ? `${formatValueAmount(snapshot.nav, snapshot.valueDecimals)} value units`
              : space.draft
                ? "Not deployed"
                : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">
            Managed assets
          </dt>
          <dd className="mt-1 font-semibold text-white">
            {snapshot?.assets.length ?? space.draft?.assets.length ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">
            Snapshot
          </dt>
          <dd
            className={`mt-1 font-semibold ${freshness === "stale" ? "text-amber-300" : "text-emerald-300"}`}
          >
            {snapshot
              ? `${freshness === "stale" ? "Stale" : "Observed"} · ${formatSnapshotAge(snapshot.observedAt, now)}`
              : space.identity.state === "DRAFT"
                ? "Save complete · activation pending"
                : "Unavailable"}
          </dd>
        </div>
      </dl>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-1 text-[11px] ${stateClass}`}
        >
          {space.identity.state === "PENDING"
            ? "Deployment pending"
            : space.identity.state}
        </span>
        <Link
          to={spaceUrl(space.identity.id)}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600"
        >
          Open Space <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
        <Link
          to={spaceUrl(space.identity.id, "holdings")}
          className="inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-200 hover:border-cyan-600"
        >
          Holdings &amp; rules
        </Link>
      </div>
    </article>
  );
}

export default function Spaces() {
  const wallet = useWallet();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    spaceAdapter
      .listSpaces(50, wallet.address ?? undefined)
      .then((next) => {
        if (active) setSpaces(next);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Spaces could not be loaded",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey, wallet.address]);

  return (
    <section className="space-y-6 text-slate-200">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
            AURKA Spaces
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {wallet.address ? "Your Aurka Spaces" : "Available Aurka Spaces"}
          </h1>
          <p className="mt-3 max-w-2xl leading-7 text-slate-400">
            {wallet.address
              ? "Create and manage the portfolios authorized by your connected wallet."
              : "Connect a wallet to see your Spaces and manage their rules. You can still inspect available demo portfolios."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {wallet.address && (
            <Link
              to="/spaces/new"
              className="inline-flex min-h-10 items-center rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600"
            >
              Create Space
            </Link>
          )}
          <button
            type="button"
            onClick={() => setRefreshKey((current) => current + 1)}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-cyan-500"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <p
          aria-live="polite"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-slate-400"
        >
          Loading Spaces…
        </p>
      ) : error ? (
        <div
          role="alert"
          className="space-y-4 rounded-2xl border border-red-900/70 bg-red-950/30 p-6"
        >
          <h2 className="text-lg font-semibold text-white">
            Spaces are unavailable
          </h2>
          <p className="text-sm leading-6 text-red-200">
            The data service could not answer: {error}
          </p>
          <button
            type="button"
            onClick={() => setRefreshKey((current) => current + 1)}
            className="rounded-lg border border-red-800 px-4 py-2 text-sm text-red-100 hover:border-red-500"
          >
            Try again
          </button>
        </div>
      ) : spaces.length === 0 ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6">
          <h2 className="text-lg font-semibold text-white">No Spaces yet</h2>
          <p className="mt-2 max-w-xl leading-6 text-slate-400">
            {wallet.address
              ? "Create a Space to define its supported assets, allocation ranges, and transaction limit."
              : "No configured portfolio is available in this environment. Connect the owner wallet to create a Space."}
          </p>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {spaces.map((space) => (
            <SpaceCard key={space.identity.id} space={space} />
          ))}
        </div>
      )}

      <p className="text-xs text-slate-500">
        {appMode === "fork"
          ? "Fork balances and policy state are read from the local chain; test funds only."
          : "This local demo uses a configured example Space. Values retain their declared units."}
      </p>
    </section>
  );
}
