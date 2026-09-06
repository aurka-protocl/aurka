import { hashBytes } from "./solver/hash.js";
import { ServiceError } from "./service.js";
import type { ServiceRepository } from "./db/repository.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { verifySignature } from "./solver/signing.js";
import { z } from "zod";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const modeSchema = z.enum(["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"]);
const signalSchema = z.enum([
  "DEX_LIQUIDITY",
  "DEX_VOLUME",
  "DIRECTIONAL_FLOW",
  "AURKA_EXECUTIONS",
  "AURKA_REVERTS",
  "BOUNDARY_PRESSURE",
]);

const boundSchema = z
  .object({
    token: addressSchema,
    minimumWeightBps: z.number().int().min(0).max(10_000),
    maximumWeightBps: z.number().int().min(0).max(10_000),
    paused: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.minimumWeightBps <= value.maximumWeightBps);
const observationSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    chainId: z.number().int().positive(),
    deploymentId: z.string().min(1),
    signal: signalSchema,
    metricValue: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
    sampleSize: uintSchema,
    affectedAssets: z.array(addressSchema),
    indexedBlock: uintSchema,
    indexedBlockHash: bytes32Schema,
    observedAt: z.number().int().nonnegative(),
    retrievedAt: z.number().int().nonnegative(),
    finality: z.enum(["FINAL", "SAFE", "UNFINALIZED"]),
    payloadHash: bytes32Schema,
  })
  .passthrough();
const thresholdSchema = z
  .object({
    signal: signalSchema,
    cautiousAt: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .optional(),
    shockAt: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .optional(),
    pauseAt: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .optional(),
    affectedAssets: z.array(addressSchema),
    reasonCode: z.string().min(1).max(128),
  })
  .strict();
const configurationSchema = z
  .object({
    version: z.string().min(1),
    maxObservationAgeSeconds: z.number().int().positive(),
    maxIndexedLagBlocks: z.number().int().nonnegative(),
    minimumSampleSize: uintSchema,
    requiredQuorum: z.number().int().positive(),
    failSafeMode: z.enum(["CAUTIOUS", "PAUSED"]),
    recoveryQuorum: z.number().int().positive(),
    cooldownSeconds: z.number().int().nonnegative(),
    thresholds: z.array(thresholdSchema).min(1),
    boundSets: z
      .array(
        z
          .object({
            mode: modeSchema,
            maximumTradeValue: uintSchema,
            activeBounds: z.array(boundSchema),
          })
          .strict(),
      )
      .length(4),
  })
  .strict();
const stateSchema = z
  .object({
    mode: modeSchema,
    activeBoundsHash: bytes32Schema,
    sourceDigest: bytes32Schema,
    maximumTradeValue: uintSchema,
    changedAt: z.number().int().nonnegative(),
    cooldownUntil: z.number().int().nonnegative(),
  })
  .strict();

