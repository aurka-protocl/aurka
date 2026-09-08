import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AurkaClient } from "@aurka/sdk";
import {
  formatBasisPoints,
  formatSnapshotAge,
  formatValueAmount,
  type ActiveAssetBound,
  type Position,
  type RiskConfiguration,
  type RiskEvaluation,
  type RiskMode,
  type RiskPositionResponse,
} from "@aurka/shared";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { appLinks } from "../config";

type DisplayBound = {
  readonly token: string;
  readonly minimumWeightBps: number;
  readonly maximumWeightBps: number;
  readonly paused?: boolean;
};

const MODE_LABELS: Record<RiskMode, string> = {
  NORMAL: "Normal hard-policy limits",
  CAUTIOUS: "Cautious temporary limits",
  SHOCK: "Shock temporary limits",
  PAUSED: "Trading paused",
};

const REASON_EXPLANATIONS: Record<string, string> = {
  LIQUIDITY_DECLINE:
    "The evaluation records a decline in observed liquidity for the affected assets.",
  DEX_LIQUIDITY:
    "The evaluation records a configured DEX-liquidity signal for the affected assets.",
  DEX_VOLUME:
    "The evaluation records a decline in observed trading volume for the affected assets.",
  DIRECTIONAL_FLOW:
    "The evaluation records an unusual directional flow in the configured sources.",
  AURKA_EXECUTIONS:
    "The evaluation records activity from AURKA executions that crossed a configured threshold.",
  AURKA_REVERTS:
    "The evaluation records AURKA reverts that crossed a configured threshold.",
  BOUNDARY_PRESSURE:
    "The evaluation records pressure near a portfolio allocation boundary.",
};

function formatRiskValue(value: string, position: Position): string {
  const decimals = position.currentPortfolio?.valueDecimals;
  return decimals === undefined
    ? `${value} value units · scale unavailable`
    : `${formatValueAmount(value, decimals)} value units`;
}

function formatMode(mode: RiskMode | null | undefined): string {
  return mode ? MODE_LABELS[mode] : "Unavailable";
}

function formatCertificateState(
  state: RiskPositionResponse["certificateState"],
): string {
  switch (state) {
    case "SIGNED":
      return "Signed, not submitted";
    case "SUBMITTED":
      return "Submitted, awaiting confirmation";
    case "ACTIVE":
      return "Marked active by the service";
    case "EXPIRED":
      return "Expired";
    case "REVOKED":
      return "Revoked or no longer authorized";
    case "NONE":
      return "No certificate recorded";
  }
}

function certificateExplanation(
  state: RiskPositionResponse["certificateState"],
): string {
  switch (state) {
    case "SIGNED":
      return "A watchtower signed this certificate, but signing alone does not change the contract's effective limits.";
    case "SUBMITTED":
      return "The certificate was submitted, but chain confirmation and the registry read are still the evidence needed for an effective limit.";
    case "ACTIVE":
      return "The service has an active certificate record. The registry response above is still the source for the currently verified limit.";
    case "EXPIRED":
      return "This certificate is past its expiry. A newer registry result may fall back to hard-policy limits; this screen does not retain an expired tightening.";
    case "REVOKED":
      return "This certificate is no longer authorized. It must not be presented as a current restriction.";
    case "NONE":
      return "No certificate has been recorded for this treasury configuration.";
  }
}

function reasonExplanation(reasonCode: string): string {
  return (
    REASON_EXPLANATIONS[reasonCode] ??
    `The evaluation recorded reason code “${reasonCode}”. No market cause is inferred beyond that recorded label.`
  );
}

function assetName(position: Position, token: string): string {
  return (
    position.policy.assets.find(
      (asset) => asset.token.toLowerCase() === token.toLowerCase(),
    )?.symbol ?? "Unknown asset"
  );
}

function formatBound(bound: DisplayBound): string {
  if (bound.paused) return "Paused";
  return `${formatBasisPoints(bound.minimumWeightBps)} – ${formatBasisPoints(bound.maximumWeightBps)}`;
}

