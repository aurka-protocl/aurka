import { readinessResponseSchema, type ReadinessResponse } from "@aurka/shared";

export type DiagnosticState = ReadinessResponse["checks"]["database"]["state"];
export type DatabaseReadiness = ReadinessResponse["checks"]["database"];
export type RpcReadiness = ReadinessResponse["checks"]["rpc"];
export type IndexerReadiness = ReadinessResponse["checks"]["indexer"];
export type SourcesReadiness = ReadinessResponse["checks"]["sources"];
export type WorkerReadiness = ReadinessResponse["checks"]["worker"];
export type SignerReadiness = ReadinessResponse["checks"]["signer"];
export type RegistryReadiness = ReadinessResponse["checks"]["registry"];

export type ReadinessCheckName = keyof ReadinessResponse["checks"];
export type ReadinessChecks = ReadinessResponse["checks"];

export interface ReadinessRequirements {
  readonly rpc: boolean;
  readonly indexer: boolean;
  readonly sources: boolean;
  readonly worker: boolean;
  readonly signer: boolean;
  readonly registry: boolean;
}

export interface ReadinessProbeSet {
  readonly rpc?: () => Promise<RpcReadiness>;
  readonly indexer?: () => Promise<IndexerReadiness>;
  readonly sources?: () => Promise<SourcesReadiness>;
  readonly worker?: () => Promise<WorkerReadiness>;
  readonly signer?: () => Promise<SignerReadiness>;
  readonly registry?: () => Promise<RegistryReadiness>;
}

export interface ReadinessConfiguration {
  readonly mode?: "fixture" | "live";
  readonly expectedChainId?: number;
  readonly requirements?: Partial<ReadinessRequirements>;
  readonly probes?: ReadinessProbeSet;
  readonly database?: () => DatabaseReadiness | Promise<DatabaseReadiness>;
  readonly probeTimeoutMs?: number;
  readonly cacheTtlSeconds?: number;
  readonly maxSourceAgeSeconds?: number;
  readonly maxWorkerAgeSeconds?: number;
  readonly maxIndexerLagBlocks?: number;
}

const names: readonly ReadinessCheckName[] = [
  "database",
  "rpc",
  "indexer",
  "sources",
  "worker",
  "signer",
  "registry",
];

const liveRequirements: ReadinessRequirements = {
  rpc: true,
  indexer: true,
  sources: true,
  worker: true,
  signer: true,
  registry: true,
};

