import { z } from "zod";

import {
  activityTypeSchema,
  activityItemSchema,
  activityStatusSchema,
  feeSummarySchema,
} from "./activity.js";
import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  paginationSchema,
  uint256StringSchema,
  identifierSchema,
  unixTimestampSchema,
} from "./primitives.js";
import { positionSchema } from "./portfolio.js";
import { executionSchema } from "./execution.js";
import { quoteSchema } from "./quote.js";
import {
  atomicSettlementIntentSchema,
  atomicSettlementProposalSchema,
} from "./trading.js";
import {
  activeAssetBoundSchema,
  riskModeSchema,
  riskCertificateSchema,
  riskConfigurationSchema,
  riskEvaluationSchema,
  riskObservationSchema,
  riskStateSchema,
} from "./risk.js";
import { spaceStateSchema } from "./space.js";

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
    observedAt: unixTimestampSchema,
  })
  .strict();

export const diagnosticStateSchema = z.enum([
  "configured",
  "healthy",
  "unhealthy",
  "unknown",
  "disabled",
]);

const diagnosticCheckSchema = z
  .object({
    state: diagnosticStateSchema,
    observedAt: unixTimestampSchema.nullable(),
    reason: z.string().min(1).max(128).nullable(),
  })
  .strict();

const blockHeadSchema = diagnosticCheckSchema
  .extend({
    chainId: z.number().int().positive().safe().nullable(),
    expectedChainId: z.number().int().positive().safe().nullable(),
    latestBlock: uint256StringSchema.nullable(),
    canonicalBlock: uint256StringSchema.nullable(),
    canonicalBlockHash: bytes32Schema.nullable(),
    finalizedBlock: uint256StringSchema.nullable(),
    finalizedBlockHash: bytes32Schema.nullable(),
    finalizedAt: unixTimestampSchema.nullable(),
  })
  .strict();

const databaseCheckSchema = diagnosticCheckSchema
  .extend({
    latencyMs: z.number().nonnegative().safe().nullable(),
  })
  .strict();

const indexerCheckSchema = diagnosticCheckSchema
  .extend({
    checkpointBlock: uint256StringSchema.nullable(),
    checkpointHash: bytes32Schema.nullable(),
    latestBlock: uint256StringSchema.nullable(),
    lagBlocks: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();

const sourceDiagnosticSchema = diagnosticCheckSchema
  .extend({
    sourceId: identifierSchema,
    lastObservedAt: unixTimestampSchema.nullable(),
    indexedBlock: uint256StringSchema.nullable(),
    lagBlocks: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();

const sourcesCheckSchema = diagnosticCheckSchema
  .extend({
    sources: z.array(sourceDiagnosticSchema),
  })
  .strict();

const workerCheckSchema = diagnosticCheckSchema
  .extend({
    lastAttemptAt: unixTimestampSchema.nullable(),
    lastCompletedAt: unixTimestampSchema.nullable(),
    leaseExpiresAt: unixTimestampSchema.nullable(),
    inFlight: z.boolean(),
  })
  .strict();

const signerCheckSchema = diagnosticCheckSchema
  .extend({
    address: addressSchema.nullable(),
    enabled: z.boolean().nullable(),
    revoked: z.boolean().nullable(),
    expiresAt: unixTimestampSchema.nullable(),
    policyFingerprint: bytes32Schema.nullable(),
  })
  .strict();

const registryCheckSchema = diagnosticCheckSchema
  .extend({
    source: z.enum(["REGISTRY", "UNAVAILABLE"]).nullable(),
    mode: z.enum(["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"]).nullable(),
    effectiveObservedAt: unixTimestampSchema.nullable(),
  })
  .strict();

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    mode: z.enum(["fixture", "live"]),
    observedAt: unixTimestampSchema,
    checks: z
      .object({
        database: databaseCheckSchema,
        rpc: blockHeadSchema,
        indexer: indexerCheckSchema,
        sources: sourcesCheckSchema,
        worker: workerCheckSchema,
        signer: signerCheckSchema,
        registry: registryCheckSchema,
      })
      .strict(),
    reasons: z.array(z.string().min(1).max(160)).max(50),
    // Legacy summary fields remain available to older clients. The detailed
    // checks above are authoritative and distinguish configuration from
    // measured health.
    database: z.enum(["ok", "error"]),
    rpc: z.enum(["fixture-only", "configured", "error"]),
    indexerLagBlocks: z.number().int().nonnegative().safe().nullable(),
    risk: z.enum(["not_configured", "unverified"]),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

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

export const agentProposalRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(1_000),
    trader: addressSchema,
    chainId: chainIdSchema,
    spaceId: identifierSchema.optional(),
  })
  .strict();

export const agentStatusSchema = z
  .object({
    provider: z.literal("openrouter"),
    configured: z.boolean(),
    model: z.string().min(1).max(128),
    custody: z.literal("wallet-approved"),
  })
  .strict();

export const agentUnavailableCodeSchema = z.enum([
  "MISSING_CONFIGURATION",
  "AUTHENTICATION_REJECTED",
  "RATE_LIMITED",
  "TIMEOUT",
  "UNSUPPORTED_CAPABILITY",
  "PROVIDER_OUTAGE",
  "MALFORMED_RESPONSE",
  "NETWORK_ERROR",
  "CONCURRENCY_LIMIT",
  "TOOL_BUDGET_EXHAUSTED",
]);

export type AgentUnavailableCode = z.infer<typeof agentUnavailableCodeSchema>;

const agentBlockedCodeSchema = z.enum([
  "NO_ELIGIBLE_SPACES",
  "TRADE_RULE_REJECTED",
  "INVALID_TRADE_REQUEST",
  "SIMULATION_REJECTED",
  "SPACE_UNAVAILABLE",
  "PRICING_RENEWAL_REQUIRED",
]);

const agentRuleAssetSchema = z
  .object({
    token: addressSchema,
    symbol: z.string().trim().min(1).max(16),
    decimals: z.number().int().nonnegative().safe(),
    minimumWeightBps: z.number().int().nonnegative().max(10_000).safe(),
    maximumWeightBps: z.number().int().nonnegative().max(10_000).safe(),
  })
  .strict();

const agentRulesSchema = z
  .object({
    chainId: chainIdSchema,
    state: spaceStateSchema,
    riskMode: riskModeSchema,
    policyNonce: uint256StringSchema,
    maximumTransactionValue: uint256StringSchema,
    valueDecimals: z.number().int().nonnegative().safe(),
    assets: z.array(agentRuleAssetSchema).min(1).max(32),
  })
  .strict();

const agentToolTraceSchema = z
  .object({
    tool: z.string().min(1).max(64),
    status: z.enum(["SUCCEEDED", "FAILED"]),
  })
  .strict();

const agentSimulationSchema = z
  .object({
    status: z.enum(["SUCCEEDED", "REVERTED", "STALE", "AUTHORIZATION_PENDING"]),
    gasEstimate: uint256StringSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

const agentSelectedSpaceSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(100),
    owner: addressSchema,
  })
  .strict();

export const agentProposalResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("READY"),
      provider: z.literal("openrouter"),
      model: z.string().min(1).max(128),
      selectedSpace: agentSelectedSpaceSchema,
      quote: quoteSchema,
      proposal: atomicSettlementProposalSchema,
      proposalHash: bytes32Schema,
      simulation: agentSimulationSchema,
      minimumReceivedValue: uint256StringSchema,
      explanation: z.string().min(1).max(1_000),
      toolTrace: z.array(agentToolTraceSchema).min(2).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("CLARIFICATION"),
      provider: z.literal("openrouter"),
      model: z.string().min(1).max(128),
      reason: z.string().min(1).max(500),
      nextAction: z.string().min(1).max(500),
      suggestions: z.array(z.string().min(1).max(160)).max(4),
      toolTrace: z.array(agentToolTraceSchema).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("READ_ONLY_ANSWER"),
      provider: z.literal("openrouter"),
      model: z.string().min(1).max(128),
      selectedSpace: agentSelectedSpaceSchema,
      rules: agentRulesSchema,
      answer: z.string().min(1).max(1_000),
      toolTrace: z.array(agentToolTraceSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("UNSUPPORTED_ACTION"),
      provider: z.literal("openrouter"),
      model: z.string().min(1).max(128),
      reason: z.string().min(1).max(500),
      nextAction: z.string().min(1).max(500),
      settingsPath: z
        .string()
        .regex(/^\/spaces\/[^/]+\/settings$/)
        .optional(),
      toolTrace: z.array(agentToolTraceSchema).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("BLOCKED"),
      provider: z.literal("openrouter"),
      model: z.string().min(1).max(128),
      code: agentBlockedCodeSchema,
      reason: z.string().min(1).max(500),
      nextAction: z.string().min(1).max(500).optional(),
      toolTrace: z.array(agentToolTraceSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("UNAVAILABLE"),
      provider: z.literal("openrouter"),
      model: z.string().min(1).max(128),
      code: agentUnavailableCodeSchema,
      reason: z.string().min(1).max(500),
      retryable: z.boolean(),
      toolTrace: z.array(agentToolTraceSchema).max(16),
    })
    .strict(),
]);

