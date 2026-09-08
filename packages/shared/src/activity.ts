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
    blockHash: bytes32Schema.optional(),
  })
  .strict();

/** One browsable attempt or canonical settlement. */
export const activityItemSchema = z
  .object({
    id: identifierSchema,
    positionId: identifierSchema,
    chainId: chainIdSchema,
    status: activityStatusSchema,
    source: activitySourceSchema,
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
    occurredAt: unixTimestampSchema.optional(),
    confirmedAt: unixTimestampSchema.optional(),
    blockNumber: uint256StringSchema.optional(),
    bindingConstraint: bindingConstraintSchema.optional(),
    estimatedFees: feeBreakdownSchema.optional(),
    feeState: activityFeeStateSchema,
    earnedFee: activityFeeSchema.optional(),
    initialPortfolio: portfolioSnapshotSchema.optional(),
    finalPortfolio: portfolioSnapshotSchema.optional(),
    expectedPostStateHash: bytes32Schema.optional(),
    revertReason: z.string().max(500).optional(),
    evidence: activityEvidenceSchema,
  })
  .strict();

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
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityFee = z.infer<typeof activityFeeSchema>;
export type FeeSummaryItem = z.infer<typeof feeSummaryItemSchema>;
export type FeeSummary = z.infer<typeof feeSummarySchema>;
