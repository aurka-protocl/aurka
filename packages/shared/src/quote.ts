import { z } from "zod";

import {
  addressSchema,
  bpsSchema,
  bytes32Schema,
  identifierSchema,
  isUint256String,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";
import { portfolioSnapshotSchema } from "./portfolio.js";
import { riskModeSchema } from "./risk.js";
import { bindingConstraintSchema } from "./trading.js";

const FIXED_POINT_SCALE = 1_000_000_000_000_000_000n;
const MAX_TOTAL_FEE_BPS_SCALED = 100n * FIXED_POINT_SCALE;

export const feeBreakdownSchema = z
  .object({
    baseFeeBps: bpsSchema,
    optionSpacePremiumBpsScaled: uint256StringSchema,
    totalFeeBpsScaled: uint256StringSchema,
    baseFeeAmount: uint256StringSchema,
    treasuryBaseFeeAmount: uint256StringSchema,
    optionSpacePremiumAmount: uint256StringSchema,
    totalFeeAmount: uint256StringSchema,
    treasuryAmount: uint256StringSchema,
    solverAmount: uint256StringSchema,
    protocolAmount: uint256StringSchema,
    feeToken: addressSchema,
    feePaymentMode: z.literal("OUTPUT_TOKEN"),
    treasuryRecipient: addressSchema,
    solverRecipient: addressSchema,
    protocolRecipient: addressSchema,
  })
  .strict()
  .superRefine((fee, context) => {
    if (
      BigInt(fee.baseFeeBps) * FIXED_POINT_SCALE +
        BigInt(fee.optionSpacePremiumBpsScaled) !==
      BigInt(fee.totalFeeBpsScaled)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Total scaled fee must equal base fee plus OptionSpace premium",
        path: ["totalFeeBpsScaled"],
      });
    }
    if (BigInt(fee.totalFeeBpsScaled) > MAX_TOTAL_FEE_BPS_SCALED) {
      context.addIssue({
        code: "custom",
        message: "Total fee exceeds the 100 bps protocol bound",
        path: ["totalFeeBpsScaled"],
      });
    }
    if (
      BigInt(fee.baseFeeAmount) + BigInt(fee.optionSpacePremiumAmount) !==
      BigInt(fee.totalFeeAmount)
    ) {
      context.addIssue({
        code: "custom",
        message: "Fee components must equal totalFeeAmount",
        path: ["totalFeeAmount"],
      });
    }
    if (
      BigInt(fee.treasuryBaseFeeAmount) +
        BigInt(fee.solverAmount) +
        BigInt(fee.protocolAmount) !==
      BigInt(fee.baseFeeAmount)
    ) {
      context.addIssue({
        code: "custom",
        message: "Base fee recipient amounts must equal baseFeeAmount",
        path: ["baseFeeAmount"],
      });
    }
    const amounts = [
      fee.treasuryAmount,
      fee.solverAmount,
      fee.protocolAmount,
      fee.totalFeeAmount,
    ];
    if (
      amounts.every(isUint256String) &&
      BigInt(fee.treasuryAmount) +
        BigInt(fee.solverAmount) +
        BigInt(fee.protocolAmount) !==
        BigInt(fee.totalFeeAmount)
    ) {
      context.addIssue({
        code: "custom",
        message: "Fee recipient amounts must equal totalFeeAmount",
        path: ["totalFeeAmount"],
      });
    }
  });

export const simulationStatusSchema = z.enum([
  "NOT_RUN",
  "SUCCEEDED",
  "REVERTED",
  "STALE",
  "AUTHORIZATION_PENDING",
]);

/** Persistence state for a solver proposal at the service boundary. */
export const proposalStatusSchema = z.enum([
  "EXECUTABLE",
  "AUTHORIZATION_PENDING",
  "REJECTED",
]);

export const quoteSchema = z
  .object({
    id: identifierSchema,
    intentHash: bytes32Schema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    requestedTraderInputAmount: uint256StringSchema,
    maximumSafeTraderInputAmount: uint256StringSchema,
    executableTraderInputAmount: uint256StringSchema,
    referencePrice: uint256StringSchema,
    referencePriceDecimals: z.number().int().min(0).max(36),
    fees: feeBreakdownSchema,
    bindingConstraint: bindingConstraintSchema,
    bindingAsset: addressSchema.optional(),
    currentPortfolio: portfolioSnapshotSchema,
    expectedPostTradePortfolio: portfolioSnapshotSchema,
    policyNonce: uint256StringSchema,
    capacityEpochId: bytes32Schema,
    consumedBefore: uint256StringSchema,
    consumedAfter: uint256StringSchema,
    riskMode: riskModeSchema,
    expiresAt: unixTimestampSchema,
    simulationStatus: simulationStatusSchema,
  })
  .strict()
  .superRefine((quote, context) => {
    if (
      isUint256String(quote.executableTraderInputAmount) &&
      isUint256String(quote.maximumSafeTraderInputAmount) &&
      BigInt(quote.executableTraderInputAmount) >
        BigInt(quote.maximumSafeTraderInputAmount)
    ) {
      context.addIssue({
        code: "custom",
        message: "Executable amount cannot exceed the maximum safe amount",
        path: ["executableTraderInputAmount"],
      });
    }
    if (
      isUint256String(quote.executableTraderInputAmount) &&
      isUint256String(quote.requestedTraderInputAmount) &&
      BigInt(quote.executableTraderInputAmount) >
        BigInt(quote.requestedTraderInputAmount)
    ) {
      context.addIssue({
        code: "custom",
        message: "Executable amount cannot exceed the requested amount",
        path: ["executableTraderInputAmount"],
      });
    }
  });

export type FeeBreakdown = z.infer<typeof feeBreakdownSchema>;
export type SimulationStatus = z.infer<typeof simulationStatusSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type Quote = z.infer<typeof quoteSchema>;
