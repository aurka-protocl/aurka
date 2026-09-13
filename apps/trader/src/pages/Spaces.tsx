import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Boxes, RefreshCw } from "lucide-react";
import { formatGroupedDecimalUnits } from "@aurka/shared";
import {
  invalidateSpaceCache,
  spaceAdapter,
  spaceUrl,
  type SpaceRecord,
} from "../domain/spaces";
import {
  displayAssetSymbol,
  lifecycleLabel,
  shortAddress,
  userFacingError,
} from "../ui";
import { useWallet } from "../wallet";

function SpaceCard({ space }: { readonly space: SpaceRecord }) {
  const snapshot = space.position?.currentPortfolio;
  const stateClass =
    space.identity.state === "ACTIVE"
      ? "border-emerald-800 bg-emerald-950/30 text-emerald-300"
      : space.identity.state === "PAUSED"
        ? "border-amber-800 bg-amber-950/30 text-amber-300"
          : space.identity.state === "PRICING_NEEDS_RENEWAL" ||
              space.identity.state === "STRATEGY_MISMATCH"
          ? "border-amber-800 bg-amber-950/30 text-amber-300"
          : space.identity.state === "REACTIVATION_REQUIRED"
            ? "border-amber-800 bg-amber-950/30 text-amber-300"
            : space.identity.state === "FAILED"
              ? "border-red-800 bg-red-950/30 text-red-300"
              : "border-slate-700 bg-slate-950 text-slate-300";
  return (
    <Link
      to={spaceUrl(space.identity.id)}
      aria-label={`Open ${space.identity.name}`}
      className="group block min-w-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
    >
      <article className="min-w-0 rounded-2xl border border-slate-700 bg-slate-900 p-5 transition group-hover:border-cyan-700 group-focus-visible:border-cyan-500 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-xl bg-cyan-950/70 p-2.5 text-cyan-300">
              <Boxes className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold text-white">
                {space.identity.name}
              </h2>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${stateClass}`}
          >
            {space.identity.state === "ACTIVE"
              ? "Online"
              : lifecycleLabel(space.identity.state)}
          </span>
        </div>

        <dl className="mt-6 space-y-5">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Owner
            </dt>
            <dd
              className="mt-1 font-mono text-sm text-slate-200"
              title={space.identity.ownerAddress}
            >
              {shortAddress(space.identity.ownerAddress)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Amounts
            </dt>
            <dd className="mt-2 flex flex-wrap gap-2">
              {snapshot?.assets.length ? (
                snapshot.assets.map((asset) => (
                  <span
                    key={asset.token}
                    className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 font-semibold text-cyan-100"
                  >
                    {formatGroupedDecimalUnits(asset.balance, asset.decimals)}{" "}
                    {displayAssetSymbol(asset.symbol)}
                  </span>
                ))
              ) : (
                <span className="text-sm text-slate-400">
                  {space.draft ? "Not active yet" : "Unavailable"}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </article>
    </Link>
  );
}

function hasSpaceAmounts(space: SpaceRecord): boolean {
  const assets = space.position?.currentPortfolio?.assets;
  // If balances are unavailable, keep the Space visible rather than hiding
  // funds that have not finished syncing yet.
  if (!assets) return true;
  return assets.some((asset) => BigInt(asset.balance) > 0n);
}

export default function Spaces() {
  const wallet = useWallet();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [view, setView] = useState<"all" | "owned">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    spaceAdapter
      .listSpaces(100)
      .then((next) => {
        if (active) setSpaces(next);
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            requestError instanceof Error
              ? userFacingError(requestError, "Spaces could not be loaded")
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

  const showingOwned = view === "owned" && wallet.address !== undefined;
  const visibleSpaces = spaces.filter((space) => {
    const isOwner =
      wallet.address?.toLowerCase() === space.identity.ownerAddress.toLowerCase();
    if (showingOwned) return isOwner && hasSpaceAmounts(space);
    return !isOwner || hasSpaceAmounts(space);
  });

  return (
    <section className="space-y-6 text-slate-200">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Spaces
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {showingOwned ? "Your Spaces" : "All Spaces"}
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">
          {wallet.address
            ? "Browse available Spaces or view the ones owned by your wallet."
            : "Browse available Spaces. Connect a wallet to create and manage your own."}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex rounded-xl border border-slate-700 bg-slate-900 p-1"
          role="tablist"
          aria-label="Space list"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!showingOwned}
            onClick={() => setView("all")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${!showingOwned ? "bg-cyan-700 text-white" : "text-slate-400 hover:text-white"}`}
          >
            All spaces
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showingOwned}
            disabled={!wallet.address}
            onClick={() => setView("owned")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${showingOwned ? "bg-cyan-700 text-white" : "text-slate-400 hover:text-white"} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Your spaces
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/spaces/new"
            className="inline-flex min-h-10 items-center rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600"
          >
            Create Space
          </Link>
          <button
            type="button"
            onClick={() => {
              invalidateSpaceCache();
              setRefreshKey((current) => current + 1);
            }}
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
          Loading your Spaces…
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
            We couldn't load your Spaces. {error}
          </p>
          <button
            type="button"
            onClick={() => {
              invalidateSpaceCache();
              setRefreshKey((current) => current + 1);
            }}
            className="rounded-lg border border-red-800 px-4 py-2 text-sm text-red-100 hover:border-red-500"
          >
            Try again
          </button>
        </div>
      ) : visibleSpaces.length === 0 ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6">
          <h2 className="text-lg font-semibold text-white">
            {showingOwned ? "No funded Spaces yet" : "No Spaces available"}
          </h2>
          <p className="mt-2 max-w-xl leading-6 text-slate-400">
            {showingOwned
              ? "Create or fund a Space to see it in Your spaces."
              : "Spaces will appear here when they are available."}
          </p>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {visibleSpaces.map((space) => (
            <SpaceCard key={space.identity.id} space={space} />
          ))}
        </div>
      )}
    </section>
  );
}
