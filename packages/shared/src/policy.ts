import { z } from "zod";

import {
  addressSchema,
  bpsSchema,
  bytes32Schema,
  identifierSchema,
  tokenDecimalsSchema,
  uint256StringSchema,
  weightBpsSchema,
} from "./primitives.js";

export const assetBoundSchema = z
  .object({
    token: addressSchema,
    symbol: z.string().trim().min(1).max(16),
    decimals: tokenDecimalsSchema,
    minimumWeightBps: weightBpsSchema,
    maximumWeightBps: weightBpsSchema,
  })
  .strict()
  .refine(
    ({ minimumWeightBps, maximumWeightBps }) =>
      minimumWeightBps <= maximumWeightBps,
    { message: "Minimum weight cannot exceed maximum weight" },
  );

export const feeConfigurationSchema = z
  .object({
    baseFeeBps: bpsSchema,
    slopeBps: bpsSchema,
    maximumFeeBps: bpsSchema,
    treasuryBaseFeeBps: bpsSchema,
    solverFeeBps: bpsSchema,
    protocolFeeBps: bpsSchema,
    treasuryFeeRecipient: addressSchema,
    protocolFeeRecipient: addressSchema,
  })
  .strict()
  .superRefine((fee, context) => {
    const distributedBaseFee =
      fee.treasuryBaseFeeBps + fee.solverFeeBps + fee.protocolFeeBps;
    if (distributedBaseFee !== fee.baseFeeBps) {
      context.addIssue({
        code: "custom",
        message: "Base-fee distribution must equal baseFeeBps",
        path: ["baseFeeBps"],
      });
    }
    if (fee.baseFeeBps > fee.maximumFeeBps) {
      context.addIssue({
        code: "custom",
        message: "Maximum fee cannot be below the base fee",
        path: ["maximumFeeBps"],
      });
    }
    if (fee.baseFeeBps + fee.slopeBps > fee.maximumFeeBps) {
      context.addIssue({
        code: "custom",
        message: "Maximum fee must cover the base fee plus the maximum premium",
        path: ["maximumFeeBps"],
      });
    }
    if (fee.maximumFeeBps > 100) {
      context.addIssue({
        code: "custom",
        message: "The bounded OptionSpace model caps total fees at 100 bps",
        path: ["maximumFeeBps"],
      });
    }
  });

export const treasuryPolicySchema = z
  .object({
    id: identifierSchema,
    chainId: z.number().int().positive().safe(),
    registry: addressSchema,
    treasury: addressSchema,
    governance: addressSchema,
    assets: z.array(assetBoundSchema).min(2),
    maximumTransactionValue: uint256StringSchema,
    quoteTtlSeconds: z.number().int().positive().max(86_400),
    priceMaxAgeSeconds: z.number().int().positive().max(86_400),
    maximumPriceDeviationBps: bpsSchema,
    fee: feeConfigurationSchema,
    nonce: uint256StringSchema,
    paused: z.boolean(),
    policyHash: bytes32Schema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const tokens = policy.assets.map(({ token }) => token.toLowerCase());
    if (new Set(tokens).size !== tokens.length) {
      context.addIssue({
        code: "custom",
        message: "Managed asset addresses must be unique",
        path: ["assets"],
      });
    }
    const minimumTotal = policy.assets.reduce(
      (total, asset) => total + asset.minimumWeightBps,
      0,
    );
    if (minimumTotal > 10_000) {
      context.addIssue({
        code: "custom",
        message: "Minimum weights cannot total more than 10,000 bps",
        path: ["assets"],
      });
    }
    const maximumTotal = policy.assets.reduce(
      (total, asset) => total + asset.maximumWeightBps,
      0,
    );
    if (maximumTotal < 10_000) {
      context.addIssue({
        code: "custom",
        message: "Maximum weights must permit a complete portfolio",
        path: ["assets"],
      });
    }
  });

export type AssetBound = z.infer<typeof assetBoundSchema>;
export type FeeConfiguration = z.infer<typeof feeConfigurationSchema>;
export type TreasuryPolicy = z.infer<typeof treasuryPolicySchema>;
