import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  identifierSchema,
  positiveUint256StringSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";

const signatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

export const delegatedSessionStateSchema = z.enum([
  "AUTHORIZED",
  "ACTIVE",
  "STOPPED",
  "EXPIRED",
  "EXHAUSTED",
  "REVOKE_PENDING",
  "RECONCILIATION_REQUIRED",
]);
export type DelegatedSessionState = z.infer<typeof delegatedSessionStateSchema>;

export const delegatedControlActionSchema = z.enum([
  "APPROVE",
  "START",
  "STOP",
  "RECONCILE",
]);
export type DelegatedControlAction = z.infer<
  typeof delegatedControlActionSchema
>;

export const delegatedTradeStateSchema = z.enum([
  "RESERVED",
  "SIGNING",
  "SUBMITTED",
  "CONFIRMED",
  "REVERTED",
  "RECONCILIATION_REQUIRED",
  "RELEASED",
]);
export type DelegatedTradeState = z.infer<typeof delegatedTradeStateSchema>;

/**
 * This is the complete, integer-unit capability Bob reviews. It intentionally
 * contains no provider credentials and is the only object covered by Bob's
 * EIP-712 authorization.
 */
export const delegatedSessionPlanSchema = z
  .object({
    ownerAddress: addressSchema,
    chainId: chainIdSchema,
    allowedSpaceIds: z.array(identifierSchema).min(1).max(8),
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    perTradeInputAmount: positiveUint256StringSchema,
    cumulativeInputBudget: positiveUint256StringSchema,
    maxTradeCount: z.number().int().min(1).max(10),
    slippageBps: z.number().int().min(0).max(1_000),
    expiresAt: unixTimestampSchema,
    sessionNonce: bytes32Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (BigInt(value.cumulativeInputBudget) < BigInt(value.perTradeInputAmount))
      context.addIssue({
        code: "custom",
        message: "Cumulative budget must cover at least one trade",
        path: ["cumulativeInputBudget"],
      });
  });
export type DelegatedSessionPlan = z.infer<typeof delegatedSessionPlanSchema>;

export const delegatedSessionAuthorizationSchema = z
  .object({
    plan: delegatedSessionPlanSchema,
    agentWallet: addressSchema,
    signature: signatureSchema,
  })
  .strict();
export type DelegatedSessionAuthorization = z.infer<
  typeof delegatedSessionAuthorizationSchema
>;
export const delegatedAuthorizationSchema = delegatedSessionAuthorizationSchema;

export const delegatedWalletBalancesSchema = z
  .object({
    native: uint256StringSchema,
    inputToken: uint256StringSchema,
    outputToken: uint256StringSchema,
    inputAllowance: uint256StringSchema,
  })
  .strict();
export type DelegatedWalletBalances = z.infer<
  typeof delegatedWalletBalancesSchema
>;

export const delegatedWalletIdentitySchema = z
  .object({
    configured: z.boolean(),
    walletId: z.string().min(1).max(128).nullable(),
    address: addressSchema.nullable(),
    chainId: chainIdSchema.nullable(),
    signerAddress: addressSchema.nullable(),
    policyId: z.string().min(1).max(128).nullable(),
    policyFingerprint: bytes32Schema.nullable(),
    enabled: z.boolean(),
    revoked: z.boolean(),
    validUntil: unixTimestampSchema.nullable(),
    reason: z.string().min(1).max(500).nullable(),
    balances: delegatedWalletBalancesSchema.optional(),
  })
  .strict();
export type DelegatedWalletIdentity = z.infer<
  typeof delegatedWalletIdentitySchema
>;

export const delegatedTradeSchema = z
  .object({
    id: bytes32Schema,
    sessionId: bytes32Schema,
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    inputAmount: positiveUint256StringSchema,
    status: delegatedTradeStateSchema,
    idempotencyKey: z.string().min(24).max(128),
    transactionHash: bytes32Schema.optional(),
    error: z.string().min(1).max(500).optional(),
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
  })
  .strict();
export type DelegatedTrade = z.infer<typeof delegatedTradeSchema>;

