import { useEffect, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import {
  bindingConstraintLabel,
  formatBasisPoints,
  formatDecimalUnits,
  formatSnapshotAge,
  formatTokenAmount,
  formatValueAmount,
  snapshotFreshness,
  type AssetSnapshot,
  type DirectionalCapacity,
  type Position,
  type PortfolioSnapshot,
} from "@aurka/shared";
import { ArrowRight, Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import { appLinks } from "../config";

type ExchangeAsset = Pick<AssetSnapshot, "token" | "symbol">;

interface ExchangePair {
  readonly input: ExchangeAsset;
  readonly output: ExchangeAsset;
}

const ALLOCATION_COLORS = [
  "bg-violet-400",
  "bg-cyan-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-rose-400",
  "bg-blue-400",
] as const;

function configuredExchangePair(position: Position): ExchangePair | undefined {
  const assets = position.currentPortfolio?.assets ?? position.policy.assets;
  const input =
    assets.find((asset) => asset.symbol.toUpperCase() === "WETH") ??
    assets[1] ??
    assets[0];
  const output =
    assets.find(
      (asset) =>
        asset.symbol.toUpperCase() === "USDC" &&
        asset.token.toLowerCase() !== input?.token.toLowerCase(),
    ) ?? assets.find((asset) => asset.token !== input?.token);
  if (!input || !output) return undefined;
  return { input, output };
}

function swapPreviewUrl(): string {
  return `${appLinks.trader.replace(/\/+$/, "")}/swap`;
}

function formatCapacityValue(
  value: string,
  position: Position,
  suffix = "value units",
): string {
  const decimals = position.currentPortfolio?.valueDecimals;
  if (decimals === undefined) return `${value} ${suffix} (scale unavailable)`;
  return `${formatValueAmount(value, decimals)} ${suffix}`;
}

export default function Positions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<DirectionalCapacity | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [capacityLoading, setCapacityLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const client = new AurkaClient({ baseUrl: "/api" });
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

  useEffect(() => {
    if (positions.length === 0) {
      setSelectedPositionId("");
      return;
    }
    setSelectedPositionId((current) =>
      positions.some((position) => position.id === current)
        ? current
        : (positions[0]?.id ?? ""),
    );
  }, [positions]);

  const selectedPosition = positions.find(
    (position) => position.id === selectedPositionId,
  );
  const pair = selectedPosition
    ? configuredExchangePair(selectedPosition)
    : undefined;
  const inputToken = pair?.input.token;
  const outputToken = pair?.output.token;

  useEffect(() => {
    let active = true;
    if (!selectedPosition || !inputToken || !outputToken) {
      setCapacity(null);
      setCapacityError(null);
      setCapacityLoading(false);
      return () => {
        active = false;
      };
    }

    setCapacity(null);
    setCapacityError(null);
    setCapacityLoading(true);
    const client = new AurkaClient({ baseUrl: "/api" });
    client
      .getCapacity(selectedPosition.id, inputToken, outputToken)
      .then((result) => {
        if (active) setCapacity(result);
      })
      .catch((requestError: unknown) => {
        if (active)
          setCapacityError(
            requestError instanceof Error
              ? requestError.message
              : "Capacity request failed",
          );
      })
      .finally(() => {
        if (active) setCapacityLoading(false);
      });

    return () => {
      active = false;
    };
  }, [inputToken, outputToken, refreshKey, selectedPosition]);

  if (loading) {
    return (
      <div
        className="flex min-h-64 items-center justify-center text-slate-400"
        aria-live="polite"
      >
        Loading holdings and rules…
      </div>
    );
  }

  if (error) {
    return (
      <section className="space-y-4" role="alert">
        <h1 className="text-3xl font-semibold text-white">
          Holdings &amp; rules
        </h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          The treasury data service could not answer: {error}
        </p>
        <button
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-violet-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-6 text-slate-200">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300">
            Treasury overview
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-white">
            Holdings &amp; rules
          </h1>
          <p className="mt-3 max-w-2xl leading-7 text-slate-400">
            See what the organization’s configured treasury holds, which trades
            its read-only rules accept, and the directional liquidity currently
            available for the demo exchange pair.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-violet-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh snapshot
        </button>
      </div>

      {positions.length === 0 ? (
        <EmptyTreasuryState />
      ) : (
        <>
          <section
            aria-labelledby="treasury-selection-heading"
            className="rounded-2xl border border-violet-900/70 bg-violet-950/30 p-5 sm:p-6"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  id="treasury-selection-heading"
                  className="text-lg font-semibold text-white"
                >
                  Choose a treasury configuration
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-300">
                  The example loads the first named configuration automatically.
                  Select another one when more are available; snapshots are
                  shown separately and are never added together.
                </p>
              </div>
              <label className="block w-full sm:max-w-sm">
                <span className="text-sm font-medium text-slate-200">
                  Treasury
                </span>
                <select
                  aria-label="Treasury configuration"
                  value={selectedPositionId}
                  onChange={(event) =>
                    setSelectedPositionId(event.target.value)
                  }
                  className="mt-1 block w-full rounded-lg border border-violet-700 bg-slate-900 p-2.5 text-slate-100"
                >
                  {positions.map((position) => (
                    <option key={position.id} value={position.id}>
                      {position.name} · {position.policy.assets.length} assets ·{" "}
                      {position.currentPortfolio
                        ? "snapshot available"
                        : "snapshot unavailable"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {selectedPosition && (
            <TreasuryCard
              position={selectedPosition}
              capacity={capacity}
              capacityError={capacityError}
              capacityLoading={capacityLoading}
              pair={pair}
            />
          )}
        </>
      )}

      {positions.length > 0 && (
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
      )}
    </div>
  );
}

function EmptyTreasuryState() {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-6">
      <h2 className="font-semibold text-white">No treasury configured</h2>
      <p className="mt-2 max-w-2xl leading-7 text-slate-400">
        There are no holdings or active rules to display. This screen is
        read-only and cannot create or fund a treasury.
      </p>
      <a
        href={swapPreviewUrl()}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white hover:bg-cyan-500"
      >
        Try the demo swap instead
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </a>
    </section>
  );
}

function TreasuryCard({
  position,
  capacity,
  capacityError,
  capacityLoading,
  pair,
}: {
  readonly position: Position;
  readonly capacity: DirectionalCapacity | null;
  readonly capacityError: string | null;
  readonly capacityLoading: boolean;
  readonly pair: ExchangePair | undefined;
}) {
  const snapshot = position.currentPortfolio;
  const now = Math.floor(Date.now() / 1000);
  const freshness = snapshot
    ? snapshotFreshness(
        snapshot.observedAt,
        now,
        position.policy.priceMaxAgeSeconds,
      )
    : "unknown";
  const headingId = `treasury-${position.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
            Selected configuration
          </p>
          <h2 id={headingId} className="mt-2 text-xl font-semibold text-white">
            {position.name}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Organization-owned local example · policy and holdings are read-only
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-slate-500">Snapshot value</p>
          <p className="text-xl font-semibold text-violet-200">
            {snapshot
              ? `${formatValueAmount(snapshot.nav, snapshot.valueDecimals)} value units`
              : "Unavailable"}
          </p>
          {snapshot && (
            <p className="text-xs text-slate-500">
              scale {snapshot.valueDecimals} · denomination unavailable
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-violet-700/70 bg-violet-950/60 px-3 py-1.5 text-violet-200">
          Rule source: local demo service response
        </span>
        <span className="rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-slate-300">
          Read-only · currentness not verified here
        </span>
      </div>

      {snapshot ? (
        <SnapshotSection
          snapshot={snapshot}
          freshness={freshness}
          now={now}
          position={position}
        />
      ) : (
        <p className="mt-5 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          Policy rules are available, but no portfolio snapshot was supplied.
          Balances, allocation, valuation, and actionable capacity remain
          unavailable until a snapshot is provided.
        </p>
      )}

      <RulesSection position={position} snapshot={snapshot} />
      <CapacitySection
        position={position}
        pair={pair}
        capacity={capacity}
        capacityError={capacityError}
        capacityLoading={capacityLoading}
        now={now}
      />
    </section>
  );
}

function SnapshotSection({
  snapshot,
  freshness,
  now,
  position,
}: {
  readonly snapshot: PortfolioSnapshot;
  readonly freshness: ReturnType<typeof snapshotFreshness>;
  readonly now: number;
  readonly position: Position;
}) {
  return (
    <div>
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
              ? "Stale evidence"
              : "Freshness unavailable"}
        </span>
        <span className="text-slate-400">
          Observed {formatSnapshotAge(snapshot.observedAt, now)} · block{" "}
          {snapshot.blockNumber}
        </span>
      </div>
      {freshness === "stale" && (
        <p className="mt-3 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          This evidence is outside the policy’s declared price-age window; do
          not treat it as current executable liquidity.
        </p>
      )}

      <AllocationGraphic snapshot={snapshot} />

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">
            Holdings and current allocation for {position.name}
          </caption>
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-4">Asset</th>
              <th className="py-2 pr-4">Balance</th>
              <th className="py-2 pr-4">Value units</th>
              <th className="py-2 pr-4">Current allocation</th>
              <th className="py-2">Allowed range</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {snapshot.assets.map((asset) => {
              const bound = position.policy.assets.find(
                (candidate) =>
                  candidate.token.toLowerCase() === asset.token.toLowerCase(),
              );
              return (
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
                  <td className="py-3 pr-4 text-slate-300">
                    {formatBasisPoints(asset.weightBps)}
                  </td>
                  <td className="py-3 text-slate-300">
                    {bound
                      ? `${formatBasisPoints(bound.minimumWeightBps)} – ${formatBasisPoints(bound.maximumWeightBps)}`
                      : "Rule unavailable"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AllocationGraphic({
  snapshot,
}: {
  readonly snapshot: PortfolioSnapshot;
}) {
  const accessibleSummary = snapshot.assets
    .map((asset) => `${asset.symbol} ${formatBasisPoints(asset.weightBps)}`)
    .join(", ");
  return (
    <figure className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <figcaption className="font-medium text-slate-100">
        Allocation by normalized value
      </figcaption>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        The graphic and legend use the same allocation values as the table;
        balances are not summed across configurations.
      </p>
      <div
        role="img"
        aria-label={`Treasury allocation: ${accessibleSummary}`}
        className="mt-4 flex h-7 w-full overflow-hidden rounded-full bg-slate-800"
      >
        {snapshot.assets.map((asset, index) => (
          <div
            key={asset.token}
            className={`${ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]} min-w-0 border-r border-slate-950/70`}
            style={{ width: `${asset.weightBps / 100}%` }}
            title={`${asset.symbol}: ${formatBasisPoints(asset.weightBps)}`}
          />
        ))}
      </div>
      <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {snapshot.assets.map((asset, index) => (
          <li
            key={asset.token}
            className="flex items-center gap-2 text-slate-300"
          >
            <span
              className={`h-3 w-3 shrink-0 rounded-sm ${ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]}`}
              aria-hidden="true"
            />
            <span>
              {asset.symbol}: {formatBasisPoints(asset.weightBps)}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function RulesSection({
  position,
  snapshot,
}: {
  readonly position: Position;
  readonly snapshot: PortfolioSnapshot | undefined;
}) {
  const policy = position.policy;
  return (
    <section
      aria-labelledby="rules-heading"
      className="mt-6 border-t border-slate-800 pt-5"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck
          className="mt-1 h-5 w-5 shrink-0 text-violet-300"
          aria-hidden="true"
        />
        <div>
          <h3 id="rules-heading" className="text-lg font-semibold text-white">
            Read-only trading rules
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            A permitted trade must stay within these ranges. Rules limit
            accepted trades; they do not insure against price declines or
            guarantee investment safety.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Rule
          label="Per-trade cap"
          value={formatCapacityValue(policy.maximumTransactionValue, position)}
        />
        <Rule
          label="Policy pause"
          value={
            policy.paused ? "Paused: trades are not accepted" : "Not paused"
          }
        />
        <Rule
          label="Paused assets"
          value={
            policy.paused
              ? "All assets covered by this policy"
              : "Asset-level pause status unavailable"
          }
        />
        <Rule
          label="Price age"
          value={`${policy.priceMaxAgeSeconds}s maximum snapshot age`}
        />
        <Rule
          label="Price deviation"
          value={`${formatBasisPoints(policy.maximumPriceDeviationBps)} maximum`}
        />
        <Rule
          label="Base fee"
          value={`${formatBasisPoints(policy.fee.baseFeeBps)}; quote-dependent total`}
        />
        <Rule
          label="Quote lifetime"
          value={`${policy.quoteTtlSeconds}s from the service quote`}
        />
        <Rule
          label="Rule currentness"
          value="Demo/service response; not verified against live governance"
        />
        <Rule
          label="Snapshot context"
          value={
            snapshot
              ? `Observed at block ${snapshot.blockNumber}`
              : "No snapshot supplied"
          }
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">
            Allocation rules for {position.name}
          </caption>
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-4">Managed asset</th>
              <th className="py-2 pr-4">Minimum allocation</th>
              <th className="py-2">Maximum allocation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {policy.assets.map((asset) => (
              <tr key={asset.token}>
                <th className="py-3 pr-4 font-medium text-slate-200">
                  {asset.symbol}
                </th>
                <td className="py-3 pr-4 text-slate-300">
                  {formatBasisPoints(asset.minimumWeightBps)}
                </td>
                <td className="py-3 text-slate-300">
                  {formatBasisPoints(asset.maximumWeightBps)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-4 text-xs text-slate-500">
        <summary className="cursor-pointer">Technical provenance</summary>
        <p className="mt-2 break-all leading-5">
          Position {position.id} · owner {position.owner} · treasury{" "}
          {position.treasury} · policy {policy.id} · registry {policy.registry}{" "}
          · governance {policy.governance}
          {snapshot && (
            <>
              {" "}
              · snapshot hash {snapshot.snapshotHash} · block{" "}
              {snapshot.blockNumber}
            </>
          )}
        </p>
      </details>
    </section>
  );
}

function CapacitySection({
  position,
  pair,
  capacity,
  capacityError,
  capacityLoading,
  now,
}: {
  readonly position: Position;
  readonly pair: ExchangePair | undefined;
  readonly capacity: DirectionalCapacity | null;
  readonly capacityError: string | null;
  readonly capacityLoading: boolean;
  readonly now: number;
}) {
  const snapshot = position.currentPortfolio;
  const expired = capacity ? capacity.expiresAt <= now : false;
  const staleSnapshot = snapshot
    ? snapshotFreshness(
        snapshot.observedAt,
        now,
        position.policy.priceMaxAgeSeconds,
      ) === "stale"
    : true;

  return (
    <section
      aria-labelledby="capacity-heading"
      className="mt-6 rounded-2xl border border-cyan-900/70 bg-cyan-950/20 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
            Directional liquidity
          </p>
          <h3
            id="capacity-heading"
            className="mt-2 text-xl font-semibold text-white"
          >
            Available to exchange
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
            This is the remaining value for one exchange direction, not the
            total liquidity held by the treasury across every asset.
          </p>
        </div>
        {pair && (
          <div className="rounded-lg border border-cyan-800/70 bg-slate-950/50 px-3 py-2 text-sm text-cyan-100">
            {pair.input.symbol} → {pair.output.symbol}
          </div>
        )}
      </div>

      {!pair && (
        <p className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
          No two-asset exchange direction is configured for this treasury.
          Directional capacity cannot be shown.
        </p>
      )}

      {capacityLoading && (
        <p className="mt-4 text-sm text-slate-400" aria-live="polite">
          Checking the configured direction…
        </p>
      )}
      {capacityError && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200"
        >
          Directional capacity is unavailable: {capacityError}. Refresh the
          snapshot before relying on an exchange amount.
        </p>
      )}

      {capacity && !capacityLoading && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CapacityMetric
              label="Available now"
              value={formatCapacityValue(capacity.remainingValue, position)}
              emphasized
            />
            <CapacityMetric
              label="Current safe maximum"
              value={formatCapacityValue(capacity.maximumValue, position)}
            />
            <CapacityMetric
              label="Consumed in this direction"
              value={formatCapacityValue(capacity.consumedBefore, position)}
            />
            <CapacityMetric
              label="Utilization"
              value={`${formatDecimalUnits(capacity.utilization, 18)} of 1.0`}
            />
          </div>
          <div className="mt-4 grid gap-2 rounded-xl border border-cyan-900/60 bg-slate-950/50 p-4 text-sm text-slate-300 sm:grid-cols-2">
            <p>
              <span className="text-slate-500">Binding constraint: </span>
              {bindingConstraintLabel(capacity.bindingConstraint)}
            </p>
            <p>
              <span className="text-slate-500">Calculated at block: </span>
              {capacity.calculatedAtBlock}
            </p>
            <p
              className={
                expired || staleSnapshot ? "text-amber-300" : undefined
              }
            >
              <span className="text-slate-500">Capacity expiry: </span>
              {expired
                ? "Expired — refresh before relying on it"
                : new Date(capacity.expiresAt * 1000).toLocaleString()}
            </p>
            <p>
              <span className="text-slate-500">Source boundary: </span>
              Service-calculated directional capacity
            </p>
          </div>
          {staleSnapshot && (
            <p className="mt-3 text-sm text-amber-200">
              The associated portfolio evidence is stale or unavailable, so this
              amount is not an executable-liquidity claim.
            </p>
          )}
        </>
      )}

      <a
        href={swapPreviewUrl()}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white hover:bg-cyan-500"
      >
        Preview a trade
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </a>
      <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-slate-500">
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        The swap screen requests a fresh quote and shows the authoritative
        before/expected-after portfolios and fee split. A preview never moves
        funds.
      </p>
    </section>
  );
}

function CapacityMetric({
  label,
  value,
  emphasized = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasized?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={`mt-1 break-words font-semibold ${emphasized ? "text-cyan-200" : "text-slate-100"}`}
      >
        {value}
      </p>
    </div>
  );
}

function Rule({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <p className="text-slate-500">{label}</p>
      <p className="mt-1 text-slate-200">{value}</p>
    </div>
  );
}
