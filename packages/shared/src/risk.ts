import { z } from "zod";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  uint256StringSchema,
  unixTimestampSchema,
  weightBpsSchema,
} from "./primitives.js";

const UINT256_MAX = (1n << 256n) - 1n;
const FIXED_SLOT = 32;

function slot(value: bigint | number | string): Uint8Array {
  const number = typeof value === "bigint" ? value : BigInt(value);
  if (number < 0n || number > UINT256_MAX)
    throw new RangeError("Value does not fit uint256");
  const result = new Uint8Array(FIXED_SLOT);
  let remaining = number;
  for (let index = FIXED_SLOT - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function addressSlot(value: string): Uint8Array {
  const result = new Uint8Array(FIXED_SLOT);
  const bytes = value.slice(2).match(/.{2}/g) ?? [];
  bytes.forEach((item, index) => {
    result[12 + index] = Number.parseInt(item, 16);
  });
  return result;
}

function join(slots: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(slots.length * FIXED_SLOT);
  slots.forEach((item, index) => result.set(item, index * FIXED_SLOT));
  return result;
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function textHash(value: string): Uint8Array {
  return keccak_256(utf8ToBytes(value));
}

export const riskModeSchema = z.enum(["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"]);

export const riskSignalSchema = z.enum([
  "DEX_LIQUIDITY",
  "DEX_VOLUME",
  "DIRECTIONAL_FLOW",
  "AURKA_EXECUTIONS",
  "AURKA_REVERTS",
  "BOUNDARY_PRESSURE",
]);

export const observationFinalitySchema = z.enum([
  "FINAL",
  "SAFE",
  "UNFINALIZED",
]);

export const signedIntegerSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/)
  .refine((value) => {
    const magnitude = BigInt(value.startsWith("-") ? value.slice(1) : value);
    return magnitude <= UINT256_MAX;
  }, "Expected a bounded integer");

/** A provenance-preserving, replayable observation consumed by the watchtower. */
export const riskObservationSchema = z
  .object({
    id: identifierSchema,
    sourceId: identifierSchema,
    sourceKind: z.enum(["AURKA_SUBGRAPH", "DEX_SUBGRAPH", "FIXTURE"]),
    chainId: z.number().int().positive().safe(),
    deploymentId: z.string().min(1).max(128),
    schemaVersion: z.string().min(1).max(32),
    queryVersion: z.string().min(1).max(32),
    signal: riskSignalSchema,
    metricValue: signedIntegerSchema,
    sampleSize: uint256StringSchema,
    affectedAssets: z.array(addressSchema),
    indexedBlock: uint256StringSchema,
    indexedBlockHash: bytes32Schema,
    observedAt: unixTimestampSchema,
    retrievedAt: unixTimestampSchema,
    finality: observationFinalitySchema,
    payloadHash: bytes32Schema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retrievedAt < value.observedAt) {
      context.addIssue({
        code: "custom",
        message: "Observation retrieval cannot precede observation time",
        path: ["retrievedAt"],
      });
    }
    const assets = value.affectedAssets.map((asset) => asset.toLowerCase());
    if (new Set(assets).size !== assets.length) {
      context.addIssue({
        code: "custom",
        message: "Affected assets must be unique",
        path: ["affectedAssets"],
      });
    }
  });

export const riskThresholdSchema = z
  .object({
    signal: riskSignalSchema,
    cautiousAt: signedIntegerSchema.optional(),
    shockAt: signedIntegerSchema.optional(),
    pauseAt: signedIntegerSchema.optional(),
    affectedAssets: z.array(addressSchema),
    reasonCode: identifierSchema,
  })
  .strict()
  .refine(
    ({ cautiousAt, shockAt, pauseAt }) =>
      cautiousAt !== undefined ||
      shockAt !== undefined ||
      pauseAt !== undefined,
    { message: "At least one risk threshold is required" },
  );

export const activeAssetBoundSchema = z
  .object({
    token: addressSchema,
    minimumWeightBps: weightBpsSchema,
    maximumWeightBps: weightBpsSchema,
    paused: z.boolean().default(false),
  })
  .strict()
  .refine(
    ({ minimumWeightBps, maximumWeightBps }) =>
      minimumWeightBps <= maximumWeightBps,
    { message: "Minimum weight cannot exceed maximum weight" },
  );

export const riskBoundSetSchema = z
  .object({
    mode: riskModeSchema,
    maximumTradeValue: uint256StringSchema,
    activeBounds: z.array(activeAssetBoundSchema),
  })
  .strict();

export const riskConfigurationSchema = z
  .object({
    version: identifierSchema,
    maxObservationAgeSeconds: z.number().int().positive().safe(),
    maxIndexedLagBlocks: z.number().int().nonnegative().safe(),
    minimumSampleSize: uint256StringSchema,
    requiredQuorum: z.number().int().positive().max(100),
    failSafeMode: z.enum(["CAUTIOUS", "PAUSED"]),
    recoveryQuorum: z.number().int().positive().max(100),
    cooldownSeconds: z.number().int().nonnegative().safe(),
    thresholds: z.array(riskThresholdSchema).min(1),
    boundSets: z.array(riskBoundSetSchema).length(4),
  })
  .strict()
  .superRefine((value, context) => {
    const modes = new Set(value.boundSets.map((boundSet) => boundSet.mode));
    for (const mode of ["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"] as const) {
      if (!modes.has(mode)) {
        context.addIssue({
          code: "custom",
          message: `Missing ${mode} bound set`,
          path: ["boundSets"],
        });
      }
    }
    if (value.recoveryQuorum < value.requiredQuorum) {
      context.addIssue({
        code: "custom",
        message: "Recovery quorum must be at least the trigger quorum",
        path: ["recoveryQuorum"],
      });
    }
  });

export const riskStateSchema = z
  .object({
    mode: riskModeSchema,
    sourceDigest: bytes32Schema,
    activeBoundsHash: bytes32Schema,
    maximumTradeValue: uint256StringSchema,
    changedAt: unixTimestampSchema,
    cooldownUntil: unixTimestampSchema,
  })
  .strict();

export const riskEvaluationSchema = z
  .object({
    version: identifierSchema,
    mode: riskModeSchema,
    reasonCode: identifierSchema,
    evidenceSummary: z.string().min(1).max(500),
    selectedBounds: z.array(activeAssetBoundSchema),
    maximumTradeValue: uint256StringSchema,
    activeBoundsHash: bytes32Schema,
    sourceDigest: bytes32Schema,
    evaluatedAt: unixTimestampSchema,
    indexedThroughBlock: uint256StringSchema,
    affectedAssets: z.array(addressSchema),
    previousMode: riskModeSchema,
    validObservationCount: z.number().int().nonnegative().safe().optional(),
    sourceCount: z.number().int().nonnegative().safe().optional(),
    failSafe: z.boolean().optional(),
  })
  .strict();

/** EIP-712 domain version for certificates bound to policy and auth epochs. */
export const RISK_CERTIFICATE_SIGNATURE_VERSION = 2 as const;

/** Must remain byte-for-byte aligned with RiskModeRegistry.sol. */
export const RISK_CERTIFICATE_EIP712_TYPE =
  "RiskCertificate(bytes32 policyId,uint8 riskMode,bytes32 activeBoundsHash,uint256 maximumTradeValue,bytes32 sourceDigest,bytes32 reasonCode,uint64 issuedAt,uint64 expiresAt,uint256 nonce,address watchtower,uint256 watchtowerAuthorizationEpoch,uint256 policyNonce)" as const;

export const riskCertificateSchema = z
  .object({
    // The registry signs and indexes policy identifiers as bytes32. Human
    // labels belong in the surrounding policy record, never in this payload.
    policyId: bytes32Schema,
    chainId: z.number().int().positive().safe(),
    verifyingContract: addressSchema,
    signatureVersion: z.literal(RISK_CERTIFICATE_SIGNATURE_VERSION),
    riskMode: riskModeSchema,
    activeBounds: z.array(activeAssetBoundSchema),
    activeBoundsHash: bytes32Schema,
    maximumTradeValue: uint256StringSchema,
    sourceDigest: bytes32Schema,
    reasonCode: bytes32Schema,
    issuedAt: unixTimestampSchema,
    expiresAt: unixTimestampSchema,
    nonce: uint256StringSchema,
    watchtower: addressSchema,
    watchtowerAuthorizationEpoch: uint256StringSchema,
    policyNonce: uint256StringSchema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
  })
  .strict()
  .superRefine((certificate, context) => {
    if (certificate.expiresAt <= certificate.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "Risk certificate must expire after it is issued",
        path: ["expiresAt"],
      });
    }
    const tokens = certificate.activeBounds.map(({ token }) =>
      token.toLowerCase(),
    );
    if (new Set(tokens).size !== tokens.length) {
      context.addIssue({
        code: "custom",
        message: "Active asset bounds must be unique",
        path: ["activeBounds"],
      });
    }
  });

