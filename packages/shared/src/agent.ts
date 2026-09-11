import { z } from "zod";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const tradingAgentStateSchema = z.enum([
  "PROVISIONING",
  "READY",
  "FUNDING",
  "ACTIVE",
  "STOPPED",
  "REVOKED",
  "FAILED",
]);
export type TradingAgentState = z.infer<typeof tradingAgentStateSchema>;

export const tradingAgentSchema = z
  .object({
    id: z.string().min(1).max(128),
    ownerAddress: addressSchema,
    chainId: z.number().int().positive().safe(),
    walletId: z.string().min(1).max(128),
    walletAddress: addressSchema,
    signerId: z.string().min(1).max(128),
    policyId: z.string().min(1).max(128),
    recoveryPolicyId: z.string().min(1).max(128),
    state: tradingAgentStateSchema,
    fundingJson: z.record(z.string(), z.unknown()),
    mandateJson: z.record(z.string(), z.unknown()).nullable(),
    lastError: z.string().max(500).nullable(),
    createdAt: z.number().int().positive().safe(),
    updatedAt: z.number().int().positive().safe(),
  })
  .strict();
export type TradingAgent = z.infer<typeof tradingAgentSchema>;

export const agentsResponseSchema = z.object({
  agent: tradingAgentSchema.nullable(),
});

export const agentResponseSchema = z.object({
  agent: tradingAgentSchema,
});

export const createAgentRequestSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const fundAgentRequestSchema = z
  .object({
    eth: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .default("0"),
    usdc: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .default("0"),
    weth: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .default("0"),
  })
  .strict();
export type FundAgentRequest = z.infer<typeof fundAgentRequestSchema>;

export const mandateSchema = z
  .object({
    spaceIds: z.array(z.string().min(1).max(128)).min(1).max(8),
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    perTradeInputAmount: z.string().regex(/^(0|[1-9][0-9]*)$/),
    cumulativeInputBudget: z.string().regex(/^(0|[1-9][0-9]*)$/),
    maxTradeCount: z.number().int().positive().max(100),
    minimumOutputPerInputBps: z
      .number()
      .int()
      .nonnegative()
      .max(100_000)
      .optional(),
    slippageBps: z.number().int().nonnegative().max(1_000),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type AgentMandate = z.infer<typeof mandateSchema>;

export const setAgentMandateRequestSchema = mandateSchema;