function describeMaximumChange(
  hardMaximum: string,
  restrictedMaximum: string,
  position: Position,
): string {
  const hard = BigInt(hardMaximum);
  const restricted = BigInt(restrictedMaximum);
  if (restricted < hard)
    return `Maximum trade reduced from ${formatRiskValue(hardMaximum, position)} to ${formatRiskValue(restrictedMaximum, position)}.`;
  if (restricted === hard)
    return `Maximum trade remains ${formatRiskValue(hardMaximum, position)}; no additional cap is shown.`;
  return `The returned maximum is wider than the hard policy (${formatRiskValue(restrictedMaximum, position)} versus ${formatRiskValue(hardMaximum, position)}). Treat that response as inconsistent, not as permission to trade.`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(seconds / 3_600);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function simulatedMaximum(hardMaximum: string): string {
  const hard = BigInt(hardMaximum);
  const reduced = (hard * 75n) / 100n;
  return reduced === 0n && hard > 0n ? "1" : reduced.toString();
}

function scenarioBounds(
  configuration: RiskConfiguration | null,
): readonly ActiveAssetBound[] | undefined {
  return configuration?.boundSets.find(
    (boundSet) => boundSet.mode === "CAUTIOUS",
  )?.activeBounds;
}

export default function RiskManagement() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [risk, setRisk] = useState<RiskPositionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [riskLoading, setRiskLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const riskRequest = useRef(0);

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
              : "The protections service could not be reached.",
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

  async function loadRisk(positionId: string): Promise<void> {
    const requestId = ++riskRequest.current;
    setSelectedPositionId(positionId);
    setRiskLoading(true);
    setRiskError(null);
    setRisk(null);
    try {
      const result = await new AurkaClient({ baseUrl: "/api" }).getRiskPosition(
        positionId,
      );
      if (requestId === riskRequest.current) setRisk(result);
    } catch (requestError: unknown) {
      if (requestId === riskRequest.current)
        setRiskError(
          requestError instanceof Error
            ? requestError.message
            : "The protections service could not answer.",
        );
    } finally {
      if (requestId === riskRequest.current) setRiskLoading(false);
    }
  }

  function refresh(): void {
    riskRequest.current += 1;
    setRisk(null);
    setRiskError(null);
    setRefreshKey((key) => key + 1);
  }

  if (loading) {
    return (
      <div
        className="flex min-h-64 items-center justify-center text-slate-400"
        aria-live="polite"
      >
        Loading protections…
      </div>
    );
  }

  if (error) {
    return (
      <section className="space-y-4" role="alert">
        <h1 className="text-3xl font-semibold text-white">Protections</h1>
        <p className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200">
          The treasury protections service could not answer: {error}
        </p>
        <button
          type="button"
          onClick={refresh}
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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300">
            Treasury controls
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-white">
            Protections
          </h1>
          <p className="mt-3 max-w-3xl leading-7 text-slate-400">
            Understand the rules that always apply, any additional tightening,
            and the evidence behind a change. These controls limit accepted
            trades; they do not guarantee against market losses or every attack.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-violet-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh protection data
        </button>
      </header>

      <section
        aria-labelledby="protection-model-heading"
        className="grid gap-4 md:grid-cols-2"
      >
        <div className="rounded-2xl border border-cyan-900/70 bg-cyan-950/20 p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300"
              aria-hidden="true"
            />
            <div>
              <h2
                id="protection-model-heading"
                className="font-semibold text-white"
              >
                Always-applicable hard rules
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                Treasury governance sets the maximum trade value and each
                asset’s allocation range. Every accepted settlement must stay
                within those hard limits, even when no temporary risk state is
                available.
              </p>
              <Link
                to="/holdings"
                className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-cyan-200 hover:text-cyan-100"
              >
                Inspect holdings and rules
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-violet-900/70 bg-violet-950/20 p-5">
          <div className="flex items-start gap-3">
            <ShieldQuestion
              className="mt-0.5 h-5 w-5 shrink-0 text-violet-300"
              aria-hidden="true"
            />
            <div>
              <h2 className="font-semibold text-white">Temporary tightening</h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                Configured automation may apply only tighter limits when
                approved evidence meets a threshold. A proposal, signature, or
                pending submission is not the same as a verified registry limit.
              </p>
              <a
                href={`${appLinks.trader.replace(/\/+$/, "")}/swap`}
                className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-violet-200 hover:text-violet-100"
              >
                See the swap consequence
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </section>

      {positions.length === 0 ? (
        <EmptyProtectionState />
      ) : (
        <>
          <section
            aria-labelledby="protection-config-heading"
            className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5 sm:p-6"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  id="protection-config-heading"
                  className="text-lg font-semibold text-white"
                >
                  Treasury configurations
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
                  Choose a named organization-owned configuration. Each policy
                  is shown separately; configurations are never combined.
                </p>
              </div>
              <label className="block w-full sm:max-w-sm">
                <span className="text-sm font-medium text-slate-200">
                  Configuration for the example
                </span>
                <select
                  aria-label="Protection treasury configuration"
                  value={selectedPositionId}
                  onChange={(event) => {
                    setSelectedPositionId(event.target.value);
                    setRisk(null);
                    setRiskError(null);
                  }}
                  className="mt-1 block w-full rounded-lg border border-violet-700 bg-slate-950 p-2.5 text-slate-100"
                >
                  {positions.map((position) => (
                    <option key={position.id} value={position.id}>
                      {position.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {positions.map((position) => (
              <ProtectionCard
                key={position.id}
                position={position}
                selected={position.id === selectedPositionId}
                loading={riskLoading && position.id === selectedPositionId}
                onView={() => void loadRisk(position.id)}
              />
            ))}
          </div>

          {riskError && (
            <section
              role="alert"
              className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-amber-200"
            >
              <div className="flex items-start gap-3">
                <XCircle
                  className="mt-0.5 h-5 w-5 shrink-0"
                  aria-hidden="true"
                />
                <div>
                  <h2 className="font-semibold">
                    Protection details unavailable
                  </h2>
                  <p className="mt-1 text-sm leading-6">
                    The hard policy is still shown above, but the service could
                    not return temporary-risk state: {riskError}
                  </p>
                </div>
              </div>
            </section>
          )}

          {risk && selectedPosition && (
            <ProtectionDetails position={selectedPosition} risk={risk} />
          )}

          {selectedPosition && (
            <SimulatedExample
              position={selectedPosition}
              configuration={
                risk?.positionId === selectedPosition.id
                  ? risk.configuration
                  : null
              }
              open={scenarioOpen}
              onToggle={() => setScenarioOpen((open) => !open)}
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

function EmptyProtectionState() {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-6">
      <h2 className="font-semibold text-white">No treasury configuration</h2>
      <p className="mt-2 max-w-2xl leading-7 text-slate-400">
        There is no hard policy or temporary protection state to display. This
        read-only screen cannot create a policy or submit a certificate.
      </p>
      <Link
        to="/holdings"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-3 font-medium text-white hover:bg-cyan-500"
      >
        Return to treasury overview
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </section>
  );
}

function ProtectionCard({
  position,
  selected,
  loading,
  onView,
}: {
  readonly position: Position;
  readonly selected: boolean;
  readonly loading: boolean;
  readonly onView: () => void;
}) {
  return (
    <article
      className={`rounded-2xl border bg-slate-900 p-5 sm:p-6 ${selected ? "border-violet-600/80" : "border-slate-700"}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
            Hard policy
          </p>
          <h2 className="mt-2 text-xl font-semibold text-white">
            {position.name}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Organization-owned local example · read-only rules
          </p>
        </div>
        <button
          type="button"
          onClick={onView}
          disabled={loading}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
        >
          {loading && (
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          {loading ? "Loading…" : "View Risk Details"}
        </button>
      </div>

      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Maximum trade</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {formatRiskValue(position.policy.maximumTransactionValue, position)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Policy state</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {position.policy.paused ? "Paused" : "Open under hard rules"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Allocation rules</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {position.policy.assets.length} managed assets
          </dd>
        </div>
      </dl>

      <p className="mt-5 text-sm leading-6 text-slate-300">
        These limits always apply. A temporary risk state can only reduce the
        maximum trade or narrow an allocation range; it cannot widen this
        policy.
      </p>
      <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
        <h3 className="font-semibold text-slate-100">
          Always-applicable allocation ranges
        </h3>
        <ul className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
          {position.policy.assets.map((asset) => (
            <li key={asset.token}>
              <span className="font-medium text-slate-100">
                {asset.symbol}:
              </span>{" "}
              {formatBound(asset)}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function ProtectionDetails({
  position,
  risk,
}: {
  readonly position: Position;
  readonly risk: RiskPositionResponse;
}) {
  const now = Math.floor(Date.now() / 1000);
  const effectiveVerified =
    risk.effective.source === "REGISTRY" &&
    risk.effective.mode !== null &&
    risk.effective.maximumTradeValue !== null &&
    risk.effective.activeBounds.length > 0;
  const hardMaximum = position.policy.maximumTransactionValue;
  const effectiveMaximum = risk.effective.maximumTradeValue;

  return (
    <section
      aria-labelledby="protection-details-heading"
      aria-live="polite"
      className="space-y-5 rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
            Protection state
          </p>
          <h2
            id="protection-details-heading"
            className="mt-2 text-xl font-semibold text-white"
          >
            {position.name}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Hard policy and temporary risk state are shown as separate sources.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 self-start rounded-full border px-3 py-1.5 text-sm ${effectiveVerified ? "border-emerald-700/70 bg-emerald-950/50 text-emerald-200" : "border-amber-700/70 bg-amber-950/40 text-amber-200"}`}
        >
          {effectiveVerified ? (
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          )}
          {effectiveVerified
            ? "Verified registry state"
            : "Effective limit unavailable"}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <p className="font-semibold text-slate-100">
            Effective mode:{" "}
            {effectiveVerified
              ? formatMode(risk.effective.mode)
              : "Unavailable"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {effectiveVerified
              ? "Read from the configured risk registry"
              : "No registry result is being treated as active"}
          </p>
        </div>
        <StateMetric
          label="Effective maximum trade"
          value={
            effectiveVerified && effectiveMaximum
              ? formatRiskValue(effectiveMaximum, position)
              : "Unavailable"
          }
          detail={
            effectiveVerified && effectiveMaximum
              ? describeMaximumChange(hardMaximum, effectiveMaximum, position)
              : "The hard policy remains the known limit; temporary state is unverified"
          }
        />
        <StateMetric
          label="Registry observation"
          value={
            effectiveVerified && risk.effective.observedAt !== null
              ? formatSnapshotAge(risk.effective.observedAt, now)
              : "Unavailable"
          }
          detail={
            effectiveVerified && risk.effective.observedAt !== null
              ? `Observed at ${new Date(risk.effective.observedAt * 1000).toLocaleString()}`
              : "Source, timestamp, and effective bounds were not verified"
          }
        />
      </div>

      {!effectiveVerified && (
        <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-sm leading-6 text-amber-200">
          <p className="font-semibold">
            No additional protection is verified here.
          </p>
          <p className="mt-1">
            The hard policy is known, but this response does not provide a
            current registry mode or temporary limit. An unavailable, expired,
            revoked, or merely proposed state must not be presented as active.
          </p>
        </div>
      )}

      {effectiveVerified && effectiveMaximum && (
        <BoundComparison
          heading="Verified effective consequences"
          description="These are the limits a current registry read reports for accepted trades. The hard range remains the outer boundary."
          position={position}
          maximumTradeValue={effectiveMaximum}
          bounds={risk.effective.activeBounds}
        />
      )}

      <ProposalSection
        position={position}
        proposed={risk.proposed}
        configuration={risk.configuration}
      />
      <CertificateSection position={position} risk={risk} now={now} />
      <SignerSection risk={risk} now={now} />
      <AuthoritySection configuration={risk.configuration} />
      <TechnicalDetails position={position} risk={risk} />
    </section>
  );
}

function StateMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 font-semibold text-slate-100">{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
    </div>
  );
}

function BoundComparison({
  heading,
  description,
  position,
  maximumTradeValue,
  bounds,
}: {
  readonly heading: string;
  readonly description: string;
  readonly position: Position;
  readonly maximumTradeValue: string;
  readonly bounds: readonly DisplayBound[];
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <h3 className="font-semibold text-slate-100">{heading}</h3>
      <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p>
      <p className="mt-3 rounded-lg border border-violet-800/60 bg-violet-950/30 p-3 text-sm font-medium text-violet-100">
        {describeMaximumChange(
          position.policy.maximumTransactionValue,
          maximumTradeValue,
          position,
        )}
      </p>
      {bounds.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">{heading} allocation ranges</caption>
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4">Asset</th>
                <th className="py-2 pr-4">Always-applicable hard range</th>
                <th className="py-2">Temporary/effective range</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {position.policy.assets.map((hardBound) => {
                const activeBound = bounds.find(
                  (bound) =>
                    bound.token.toLowerCase() === hardBound.token.toLowerCase(),
                );
                return (
                  <tr key={hardBound.token}>
                    <th className="py-3 pr-4 font-medium text-slate-200">
                      {hardBound.symbol}
                    </th>
                    <td className="py-3 pr-4 text-slate-300">
                      {formatBound(hardBound)}
                    </td>
                    <td className="py-3 text-slate-300">
                      {activeBound ? formatBound(activeBound) : "Unavailable"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-amber-200">
          Effective allocation ranges were not returned with this state.
        </p>
      )}
    </section>
  );
}

function ProposalSection({
  position,
  proposed,
  configuration,
}: {
  readonly position: Position;
  readonly proposed: RiskEvaluation | null;
  readonly configuration: RiskConfiguration | null;
}) {
  if (!proposed)
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
        <h3 className="font-semibold text-slate-100">Proposed risk change</h3>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          No evaluation proposal has been returned. There is no temporary change
          to explain from this response.
        </p>
      </section>
    );

  return (
    <section className="rounded-xl border border-amber-800/70 bg-amber-950/20 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-300"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 className="font-semibold text-amber-100">
            Proposed risk change · not active
          </h3>
          <p className="mt-1 text-sm leading-6 text-amber-200/80">
            This is the latest stored evaluation, not proof that a certificate
            was signed, submitted, or accepted by the registry.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <StateMetric
          label="Proposed mode"
          value={formatMode(proposed.mode)}
          detail={`Previous state: ${formatMode(proposed.previousMode)}`}
        />
        <StateMetric
          label="Proposed maximum trade"
          value={formatRiskValue(proposed.maximumTradeValue, position)}
          detail={describeMaximumChange(
            position.policy.maximumTransactionValue,
            proposed.maximumTradeValue,
            position,
          )}
        />
        <StateMetric
          label="Evaluation evidence"
          value={
            proposed.validObservationCount === undefined
              ? "Count unavailable"
              : `${proposed.validObservationCount} valid observation(s)`
          }
          detail={
            proposed.sourceCount === undefined
              ? "Source count unavailable"
              : `${proposed.sourceCount} configured source(s)`
          }
        />
      </div>
      <div className="mt-4 rounded-lg border border-amber-900/70 bg-slate-950/40 p-3 text-sm leading-6 text-slate-300">
        <p>
          <span className="font-medium text-slate-100">
            Why this was proposed:
          </span>{" "}
          {reasonExplanation(proposed.reasonCode)}
        </p>
        <p className="mt-2 text-slate-400">
          Recorded evidence summary: {proposed.evidenceSummary}
        </p>
        <p className="mt-2 text-slate-400">
          Affected assets:{" "}
          {proposed.affectedAssets
            .map((token) => assetName(position, token))
            .join(", ") || "none recorded"}
          .
        </p>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">
        Evaluated {new Date(proposed.evaluatedAt * 1000).toLocaleString()} ·
        indexed through block {proposed.indexedThroughBlock} · reason code is
        from the stored evaluation, not a browser inference.
      </p>
      {configuration && (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Configuration {configuration.version} supplied the thresholds for this
          proposal.
        </p>
      )}
      <BoundComparison
        heading="Proposed allocation consequences"
        description="These ranges belong to the proposal only. They do not replace the hard policy or the effective registry result."
        position={position}
        maximumTradeValue={proposed.maximumTradeValue}
        bounds={proposed.selectedBounds}
      />
    </section>
  );
}

function CertificateSection({
  position,
  risk,
  now,
}: {
  readonly position: Position;
  readonly risk: RiskPositionResponse;
  readonly now: number;
}) {
  const certificate = risk.certificate;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="flex items-start gap-3">
        <Clock3
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-400"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-100">
            Certificate lifecycle
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            State: {formatCertificateState(risk.certificateState)}.{" "}
            {certificateExplanation(risk.certificateState)}
          </p>
        </div>
      </div>
      {certificate ? (
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-slate-500">Certificate mode</p>
            <p className="mt-1 text-slate-200">
              {formatMode(certificate.riskMode)}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Certificate maximum</p>
            <p className="mt-1 text-slate-200">
              {formatRiskValue(certificate.maximumTradeValue, position)}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Validity</p>
            <p className="mt-1 text-slate-200">
              {certificate.expiresAt <= now
                ? "Expired"
                : `${formatSnapshotAge(certificate.issuedAt, now)} · expires ${new Date(certificate.expiresAt * 1000).toLocaleString()}`}
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          No signed certificate payload was returned.
        </p>
      )}
      <p className="mt-4 text-xs leading-5 text-slate-500">
        Only the effective registry read can establish the currently active
        temporary limit. Certificate records are lifecycle evidence, not a
        substitute for that read.
      </p>
    </section>
  );
}

function SignerSection({
  risk,
  now,
}: {
  readonly risk: RiskPositionResponse;
  readonly now: number;
}) {
  const signer = risk.signer;
  let status = "Unavailable";
  let detail =
    "The response does not include signer authority, so it is not treated as verified.";
  if (signer) {
    if (signer.revoked) {
      status = "Revoked";
      detail = "This signer cannot establish a current risk certificate.";
    } else if (!signer.enabled) {
      status = "Disabled";
      detail = "This signer is not enabled for current risk authority.";
    } else if (signer.expiresAt <= now) {
      status = "Expired";
      detail = "This signer authority is past its configured expiry.";
    } else {
      status = "Enabled";
      detail = `Authority expires ${new Date(signer.expiresAt * 1000).toLocaleString()}.`;
    }
  }
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="flex items-start gap-3">
        <ShieldQuestion
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-400"
          aria-hidden="true"
        />
        <div>
          <h3 className="font-semibold text-slate-100">
            Risk signer authority
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            Status: <span className="font-medium text-slate-200">{status}</span>
            . {detail}
          </p>
          {signer && (
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Role {signer.role} · policy fingerprint is available in technical
              evidence.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function AuthoritySection({
  configuration,
}: {
  readonly configuration: RiskConfiguration | null;
}) {
  return (
    <section className="rounded-xl border border-cyan-900/60 bg-cyan-950/15 p-4">
      <div className="flex items-start gap-3">
        <CircleHelp
          className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300"
          aria-hidden="true"
        />
        <div>
          <h3 className="font-semibold text-cyan-100">Who has authority?</h3>
          <p className="mt-1 text-sm leading-6 text-slate-300">
            Treasury governance sets the hard rules. Configured automation may
            apply only approved tighter limits. Settlement contracts check the
            policy state when a trade is executed. These controls do not promise
            profit, prevent market losses, or cover every oracle, source, or
            operational failure.
          </p>
          {configuration ? (
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Configuration</dt>
                <dd className="mt-1 text-slate-200">{configuration.version}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Trigger quorum</dt>
                <dd className="mt-1 text-slate-200">
                  {configuration.requiredQuorum} source(s)
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Recovery quorum</dt>
                <dd className="mt-1 text-slate-200">
                  {configuration.recoveryQuorum} source(s)
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Cooldown</dt>
                <dd className="mt-1 text-slate-200">
                  {formatDuration(configuration.cooldownSeconds)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Observation freshness</dt>
                <dd className="mt-1 text-slate-200">
                  {formatDuration(configuration.maxObservationAgeSeconds)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Fail-safe mode</dt>
                <dd className="mt-1 text-slate-200">
                  {formatMode(configuration.failSafeMode)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-amber-200">
              Trigger, cooldown, and recovery configuration was not supplied by
              this response, so those timings are unavailable rather than
              guessed.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function TechnicalDetails({
  position,
  risk,
}: {
  readonly position: Position;
  readonly risk: RiskPositionResponse;
}) {
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-slate-200">
        <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden="true" />
        Technical evidence
      </summary>
      <dl className="mt-4 grid gap-x-6 gap-y-3 break-all text-xs text-slate-400 sm:grid-cols-2">
        <div>
          <dt className="text-slate-600">Position ID</dt>
          <dd className="mt-1">{position.id}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Policy ID / nonce</dt>
          <dd className="mt-1">
            {position.policy.id} · {position.policy.nonce}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">Effective source</dt>
          <dd className="mt-1">{risk.effective.source}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Certificate watchtower</dt>
          <dd className="mt-1">
            {risk.certificate?.watchtower ?? "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">Certificate nonce / policy nonce</dt>
          <dd className="mt-1">
            {risk.certificate
              ? `${risk.certificate.nonce} / ${risk.certificate.policyNonce}`
              : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">Signer status</dt>
          <dd className="mt-1">
            {risk.signer
              ? `${risk.signer.enabled ? "enabled" : "disabled"} · ${risk.signer.revoked ? "revoked" : "not revoked"}`
              : "Unavailable"}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function SimulatedExample({
  position,
  configuration,
  open,
  onToggle,
}: {
  readonly position: Position;
  readonly configuration: RiskConfiguration | null;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const configuredBounds = scenarioBounds(configuration);
  const afterMaximum =
    configuration?.boundSets.find((boundSet) => boundSet.mode === "CAUTIOUS")
      ?.maximumTradeValue ??
    simulatedMaximum(position.policy.maximumTransactionValue);
  return (
    <section
      aria-labelledby="simulated-example-heading"
      className="rounded-2xl border border-dashed border-violet-700/70 bg-violet-950/15 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
            Teaching aid
          </p>
          <h2
            id="simulated-example-heading"
            className="mt-2 text-lg font-semibold text-white"
          >
            Simulated example: a liquidity drop
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
            Explore how a tighter limit could change the next trade. This is a
            resettable simulation; it never calls the API, creates an
            observation, submits a certificate, or changes trusted state.
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-violet-600 px-4 py-2 text-sm font-medium text-violet-100 hover:bg-violet-900/40"
        >
          {open ? "Reset simulated example" : "Show simulated example"}
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {open && (
        <div className="mt-5 border-t border-violet-900/70 pt-5">
          <p className="text-sm leading-6 text-slate-300">
            Imagine approved evidence reported a liquidity decline. The example
            applies a deterministic tighter cap to show the consequence before
            and after; it is not a measured market event or a current trade
            quote.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <StateMetric
              label="Before · hard-policy capacity"
              value={formatRiskValue(
                position.policy.maximumTransactionValue,
                position,
              )}
              detail="The maximum accepted trade under the always-applicable policy"
            />
            <StateMetric
              label="After · simulated temporary capacity"
              value={formatRiskValue(afterMaximum, position)}
              detail={describeMaximumChange(
                position.policy.maximumTransactionValue,
                afterMaximum,
                position,
              )}
            />
          </div>
          {configuredBounds ? (
            <div className="mt-4 rounded-lg border border-violet-900/60 bg-slate-950/40 p-3 text-sm text-slate-300">
              This example uses the configured Cautious bound set as a display
              fixture. It still remains simulated because no observation or
              certificate was submitted from this screen.
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {configuredBounds.map((bound) => (
                  <li key={bound.token}>
                    {assetName(position, bound.token)}: {formatBound(bound)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-violet-900/60 bg-slate-950/40 p-3 text-sm leading-6 text-violet-100">
              No configured scenario bounds were returned, so this teaching aid
              shows only its explicit illustrative cap. A live directional
              capacity value belongs to the holdings and rules response.
            </p>
          )}
          <p className="mt-4 text-xs leading-5 text-slate-500">
            To inspect a real source-backed consequence, use the treasury
            preview or swap flow after checking its current quote and expiry.
          </p>
        </div>
      )}
    </section>
  );
}