export type RiskMode = z.infer<typeof riskModeSchema>;
export type RiskSignal = z.infer<typeof riskSignalSchema>;
export type RiskObservation = z.infer<typeof riskObservationSchema>;
export type RiskThreshold = z.infer<typeof riskThresholdSchema>;
export type RiskBoundSet = z.infer<typeof riskBoundSetSchema>;
export type RiskConfiguration = z.infer<typeof riskConfigurationSchema>;
export type RiskState = z.infer<typeof riskStateSchema>;
export type RiskEvaluation = z.infer<typeof riskEvaluationSchema>;
export type ActiveAssetBound = z.infer<typeof activeAssetBoundSchema>;
export type RiskCertificate = z.infer<typeof riskCertificateSchema>;

/** Exact Solidity `keccak256(abi.encode(ActiveAssetBound[]))` commitment. */
export function hashActiveBounds(bounds: readonly ActiveAssetBound[]): string {
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

export interface RiskCertificateHashInput {
  readonly policyId: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly riskMode: RiskMode;
  readonly activeBoundsHash: string;
  readonly maximumTradeValue: bigint | string;
  readonly sourceDigest: string;
  readonly reasonCode: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: bigint | string;
  readonly watchtower: string;
  readonly watchtowerAuthorizationEpoch: bigint | string;
  readonly policyNonce: bigint | string;
}

/** Exact EIP-712 v2 digest produced by `RiskModeRegistry.hashTypedData`. */
export function hashRiskCertificate(input: RiskCertificateHashInput): string {
  const mode: Record<RiskMode, number> = {
    NORMAL: 0,
    CAUTIOUS: 1,
    SHOCK: 2,
    PAUSED: 3,
  };
  const domainTypeHash = textHash(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  );
  const domain = keccak_256(
    join([
      domainTypeHash,
      textHash("AURKA RiskModeRegistry"),
      textHash("2"),
      slot(input.chainId),
      addressSlot(input.verifyingContract),
    ]),
  );
  const structHash = keccak_256(
    join([
      textHash(RISK_CERTIFICATE_EIP712_TYPE),
      hexToBytes(input.policyId),
      slot(mode[input.riskMode]),
      hexToBytes(input.activeBoundsHash),
      slot(input.maximumTradeValue),
      hexToBytes(input.sourceDigest),
      hexToBytes(input.reasonCode),
      slot(input.issuedAt),
      slot(input.expiresAt),
      slot(input.nonce),
      addressSlot(input.watchtower),
      slot(input.watchtowerAuthorizationEpoch),
      slot(input.policyNonce),
    ]),
  );
  return hex(
    keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...structHash])),
  );
}

function hexToBytes(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError("Expected bytes32");
  return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (item) =>
    Number.parseInt(item, 16),
  );
}

/** Human-readable configuration codes are committed as bytes32 in v2. */
export function hashRiskReasonCode(value: string): string {
  return hex(textHash(value));
}
