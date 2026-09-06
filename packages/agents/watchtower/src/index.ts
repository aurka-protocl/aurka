import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { z } from "zod";

const UINT256_MAX = (1n << 256n) - 1n;
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= UINT256_MAX);
const signedSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/)
  .refine(
    (value) =>
      BigInt(value.startsWith("-") ? value.slice(1) : value) <= UINT256_MAX,
  );

export const watchtowerRiskModeSchema = z.enum([
  "NORMAL",
  "CAUTIOUS",
  "SHOCK",
  "PAUSED",
]);
export type WatchtowerRiskMode = z.infer<typeof watchtowerRiskModeSchema>;

export const watchtowerObservationSchema = z
  .object({
    id: z.string().min(1).max(128),
    sourceId: z.string().min(1).max(128),
    sourceKind: z.enum(["AURKA_SUBGRAPH", "DEX_SUBGRAPH", "FIXTURE"]),
    chainId: z.number().int().positive().safe(),
    deploymentId: z.string().min(1).max(128),
    schemaVersion: z.string().min(1).max(32),
    queryVersion: z.string().min(1).max(32),
    signal: z.enum([
      "DEX_LIQUIDITY",
      "DEX_VOLUME",
      "DIRECTIONAL_FLOW",
      "AURKA_EXECUTIONS",
      "AURKA_REVERTS",
      "BOUNDARY_PRESSURE",
    ]),
    metricValue: signedSchema,
    sampleSize: uintSchema,
    affectedAssets: z.array(addressSchema),
    indexedBlock: uintSchema,
    indexedBlockHash: bytes32Schema,
    observedAt: z.number().int().nonnegative().safe(),
    retrievedAt: z.number().int().nonnegative().safe(),
    finality: z.enum(["FINAL", "SAFE", "UNFINALIZED"]),
    payloadHash: bytes32Schema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WatchtowerObservation = z.infer<typeof watchtowerObservationSchema>;

export const watchtowerBoundSchema = z
  .object({
    token: addressSchema,
    minimumWeightBps: z.number().int().min(0).max(10_000),
    maximumWeightBps: z.number().int().min(0).max(10_000),
    paused: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.minimumWeightBps <= value.maximumWeightBps);
export type WatchtowerBound = z.infer<typeof watchtowerBoundSchema>;

const thresholdSchema = z
  .object({
    signal: watchtowerObservationSchema.shape.signal,
    cautiousAt: signedSchema.optional(),
    shockAt: signedSchema.optional(),
    pauseAt: signedSchema.optional(),
    affectedAssets: z.array(addressSchema),
    reasonCode: z.string().min(1).max(128),
  })
  .strict()
  .refine(
    (value) =>
      value.cautiousAt !== undefined ||
      value.shockAt !== undefined ||
      value.pauseAt !== undefined,
  );

const boundSetSchema = z
  .object({
    mode: watchtowerRiskModeSchema,
    maximumTradeValue: uintSchema,
    activeBounds: z.array(watchtowerBoundSchema),
  })
  .strict();

export const watchtowerConfigurationSchema = z
  .object({
    version: z.string().min(1).max(128),
    maxObservationAgeSeconds: z.number().int().positive().safe(),
    maxIndexedLagBlocks: z.number().int().nonnegative().safe(),
    minimumSampleSize: uintSchema,
    requiredQuorum: z.number().int().positive().max(100),
    failSafeMode: z.enum(["CAUTIOUS", "PAUSED"]),
    recoveryQuorum: z.number().int().positive().max(100),
    cooldownSeconds: z.number().int().nonnegative().safe(),
    thresholds: z.array(thresholdSchema).min(1),
    boundSets: z.array(boundSetSchema).length(4),
  })
  .strict()
  .superRefine((value, context) => {
    const modes = new Set(value.boundSets.map((set) => set.mode));
    for (const mode of ["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"] as const) {
      if (!modes.has(mode))
        context.addIssue({
          code: "custom",
          message: `Missing ${mode} bound set`,
          path: ["boundSets"],
        });
    }
    if (value.recoveryQuorum < value.requiredQuorum)
      context.addIssue({
        code: "custom",
        message: "Recovery quorum must be at least the trigger quorum",
        path: ["recoveryQuorum"],
      });
  });
export type WatchtowerConfiguration = z.infer<
  typeof watchtowerConfigurationSchema
>;

export const watchtowerStateSchema = z
  .object({
    mode: watchtowerRiskModeSchema,
    activeBounds: z.array(watchtowerBoundSchema),
    sourceDigest: bytes32Schema,
    activeBoundsHash: bytes32Schema,
    maximumTradeValue: uintSchema,
    changedAt: z.number().int().nonnegative().safe(),
    cooldownUntil: z.number().int().nonnegative().safe(),
  })
  .strict();
export type WatchtowerState = z.infer<typeof watchtowerStateSchema>;

export const watchtowerEvaluationSchema = z
  .object({
    version: z.string().min(1).max(128),
    mode: watchtowerRiskModeSchema,
    reasonCode: z.string().min(1).max(128),
    evidenceSummary: z.string().min(1).max(500),
    selectedBounds: z.array(watchtowerBoundSchema),
    maximumTradeValue: uintSchema,
    activeBoundsHash: bytes32Schema,
    sourceDigest: bytes32Schema,
    evaluatedAt: z.number().int().nonnegative().safe(),
    indexedThroughBlock: uintSchema,
    affectedAssets: z.array(addressSchema),
    previousMode: watchtowerRiskModeSchema,
    validObservationCount: z.number().int().nonnegative().safe(),
    sourceCount: z.number().int().nonnegative().safe(),
    failSafe: z.boolean(),
  })
  .strict();
export type WatchtowerEvaluation = z.infer<typeof watchtowerEvaluationSchema>;

const modeRank: Record<WatchtowerRiskMode, number> = {
  NORMAL: 0,
  CAUTIOUS: 1,
  SHOCK: 2,
  PAUSED: 3,
};

export function riskModeRank(mode: WatchtowerRiskMode): number {
  return modeRank[mode];
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function slot(value: bigint | number | string): Uint8Array {
  const number = typeof value === "bigint" ? value : BigInt(value);
  if (number < 0n || number > UINT256_MAX)
    throw new RangeError("Value does not fit uint256");
  return Uint8Array.from(
    number.toString(16).padStart(64, "0").match(/../g) ?? [],
    (item) => Number.parseInt(item, 16),
  );
}

function addressSlot(value: string): Uint8Array {
  return slot(BigInt(`0x${value.slice(2)}`));
}

function bytes32(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError("Expected bytes32");
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], (item) =>
    Number.parseInt(item, 16),
  );
}

function join(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.length * 32);
  values.forEach((value, index) => result.set(value, index * 32));
  return result;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function digest(value: unknown): string {
  return hex(keccak_256(new TextEncoder().encode(canonical(value))));
}

function metricTriggers(metric: bigint, threshold: string): boolean {
  const value = BigInt(threshold);
  return value < 0n ? metric <= value : metric >= value;
}

function assetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightSet = new Set(right.map((item) => item.toLowerCase()));
  return left.some((item) => rightSet.has(item.toLowerCase()));
}

function observationInvalid(
  observation: WatchtowerObservation,
  input: EvaluateRiskInput,
): string | undefined {
  if (observation.chainId !== input.chainId) return "wrong-chain";
  if (observation.deploymentId !== input.deploymentId)
    return "wrong-deployment";
  if (
    observation.retrievedAt < observation.observedAt ||
    observation.observedAt > input.nowSeconds
  )
    return "future-observation";
  if (
    input.nowSeconds - observation.observedAt >
    input.configuration.maxObservationAgeSeconds
  )
    return "stale-observation";
  const block = BigInt(observation.indexedBlock);
  if (block > input.canonicalBlock) return "future-index";
  if (
    input.canonicalBlock - block >
    BigInt(input.configuration.maxIndexedLagBlocks)
  )
    return "lagging-index";
  if (observation.finality === "UNFINALIZED") return "unfinalized-observation";
  const canonicalHash = input.canonicalBlockHashes[observation.indexedBlock];
  if (
    canonicalHash === undefined ||
    canonicalHash.toLowerCase() !== observation.indexedBlockHash.toLowerCase()
  )
    return "reorged-observation";
  if (
    BigInt(observation.sampleSize) <
    BigInt(input.configuration.minimumSampleSize)
  )
    return "insufficient-sample";
  return undefined;
}

function selectedBoundSet(
  configuration: WatchtowerConfiguration,
  mode: WatchtowerRiskMode,
): {
  readonly maximumTradeValue: bigint;
  readonly activeBounds: readonly WatchtowerBound[];
} {
  const set = configuration.boundSets.find(
    (candidate) => candidate.mode === mode,
  );
  if (!set) throw new Error(`Missing governance bound set for ${mode}`);
  return {
    maximumTradeValue: BigInt(set.maximumTradeValue),
    activeBounds: set.activeBounds,
  };
}

function validateTightening(
  mode: WatchtowerRiskMode,
  selected: readonly WatchtowerBound[],
  hard: readonly WatchtowerBound[],
  maximumTradeValue: bigint,
  hardMaximumTradeValue: bigint,
): readonly WatchtowerBound[] {
  const expectedMaximum =
    mode === "NORMAL"
      ? hardMaximumTradeValue
      : mode === "CAUTIOUS"
        ? (hardMaximumTradeValue * 75n) / 100n
        : mode === "SHOCK"
          ? (hardMaximumTradeValue * 40n) / 100n
          : 0n;
  if (maximumTradeValue !== expectedMaximum)
    throw new Error(`Risk ${mode} cap must equal its governance ratio`);
  if (maximumTradeValue > hardMaximumTradeValue)
    throw new Error("Risk configuration widens transaction cap");
  if (mode === "PAUSED" && maximumTradeValue !== 0n)
    throw new Error("Paused mode must have zero capacity");
  const selectedByToken = new Map(
    selected.map((bound) => [bound.token.toLowerCase(), bound]),
  );
  const result = hard.map((hardBound) => {
    const candidate = selectedByToken.get(hardBound.token.toLowerCase());
    if (!candidate)
      throw new Error(`Risk configuration omitted ${hardBound.token}`);
    if (
      candidate.minimumWeightBps < hardBound.minimumWeightBps ||
      candidate.maximumWeightBps > hardBound.maximumWeightBps ||
      candidate.minimumWeightBps > candidate.maximumWeightBps
    )
      throw new Error("Risk configuration widens asset bounds");
    return { ...candidate, token: hardBound.token };
  });
  if (mode !== "PAUSED") {
    const minimum = result.reduce(
      (sum, bound) => sum + bound.minimumWeightBps,
      0,
    );
    const maximum = result.reduce(
      (sum, bound) => sum + bound.maximumWeightBps,
      0,
    );
    if (minimum > 10_000 || maximum < 10_000)
      throw new Error("Risk bounds cannot hold a valid portfolio");
  }
  return result;
}

export interface EvaluateRiskInput {
  readonly observations: readonly WatchtowerObservation[];
  readonly configuration: WatchtowerConfiguration;
  readonly hardMaximumTradeValue: string;
  readonly hardBounds: readonly WatchtowerBound[];
  readonly chainId: number;
  readonly deploymentId: string;
  readonly canonicalBlock: bigint;
  readonly canonicalBlockHashes: Readonly<Record<string, string>>;
  readonly nowSeconds: number;
  readonly currentState?: WatchtowerState;
}

/**
 * Pure integer-only evaluation. Evidence can only move the result toward a
 * tighter state. Recovery requires a larger source quorum and a completed
 * cooldown; invalid evidence enters the configured fail-safe mode.
 */
export function evaluateRisk(input: EvaluateRiskInput): WatchtowerEvaluation {
  const configuration = watchtowerConfigurationSchema.parse(
    input.configuration,
  );
  const observations = input.observations.map((item) =>
    watchtowerObservationSchema.parse(item),
  );
  const hardMaximum = BigInt(input.hardMaximumTradeValue);
  const hardBounds = input.hardBounds.map((item) =>
    watchtowerBoundSchema.parse(item),
  );
  const previousMode = input.currentState?.mode ?? "NORMAL";
  const seen = new Set<string>();
  const invalidReasons: string[] = [];
  const valid = observations.filter((observation) => {
    if (seen.has(`${observation.sourceId}:${observation.id}`)) {
      invalidReasons.push("duplicate-observation");
      return false;
    }
    seen.add(`${observation.sourceId}:${observation.id}`);
    const reason = observationInvalid(observation, { ...input, configuration });
    if (reason !== undefined) invalidReasons.push(reason);
    return reason === undefined;
  });
  const sources = new Set(valid.map((observation) => observation.sourceId));
  const affectedAssets = [
    ...new Set(
      valid.flatMap((observation) =>
        observation.affectedAssets.map((asset) => asset.toLowerCase()),
      ),
    ),
  ].sort();
  const triggered = new Map<WatchtowerRiskMode, Set<string>>();
  const reasonCodes = new Map<WatchtowerRiskMode, string>();
  for (const observation of valid) {
    const metric = BigInt(observation.metricValue);
    for (const threshold of configuration.thresholds) {
      if (
        threshold.signal !== observation.signal ||
        !assetsOverlap(threshold.affectedAssets, observation.affectedAssets)
      )
        continue;
      for (const mode of ["CAUTIOUS", "SHOCK", "PAUSED"] as const) {
        const value =
          threshold[
            mode === "CAUTIOUS"
              ? "cautiousAt"
              : mode === "SHOCK"
                ? "shockAt"
                : "pauseAt"
          ];
        if (value !== undefined && metricTriggers(metric, value)) {
          const set = triggered.get(mode) ?? new Set<string>();
          set.add(observation.sourceId);
          triggered.set(mode, set);
          reasonCodes.set(mode, threshold.reasonCode);
        }
      }
    }
  }
  let desired: WatchtowerRiskMode = "NORMAL";
  for (const mode of ["CAUTIOUS", "SHOCK", "PAUSED"] as const) {
    if ((triggered.get(mode)?.size ?? 0) >= configuration.requiredQuorum)
      desired = mode;
  }
  const failSafe = valid.length === 0 || invalidReasons.length > 0;
  if (
    failSafe &&
    riskModeRank(desired) < riskModeRank(configuration.failSafeMode)
  )
    desired = configuration.failSafeMode;
  if (riskModeRank(previousMode) > riskModeRank(desired)) {
    const recoverySources = new Set(
      valid
        .filter(
          (observation) =>
            ![...triggered.values()].some((set) =>
              set.has(observation.sourceId),
            ),
        )
        .map((observation) => observation.sourceId),
    );
    const cooldownComplete =
      input.currentState === undefined ||
      input.nowSeconds >= input.currentState.cooldownUntil;
    desired =
      cooldownComplete && recoverySources.size >= configuration.recoveryQuorum
        ? desired
        : previousMode;
  }
  const selected = selectedBoundSet(configuration, desired);
  if (desired === "SHOCK") {
    const cautious = selectedBoundSet(configuration, "CAUTIOUS");
    const cautiousByToken = new Map(
      cautious.activeBounds.map((bound) => [bound.token.toLowerCase(), bound]),
    );
    for (const bound of selected.activeBounds) {
      const cautiousBound = cautiousByToken.get(bound.token.toLowerCase());
      if (
        cautiousBound === undefined ||
        bound.minimumWeightBps < cautiousBound.minimumWeightBps ||
        bound.maximumWeightBps > cautiousBound.maximumWeightBps
      )
        throw new Error("Shock bounds cannot widen cautious bounds");
    }
  }
  const selectedBounds = validateTightening(
    desired,
    selected.activeBounds,
    hardBounds,
    selected.maximumTradeValue,
    hardMaximum,
  );
  const indexedThroughBlock =
    valid.length === 0
      ? 0n
      : valid.reduce((minimum, observation) => {
          const block = BigInt(observation.indexedBlock);
          return block < minimum ? block : minimum;
        }, BigInt(valid[0]!.indexedBlock));
  const sourceDigest = digest({
    version: configuration.version,
    observations: [...valid].sort((a, b) => a.id.localeCompare(b.id)),
  });
  const activeBoundsHash = hashActiveBounds(selectedBounds);
  const reasonCode = failSafe
    ? `FAIL_SAFE_${configuration.failSafeMode}`
    : (reasonCodes.get(desired) ??
      (desired === "NORMAL" ? "NORMAL_EVIDENCE" : `RECOVERY_${desired}`));
  return watchtowerEvaluationSchema.parse({
    version: configuration.version,
    mode: desired,
    reasonCode,
    evidenceSummary: `${valid.length} valid observations from ${sources.size} sources${invalidReasons.length === 0 ? "" : `; rejected ${[...new Set(invalidReasons)].sort().join(",")}`}`,
    selectedBounds,
    maximumTradeValue: selected.maximumTradeValue.toString(),
    activeBoundsHash,
    sourceDigest,
    evaluatedAt: input.nowSeconds,
    indexedThroughBlock: indexedThroughBlock.toString(),
    affectedAssets,
    previousMode,
    validObservationCount: valid.length,
    sourceCount: sources.size,
    failSafe,
  });
}

function hashText(value: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(value));
}

