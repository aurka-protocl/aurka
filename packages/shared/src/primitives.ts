import { z } from "zod";

const UINT256_MAX = (1n << 256n) - 1n;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

export const isUint256String = (value: string): boolean =>
  UINT_PATTERN.test(value) && BigInt(value) <= UINT256_MAX;

/** EVM address. Checksum verification belongs in chain-aware adapters. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Expected an EVM address");

export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "Expected 32 bytes of hex data");

export const transactionHashSchema = bytes32Schema;

/**
 * Lossless JSON representation of a uint256. Leading zeros are rejected so
 * hashes and signatures have one canonical representation.
 */
export const uint256StringSchema = z
  .string()
  .refine(isUint256String, "Expected a canonical uint256 string");

export const positiveUint256StringSchema = uint256StringSchema.refine(
  (value) => value !== "0",
  "Expected a positive integer",
);

export const unixTimestampSchema = z.number().int().nonnegative().safe();
export const chainIdSchema = z.number().int().positive().safe();
export const tokenDecimalsSchema = z.number().int().min(0).max(36);
export const bpsSchema = z.number().int().min(0).max(10_000);
export const weightBpsSchema = bpsSchema;

export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid identifier");

export const paginationSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type Address = z.infer<typeof addressSchema>;
export type Bytes32 = z.infer<typeof bytes32Schema>;
export type Uint256String = z.infer<typeof uint256StringSchema>;
