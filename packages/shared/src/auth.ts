import { z } from "zod";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const authChallengeRequestSchema = z
  .object({
    address: addressSchema,
    chainId: z.number().int().positive().safe(),
  })
  .strict();
export type AuthChallengeRequest = z.infer<typeof authChallengeRequestSchema>;

export const authChallengeResponseSchema = z
  .object({
    challengeId: z.string().min(1).max(128),
    address: addressSchema,
    chainId: z.number().int().positive().safe(),
    nonce: z.string().min(32).max(128),
    origin: z.string().url().max(512),
    expiresAt: z.number().int().positive().safe(),
    typedData: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AuthChallengeResponse = z.infer<typeof authChallengeResponseSchema>;

export const authVerifyRequestSchema = z
  .object({
    challengeId: z.string().min(1).max(128),
    address: addressSchema,
    chainId: z.number().int().positive().safe(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();
export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>;

export const authSessionSchema = z
  .object({
    address: addressSchema,
    chainId: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type AuthSession = z.infer<typeof authSessionSchema>;

export const authLogoutResponseSchema = z
  .object({ loggedOut: z.literal(true) })
  .strict();
export type AuthLogoutResponse = z.infer<typeof authLogoutResponseSchema>;

export const authChallengeTypedData = (input: {
  readonly address: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly origin: string;
}) => ({
  domain: {
    name: "AURKA Agent Login",
    version: "1",
    chainId: input.chainId,
  },
  primaryType: "AurkaLogin",
  types: {
    AurkaLogin: [
      { name: "address", type: "address" },
      { name: "nonce", type: "string" },
      { name: "expiresAt", type: "uint256" },
      { name: "origin", type: "string" },
    ],
  },
  message: {
    address: input.address,
    nonce: input.nonce,
    expiresAt: input.expiresAt.toString(),
    origin: input.origin,
  },
});
