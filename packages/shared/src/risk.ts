import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  uint256StringSchema,
  unixTimestampSchema,
  weightBpsSchema,
} from "./primitives.js";

export const riskModeSchema = z.enum(["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"]);

/** EIP-712 domain version for certificates bound to policy and auth epochs. */
export const RISK_CERTIFICATE_SIGNATURE_VERSION = 2 as const;

/** Must remain byte-for-byte aligned with RiskModeRegistry.sol. */
export const RISK_CERTIFICATE_EIP712_TYPE =
  "RiskCertificate(bytes32 policyId,uint8 riskMode,bytes32 activeBoundsHash,uint256 maximumTradeValue,bytes32 sourceDigest,bytes32 reasonCode,uint64 issuedAt,uint64 expiresAt,uint256 nonce,address watchtower,uint256 watchtowerAuthorizationEpoch,uint256 policyNonce)" as const;

export const activeAssetBoundSchema = z
  .object({
    token: addressSchema,
    minimumWeightBps: weightBpsSchema,
    maximumWeightBps: weightBpsSchema,
    paused: z.boolean().default(false),
  })
  .strict()
  .refine(
    ({ minimumWeightBps, maximumWeightBps }) =>
      minimumWeightBps <= maximumWeightBps,
    { message: "Minimum weight cannot exceed maximum weight" },
  );

export const riskCertificateSchema = z
  .object({
    policyId: identifierSchema,
    chainId: z.number().int().positive().safe(),
    verifyingContract: addressSchema,
    signatureVersion: z.literal(RISK_CERTIFICATE_SIGNATURE_VERSION),
    riskMode: riskModeSchema,
    activeBounds: z.array(activeAssetBoundSchema),
    activeBoundsHash: bytes32Schema,
    maximumTradeValue: uint256StringSchema,
    sourceDigest: bytes32Schema,
    reasonCode: z.string().min(1).max(64),
    issuedAt: unixTimestampSchema,
    expiresAt: unixTimestampSchema,
    nonce: uint256StringSchema,
    watchtower: addressSchema,
    watchtowerAuthorizationEpoch: uint256StringSchema,
    policyNonce: uint256StringSchema,
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
  })
  .strict()
  .superRefine((certificate, context) => {
    if (certificate.expiresAt <= certificate.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "Risk certificate must expire after it is issued",
        path: ["expiresAt"],
      });
    }
    const tokens = certificate.activeBounds.map(({ token }) =>
      token.toLowerCase(),
    );
    if (new Set(tokens).size !== tokens.length) {
      context.addIssue({
        code: "custom",
        message: "Active asset bounds must be unique",
        path: ["activeBounds"],
      });
    }
  });

export type RiskMode = z.infer<typeof riskModeSchema>;
export type ActiveAssetBound = z.infer<typeof activeAssetBoundSchema>;
export type RiskCertificate = z.infer<typeof riskCertificateSchema>;
