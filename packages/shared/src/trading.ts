import { z } from "zod";

import {
  addressSchema,
  bpsSchema,
  bytes32Schema,
  identifierSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";

export const tradeIntentSchema = z
  .object({
    intentId: bytes32Schema,
    chainId: z.number().int().positive().safe(),
    verifyingContract: addressSchema,
    trader: addressSchema,
    positionId: identifierSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    requestedTraderInputAmount: uint256StringSchema,
    exactInput: z.boolean(),
    allowPartialFill: z.boolean(),
    minimumAcceptableTraderOutput: uint256StringSchema,
    deadline: unixTimestampSchema,
    nonce: uint256StringSchema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
  })
  .strict()
  .refine(
    ({ traderInputToken, traderOutputToken }) =>
      traderInputToken.toLowerCase() !== traderOutputToken.toLowerCase(),
    {
      message: "Trader input and output assets must differ",
      path: ["traderOutputToken"],
    },
  );

export const bindingConstraintSchema = z.enum([
  "REQUESTED_AMOUNT",
  "TRANSACTION_CAP",
  "AVAILABLE_BALANCE",
  "CAPACITY_EXHAUSTED",
  "MINIMUM_WEIGHT",
  "MAXIMUM_WEIGHT",
  "RISK_LIMIT",
  "FEE_EXCEEDS_OUTPUT",
  "PAUSED",
  "NONE",
]);

export const solverProposalSchema = z
  .object({
    intentHash: bytes32Schema,
    solver: addressSchema,
    snapshotBlock: uint256StringSchema,
    balancesHash: bytes32Schema,
    priceSnapshotHash: bytes32Schema,
    policyNonce: uint256StringSchema,
    riskCertificateHash: bytes32Schema,
    traderInputValue: uint256StringSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    traderInputAmount: uint256StringSchema,
    traderOutputAmount: uint256StringSchema,
    feeBps: bpsSchema,
    feeBpsScaled: uint256StringSchema,
    feeToken: addressSchema,
    feePaymentMode: z.literal("OUTPUT_TOKEN"),
    capacityBaselineValue: uint256StringSchema,
    consumedBefore: uint256StringSchema,
    consumedAfter: uint256StringSchema,
    capacityEpochId: bytes32Schema,
    utilizationBefore: uint256StringSchema,
    utilizationAfter: uint256StringSchema,
    bindingConstraint: bindingConstraintSchema,
    bindingAsset: addressSchema.optional(),
    expectedPostStateHash: bytes32Schema,
    deadline: unixTimestampSchema,
    swapVMCalldataHash: bytes32Schema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
  })
  .strict();

export type TradeIntent = z.infer<typeof tradeIntentSchema>;
export type BindingConstraint = z.infer<typeof bindingConstraintSchema>;
export type SolverProposal = z.infer<typeof solverProposalSchema>;

/** The exact static intent signed by AurkaSwapVMRouter. */
export const atomicSettlementIntentSchema = z
  .object({
    intentId: bytes32Schema,
    policyId: bytes32Schema,
    positionIdHash: bytes32Schema,
    trader: addressSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    requestedValue: uint256StringSchema,
    minimumTraderOutputValue: uint256StringSchema,
    exactInput: z.boolean(),
    allowPartialFill: z.boolean(),
    deadline: unixTimestampSchema,
    nonce: uint256StringSchema,
    balanceSnapshot: bytes32Schema,
    priceSnapshot: bytes32Schema,
    aquaStrategyHash: bytes32Schema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .optional(),
  })
  .strict()
  .refine(
    ({ traderInputToken, traderOutputToken }) =>
      traderInputToken.toLowerCase() !== traderOutputToken.toLowerCase(),
    {
      message: "Trader input and output assets must differ",
      path: ["traderOutputToken"],
    },
  );

/** The exact static solver commitment signed for the direct router. */
export const atomicSettlementProposalSchema = z
  .object({
    intentHash: bytes32Schema,
    solver: addressSchema,
    balancesHash: bytes32Schema,
    priceSnapshotHash: bytes32Schema,
    policyNonce: uint256StringSchema,
    riskCertificateHash: bytes32Schema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    traderInputAmount: uint256StringSchema,
    traderOutputAmount: uint256StringSchema,
    solverFeeAmount: uint256StringSchema,
    protocolFeeAmount: uint256StringSchema,
    traderInputValue: uint256StringSchema,
    traderOutputValue: uint256StringSchema,
    treasuryOutputValue: uint256StringSchema,
    feeBpsScaled: uint256StringSchema,
    baseFeeAmount: uint256StringSchema,
    treasuryBaseFeeAmount: uint256StringSchema,
    optionSpacePremiumAmount: uint256StringSchema,
    totalFeeAmount: uint256StringSchema,
    treasuryAmount: uint256StringSchema,
    solverAmount: uint256StringSchema,
    protocolAmount: uint256StringSchema,
    feeToken: addressSchema,
    feePaymentMode: z.literal("OUTPUT_TOKEN"),
    initialPortfolioHash: bytes32Schema,
    capacityBaselineValue: uint256StringSchema,
    consumedBefore: uint256StringSchema,
    consumedAfter: uint256StringSchema,
    capacityEpochId: bytes32Schema,
    utilizationBefore: uint256StringSchema,
    utilizationAfter: uint256StringSchema,
    bindingConstraint: bindingConstraintSchema,
    bindingAsset: addressSchema.optional(),
    expectedPostStateHash: bytes32Schema,
    aquaStrategyHash: bytes32Schema,
    swapVMCalldataHash: bytes32Schema,
    deadline: unixTimestampSchema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .optional(),
  })
  .strict();

export type AtomicSettlementIntent = z.infer<
  typeof atomicSettlementIntentSchema
>;
export type AtomicSettlementProposal = z.infer<
  typeof atomicSettlementProposalSchema
>;
