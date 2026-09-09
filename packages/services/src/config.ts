import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_URL: z.string().min(1).default(".aurka/service.sqlite"),
  CHAIN_ID: z.coerce.number().int().positive().safe().default(31_337),
  RISK_RUNTIME_MODULE: z.string().min(1).optional(),
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
  INDEXER_MAX_LAG_BLOCKS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(1_000_000)
    .default(20),
  RPC_FINALITY_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(86_400)
    .default(120),
  READINESS_PROBE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(2_000),
  READINESS_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3_600)
    .default(5),
});

export type ServiceConfig = z.infer<typeof environmentSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return environmentSchema.parse(environment);
}