export const delegatedSessionSchema = z
  .object({
    id: bytes32Schema,
    plan: delegatedSessionPlanSchema,
    wallet: delegatedWalletIdentitySchema,
    state: delegatedSessionStateSchema,
    authorizedAt: unixTimestampSchema,
    authorityGeneration: z.number().int().nonnegative().safe(),
    consumedInputAmount: uint256StringSchema,
    tradeCount: z.number().int().nonnegative().max(10),
    remainingInputBudget: uint256StringSchema,
    lastProposalHash: bytes32Schema.optional(),
    lastTransactionHash: bytes32Schema.optional(),
    lastRecoveryTransactionHash: bytes32Schema.optional(),
    lastResult: z.string().min(1).max(500).optional(),
    updatedAt: unixTimestampSchema,
    trades: z.array(delegatedTradeSchema),
  })
  .strict();
export type DelegatedSession = z.infer<typeof delegatedSessionSchema>;

export const delegatedStatusSchema = z
  .object({
    wallet: delegatedWalletIdentitySchema,
    activeSessions: z.number().int().nonnegative().max(100),
  })
  .strict();
export type DelegatedStatus = z.infer<typeof delegatedStatusSchema>;

export const delegatedStartRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(1_000),
    authorization: z.lazy(() => delegatedControlAuthorizationSchema),
    idempotencyKey: z.string().min(24).max(128).optional(),
  })
  .strict();
export type DelegatedStartRequest = z.infer<typeof delegatedStartRequestSchema>;

export const delegatedControlRequestSchema = z
  .object({
    authorization: z.lazy(() => delegatedControlAuthorizationSchema),
    idempotencyKey: z.string().min(24).max(128).optional(),
  })
  .strict();
export type DelegatedControlRequest = z.infer<
  typeof delegatedControlRequestSchema
>;

/** @deprecated Use delegatedControlRequestSchema. */
export const delegatedSessionIdRequestSchema = delegatedControlRequestSchema;

export const delegatedSessionResponseSchema = delegatedSessionSchema;

export const delegatedRecoveryAssetSchema = z
  .object({ token: addressSchema, amount: positiveUint256StringSchema })
  .strict();
export type DelegatedRecoveryAsset = z.infer<
  typeof delegatedRecoveryAssetSchema
>;

export const delegatedRecoveryRequestSchema = z
  .object({
    destination: addressSchema,
    // Recovery is one durable transfer per signed authorization. A second
    // token gets its own nonce/hash and receipt, so retries cannot partially
    // replay a two-transfer request.
    assets: z.array(delegatedRecoveryAssetSchema).length(1),
    recoveryNonce: bytes32Schema,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    idempotencyKey: z.string().min(24).max(128).optional(),
  })
  .strict();
export type DelegatedRecoveryRequest = z.infer<
  typeof delegatedRecoveryRequestSchema
>;

export const delegatedControlAuthorizationSchema = z
  .object({
    sessionId: bytes32Schema,
    ownerAddress: addressSchema,
    agentWallet: addressSchema,
    chainId: chainIdSchema,
    action: delegatedControlActionSchema,
    requestHash: bytes32Schema,
    nonce: bytes32Schema,
    expiresAt: unixTimestampSchema,
    signature: signatureSchema,
  })
  .strict();
export type DelegatedControlAuthorization = z.infer<
  typeof delegatedControlAuthorizationSchema
>;

