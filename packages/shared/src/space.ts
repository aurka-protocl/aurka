import { z } from "zod";
import { positionSchema, type Position } from "./portfolio.js";
import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";
import { assetBoundSchema } from "./policy.js";

export const spaceEnvironmentSchema = z.enum(["demo", "fork"]);
export const spaceStateSchema = z.enum([
  "DRAFT",
  "PENDING",
  "ACTIVE",
  "REACTIVATION_REQUIRED",
  "PAUSED",
  "FAILED",
]);

export const spaceMutationOperationSchema = z.enum([
  "CREATE",
  "UPDATE",
  "ACTIVATE",
  "PAUSE",
  "RESUME",
]);

export const SPACE_MANAGEMENT_AUTHORITY =
  "0x0000000000000000000000000000000000000001" as const;
export const SPACE_MUTATION_TYPES = [
  { name: "operation", type: "string" },
  { name: "spaceId", type: "string" },
  { name: "owner", type: "address" },
  { name: "payloadHash", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export const spaceIdentitySchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(100),
    ownerAddress: addressSchema,
    controllerAddress: addressSchema,
    treasuryAddress: addressSchema,
    chainId: z.number().int().positive().safe(),
    policyId: identifierSchema,
    strategyId: bytes32Schema,
    policyRegistryAddress: addressSchema,
    mode: spaceEnvironmentSchema,
    state: spaceStateSchema,
  })
  .strict();

export type SpaceEnvironment = z.infer<typeof spaceEnvironmentSchema>;
export type SpaceState = z.infer<typeof spaceStateSchema>;
export type SpaceMutationOperation = z.infer<
  typeof spaceMutationOperationSchema
>;
export type SpaceIdentity = z.infer<typeof spaceIdentitySchema>;

export const spaceChangeEventTypeSchema = z.enum([
  "SPACE_CREATED",
  "SPACE_UPDATED",
  "SPACE_ACTIVATED",
  "SPACE_PAUSED",
  "SPACE_RESUMED",
  "SPACE_REACTIVATED",
  "SPACE_DEPLOYMENT_FAILED",
]);

/** The editable, supported Space policy draft. Chain-bound addresses are
 * deliberately kept in the draft so the server can validate the complete
 * signed payload before accepting it. */
export const spaceDraftSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(100),
    ownerAddress: addressSchema,
    chainId: z.number().int().positive().safe(),
    assets: z.array(assetBoundSchema).min(2).max(32),
    maximumTransactionValue: uint256StringSchema,
  })
  .strict();

export type SpaceDraft = z.infer<typeof spaceDraftSchema>;

export const spaceChangeSchema = z
  .object({
    id: identifierSchema,
    spaceId: identifierSchema,
    eventType: spaceChangeEventTypeSchema,
    actor: addressSchema,
    status: z.enum(["PENDING", "CONFIRMED", "FAILED"]),
    receiptHash: bytes32Schema.optional(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: unixTimestampSchema,
  })
  .strict();

export type SpaceChange = z.infer<typeof spaceChangeSchema>;

export interface SpaceRecord {
  readonly identity: SpaceIdentity;
  readonly position?: Position | undefined;
  readonly draft?: SpaceDraft | undefined;
  readonly failureReason?: string | undefined;
}

export const spaceRecordSchema = z
  .object({
    identity: spaceIdentitySchema,
    position: positionSchema.optional(),
    draft: spaceDraftSchema.optional(),
    failureReason: z.string().min(1).max(500).optional(),
  })
  .strict();

export const spaceMutationPrepareRequestSchema = z
  .object({
    operation: spaceMutationOperationSchema,
    spaceId: identifierSchema,
    ownerAddress: addressSchema,
    draft: spaceDraftSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      (input.operation === "CREATE" ||
        input.operation === "UPDATE" ||
        input.operation === "ACTIVATE") &&
      !input.draft
    ) {
      context.addIssue({
        code: "custom",
        message: "This Space mutation requires a policy draft",
        path: ["draft"],
      });
    }
    if (input.draft && input.draft.id !== input.spaceId) {
      context.addIssue({
        code: "custom",
        message: "Draft identity does not match the Space identity",
        path: ["draft", "id"],
      });
    }
  });

