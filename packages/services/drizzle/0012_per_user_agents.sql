CREATE TABLE IF NOT EXISTS "auth_challenges" (
  "id" text PRIMARY KEY NOT NULL,
  "address" text NOT NULL,
  "chain_id" integer NOT NULL,
  "nonce" text NOT NULL,
  "origin" text NOT NULL,
  "expires_at" integer NOT NULL,
  "consumed_at" integer,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_challenges_address_idx" ON "auth_challenges" ("address", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_challenges_expiry_idx" ON "auth_challenges" ("expires_at", "consumed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "owner_address" text NOT NULL,
  "chain_id" integer NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_owner_idx" ON "auth_sessions" ("owner_address", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_expiry_idx" ON "auth_sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_agents" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_address" text NOT NULL,
  "chain_id" integer NOT NULL,
  "wallet_id" text NOT NULL,
  "wallet_address" text NOT NULL,
  "signer_id" text NOT NULL,
  "policy_id" text NOT NULL,
  "recovery_policy_id" text NOT NULL,
  "state" text NOT NULL,
  "funding_json" text NOT NULL,
  "mandate_json" text,
  "last_error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_agents_owner_chain_idx" ON "trading_agents" ("owner_address", "chain_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_agents_wallet_idx" ON "trading_agents" ("wallet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_agents_state_idx" ON "trading_agents" ("state", "updated_at");
