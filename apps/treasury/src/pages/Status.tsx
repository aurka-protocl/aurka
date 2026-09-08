import { useEffect, useState } from "react";
import { Activity, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";

export default function Status() {
  const [health, setHealth] = useState<Awaited<
    ReturnType<AurkaClient["health"]>
  > | null>(null);
  const [readiness, setReadiness] = useState<Awaited<
    ReturnType<AurkaClient["readiness"]>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const client = new AurkaClient({ baseUrl: "/api" });
    Promise.all([client.health(), client.readiness()])
      .then(([healthData, readinessData]) => {
        setHealth(healthData);
        setReadiness(readinessData);
      })
      .catch((requestError: unknown) =>
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The diagnostics service could not be reached.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Secondary details
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          System status
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-300">
          These checks describe whether the local service can answer requests.
          They are diagnostics, not a measure of treasury performance or a
          promise that a swap will settle.
        </p>
      </div>

      {loading && (
        <p className="rounded-xl border border-slate-700 bg-slate-900/70 p-4 text-slate-300">
          Checking the local service…
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-amber-700/70 bg-amber-950/40 p-5"
        >
          <div className="flex items-start gap-3">
            <XCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-300"
              aria-hidden="true"
            />
            <div>
              <h2 className="font-semibold text-amber-100">
                Diagnostics are unavailable
              </h2>
              <p className="mt-1 text-sm leading-6 text-amber-200/80">
                {error}. The product explanation and navigation remain
                available; try the request again when the local service is
                running.
              </p>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && health && readiness && (
        <div className="grid gap-4 sm:grid-cols-2">
          <StatusCard
            label="API service"
            value={health.status}
            detail={`${health.service} · version ${health.version}`}
            healthy
          />
          <StatusCard
            label="Readiness"
            value={readiness.status}
            detail={`Mode: ${readiness.mode}`}
            healthy={readiness.status === "ready"}
          />
          <StatusCard
            label="Database"
            value={readiness.checks.database.state}
            detail={readiness.checks.database.reason ?? "No additional detail"}
            healthy={readiness.checks.database.state === "healthy"}
          />
          <StatusCard
            label="RPC / chain"
            value={readiness.checks.rpc.state}
            detail={
              readiness.checks.rpc.reason ??
              `Expected chain ${readiness.checks.rpc.expectedChainId ?? "unknown"}`
            }
            healthy={
              readiness.checks.rpc.state === "healthy" ||
              readiness.checks.rpc.state === "disabled"
            }
          />
          <StatusCard
            label="Indexer"
            value={readiness.checks.indexer.state}
            detail={
              readiness.checks.indexer.lagBlocks == null
                ? (readiness.checks.indexer.reason ?? "Lag unavailable")
                : `${readiness.checks.indexer.lagBlocks} block(s) behind`
            }
            healthy={readiness.checks.indexer.state === "healthy"}
          />
          <StatusCard
            label="Risk authority"
            value={readiness.checks.registry.mode ?? "unverified"}
            detail={
              readiness.checks.registry.source === "REGISTRY"
                ? "Read from the configured registry"
                : "Effective protection is not verified"
            }
            healthy={readiness.checks.registry.source === "REGISTRY"}
          />
        </div>
      )}

      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-5 text-sm leading-6 text-slate-400">
        <div className="flex items-start gap-3">
          <CircleHelp
            className="mt-0.5 h-5 w-5 shrink-0 text-slate-500"
            aria-hidden="true"
          />
          <p>
            This default app uses a local fixture. No wallet is connected, and
            this interface does not broadcast transactions.
          </p>
        </div>
      </div>
    </section>
  );
}

function StatusCard({
  label,
  value,
  detail,
  healthy,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly healthy: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">{label}</p>
        {healthy ? (
          <CheckCircle2
            className="h-5 w-5 text-emerald-300"
            aria-label="Available"
          />
        ) : (
          <Activity
            className="h-5 w-5 text-amber-300"
            aria-label="Needs attention"
          />
        )}
      </div>
      <p className="mt-2 text-xl font-semibold capitalize text-white">
        {value}
      </p>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}
