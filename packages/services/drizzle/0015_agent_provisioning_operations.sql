CREATE TABLE IF NOT EXISTS "agent_provisioning_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_address" text NOT NULL,
  "chain_id" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "state" text NOT NULL,
  "recovery_policy_id" text,
  "wallet_id" text,
  "wallet_address" text,
  "last_error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_provisioning_owner_chain_idx" ON "agent_provisioning_operations" ("owner_address", "chain_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_provisioning_idempotency_idx" ON "agent_provisioning_operations" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_provisioning_state_idx" ON "agent_provisioning_operations" ("state", "updated_at");
