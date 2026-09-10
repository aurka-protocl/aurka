import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  identifierSchema,
  transactionHashSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";
import { portfolioSnapshotSchema } from "./portfolio.js";
import { feeBreakdownSchema } from "./quote.js";
import { spaceMutationOperationSchema, spaceStateSchema } from "./space.js";
import { bindingConstraintSchema } from "./trading.js";

/**
 * Read-model status, deliberately separate from the solver's execution status.
 * A service-generated execution hash is a preparation identifier until a
 * canonical chain receipt is indexed.
 */
export const activityStatusSchema = z.enum([
  "PREPARED",
  "PENDING",
  "CONFIRMED",
  "FAILED",
  "ORPHANED",
]);

export const activitySourceSchema = z.enum([
  "SERVICE_PREPARATION",
  "CHAIN_EVENT",
  "SPACE_CHANGE",
]);

/** User-facing categories supported by the global Activity feed. */
export const activityTypeSchema = z.enum([
  "SWAP",
  "RULE_CHANGE",
  "TRADING_STATUS",
]);

export const activityFeeStateSchema = z.enum(["NONE", "ESTIMATE", "EARNED"]);

export const activityFeeSchema = z
  .object({
    feeToken: addressSchema,
    treasuryAmount: uint256StringSchema,
    solverAmount: uint256StringSchema,
    protocolAmount: uint256StringSchema,
    totalAmount: uint256StringSchema,
    unit: z.literal("NORMALIZED_SETTLEMENT_VALUE"),
    eventId: identifierSchema,
  })
  .strict();

export const activityEvidenceSchema = z
  .object({
    tradeEventId: identifierSchema.optional(),
    feeEventId: identifierSchema.optional(),
    graphEntityId: identifierSchema.optional(),
    receiptHash: transactionHashSchema.optional(),
    blockHash: bytes32Schema.optional(),
  })
  .strict();

const activityCommonShape = {
  id: identifierSchema,
  spaceId: identifierSchema,
  spaceName: z.string().trim().min(1).max(100).optional(),
  positionId: identifierSchema.optional(),
  chainId: chainIdSchema,
  status: activityStatusSchema,
  actor: addressSchema.optional(),
  transactionHash: transactionHashSchema.optional(),
  submittedAt: unixTimestampSchema.optional(),
  occurredAt: unixTimestampSchema.optional(),
  confirmedAt: unixTimestampSchema.optional(),
  blockNumber: uint256StringSchema.optional(),
  evidence: activityEvidenceSchema,
};

/** A service preparation or canonical, paired router settlement. */
const activitySwapSchema = z
  .object({
    ...activityCommonShape,
    type: z.literal("SWAP"),
    positionId: identifierSchema,
    source: z.enum(["SERVICE_PREPARATION", "CHAIN_EVENT"]),
    transactionHash: transactionHashSchema,
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    trader: addressSchema,
    treasury: addressSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    traderInputSymbol: z.string().trim().min(1).max(16).optional(),
    traderOutputSymbol: z.string().trim().min(1).max(16).optional(),
    requestedTraderInputValue: uint256StringSchema,
    executedTraderInputValue: uint256StringSchema.optional(),
    traderOutputValue: uint256StringSchema.optional(),
    submittedAt: unixTimestampSchema,
    bindingConstraint: bindingConstraintSchema.optional(),
    estimatedFees: feeBreakdownSchema.optional(),
    feeState: activityFeeStateSchema,
    earnedFee: activityFeeSchema.optional(),
    initialPortfolio: portfolioSnapshotSchema.optional(),
    finalPortfolio: portfolioSnapshotSchema.optional(),
    expectedPostStateHash: bytes32Schema.optional(),
    revertReason: z.string().max(500).optional(),
  })
  .strict();

/** A durable owner-authenticated policy/draft mutation. */
const activityChangeShape = {
  ...activityCommonShape,
  source: z.literal("SPACE_CHANGE"),
  actor: addressSchema,
  submittedAt: unixTimestampSchema,
  occurredAt: unixTimestampSchema,
  operation: spaceMutationOperationSchema.optional(),
  state: spaceStateSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
};

const activityRuleChangeSchema = z
  .object({
    ...activityChangeShape,
    type: z.literal("RULE_CHANGE"),
    eventType: z.enum(["SPACE_CREATED", "SPACE_UPDATED", "SPACE_ACTIVATED"]),
  })
  .strict();

const activityTradingStatusSchema = z
  .object({
    ...activityChangeShape,
    type: z.literal("TRADING_STATUS"),
    eventType: z.enum([
      "SPACE_PAUSED",
      "SPACE_RESUMED",
      "SPACE_DEPLOYMENT_FAILED",
    ]),
  })
  .strict();

/** One browsable swap, rule change, or trading-status transition. */
const activityItemUnionSchema = z.discriminatedUnion("type", [
  activitySwapSchema,
  activityRuleChangeSchema,
  activityTradingStatusSchema,
]);

/**
 * Add the new SWAP discriminator when reading pre-MVP-005 swap payloads. The
 * activity feed is a derived read model, so this keeps old persisted attempts
 * readable while all newly emitted responses are explicit.
 */
export const activityItemSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.type !== undefined) return value;
  if (typeof record.positionId !== "string") return value;
  return {
    ...record,
    type: "SWAP",
    spaceId: record.spaceId ?? record.positionId,
  };
}, activityItemUnionSchema);

export const feeSummaryItemSchema = z
  .object({
    feeToken: addressSchema,
    feeTokenSymbol: z.string().trim().min(1).max(16).optional(),
    treasuryAmount: uint256StringSchema,
    totalFeeAmount: uint256StringSchema,
    solverAmount: uint256StringSchema,
    protocolAmount: uint256StringSchema,
    settlementCount: z.number().int().nonnegative().safe(),
    unit: z.literal("NORMALIZED_SETTLEMENT_VALUE"),
    firstConfirmedAt: unixTimestampSchema,
    lastConfirmedAt: unixTimestampSchema,
  })
  .strict();

/**
 * Fee totals are grouped by fee token. They are never added across unlike
 * tokens, and only canonical TradeExecuted + FeesRouted pairs qualify.
 */
export const feeSummarySchema = z
  .object({
    positionId: identifierSchema,
    chainId: chainIdSchema,
    treasury: addressSchema,
    periodFrom: unixTimestampSchema.nullable(),
    periodTo: unixTimestampSchema.nullable(),
    coveredFrom: unixTimestampSchema.nullable(),
    coveredTo: unixTimestampSchema.nullable(),
    coverage: z.enum([
      "CONFIRMED_SETTLEMENT_EVENTS",
      "NO_CONFIRMED_SETTLEMENTS",
    ]),
    items: z.array(feeSummaryItemSchema),
    confirmedSettlementCount: z.number().int().nonnegative().safe(),
  })
  .strict();

export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityFee = z.infer<typeof activityFeeSchema>;
export type FeeSummaryItem = z.infer<typeof feeSummaryItemSchema>;
export type FeeSummary = z.infer<typeof feeSummarySchema>;
