CREATE TABLE IF NOT EXISTS "agent_funding_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "owner_address" text NOT NULL,
  "chain_id" integer NOT NULL,
  "eth_amount" text NOT NULL,
  "usdc_amount" text NOT NULL,
  "weth_amount" text NOT NULL,
  "status" text NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_funding_operations_agent_idx" ON "agent_funding_operations" ("agent_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_funding_operations_budget_idx" ON "agent_funding_operations" ("status", "chain_id");
