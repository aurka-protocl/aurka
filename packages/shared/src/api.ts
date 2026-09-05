import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  paginationSchema,
  uint256StringSchema,
} from "./primitives.js";
import { atomicSettlementIntentSchema } from "./trading.js";

export const apiErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().min(1).optional(),
  })
  .strict();

export const apiSuccessSchema = <T extends z.ZodType>(data: T) =>
  z
    .object({
      ok: z.literal(true),
      data,
    })
    .strict();

export const apiFailureSchema = z
  .object({
    ok: z.literal(false),
    error: apiErrorSchema,
  })
  .strict();

export const apiResponseSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("ok", [apiSuccessSchema(data), apiFailureSchema]);

export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict();

export const listRequestSchema = paginationSchema;

export const submitIntentRequestSchema = z
  .object({ intent: atomicSettlementIntentSchema })
  .strict();

export const quoteRequestSchema = z
  .object({ intent: atomicSettlementIntentSchema })
  .strict();

export const solveRequestSchema = z
  .object({
    intent: atomicSettlementIntentSchema,
    maxProposals: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export const executeRequestSchema = z
  .object({
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    externalSignature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const positionCapacityQuerySchema = z
  .object({
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
  })
  .strict();

export const eventPayloadSchema = z.record(z.string(), z.unknown());

export const unsignedTransactionRequestSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    to: addressSchema,
    data: z.string().regex(/^0x[0-9a-fA-F]*$/),
    value: uint256StringSchema,
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };
