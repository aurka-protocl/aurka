ALTER TABLE "delegated_sessions" ADD COLUMN "authority_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delegated_recoveries" (
  "authorization_hash" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "owner_address" text NOT NULL,
  "destination" text NOT NULL,
  "assets_json" text NOT NULL,
  "status" text NOT NULL,
  "transaction_hash" text,
  "error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_recoveries_session_idx"
  ON "delegated_recoveries" ("session_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_recoveries_status_idx"
  ON "delegated_recoveries" ("status", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delegated_control_authorizations" (
  "authorization_hash" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "owner_address" text NOT NULL,
  "action" text NOT NULL,
  "nonce" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delegated_control_nonce_idx"
  ON "delegated_control_authorizations" ("session_id", "nonce");
