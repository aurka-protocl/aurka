CREATE TABLE IF NOT EXISTS "positions" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "chain_id" integer NOT NULL,
  "owner" text NOT NULL,
  "treasury" text NOT NULL,
  "policy_id" text NOT NULL,
  "risk_mode" text NOT NULL,
  "portfolio_json" text NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policies" (
  "id" text PRIMARY KEY NOT NULL,
  "chain_id" integer NOT NULL,
  "registry" text NOT NULL,
  "treasury" text NOT NULL,
  "governance" text NOT NULL,
  "maximum_transaction_value" text NOT NULL,
  "quote_ttl_seconds" integer NOT NULL,
  "price_max_age_seconds" integer NOT NULL,
  "maximum_price_deviation_bps" integer NOT NULL,
  "fee_json" text NOT NULL,
  "paused" integer NOT NULL,
  "nonce" text NOT NULL,
  "policy_json" text NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "managed_assets" (
  "policy_id" text NOT NULL,
  "token" text NOT NULL,
  "symbol" text NOT NULL,
  "decimals" integer NOT NULL,
  "minimum_weight_bps" integer NOT NULL,
  "maximum_weight_bps" integer NOT NULL,
  PRIMARY KEY("policy_id", "token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_certificates" (
  "hash" text PRIMARY KEY NOT NULL,
  "policy_id" text NOT NULL,
  "chain_id" integer NOT NULL,
  "verifying_contract" text NOT NULL,
  "nonce" text NOT NULL,
  "risk_mode" text NOT NULL,
  "expires_at" integer NOT NULL,
  "certificate_json" text NOT NULL,
  "active" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intents" (
  "id" text PRIMARY KEY NOT NULL,
  "intent_hash" text NOT NULL,
  "trader" text NOT NULL,
  "policy_id" text NOT NULL,
  "status" text NOT NULL,
  "intent_json" text NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intents_hash_idx" ON "intents" ("intent_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
  "proposal_hash" text PRIMARY KEY NOT NULL,
  "intent_hash" text NOT NULL,
  "solver" text NOT NULL,
  "status" text NOT NULL,
  "simulation_status" text NOT NULL,
  "proposal_json" text NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_intent_idx" ON "proposals" ("intent_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_rank_idx" ON "proposals" ("intent_hash", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotes" (
  "id" text PRIMARY KEY NOT NULL,
  "intent_hash" text NOT NULL,
  "quote_json" text NOT NULL,
  "expires_at" integer NOT NULL,
  "simulation_status" text NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_intent_idx" ON "quotes" ("intent_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "executions" (
  "transaction_hash" text PRIMARY KEY NOT NULL,
  "intent_hash" text NOT NULL,
  "proposal_hash" text NOT NULL,
  "status" text NOT NULL,
  "execution_json" text NOT NULL,
  "submitted_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "executions_intent_proposal_idx" ON "executions" ("intent_hash", "proposal_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "capacity_epochs" (
  "position_id" text NOT NULL,
  "trader_input_token" text NOT NULL,
  "trader_output_token" text NOT NULL,
  "capacity_epoch_id" text NOT NULL,
  "capacity_baseline_value" text NOT NULL,
  "consumed_value" text NOT NULL,
  "policy_nonce" text NOT NULL,
  "risk_certificate_hash" text NOT NULL,
  "balance_snapshot" text NOT NULL,
  "price_snapshot" text NOT NULL,
  "chain_id" integer NOT NULL,
  "verifying_contract" text NOT NULL,
  "active" integer NOT NULL,
  "updated_at" integer NOT NULL,
  PRIMARY KEY("position_id", "trader_input_token", "trader_output_token")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "capacity_epochs_id_idx" ON "capacity_epochs" ("capacity_epoch_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "address" text NOT NULL,
  "role" text NOT NULL,
  "enabled" integer NOT NULL,
  "metadata_json" text NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_identities_address_idx" ON "agent_identities" ("address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indexing_checkpoints" (
  "chain_id" integer NOT NULL,
  "contract" text NOT NULL,
  "block_number" text NOT NULL,
  "block_hash" text NOT NULL,
  "updated_at" integer NOT NULL,
  PRIMARY KEY("chain_id", "contract")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chain_events" (
  "id" text PRIMARY KEY NOT NULL,
  "chain_id" integer NOT NULL,
  "block_number" text NOT NULL,
  "block_hash" text NOT NULL,
  "transaction_hash" text NOT NULL,
  "log_index" integer NOT NULL,
  "contract" text NOT NULL,
  "event_version" integer NOT NULL,
  "name" text NOT NULL,
  "payload_json" text NOT NULL,
  "removed" integer NOT NULL,
  "observed_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chain_events_log_idx" ON "chain_events" ("chain_id", "contract", "transaction_hash", "log_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chain_events_block_idx" ON "chain_events" ("chain_id", "block_number");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "key" text PRIMARY KEY NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status_code" integer NOT NULL,
  "response_json" text NOT NULL,
  "created_at" integer NOT NULL
);