export type SpaceMutationPrepareRequest = z.infer<
  typeof spaceMutationPrepareRequestSchema
>;

const typedDataFieldSchema = z
  .object({ name: z.string().min(1), type: z.string().min(1) })
  .strict();

export const spaceMutationTypedDataSchema = z
  .object({
    domain: z
      .object({
        name: z.literal("AURKA Space Management"),
        version: z.literal("1"),
        chainId: z.number().int().positive().safe(),
        verifyingContract: addressSchema,
      })
      .strict(),
    primaryType: z.literal("SpaceMutation"),
    types: z.record(z.string(), z.array(typedDataFieldSchema)),
    message: z
      .object({
        operation: z.string().min(1),
        spaceId: identifierSchema,
        owner: addressSchema,
        payloadHash: bytes32Schema,
        nonce: uint256StringSchema,
        deadline: unixTimestampSchema,
      })
      .strict(),
  })
  .strict();

export type SpaceMutationTypedData = z.infer<
  typeof spaceMutationTypedDataSchema
>;

export const spaceMutationAuthorizationSchema = z
  .object({
    operation: spaceMutationOperationSchema,
    spaceId: identifierSchema,
    ownerAddress: addressSchema,
    payloadHash: bytes32Schema,
    nonce: uint256StringSchema,
    deadline: unixTimestampSchema,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();

export type SpaceMutationAuthorization = z.infer<
  typeof spaceMutationAuthorizationSchema
>;

export const spaceMutationPrepareResponseSchema = z
  .object({
    authorization: spaceMutationAuthorizationSchema.omit({ signature: true }),
    typedData: spaceMutationTypedDataSchema,
  })
  .strict();

export type SpaceMutationPrepareResponse = z.infer<
  typeof spaceMutationPrepareResponseSchema
>;

export const spaceMutationConfirmRequestSchema = z
  .object({
    operation: spaceMutationOperationSchema,
    spaceId: identifierSchema,
    ownerAddress: addressSchema,
    draft: spaceDraftSchema.optional(),
    authorization: spaceMutationAuthorizationSchema,
    receiptHash: bytes32Schema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.authorization.operation !== input.operation)
      context.addIssue({
        code: "custom",
        message: "Authorization operation does not match the mutation",
        path: ["authorization", "operation"],
      });
    if (input.authorization.spaceId !== input.spaceId)
      context.addIssue({
        code: "custom",
        message: "Authorization identity does not match the mutation",
        path: ["authorization", "spaceId"],
      });
    if (
      (input.operation === "CREATE" ||
        input.operation === "UPDATE" ||
        input.operation === "ACTIVATE") &&
      !input.draft
    )
      context.addIssue({
        code: "custom",
        message: "This Space mutation requires a policy draft",
        path: ["draft"],
      });
  });

export type SpaceMutationConfirmRequest = z.infer<
  typeof spaceMutationConfirmRequestSchema
>;

export const spaceMutationResponseSchema = z
  .object({
    space: spaceRecordSchema,
    change: spaceChangeSchema,
  })
  .strict();

export type SpaceMutationResponse = z.infer<typeof spaceMutationResponseSchema>;

export const spacesResponseSchema = z
  .object({
    items: z.array(spaceRecordSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const spaceListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    ownerAddress: addressSchema.optional(),
  })
  .strict();

export const spaceChangesResponseSchema = z.array(spaceChangeSchema);

/** Frontend boundary for listing and reading Spaces. */
export interface SpaceAdapter {
  listSpaces(limit?: number, ownerAddress?: string): Promise<SpaceRecord[]>;
  getSpace(spaceId: string): Promise<SpaceRecord>;
}
