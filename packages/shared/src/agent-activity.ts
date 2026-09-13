import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  transactionHashSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";
import { agentProviderSchema } from "./api.js";

export const agentActivityEventTypeSchema = z.enum([
  "MANDATE_ACTIVATED",
  "EVALUATION_STARTED",
  "EVALUATION_WAITING",
  "PROVIDER_UNAVAILABLE",
  "DETERMINISTIC_REJECTED",
  "APPROVAL_PENDING",
  "TRADE_SUBMITTED",
  "TRADE_CONFIRMED",
  "TRADE_REVERTED",
  "STOP_REQUESTED",
  "STOP_CONFIRMED",
  "RECOVERY_PENDING",
  "RECOVERY_SUBMITTED",
  "RECOVERY_CONFIRMED",
  "RECOVERY_REVERTED",
]);
export type AgentActivityEventType = z.infer<
  typeof agentActivityEventTypeSchema
>;

export const agentActivityDetailsSchema = z
  .object({
    provider: agentProviderSchema.optional(),
    model: z.string().min(1).max(128).optional(),
    latencyMs: z.number().int().nonnegative().max(600_000).optional(),
    inputTokens: z.number().int().nonnegative().max(10_000_000).optional(),
    outputTokens: z.number().int().nonnegative().max(10_000_000).optional(),
    inputToken: addressSchema.optional(),
    outputToken: addressSchema.optional(),
    inputAmount: uint256StringSchema.optional(),
    outputAmount: uint256StringSchema.optional(),
    quotedRate: z.string().min(1).max(128).optional(),
    minimumRate: z.string().min(1).max(128).optional(),
    transactionHash: transactionHashSchema.optional(),
    explorerUrl: z.string().url().max(500).optional(),
    nextCheckAt: unixTimestampSchema.optional(),
    reasonCode: z.string().min(1).max(64).optional(),
  })
  .strict();
export type AgentActivityDetails = z.infer<typeof agentActivityDetailsSchema>;

export const agentActivityEventSchema = z
  .object({
    id: identifierSchema,
    ownerAddress: addressSchema,
    agentId: identifierSchema,
    sessionId: bytes32Schema.optional(),
    occurredAt: unixTimestampSchema,
    eventType: agentActivityEventTypeSchema,
    code: z.string().min(1).max(64),
    summary: z.string().min(1).max(500),
    correlationId: identifierSchema.optional(),
    transactionHash: transactionHashSchema.optional(),
    details: agentActivityDetailsSchema.optional(),
  })
  .strict();
export type AgentActivityEvent = z.infer<typeof agentActivityEventSchema>;

export const agentActivityResponseSchema = z.object({
  items: z.array(agentActivityEventSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const agentActivityStatusSchema = z
  .object({
    agentId: identifierSchema,
    ownerAddress: addressSchema,
    state: z.string().min(1).max(32),
    provider: agentProviderSchema,
    model: z.string().min(1).max(128),
    lastEvaluatedAt: unixTimestampSchema.nullable(),
    nextCheckAt: unixTimestampSchema.nullable(),
    remainingInputBudget: uint256StringSchema.nullable(),
    confirmedTrades: z.number().int().nonnegative().max(100),
    maxTradeCount: z.number().int().positive().max(100),
    expiresAt: unixTimestampSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative().max(100),
  })
  .strict();
export type AgentActivityStatus = z.infer<typeof agentActivityStatusSchema>;
