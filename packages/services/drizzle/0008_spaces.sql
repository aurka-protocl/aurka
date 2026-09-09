CREATE TABLE IF NOT EXISTS "spaces" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "owner" text NOT NULL,
  "controller" text NOT NULL,
  "treasury" text NOT NULL,
  "chain_id" integer NOT NULL,
  "policy_id" text NOT NULL,
  "strategy_id" text NOT NULL,
  "policy_registry" text NOT NULL,
  "mode" text NOT NULL,
  "state" text NOT NULL,
  "position_id" text,
  "draft_json" text,
  "failure_reason" text,
  "auth_nonce" text NOT NULL DEFAULT '0',
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spaces_owner_idx"
  ON "spaces" ("owner", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spaces_state_idx"
  ON "spaces" ("state", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_changes" (
  "id" text PRIMARY KEY NOT NULL,
  "space_id" text NOT NULL,
  "event_type" text NOT NULL,
  "actor" text NOT NULL,
  "status" text NOT NULL,
  "receipt_hash" text,
  "payload_json" text NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_changes_space_idx"
  ON "space_changes" ("space_id", "created_at", "id");
