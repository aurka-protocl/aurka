import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  paginationSchema,
  uint256StringSchema,
  identifierSchema,
} from "./primitives.js";
import { positionSchema } from "./portfolio.js";
import { executionSchema } from "./execution.js";
import {
  atomicSettlementIntentSchema,
  atomicSettlementProposalSchema,
} from "./trading.js";
import {
  activeAssetBoundSchema,
  riskCertificateSchema,
  riskConfigurationSchema,
  riskEvaluationSchema,
  riskObservationSchema,
  riskStateSchema,
} from "./risk.js";

export const apiErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().min(1).optional(),
  })
  .strict();

export const apiSuccessSchema = <T extends z.ZodType>(data: T) =>
  z
    .object({
      ok: z.literal(true),
      data,
    })
    .strict();

export const apiFailureSchema = z
  .object({
    ok: z.literal(false),
    error: apiErrorSchema,
  })
  .strict();

export const apiResponseSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("ok", [apiSuccessSchema(data), apiFailureSchema]);

export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict();

export const listRequestSchema = paginationSchema;

export const submitIntentRequestSchema = z
  .object({ intent: atomicSettlementIntentSchema })
  .strict();

export const quoteRequestSchema = z
  .object({ intent: atomicSettlementIntentSchema })
  .strict();

export const solveRequestSchema = z
  .object({
    intent: atomicSettlementIntentSchema,
  })
  .strict();

export const executeRequestSchema = z
  .object({
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    externalSignature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const positionCapacityQuerySchema = z
  .object({
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
  })
  .strict();

export const eventPayloadSchema = z.record(z.string(), z.unknown());

export const unsignedTransactionRequestSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    to: addressSchema,
    data: z.string().regex(/^0x[0-9a-fA-F]*$/),
    value: uint256StringSchema,
  })
  .strict();

/** Versioned response data contracts used by each HTTP route. */
export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    database: z.enum(["ok", "error"]),
    rpc: z.enum(["fixture-only", "configured"]),
    indexerLagBlocks: z.number().int().nonnegative().safe(),
  })
  .strict();

export const submitIntentResponseSchema = z
  .object({
    intent: atomicSettlementIntentSchema,
    intentHash: bytes32Schema,
  })
  .strict();

export const solveResponseSchema = z
  .object({
    proposal: atomicSettlementProposalSchema,
    proposalHash: bytes32Schema,
    simulation: z
      .object({
        status: z.enum([
          "SUCCEEDED",
          "REVERTED",
          "STALE",
          "AUTHORIZATION_PENDING",
        ]),
        gasEstimate: uint256StringSchema,
        reason: z.string().max(500).optional(),
      })
      .strict(),
  })
  .strict();

export const executeResponseSchema = z
  .object({
    execution: executionSchema,
    transactionRequest: unsignedTransactionRequestSchema,
  })
  .strict();

export const positionsResponseSchema = paginatedSchema(positionSchema);
export const proposalsResponseSchema = z.array(atomicSettlementProposalSchema);

export const riskEvaluateRequestSchema = z
  .object({
    positionId: identifierSchema,
    observations: z.array(riskObservationSchema),
    configuration: riskConfigurationSchema,
    hardMaximumTradeValue: uint256StringSchema,
    hardBounds: z.array(activeAssetBoundSchema),
    chainId: z.number().int().positive().safe(),
    deploymentId: z.string().min(1).max(128),
    canonicalBlock: uint256StringSchema,
    canonicalBlockHashes: z.record(z.string(), bytes32Schema),
    nowSeconds: z.number().int().nonnegative().safe(),
    currentState: riskStateSchema.optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const riskEvaluateResponseSchema = z
  .object({
    positionId: identifierSchema,
    evaluation: riskEvaluationSchema,
  })
  .strict();

export const riskCertificateRequestSchema = z
  .object({
    positionId: identifierSchema,
    certificate: riskCertificateSchema,
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const riskPositionResponseSchema = z
  .object({
    positionId: identifierSchema,
    hardPolicy: z.record(z.string(), z.unknown()),
    effective: riskEvaluationSchema,
    certificate: riskCertificateSchema.nullable(),
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
        role: z.enum(["EXECUTION", "RISK"]),
        address: addressSchema,
        enabled: z.boolean(),
        revoked: z.boolean(),
        expiresAt: z.number().int().nonnegative().safe(),
        policyFingerprint: bytes32Schema,
      })
      .strict(),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };
