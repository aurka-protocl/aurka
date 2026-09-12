ALTER TABLE "agent_provisioning_operations" ADD COLUMN "lease_id" text;
--> statement-breakpoint
ALTER TABLE "agent_provisioning_operations" ADD COLUMN "lease_expires_at" integer;