export type AgentProposalRequest = z.infer<typeof agentProposalRequestSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentProposalResponse = z.infer<typeof agentProposalResponseSchema>;

export const executeResponseSchema = z
  .object({
    execution: executionSchema,
    transactionRequest: unsignedTransactionRequestSchema,
  })
  .strict();

export const positionsResponseSchema = paginatedSchema(positionSchema);
export const proposalsResponseSchema = z.array(atomicSettlementProposalSchema);
export const activityResponseSchema = paginatedSchema(activityItemSchema);

export const activityQuerySchema = paginationSchema
  .extend({
    spaceId: identifierSchema.optional(),
    positionId: identifierSchema.optional(),
    chainId: z.coerce.number().pipe(chainIdSchema).optional(),
    type: activityTypeSchema.optional(),
    status: activityStatusSchema.optional(),
    from: z.coerce.number().pipe(unixTimestampSchema).optional(),
    to: z.coerce.number().pipe(unixTimestampSchema).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.spaceId !== undefined &&
      query.positionId !== undefined &&
      query.spaceId !== query.positionId
    ) {
      context.addIssue({
        code: "custom",
        message: "Activity spaceId and legacy positionId must match",
        path: ["spaceId"],
      });
    }
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from > query.to
    ) {
      context.addIssue({
        code: "custom",
        message: "Activity start time must not be after end time",
        path: ["from"],
      });
    }
  });

export const feeSummaryQuerySchema = z
  .object({
    from: z.coerce.number().pipe(unixTimestampSchema).optional(),
    to: z.coerce.number().pipe(unixTimestampSchema).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from > query.to
    ) {
      context.addIssue({
        code: "custom",
        message: "Fee-summary start time must not be after end time",
        path: ["from"],
      });
    }
  });
export const feeSummaryResponseSchema = feeSummarySchema;

export const riskEvaluateRequestSchema = z
  .object({
    positionId: identifierSchema,
    observations: z.array(riskObservationSchema),
    // Trusted runtimes use this to preserve source outages as fail-safe input.
    // Public callers may only make an evaluation tighter by supplying it.
    sourceFailures: z.array(identifierSchema).max(100).default([]),
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

export const riskCertificateResponseSchema = z
  .object({
    positionId: identifierSchema,
    certificateHash: bytes32Schema,
    certificate: riskCertificateSchema,
    state: z.enum(["SIGNED", "SUBMITTED", "ACTIVE", "EXPIRED", "REVOKED"]),
    submissionState: z.enum(["NOT_SUBMITTED", "SUBMITTED"]),
  })
  .strict();

export const riskPositionResponseSchema = z
  .object({
    positionId: identifierSchema,
    hardPolicy: z.record(z.string(), z.unknown()),
    effective: z
      .object({
        source: z.enum(["REGISTRY", "UNAVAILABLE"]),
        mode: z.enum(["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"]).nullable(),
        maximumTradeValue: uint256StringSchema.nullable(),
        activeBounds: z.array(activeAssetBoundSchema),
        observedAt: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    // This is the versioned operator configuration used by the latest
    // evaluation. It is nullable when no evaluation has been persisted yet.
    configuration: riskConfigurationSchema.nullable(),
    proposed: riskEvaluationSchema.nullable(),
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
      .strict()
      .nullable(),
  })
  .strict();

export type RiskPositionResponse = z.infer<typeof riskPositionResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

export const prepareIntentRequestSchema = z
  .object({
    positionId: identifierSchema,
    trader: addressSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    requestedValue: uint256StringSchema,
    minimumTraderOutputValue: uint256StringSchema,
    nonce: uint256StringSchema,
    deadline: z.number().int().positive().safe(),
  })
  .strict();
export type PrepareIntentRequest = z.infer<typeof prepareIntentRequestSchema>;

/** Human-facing preparation input; the service converts token units at its committed snapshot. */
export const prepareTokenIntentRequestSchema = z
  .object({
    positionId: identifierSchema,
    trader: addressSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    requestedTraderInputAmount: uint256StringSchema,
    minimumTraderOutputValue: uint256StringSchema,
    nonce: uint256StringSchema,
    deadline: z.number().int().positive().safe(),
  })
  .strict();
export type PrepareTokenIntentRequest = z.infer<
  typeof prepareTokenIntentRequestSchema
>;
