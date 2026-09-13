ALTER TABLE "delegated_sessions" ADD COLUMN "last_evaluated_at" integer;
--> statement-breakpoint
ALTER TABLE "delegated_sessions" ADD COLUMN "next_check_at" integer;
--> statement-breakpoint
ALTER TABLE "delegated_sessions" ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"owner_address" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text,
	"event_type" text NOT NULL,
	"code" text NOT NULL,
	"summary" text NOT NULL,
	"correlation_id" text,
	"transaction_hash" text,
	"details_json" text,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_activity_dedupe_idx" ON "agent_activity_events" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_activity_owner_idx" ON "agent_activity_events" ("owner_address", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_activity_agent_idx" ON "agent_activity_events" ("agent_id", "created_at", "id");
