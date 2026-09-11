import { useEffect, useState } from "react";
import { Activity, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";
import {
  apiBaseUrl,
  appMode,
  environmentLabel,
  supportedChainId,
} from "../config";
import { userFacingError } from "../ui";

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
    const client = new AurkaClient({ baseUrl: apiBaseUrl });
    Promise.all([client.health(), client.readiness()])
      .then(([healthData, readinessData]) => {
        setHealth(healthData);
        setReadiness(readinessData);
      })
      .catch((requestError: unknown) =>
        setError(
          userFacingError(
            requestError,
            "The service status could not be checked. Try again later.",
          ),
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          About AURKA
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          Constrained liquidity, clearly presented
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-300">
          AURKA helps an organization offer liquidity within portfolio limits.
          Traders can review what they pay, receive, and pay in fees before
          approving a trade.
        </p>
      </div>

      <section className="rounded-2xl border border-cyan-900/70 bg-cyan-950/25 p-5 sm:p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          {environmentLabel}
        </p>
        <h2 className="mt-2 text-xl font-semibold text-white">
          Know what this environment means
        </h2>
        <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
          <li>
            <strong className="text-white">Local demo:</strong> balances and
            prices come from deterministic test data. A quote is not a completed
            trade.
          </li>
          <li>
            <strong className="text-white">Test network:</strong> wallet actions
            use the selected local chain (chain {supportedChainId}) and test
            funds only. They are not mainnet transactions.
          </li>
          <li>
            <strong className="text-white">Always:</strong> Space rules limit
            accepted trades; they do not promise profit or protection from
            market loss.
          </li>
        </ul>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          {appMode === "testnet"
            ? "This testnet may read selected upstream contracts or fixture integrations; the trade page labels the configured path."
            : "The local demo does not claim live market data, custody, or a public deployment."}
        </p>
      </section>

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
                Service status is unavailable
              </h2>
              <p className="mt-1 text-sm leading-6 text-amber-200/80">
                {error} Product navigation remains available; try again when the
                service is running.
              </p>
            </div>
          </div>
        </div>
      )}

      <details className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5">
        <summary className="flex cursor-pointer items-center gap-3 font-semibold text-white">
          <Activity className="h-5 w-5 text-slate-400" aria-hidden="true" />
          Service diagnostics
        </summary>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Technical checks for troubleshooting the configured environment. They
          do not measure portfolio performance or guarantee settlement.
        </p>
        {!loading && !error && health && readiness && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <StatusCard
              label="API service"
              value={health.status}
              detail={`${health.service} · version ${health.version}`}
              healthy
            />
            <StatusCard
              label="Readiness"
              value={readiness.status}
              detail={`Configured mode: ${readiness.mode}`}
              healthy={readiness.status === "ready"}
            />
            <StatusCard
              label="Database"
              value={readiness.checks.database.state}
              detail={
                readiness.checks.database.reason ?? "No additional detail"
              }
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
      </details>

      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-5 text-sm leading-6 text-slate-400">
        <div className="flex items-start gap-3">
          <CircleHelp
            className="mt-0.5 h-5 w-5 shrink-0 text-slate-500"
            aria-hidden="true"
          />
          <p>
            Connect a wallet only when you are ready to sign. Viewing Spaces,
            rules, and quotes does not request a signature.
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
