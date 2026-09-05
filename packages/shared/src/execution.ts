import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  transactionHashSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";
import { portfolioSnapshotSchema } from "./portfolio.js";
import { feeBreakdownSchema } from "./quote.js";
import { bindingConstraintSchema } from "./trading.js";

export const executionStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "REVERTED",
  "DROPPED",
]);

export const executionSchema = z
  .object({
    transactionHash: transactionHashSchema,
    chainId: z.number().int().positive().safe(),
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    selectedSolver: addressSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    requestedTraderInputAmount: uint256StringSchema,
    executedTraderInputAmount: uint256StringSchema,
    fees: feeBreakdownSchema,
    bindingConstraint: bindingConstraintSchema,
    initialPortfolio: portfolioSnapshotSchema,
    finalPortfolio: portfolioSnapshotSchema.optional(),
    remainingCapacity: uint256StringSchema.optional(),
    status: executionStatusSchema,
    submittedAt: unixTimestampSchema,
    confirmedAt: unixTimestampSchema.optional(),
    blockNumber: uint256StringSchema.optional(),
    revertReason: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.status === "CONFIRMED" && !execution.finalPortfolio) {
      context.addIssue({
        code: "custom",
        message: "Confirmed execution requires a final portfolio",
        path: ["finalPortfolio"],
      });
    }
    if (execution.status === "REVERTED" && !execution.revertReason) {
      context.addIssue({
        code: "custom",
        message: "Reverted execution requires a reason",
        path: ["revertReason"],
      });
    }
  });

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type Execution = z.infer<typeof executionSchema>;
