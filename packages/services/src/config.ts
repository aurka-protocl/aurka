import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_URL: z.string().min(1).default(":memory:"),
  CHAIN_ID: z.coerce.number().int().positive().safe().default(31_337),
  RPC_URL: z.string().url().optional(),
  SETTLEMENT_CONTRACT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  INDEX_CONFIRMATIONS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(100)
    .default(2),
});

export type ServiceConfig = z.infer<typeof environmentSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return environmentSchema.parse(environment);
}