export type DelegationTypedData = {
  readonly domain: {
    readonly name: "AURKA Delegated Agent";
    readonly version: "1";
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  readonly types: {
    readonly DelegationAuthorization: readonly [
      { readonly name: "commitment"; readonly type: "bytes32" },
      { readonly name: "owner"; readonly type: "address" },
      { readonly name: "agentWallet"; readonly type: "address" },
      { readonly name: "chainId"; readonly type: "uint256" },
      { readonly name: "sessionNonce"; readonly type: "bytes32" },
      { readonly name: "expiresAt"; readonly type: "uint256" },
    ];
  };
  readonly primaryType: "DelegationAuthorization";
  readonly message: {
    readonly commitment: string;
    readonly owner: string;
    readonly agentWallet: string;
    readonly chainId: number;
    readonly sessionNonce: string;
    readonly expiresAt: number;
  };
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function hashText(value: string): string {
  return `0x${Array.from(keccak_256(Uint8Array.from(value, (character) => character.charCodeAt(0))), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function delegatedControlRequestHash(message: string): string {
  return hashText(`AURKA_DELEGATED_CONTROL_REQUEST_V1:${message}`);
}

export function delegatedPlanCommitment(plan: DelegatedSessionPlan): string {
  return hashText(
    `AURKA_DELEGATED_PLAN_V1:${canonical(delegatedSessionPlanSchema.parse(plan))}`,
  );
}

export function delegatedAuthorizationTypedData(
  plan: DelegatedSessionPlan,
  agentWallet: string,
): DelegationTypedData {
  const value = delegatedSessionPlanSchema.parse(plan);
  addressSchema.parse(agentWallet);
  return {
    domain: {
      name: "AURKA Delegated Agent",
      version: "1",
      chainId: value.chainId,
      verifyingContract: agentWallet,
    },
    types: {
      DelegationAuthorization: [
        { name: "commitment", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "agentWallet", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "sessionNonce", type: "bytes32" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "DelegationAuthorization",
    message: {
      commitment: delegatedPlanCommitment(value),
      owner: value.ownerAddress,
      agentWallet,
      chainId: value.chainId,
      sessionNonce: value.sessionNonce,
      expiresAt: value.expiresAt,
    },
  };
}

export function delegatedSessionId(
  plan: DelegatedSessionPlan,
  agentWallet: string,
): string {
  return hashText(
    `AURKA_DELEGATED_SESSION_V1:${delegatedPlanCommitment(plan)}:${agentWallet.toLowerCase()}`,
  );
}

export function delegatedControlTypedData(
  plan: DelegatedSessionPlan,
  sessionId: string,
  agentWallet: string,
  action: DelegatedControlAction,
  requestHash: string,
  nonce: string,
  expiresAt: number,
) {
  const value = delegatedSessionPlanSchema.parse(plan);
  bytes32Schema.parse(sessionId);
  addressSchema.parse(agentWallet);
  bytes32Schema.parse(requestHash);
  bytes32Schema.parse(nonce);
  const parsedAction = delegatedControlActionSchema.parse(action);
  unixTimestampSchema.parse(expiresAt);
  return {
    domain: {
      name: "AURKA Delegated Agent" as const,
      version: "1" as const,
      chainId: value.chainId,
      verifyingContract: agentWallet,
    },
    types: {
      ControlAuthorization: [
        { name: "sessionId", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "agentWallet", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "action", type: "string" },
        { name: "requestHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "ControlAuthorization" as const,
    message: {
      sessionId,
      owner: value.ownerAddress,
      agentWallet,
      chainId: value.chainId,
      action: parsedAction,
      requestHash,
      nonce,
      expiresAt,
    },
  } as const;
}

export function delegatedRecoveryTypedData(
  plan: DelegatedSessionPlan,
  sessionId: string,
  agentWallet: string,
  destination: string,
  assets: readonly { token: string; amount: string }[],
  recoveryNonce: string,
) {
  const value = delegatedSessionPlanSchema.parse(plan);
  bytes32Schema.parse(sessionId);
  addressSchema.parse(agentWallet);
  addressSchema.parse(destination);
  bytes32Schema.parse(recoveryNonce);
  const normalizedAssets = assets.map((asset) =>
    delegatedRecoveryAssetSchema.parse(asset),
  );
  return {
    domain: {
      name: "AURKA Delegated Agent" as const,
      version: "1" as const,
      chainId: value.chainId,
      verifyingContract: agentWallet,
    },
    types: {
      RecoveryAuthorization: [
        { name: "sessionId", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "destination", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "assetsHash", type: "bytes32" },
        { name: "recoveryNonce", type: "bytes32" },
      ],
    },
    primaryType: "RecoveryAuthorization" as const,
    message: {
      sessionId,
      owner: value.ownerAddress,
      destination,
      chainId: value.chainId,
      assetsHash: hashText(
        `AURKA_DELEGATED_RECOVERY_V1:${canonical(normalizedAssets)}`,
      ),
      recoveryNonce,
    },
  } as const;
}

export type DelegatedSessionIdRequest = z.infer<
  typeof delegatedSessionIdRequestSchema
>;
