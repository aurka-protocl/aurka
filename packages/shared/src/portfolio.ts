import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  tokenDecimalsSchema,
  uint256StringSchema,
  unixTimestampSchema,
  weightBpsSchema,
} from "./primitives.js";
import { treasuryPolicySchema } from "./policy.js";
import { riskModeSchema } from "./risk.js";

export const assetSnapshotSchema = z
  .object({
    token: addressSchema,
    symbol: z.string().trim().min(1).max(16),
    decimals: tokenDecimalsSchema,
    balance: uint256StringSchema,
    price: uint256StringSchema,
    priceDecimals: tokenDecimalsSchema,
    value: uint256StringSchema,
    weightBps: weightBpsSchema,
  })
  .strict();

export const portfolioSnapshotSchema = z
  .object({
    positionId: identifierSchema,
    blockNumber: uint256StringSchema,
    observedAt: unixTimestampSchema,
    nav: uint256StringSchema,
    valueDecimals: tokenDecimalsSchema,
    assets: z.array(assetSnapshotSchema).min(1),
    snapshotHash: bytes32Schema,
  })
  .strict();

export const positionSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(100),
    chainId: z.number().int().positive().safe(),
    owner: addressSchema,
    treasury: addressSchema,
    policy: treasuryPolicySchema,
    riskMode: riskModeSchema,
    currentPortfolio: portfolioSnapshotSchema.optional(),
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
  })
  .strict()
  .refine(({ createdAt, updatedAt }) => updatedAt >= createdAt, {
    message: "updatedAt cannot precede createdAt",
    path: ["updatedAt"],
  });

export const directionalCapacitySchema = z
  .object({
    positionId: identifierSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    maximumTraderInput: uint256StringSchema,
    maximumTraderOutput: uint256StringSchema,
    maximumValue: uint256StringSchema,
    capacityBaselineValue: uint256StringSchema,
    consumedBefore: uint256StringSchema,
    capacityEpochId: bytes32Schema,
    remainingValue: uint256StringSchema,
    utilization: uint256StringSchema,
    bindingConstraint: z.string().min(1).max(64),
    calculatedAtBlock: uint256StringSchema,
    expiresAt: unixTimestampSchema,
  })
  .strict();

export type AssetSnapshot = z.infer<typeof assetSnapshotSchema>;
export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
export type Position = z.infer<typeof positionSchema>;
export type DirectionalCapacity = z.infer<typeof directionalCapacitySchema>;