const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function recoverAddress(digestValue: string, signature: string): string {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new Error("Risk signature must be 65 bytes");
  const encoded = Uint8Array.from(
    signature.slice(2).match(/../g) ?? [],
    (item) => Number.parseInt(item, 16),
  );
  const recovery = (encoded[64] ?? 0) - 27;
  if (recovery !== 0 && recovery !== 1)
    throw new Error("Invalid risk signature recovery");
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s > SECP256K1_HALF_ORDER)
    throw new Error("Risk signature s exceeds half order");
  const recovered = secp256k1.recoverPublicKey(
    new Uint8Array([recovery, ...encoded.slice(0, 64)]),
    bytes32(digestValue),
    { prehash: false },
  );
  const uncompressed =
    recovered.length === 65
      ? recovered
      : secp256k1.Point.fromBytes(recovered).toBytes(false);
  const digestValueBytes = keccak_256(uncompressed.slice(1));
  return `0x${Array.from(digestValueBytes.slice(-20), (item) =>
    item.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export interface RiskCertificateDraft {
  readonly policyId: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly evaluation: WatchtowerEvaluation;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly watchtower: string;
  readonly watchtowerAuthorizationEpoch: string;
  readonly policyNonce: string;
  readonly signature?: string;
}

export const riskCertificateDraftSchema = z
  .object({
    policyId: bytes32Schema,
    chainId: z.number().int().positive().safe(),
    verifyingContract: addressSchema,
    evaluation: watchtowerEvaluationSchema,
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
    nonce: uintSchema,
    watchtower: addressSchema,
    watchtowerAuthorizationEpoch: uintSchema,
    policyNonce: uintSchema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt)
      context.addIssue({
        code: "custom",
        message: "Certificate expiry must follow issue time",
        path: ["expiresAt"],
      });
    if (
      value.evaluation.mode === "PAUSED" &&
      value.evaluation.maximumTradeValue !== "0"
    )
      context.addIssue({
        code: "custom",
        message: "Paused certificate must have zero capacity",
        path: ["evaluation", "maximumTradeValue"],
      });
  });
export type RiskCertificateDraftValue = z.infer<
  typeof riskCertificateDraftSchema
>;

export interface RiskCertificateSigner {
  readonly address: string;
  signDigest(digest: string): Promise<string> | string;
}

export const riskModeNumber: Record<WatchtowerRiskMode, number> = {
  NORMAL: 0,
  CAUTIOUS: 1,
  SHOCK: 2,
  PAUSED: 3,
};

/** Exact EIP-712 v2 digest shared with the Solidity registry. */
export function hashRiskCertificate(
  draft: Omit<RiskCertificateDraft, "signature" | "evaluation"> & {
    readonly evaluation: WatchtowerEvaluation;
  },
): string {
  const typeHash = hashText(
    "RiskCertificate(bytes32 policyId,uint8 riskMode,bytes32 activeBoundsHash,uint256 maximumTradeValue,bytes32 sourceDigest,bytes32 reasonCode,uint64 issuedAt,uint64 expiresAt,uint256 nonce,address watchtower,uint256 watchtowerAuthorizationEpoch,uint256 policyNonce)",
  );
  const domainTypeHash = hashText(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  );
  const domain = keccak_256(
    join([
      domainTypeHash,
      hashText("AURKA RiskModeRegistry"),
      hashText("2"),
      slot(draft.chainId),
      addressSlot(draft.verifyingContract),
    ]),
  );
  const struct = keccak_256(
    join([
      typeHash,
      bytes32(draft.policyId),
      slot(riskModeNumber[draft.evaluation.mode]),
      bytes32(draft.evaluation.activeBoundsHash),
      slot(draft.evaluation.maximumTradeValue),
      bytes32(draft.evaluation.sourceDigest),
      hashText(draft.evaluation.reasonCode),
      slot(draft.issuedAt),
      slot(draft.expiresAt),
      slot(draft.nonce),
      addressSlot(draft.watchtower),
      slot(draft.watchtowerAuthorizationEpoch),
      slot(draft.policyNonce),
    ]),
  );
  return hex(keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...struct])));
}

export async function prepareRiskCertificate(
  draft: RiskCertificateDraft,
  signer?: RiskCertificateSigner,
): Promise<RiskCertificateDraftValue> {
  const parsed = riskCertificateDraftSchema.parse(draft);
  const expectedBoundsHash = hashActiveBounds(parsed.evaluation.selectedBounds);
  if (expectedBoundsHash !== parsed.evaluation.activeBoundsHash)
    throw new Error("Evaluation bounds hash mismatch");
  const digestValue = hashRiskCertificate(parsed);
  const signature =
    parsed.signature ??
    (signer === undefined ? undefined : await signer.signDigest(digestValue));
  if (
    signature !== undefined &&
    signer !== undefined &&
    signer.address.toLowerCase() !== parsed.watchtower.toLowerCase()
  )
    throw new Error("Certificate signer does not match watchtower");
  if (
    signature !== undefined &&
    recoverAddress(digestValue, signature).toLowerCase() !==
      parsed.watchtower.toLowerCase()
  )
    throw new Error("Risk signature does not recover the watchtower");
  return riskCertificateDraftSchema.parse({
    ...parsed,
    ...(signature === undefined ? {} : { signature }),
  });
}

export function hashActiveBounds(bounds: readonly WatchtowerBound[]): string {
  return hex(
    keccak_256(
      join([
        slot(32),
        slot(bounds.length),
        ...bounds.flatMap((bound) => [
          addressSlot(bound.token),
          slot(bound.minimumWeightBps),
          slot(bound.maximumWeightBps),
          slot(bound.paused ? 1 : 0),
        ]),
      ]),
    ),
  );
}

export function explainEvaluation(evaluation: WatchtowerEvaluation): string {
  return `${evaluation.mode}: ${evaluation.reasonCode}; ${evaluation.evidenceSummary}; cap=${evaluation.maximumTradeValue}; bounds=${evaluation.activeBoundsHash}`;
}
