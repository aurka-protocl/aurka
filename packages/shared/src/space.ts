import { z } from "zod";
import type { Position } from "./portfolio.js";

export const spaceEnvironmentSchema = z.enum(["demo", "fork"]);

export const spaceIdentitySchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(100),
    ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    treasuryAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    chainId: z.number().int().positive().safe(),
    mode: spaceEnvironmentSchema,
  })
  .strict();

export type SpaceEnvironment = z.infer<typeof spaceEnvironmentSchema>;
export type SpaceIdentity = z.infer<typeof spaceIdentitySchema>;

export interface SpaceRecord {
  readonly identity: SpaceIdentity;
  readonly position: Position;
}

/** Frontend boundary for listing and reading Spaces; CRUD/live adapters can implement this later. */
export interface SpaceAdapter {
  listSpaces(limit?: number): Promise<SpaceRecord[]>;
  getSpace(spaceId: string): Promise<SpaceRecord>;
}