export const riskEvaluateRequestSchema = z
  .object({
    positionId: z.string().min(1).max(128),
    observations: z.array(observationSchema),
    configuration: configurationSchema,
    hardMaximumTradeValue: uintSchema,
    hardBounds: z.array(boundSchema),
    chainId: z.number().int().positive(),
    deploymentId: z.string().min(1),
    canonicalBlock: uintSchema,
    canonicalBlockHashes: z.record(z.string(), bytes32Schema),
    nowSeconds: z.number().int().nonnegative(),
    currentState: stateSchema.optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const riskCertificateRequestSchema = z
  .object({
    positionId: z.string().min(1).max(128),
    certificate: z
      .object({
        policyId: bytes32Schema,
        chainId: z.number().int().positive(),
        verifyingContract: addressSchema,
        signatureVersion: z.literal(2),
        riskMode: modeSchema,
        activeBounds: z.array(boundSchema),
        activeBoundsHash: bytes32Schema,
        maximumTradeValue: uintSchema,
        sourceDigest: bytes32Schema,
        reasonCode: bytes32Schema,
        issuedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
        nonce: uintSchema,
        watchtower: addressSchema,
        watchtowerAuthorizationEpoch: uintSchema,
        policyNonce: uintSchema,
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      })
      .strict(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

const riskEvaluationResponseSchema = z.object({
  version: z.string(),
  mode: modeSchema,
  reasonCode: z.string(),
  evidenceSummary: z.string(),
  selectedBounds: z.array(boundSchema),
  maximumTradeValue: uintSchema,
  activeBoundsHash: bytes32Schema,
  sourceDigest: bytes32Schema,
  evaluatedAt: z.number(),
  indexedThroughBlock: uintSchema,
  affectedAssets: z.array(addressSchema),
  previousMode: modeSchema,
  validObservationCount: z.number(),
  sourceCount: z.number(),
  failSafe: z.boolean(),
});
export const riskEvaluateResponseSchema = z
  .object({ positionId: z.string(), evaluation: riskEvaluationResponseSchema })
  .strict();
export const riskCertificateResponseSchema = z
  .object({
    positionId: z.string(),
    certificateHash: bytes32Schema,
    certificate: z.record(z.string(), z.unknown()),
    state: z.enum(["SIGNED", "SUBMITTED", "ACTIVE", "EXPIRED", "REVOKED"]),
    submissionState: z.enum(["NOT_SUBMITTED", "SUBMITTED"]),
  })
  .strict();
export const riskPositionResponseSchema = z
  .object({
    positionId: z.string(),
    hardPolicy: z.record(z.string(), z.unknown()),
    effective: z.record(z.string(), z.unknown()),
    certificate: z.record(z.string(), z.unknown()).nullable(),
    certificateState: z.enum([
      "NONE",
      "SIGNED",
      "SUBMITTED",
      "ACTIVE",
      "EXPIRED",
      "REVOKED",
    ]),
    signer: z
      .object({
        role: z.literal("RISK"),
        address: addressSchema,
        enabled: z.boolean(),
        revoked: z.boolean(),
        expiresAt: z.number(),
        policyFingerprint: bytes32Schema,
      })
      .strict(),
  })
  .strict();

export type RiskEvaluateRequest = z.infer<typeof riskEvaluateRequestSchema>;
export type RiskEvaluation = {
  readonly version: string;
  readonly mode: z.infer<typeof modeSchema>;
  readonly reasonCode: string;
  readonly evidenceSummary: string;
  readonly selectedBounds: readonly z.infer<typeof boundSchema>[];
  readonly maximumTradeValue: string;
  readonly activeBoundsHash: string;
  readonly sourceDigest: string;
  readonly evaluatedAt: number;
  readonly indexedThroughBlock: string;
  readonly affectedAssets: readonly string[];
  readonly previousMode: z.infer<typeof modeSchema>;
  readonly validObservationCount: number;
  readonly sourceCount: number;
  readonly failSafe: boolean;
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function modeRank(mode: z.infer<typeof modeSchema>): number {
  return { NORMAL: 0, CAUTIOUS: 1, SHOCK: 2, PAUSED: 3 }[mode];
}

function boundHash(bounds: readonly z.infer<typeof boundSchema>[]): string {
  const slot = (value: bigint | number | string): Uint8Array =>
    Uint8Array.from(
      BigInt(value).toString(16).padStart(64, "0").match(/../g) ?? [],
      (item) => Number.parseInt(item, 16),
    );
  const address = (value: string): Uint8Array =>
    slot(BigInt(`0x${value.slice(2)}`));
  const encoded = [
    slot(32),
    slot(bounds.length),
    ...bounds.flatMap((bound) => [
      address(bound.token),
      slot(bound.minimumWeightBps),
      slot(bound.maximumWeightBps),
      slot(bound.paused ? 1 : 0),
    ]),
  ];
  const joined = new Uint8Array(encoded.length * 32);
  encoded.forEach((item, index) => joined.set(item, index * 32));
  return `0x${Array.from(keccak_256(joined), (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function certificateDigest(
  certificate: z.infer<typeof riskCertificateRequestSchema>["certificate"],
): string {
  const bytes = (value: string): Uint8Array =>
    Uint8Array.from(value.slice(2).match(/../g) ?? [], (item) =>
      Number.parseInt(item, 16),
    );
  const word = (value: bigint | number | string): Uint8Array =>
    bytes(`0x${BigInt(value).toString(16).padStart(64, "0")}`);
  const textHash = (value: string): Uint8Array => bytes(hashBytes(value));
  const address = (value: string): Uint8Array =>
    word(BigInt(`0x${value.slice(2)}`));
  const join = (values: readonly Uint8Array[]): Uint8Array => {
    const result = new Uint8Array(values.length * 32);
    values.forEach((value, index) => result.set(value, index * 32));
    return result;
  };
  const mode = { NORMAL: 0, CAUTIOUS: 1, SHOCK: 2, PAUSED: 3 }[
    certificate.riskMode
  ];
  const domain = keccak_256(
    join([
      textHash(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      ),
      textHash("AURKA RiskModeRegistry"),
      textHash("2"),
      word(certificate.chainId),
      address(certificate.verifyingContract),
    ]),
  );
  const struct = keccak_256(
    join([
      textHash(
        "RiskCertificate(bytes32 policyId,uint8 riskMode,bytes32 activeBoundsHash,uint256 maximumTradeValue,bytes32 sourceDigest,bytes32 reasonCode,uint64 issuedAt,uint64 expiresAt,uint256 nonce,address watchtower,uint256 watchtowerAuthorizationEpoch,uint256 policyNonce)",
      ),
      bytes(certificate.policyId),
      word(mode),
      bytes(certificate.activeBoundsHash),
      word(certificate.maximumTradeValue),
      bytes(certificate.sourceDigest),
      bytes(certificate.reasonCode),
      word(certificate.issuedAt),
      word(certificate.expiresAt),
      word(certificate.nonce),
      address(certificate.watchtower),
      word(certificate.watchtowerAuthorizationEpoch),
      word(certificate.policyNonce),
    ]),
  );
  return `0x${Array.from(keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...struct])), (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function validObservation(
  item: z.infer<typeof observationSchema>,
  input: RiskEvaluateRequest,
): boolean {
  const block = BigInt(item.indexedBlock);
  return (
    item.chainId === input.chainId &&
    item.deploymentId === input.deploymentId &&
    item.retrievedAt >= item.observedAt &&
    item.observedAt <= input.nowSeconds &&
    input.nowSeconds - item.observedAt <=
      input.configuration.maxObservationAgeSeconds &&
    block <= BigInt(input.canonicalBlock) &&
    BigInt(input.canonicalBlock) - block <=
      BigInt(input.configuration.maxIndexedLagBlocks) &&
    item.finality !== "UNFINALIZED" &&
    input.canonicalBlockHashes[item.indexedBlock]?.toLowerCase() ===
      item.indexedBlockHash.toLowerCase() &&
    BigInt(item.sampleSize) >= BigInt(input.configuration.minimumSampleSize)
  );
}

function triggered(metric: bigint, threshold: string): boolean {
  const value = BigInt(threshold);
  return value < 0n ? metric <= value : metric >= value;
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightSet = new Set(right.map((asset) => asset.toLowerCase()));
  return left.some((asset) => rightSet.has(asset.toLowerCase()));
}

function sourceDigest(
  observations: readonly z.infer<typeof observationSchema>[],
  version: string,
): string {
  return hashBytes(
    canonical({
      version,
      observations: [...observations].sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
}

function selectBounds(
  input: RiskEvaluateRequest,
  mode: z.infer<typeof modeSchema>,
): {
  maximumTradeValue: bigint;
  activeBounds: readonly z.infer<typeof boundSchema>[];
} {
  const set = input.configuration.boundSets.find((item) => item.mode === mode);
  if (!set)
    throw new ServiceError(
      "RISK_CONFIGURATION_INVALID",
      `Missing ${mode} bound set`,
      400,
    );
  const hardMaximum = BigInt(input.hardMaximumTradeValue);
  const expectedMaximum =
    mode === "NORMAL"
      ? hardMaximum
      : mode === "CAUTIOUS"
        ? (hardMaximum * 75n) / 100n
        : mode === "SHOCK"
          ? (hardMaximum * 40n) / 100n
          : 0n;
  if (BigInt(set.maximumTradeValue) !== expectedMaximum)
    throw new ServiceError(
      "RISK_CONFIGURATION_INVALID",
      `Risk ${mode} cap must equal its governance ratio`,
      400,
    );
  if (BigInt(set.maximumTradeValue) > BigInt(input.hardMaximumTradeValue))
    throw new ServiceError(
      "RISK_CONFIGURATION_INVALID",
      "Risk maximum exceeds hard policy",
      400,
    );
  const hardByToken = new Map(
    input.hardBounds.map((bound) => [bound.token.toLowerCase(), bound]),
  );
  const bounds = input.hardBounds.map((hard) => {
    const selected = set.activeBounds.find(
      (bound) => bound.token.toLowerCase() === hard.token.toLowerCase(),
    );
    if (
      !selected ||
      selected.minimumWeightBps < hard.minimumWeightBps ||
      selected.maximumWeightBps > hard.maximumWeightBps
    )
      throw new ServiceError(
        "RISK_CONFIGURATION_INVALID",
        "Risk bounds widen hard policy",
        400,
      );
    return { ...selected, token: hard.token };
  });
  if (mode === "SHOCK") {
    const cautious = input.configuration.boundSets.find(
      (item) => item.mode === "CAUTIOUS",
    );
    for (const bound of bounds) {
      const cautiousBound = cautious?.activeBounds.find(
        (item) => item.token.toLowerCase() === bound.token.toLowerCase(),
      );
      if (
        cautiousBound === undefined ||
        bound.minimumWeightBps < cautiousBound.minimumWeightBps ||
        bound.maximumWeightBps > cautiousBound.maximumWeightBps
      )
        throw new ServiceError(
          "RISK_CONFIGURATION_INVALID",
          "Shock bounds widen cautious bounds",
          400,
        );
    }
  }
  if (bounds.length !== hardByToken.size)
    throw new ServiceError(
      "RISK_CONFIGURATION_INVALID",
      "Risk bounds do not cover the hard asset set",
      400,
    );
  return {
    maximumTradeValue: BigInt(set.maximumTradeValue),
    activeBounds: bounds,
  };
}

export class RiskService {
  constructor(private readonly repository: ServiceRepository) {}

  evaluate(raw: unknown): {
    readonly positionId: string;
    readonly evaluation: RiskEvaluation;
  } {
    const input = riskEvaluateRequestSchema.parse(raw);
    const previousMode = input.currentState?.mode ?? "NORMAL";
    const valid = input.observations.filter((item) =>
      validObservation(item, input),
    );
    const sourceIds = new Set(valid.map((item) => item.sourceId));
    const triggeredSources = new Map<z.infer<typeof modeSchema>, Set<string>>();
    let reasonCode = "NORMAL_EVIDENCE";
    for (const item of valid) {
      for (const threshold of input.configuration.thresholds) {
        if (
          threshold.signal !== item.signal ||
          !overlaps(threshold.affectedAssets, item.affectedAssets)
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
          if (
            value !== undefined &&
            triggered(BigInt(item.metricValue), value)
          ) {
            const sources = triggeredSources.get(mode) ?? new Set<string>();
            sources.add(item.sourceId);
            triggeredSources.set(mode, sources);
            reasonCode = threshold.reasonCode;
          }
        }
      }
    }
    let mode: z.infer<typeof modeSchema> = "NORMAL";
    for (const candidate of ["CAUTIOUS", "SHOCK", "PAUSED"] as const)
      if (
        (triggeredSources.get(candidate)?.size ?? 0) >=
        input.configuration.requiredQuorum
      )
        mode = candidate;
    const failSafe =
      valid.length !== input.observations.length || valid.length === 0;
    if (
      failSafe &&
      modeRank(mode) < modeRank(input.configuration.failSafeMode)
    ) {
      mode = input.configuration.failSafeMode;
      reasonCode = `FAIL_SAFE_${mode}`;
    }
    if (modeRank(previousMode) > modeRank(mode)) {
      const cleanSources = new Set(
        valid
          .filter(
            (item) =>
              ![...triggeredSources.values()].some((set) =>
                set.has(item.sourceId),
              ),
          )
          .map((item) => item.sourceId),
      );
      if (
        (input.currentState !== undefined &&
          input.nowSeconds < input.currentState.cooldownUntil) ||
        cleanSources.size < input.configuration.recoveryQuorum
      )
        mode = previousMode;
      else reasonCode = `RECOVERY_${mode}`;
    }
    const selected = selectBounds(input, mode);
    const evaluation: RiskEvaluation = {
      version: input.configuration.version,
      mode,
      reasonCode,
      evidenceSummary: `${valid.length} valid observations from ${sourceIds.size} sources`,
      selectedBounds: selected.activeBounds,
      maximumTradeValue: selected.maximumTradeValue.toString(),
      activeBoundsHash: boundHash(selected.activeBounds),
      sourceDigest: sourceDigest(valid, input.configuration.version),
      evaluatedAt: input.nowSeconds,
      indexedThroughBlock:
        valid.length === 0
          ? "0"
          : valid.reduce(
              (lowest, item) =>
                BigInt(item.indexedBlock) < BigInt(lowest)
                  ? item.indexedBlock
                  : lowest,
              valid[0]!.indexedBlock,
            ),
      affectedAssets: [
        ...new Set(
          valid.flatMap((item) =>
            item.affectedAssets.map((asset) => asset.toLowerCase()),
          ),
        ),
      ].sort(),
      previousMode,
      validObservationCount: valid.length,
      sourceCount: sourceIds.size,
      failSafe,
    };
    const evaluationHash = hashBytes(
      canonical({ positionId: input.positionId, evaluation }),
    );
    for (const observation of valid)
      this.repository.saveRiskObservation(
        observation as unknown as Record<string, unknown>,
      );
    this.repository.saveRiskEvaluation(
      evaluationHash,
      input.positionId,
      evaluation as unknown as Record<string, unknown>,
      input.configuration as unknown as Record<string, unknown>,
      hashBytes(canonical(input.configuration)),
    );
    this.repository.saveRiskJob({
      id: `evaluate:${input.positionId}`,
      positionId: input.positionId,
      kind: "EVALUATE",
      status: "COMPLETED",
      attempt: 1,
      nextRunAt: input.nowSeconds,
    });
    this.repository.saveRiskAuditEvent({
      id: evaluationHash,
      positionId: input.positionId,
      eventType: "RISK_EVALUATED",
      actor: "watchtower",
      payload: {
        evaluationHash,
        mode: evaluation.mode,
        sourceDigest: evaluation.sourceDigest,
      },
    });
    return { positionId: input.positionId, evaluation };
  }

  saveCertificate(raw: unknown): {
    readonly positionId: string;
    readonly certificateHash: string;
    readonly certificate: Record<string, unknown>;
    readonly state: "SIGNED";
    readonly submissionState: "NOT_SUBMITTED";
  } {
    const input = riskCertificateRequestSchema.parse(raw);
    const position = this.repository.getPosition(input.positionId);
    if (!position)
      throw new ServiceError(
        "POSITION_NOT_FOUND",
        "Position was not found",
        404,
      );
    if (
      input.certificate.policyId.toLowerCase() !==
        position.policy.id.toLowerCase() ||
      input.certificate.chainId !== position.chainId ||
      input.certificate.verifyingContract.toLowerCase() !==
        position.policy.registry.toLowerCase() ||
      input.certificate.policyNonce !== position.policy.nonce
    )
      throw new ServiceError(
        "RISK_CERTIFICATE_CONTEXT_MISMATCH",
        "Risk certificate does not match the position policy",
        409,
      );
    const hardMaximum = BigInt(position.policy.maximumTransactionValue);
    const expectedMaximum =
      input.certificate.riskMode === "NORMAL"
        ? hardMaximum
        : input.certificate.riskMode === "CAUTIOUS"
          ? (hardMaximum * 75n) / 100n
          : input.certificate.riskMode === "SHOCK"
            ? (hardMaximum * 40n) / 100n
            : 0n;
    if (BigInt(input.certificate.maximumTradeValue) !== expectedMaximum)
      throw new ServiceError(
        "RISK_CERTIFICATE_WIDENS_POLICY",
        "Risk certificate cap does not match the approved mode ratio",
        400,
      );
    const hardByToken = new Map(
      position.policy.assets.map((asset) => [asset.token.toLowerCase(), asset]),
    );
    for (const bound of input.certificate.activeBounds) {
      const hard = hardByToken.get(bound.token.toLowerCase());
      if (
        !hard ||
        bound.minimumWeightBps < hard.minimumWeightBps ||
        bound.maximumWeightBps > hard.maximumWeightBps
      )
        throw new ServiceError(
          "RISK_CERTIFICATE_WIDENS_POLICY",
          "Risk certificate widens the hard asset policy",
          400,
        );
    }
    if (input.certificate.activeBounds.length !== hardByToken.size)
      throw new ServiceError(
        "RISK_CERTIFICATE_WIDENS_POLICY",
        "Risk certificate does not cover every managed asset",
        400,
      );
    for (const [index, bound] of input.certificate.activeBounds.entries()) {
      if (
        bound.token.toLowerCase() !==
        position.policy.assets[index]!.token.toLowerCase()
      )
        throw new ServiceError(
          "RISK_CERTIFICATE_WIDENS_POLICY",
          "Risk certificate assets are not in governance order",
          400,
        );
    }
    if (input.certificate.expiresAt <= input.certificate.issuedAt)
      throw new ServiceError(
        "RISK_CERTIFICATE_EXPIRED",
        "Risk certificate validity window is invalid",
        400,
      );
    if (input.certificate.expiresAt <= Math.floor(Date.now() / 1000))
      throw new ServiceError(
        "RISK_CERTIFICATE_EXPIRED",
        "Risk certificate is already expired",
        400,
      );
    if (
      boundHash(input.certificate.activeBounds) !==
      input.certificate.activeBoundsHash
    )
      throw new ServiceError(
        "RISK_BOUNDS_HASH_MISMATCH",
        "Risk certificate active bounds hash is invalid",
        400,
      );
    const certificate = {
      ...(input.certificate as unknown as Record<string, unknown>),
      status: "SIGNED",
    };
    const certificateHash = certificateDigest(input.certificate);
    if (
      !verifySignature(
        input.certificate.watchtower,
        certificateHash,
        input.certificate.signature,
      )
    )
      throw new ServiceError(
        "RISK_CERTIFICATE_SIGNATURE_INVALID",
        "Risk certificate signature does not recover the watchtower",
        400,
      );
    this.repository.saveRiskCertificate(certificateHash, certificate, true);
    this.repository.saveRiskAuditEvent({
      id: certificateHash,
      positionId: input.positionId,
      eventType: "RISK_CERTIFICATE_SIGNED",
      actor: input.certificate.watchtower,
      payload: {
        certificateHash,
        nonce: input.certificate.nonce,
        expiresAt: input.certificate.expiresAt,
      },
    });
    this.repository.saveRiskJob({
      id: `renew:${input.positionId}:${input.certificate.nonce}`,
      positionId: input.positionId,
      kind: "CERTIFICATE_RENEWAL",
      status: "QUEUED",
      attempt: 0,
      nextRunAt: Math.max(0, input.certificate.expiresAt - 60),
    });
    return {
      positionId: input.positionId,
      certificateHash,
      certificate,
      state: "SIGNED",
      submissionState: "NOT_SUBMITTED",
    };
  }

  getPosition(positionId: string): {
    readonly positionId: string;
    readonly hardPolicy: Record<string, unknown>;
    readonly effective: Record<string, unknown>;
    readonly certificate: Record<string, unknown> | null;
    readonly certificateState:
      "NONE" | "SIGNED" | "SUBMITTED" | "ACTIVE" | "EXPIRED" | "REVOKED";
    readonly signer: {
      readonly role: "RISK";
      readonly address: string;
      readonly enabled: false;
      readonly revoked: false;
      readonly expiresAt: number;
      readonly policyFingerprint: string;
    };
  } {
    const position = this.repository.getPosition(positionId);
    if (!position)
      throw new ServiceError(
        "POSITION_NOT_FOUND",
        "Position was not found",
        404,
      );
    const stored = this.repository.getRiskPosition(positionId);
    if (!stored.evaluation)
      throw new ServiceError(
        "RISK_NOT_FOUND",
        "No risk evaluation is available",
        404,
      );
    return {
      positionId,
      hardPolicy: {
        maximumTransactionValue: position.policy.maximumTransactionValue,
        assets: position.policy.assets,
        nonce: position.policy.nonce,
        paused: position.policy.paused,
      },
      effective: stored.evaluation,
      certificate: stored.certificate ?? null,
      certificateState: (stored.certificateStatus ?? "NONE") as
        "NONE" | "SIGNED" | "SUBMITTED" | "ACTIVE" | "EXPIRED" | "REVOKED",
      signer: {
        role: "RISK",
        address: position.owner,
        enabled: false,
        revoked: false,
        expiresAt: 0,
        policyFingerprint: `0x${"00".repeat(32)}`,
      },
    };
  }
}
