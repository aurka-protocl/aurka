ALTER TABLE "executions" ADD COLUMN "position_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "executions_activity_idx"
  ON "executions" ("position_id", "submitted_at", "transaction_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settlement_records" (
  "id" text PRIMARY KEY NOT NULL,
  "chain_id" integer NOT NULL,
  "contract" text NOT NULL,
  "transaction_hash" text NOT NULL,
  "block_number" text NOT NULL,
  "block_hash" text NOT NULL,
  "proposal_hash" text NOT NULL,
  "position_id_hash" text,
  "position_id" text,
  "intent_hash" text,
  "trade_event_id" text,
  "fee_event_id" text,
  "trade_json" text,
  "fee_json" text,
  "orphaned" integer NOT NULL,
  "observed_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_records_proposal_idx"
  ON "settlement_records" ("chain_id", "contract", "transaction_hash", "proposal_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlement_records_activity_idx"
  ON "settlement_records" ("chain_id", "position_id", "observed_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlement_records_status_idx"
  ON "settlement_records" ("chain_id", "orphaned", "observed_at");
