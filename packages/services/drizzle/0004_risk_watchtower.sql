ALTER TABLE "risk_certificates" ADD COLUMN "status" text NOT NULL DEFAULT 'ACTIVE';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_observations" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "chain_id" integer NOT NULL,
  "deployment_id" text NOT NULL,
  "indexed_block" text NOT NULL,
  "indexed_block_hash" text NOT NULL,
  "finality" text NOT NULL,
  "payload_hash" text NOT NULL,
  "observation_json" text NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_observations_source_idx" ON "risk_observations" ("source_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_evaluations" (
  "evaluation_hash" text PRIMARY KEY NOT NULL,
  "position_id" text NOT NULL,
  "configuration_version" text NOT NULL,
  "configuration_hash" text NOT NULL,
  "configuration_json" text NOT NULL,
  "source_digest" text NOT NULL,
  "mode" text NOT NULL,
  "active_bounds_hash" text NOT NULL,
  "evaluated_at" integer NOT NULL,
  "evaluation_json" text NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_evaluations_position_idx" ON "risk_evaluations" ("position_id", "evaluated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "position_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "attempt" integer NOT NULL,
  "last_error" text,
  "next_run_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_jobs_due_idx" ON "risk_jobs" ("status", "next_run_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "position_id" text NOT NULL,
  "event_type" text NOT NULL,
  "actor" text NOT NULL,
  "payload_json" text NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_audit_position_idx" ON "risk_audit_events" ("position_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_policies" (
  "fingerprint" text PRIMARY KEY NOT NULL,
  "wallet_id" text NOT NULL,
  "role" text NOT NULL,
  "signer_address" text NOT NULL,
  "expires_at" integer NOT NULL,
  "revoked" integer NOT NULL,
  "policy_json" text NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_policies_wallet_idx" ON "wallet_policies" ("wallet_id");
