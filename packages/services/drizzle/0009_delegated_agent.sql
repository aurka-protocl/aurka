CREATE TABLE IF NOT EXISTS "delegated_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_address" text NOT NULL,
  "agent_address" text NOT NULL,
  "state" text NOT NULL,
  "plan_json" text NOT NULL,
  "wallet_json" text NOT NULL,
  "authorized_at" integer NOT NULL,
  "consumed_input_amount" text NOT NULL,
  "trade_count" integer NOT NULL,
  "last_proposal_hash" text,
  "last_transaction_hash" text,
  "last_recovery_transaction_hash" text,
  "last_result" text,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_sessions_owner_idx"
  ON "delegated_sessions" ("owner_address", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_sessions_state_idx"
  ON "delegated_sessions" ("state", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delegated_trades" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "intent_hash" text NOT NULL,
  "proposal_hash" text NOT NULL,
  "input_amount" text NOT NULL,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "transaction_hash" text,
  "error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delegated_trades_idempotency_idx"
  ON "delegated_trades" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_trades_session_idx"
  ON "delegated_trades" ("session_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_trades_status_idx"
  ON "delegated_trades" ("status", "updated_at");