const fixtureRequirements: ReadinessRequirements = {
  rpc: false,
  indexer: false,
  sources: false,
  worker: false,
  signer: false,
  registry: false,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function base(
  state: DiagnosticState,
  reason: string | null,
  observedAt: number | null = null,
): {
  state: DiagnosticState;
  reason: string | null;
  observedAt: number | null;
} {
  return { state, reason, observedAt };
}

function initialDatabase(
  state: DiagnosticState,
  reason: string,
): DatabaseReadiness {
  return {
    ...base(state, reason),
    latencyMs: null,
  };
}

function initialRpc(state: DiagnosticState, reason: string): RpcReadiness {
  return {
    ...base(state, reason),
    chainId: null,
    expectedChainId: null,
    latestBlock: null,
    canonicalBlock: null,
    canonicalBlockHash: null,
    finalizedBlock: null,
    finalizedBlockHash: null,
    finalizedAt: null,
  };
}

function initialIndexer(
  state: DiagnosticState,
  reason: string,
): IndexerReadiness {
  return {
    ...base(state, reason),
    checkpointBlock: null,
    checkpointHash: null,
    latestBlock: null,
    lagBlocks: null,
  };
}

function initialSources(
  state: DiagnosticState,
  reason: string,
): SourcesReadiness {
  return { ...base(state, reason), sources: [] };
}

function initialWorker(
  state: DiagnosticState,
  reason: string,
): WorkerReadiness {
  return {
    ...base(state, reason),
    lastAttemptAt: null,
    lastCompletedAt: null,
    leaseExpiresAt: null,
    inFlight: false,
  };
}

function initialSigner(
  state: DiagnosticState,
  reason: string,
): SignerReadiness {
  return {
    ...base(state, reason),
    address: null,
    enabled: null,
    revoked: null,
    expiresAt: null,
    policyFingerprint: null,
  };
}

function initialRegistry(
  state: DiagnosticState,
  reason: string,
): RegistryReadiness {
  return {
    ...base(state, reason),
    source: null,
    mode: null,
    effectiveObservedAt: null,
  };
}

function initialCheck(
  name: ReadinessCheckName,
  state: DiagnosticState,
  reason: string,
): ReadinessChecks[ReadinessCheckName] {
  switch (name) {
    case "database":
      return initialDatabase(state, reason);
    case "rpc":
      return initialRpc(state, reason);
    case "indexer":
      return initialIndexer(state, reason);
    case "sources":
      return initialSources(state, reason);
    case "worker":
      return initialWorker(state, reason);
    case "signer":
      return initialSigner(state, reason);
    case "registry":
      return initialRegistry(state, reason);
  }
}

type AnyCheck = ReadinessChecks[ReadinessCheckName];

interface ProbeSlot {
  value?: AnyCheck;
  expiresAt: number;
  inFlight?: Promise<AnyCheck>;
}

function reasonForError(error: unknown): string {
  // Provider errors can contain URLs, headers, request bodies or credentials.
  // Public readiness only exposes stable remediation categories.
  if (error instanceof Error && error.name === "AbortError")
    return "probe_timeout";
  const message = error instanceof Error ? error.message : "";
  const known: Record<string, string> = {
    rpc_chain_mismatch: "chain_mismatch",
    finalized_head_unavailable: "finalized_head_unavailable",
    latest_head_unavailable: "latest_head_unavailable",
    invalid_canonical_head: "invalid_canonical_head",
    finalized_head_from_future: "finalized_head_from_future",
    finalized_head_stale: "finalized_head_stale",
    effective_registry_read_unavailable: "registry_unavailable",
  };
  if (known[message]) return known[message];
  return "probe_failed";
}

/**
 * Bounded readiness composition with short-lived observations and per-check
 * single-flight behavior. A timeout never authorizes a signer or transaction.
 */
export class ReadinessMonitor {
  private mode: "fixture" | "live";
  private expectedChainId: number | null;
  private requirements: ReadinessRequirements;
  private probes: ReadinessProbeSet;
  private database:
    (() => DatabaseReadiness | Promise<DatabaseReadiness>) | undefined;
  private readonly slots = new Map<ReadinessCheckName, ProbeSlot>();
  private readonly now: () => number;
  private probeTimeoutMs: number;
  private cacheTtlSeconds: number;
  private maxSourceAgeSeconds: number;
  private maxWorkerAgeSeconds: number;
  private maxIndexerLagBlocks: number | null;

  constructor(
    configuration: ReadinessConfiguration = {},
    now: () => number = nowSeconds,
  ) {
    this.mode = configuration.mode ?? "fixture";
    this.expectedChainId = configuration.expectedChainId ?? null;
    this.requirements = {
      ...(this.mode === "live" ? liveRequirements : fixtureRequirements),
      ...configuration.requirements,
    };
    this.probes = configuration.probes ?? {};
    this.database = configuration.database;
    this.now = now;
    this.probeTimeoutMs = configuration.probeTimeoutMs ?? 2_000;
    this.cacheTtlSeconds = configuration.cacheTtlSeconds ?? 5;
    this.maxSourceAgeSeconds = configuration.maxSourceAgeSeconds ?? 300;
    this.maxWorkerAgeSeconds = configuration.maxWorkerAgeSeconds ?? 300;
    this.maxIndexerLagBlocks = configuration.maxIndexerLagBlocks ?? null;
    if (
      !Number.isSafeInteger(this.probeTimeoutMs) ||
      this.probeTimeoutMs < 1 ||
      this.probeTimeoutMs > 120_000
    )
      throw new RangeError(
        "Readiness probe timeout is outside the allowed range",
      );
    if (
      !Number.isSafeInteger(this.cacheTtlSeconds) ||
      this.cacheTtlSeconds < 1 ||
      this.cacheTtlSeconds > 3_600
    )
      throw new RangeError("Readiness cache TTL is outside the allowed range");
    this.validateBudgets();
  }

  private validateBudgets(): void {
    if (
      !Number.isSafeInteger(this.probeTimeoutMs) ||
      this.probeTimeoutMs < 1 ||
      this.probeTimeoutMs > 120_000
    )
      throw new RangeError(
        "Readiness probe timeout is outside the allowed range",
      );
    if (
      !Number.isSafeInteger(this.cacheTtlSeconds) ||
      this.cacheTtlSeconds < 1 ||
      this.cacheTtlSeconds > 3_600
    )
      throw new RangeError("Readiness cache TTL is outside the allowed range");
    if (
      !Number.isSafeInteger(this.maxSourceAgeSeconds) ||
      this.maxSourceAgeSeconds < 1 ||
      this.maxSourceAgeSeconds > 86_400
    )
      throw new RangeError("Readiness source age is outside the allowed range");
    if (
      !Number.isSafeInteger(this.maxWorkerAgeSeconds) ||
      this.maxWorkerAgeSeconds < 1 ||
      this.maxWorkerAgeSeconds > 86_400
    )
      throw new RangeError("Readiness worker age is outside the allowed range");
    if (
      this.maxIndexerLagBlocks !== null &&
      (!Number.isSafeInteger(this.maxIndexerLagBlocks) ||
        this.maxIndexerLagBlocks < 0 ||
        this.maxIndexerLagBlocks > 1_000_000)
    )
      throw new RangeError(
        "Readiness indexer lag is outside the allowed range",
      );
  }

  configure(configuration: ReadinessConfiguration): void {
    if (configuration.mode !== undefined) {
      this.mode = configuration.mode;
      const defaults =
        this.mode === "live" ? liveRequirements : fixtureRequirements;
      this.requirements = { ...defaults, ...configuration.requirements };
    }
    if (configuration.expectedChainId !== undefined)
      this.expectedChainId = configuration.expectedChainId;
    if (configuration.requirements)
      this.requirements = {
        ...this.requirements,
        ...configuration.requirements,
      };
    if (configuration.probes)
      this.probes = { ...this.probes, ...configuration.probes };
    if (configuration.database !== undefined)
      this.database = configuration.database;
    if (configuration.probeTimeoutMs !== undefined)
      this.probeTimeoutMs = configuration.probeTimeoutMs;
    if (configuration.cacheTtlSeconds !== undefined)
      this.cacheTtlSeconds = configuration.cacheTtlSeconds;
    if (configuration.maxSourceAgeSeconds !== undefined)
      this.maxSourceAgeSeconds = configuration.maxSourceAgeSeconds;
    if (configuration.maxWorkerAgeSeconds !== undefined)
      this.maxWorkerAgeSeconds = configuration.maxWorkerAgeSeconds;
    if (configuration.maxIndexerLagBlocks !== undefined)
      this.maxIndexerLagBlocks = configuration.maxIndexerLagBlocks;
    this.validateBudgets();
    this.slots.clear();
  }

  private validateCheck(name: ReadinessCheckName, value: AnyCheck): AnyCheck {
    if (value.state !== "healthy") return value;
    const now = this.now();
    if (name === "rpc") {
      const rpcValue = value as RpcReadiness;
      if (
        (this.expectedChainId !== null &&
          rpcValue.chainId !== this.expectedChainId) ||
        rpcValue.latestBlock === null ||
        rpcValue.canonicalBlock === null ||
        rpcValue.canonicalBlockHash === null ||
        rpcValue.finalizedBlock === null ||
        rpcValue.finalizedBlockHash === null ||
        rpcValue.finalizedAt === null
      )
        return { ...value, state: "unhealthy", reason: "chain_unverified" };
    }
    if (name === "indexer") {
      const indexerValue = value as IndexerReadiness;
      if (
        indexerValue.lagBlocks === null ||
        (this.maxIndexerLagBlocks !== null &&
          indexerValue.lagBlocks > this.maxIndexerLagBlocks)
      )
        return {
          ...value,
          state: "unhealthy",
          reason:
            indexerValue.lagBlocks === null
              ? "indexer_lag_unknown"
              : "indexer_lag_exceeded",
        };
    }
    if (name === "sources") {
      const sourceValue = value as SourcesReadiness;
      if (
        sourceValue.sources.length === 0 ||
        sourceValue.sources.some(
          (source) =>
            source.lastObservedAt === null ||
            now - source.lastObservedAt > this.maxSourceAgeSeconds,
        )
      )
        return { ...value, state: "unhealthy", reason: "source_stale" };
    }
    if (name === "worker") {
      const workerValue = value as WorkerReadiness;
      if (
        workerValue.lastCompletedAt === null ||
        now - workerValue.lastCompletedAt > this.maxWorkerAgeSeconds
      )
        return { ...value, state: "unhealthy", reason: "worker_stale" };
    }
    if (name === "signer") {
      const signerValue = value as SignerReadiness;
      if (
        signerValue.enabled !== true ||
        signerValue.revoked === true ||
        signerValue.expiresAt === null ||
        signerValue.expiresAt <= now
      )
        return { ...value, state: "unhealthy", reason: "signer_unavailable" };
    }
    if (name === "registry") {
      const registryValue = value as RegistryReadiness;
      if (
        registryValue.source !== "REGISTRY" ||
        registryValue.effectiveObservedAt === null
      )
        return {
          ...value,
          state: "unhealthy",
          reason: "registry_unavailable",
        };
    }
    return value;
  }

  private async bounded(
    name: ReadinessCheckName,
    probe: (() => AnyCheck | Promise<AnyCheck>) | undefined,
  ): Promise<AnyCheck> {
    const required =
      name === "database"
        ? true
        : this.requirements[name as keyof ReadinessRequirements];
    if (!probe) {
      return initialCheck(
        name,
        required ? "unknown" : "disabled",
        required ? "not_configured" : "disabled",
      );
    }
    const slot = this.slots.get(name) ?? { expiresAt: 0 };
    this.slots.set(name, slot);
    const now = this.now();
    if (slot.value && now < slot.expiresAt)
      return this.validateCheck(name, slot.value);
    if (slot.inFlight) {
      return initialCheck(name, "unknown", "probe_in_progress");
    }

    const actual = Promise.resolve()
      .then(() => probe())
      .then((value) => value as AnyCheck)
      .catch((error: unknown) => ({
        ...initialCheck(name, "unhealthy", reasonForError(error)),
        observedAt: this.now(),
      }));
    slot.inFlight = actual as Promise<AnyCheck>;
    void actual.finally(() => {
      if (slot.inFlight === actual) delete slot.inFlight;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AnyCheck>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ...initialCheck(name, "unhealthy", "probe_timeout"),
            observedAt: this.now(),
          }),
        this.probeTimeoutMs,
      );
    });
    const result = await Promise.race([actual, timeout]);
    if (timer) clearTimeout(timer);
    const validated = this.validateCheck(name, result as AnyCheck);
    slot.value = validated;
    slot.expiresAt = this.now() + this.cacheTtlSeconds;
    return validated;
  }

  private async databaseCheck(): Promise<DatabaseReadiness> {
    const fallback = () => initialDatabase("unhealthy", "probe_failed");
    return (await this.bounded(
      "database",
      this.database ?? (() => fallback()),
    )) as DatabaseReadiness;
  }

  async snapshot(): Promise<ReadinessResponse> {
    const [
      databaseValue,
      rpcValue,
      indexerValue,
      sourcesValue,
      workerValue,
      signerValue,
      registryValue,
    ] = await Promise.all([
      this.databaseCheck(),
      this.bounded("rpc", this.probes.rpc),
      this.bounded("indexer", this.probes.indexer),
      this.bounded("sources", this.probes.sources),
      this.bounded("worker", this.probes.worker),
      this.bounded("signer", this.probes.signer),
      this.bounded("registry", this.probes.registry),
    ]);
    const database = databaseValue as DatabaseReadiness;
    const rpc = rpcValue as RpcReadiness;
    const indexer = indexerValue as IndexerReadiness;
    const sources = sourcesValue as SourcesReadiness;
    const worker = workerValue as WorkerReadiness;
    const signer = signerValue as SignerReadiness;
    const registry = registryValue as RegistryReadiness;
    const checks: ReadinessChecks = {
      database,
      rpc,
      indexer,
      sources,
      worker,
      signer,
      registry,
    };
    const reasons = names.flatMap((name) => {
      const check = checks[name];
      if (name === "database" || !this.requirements[name]) return [];
      return check.state === "healthy"
        ? []
        : [`${name}:${check.reason ?? check.state}`];
    });
    const databaseOk = database.state === "healthy";
    const ready = databaseOk && reasons.length === 0;
    const rpcLegacy =
      this.mode === "fixture"
        ? "fixture-only"
        : rpc.state === "unhealthy"
          ? "error"
          : "configured";
    const result = {
      status: ready ? "ready" : "not_ready",
      mode: this.mode,
      observedAt: this.now(),
      checks,
      reasons:
        reasons.length > 0 ? reasons : databaseOk ? [] : ["database:unhealthy"],
      database: databaseOk ? "ok" : "error",
      rpc: rpcLegacy,
      indexerLagBlocks: indexer.lagBlocks,
      risk: registry.state === "disabled" ? "not_configured" : "unverified",
    } as const;
    return readinessResponseSchema.parse(result);
  }
}
