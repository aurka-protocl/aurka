CREATE TABLE IF NOT EXISTS "delegated_worker_leases" (
  "session_id" text PRIMARY KEY NOT NULL,
  "lease_id" text NOT NULL,
  "expires_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_worker_leases_expiry_idx" ON "delegated_worker_leases" ("expires_at");
