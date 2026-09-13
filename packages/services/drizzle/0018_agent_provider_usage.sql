CREATE TABLE IF NOT EXISTS "agent_provider_usage" (
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"day" text NOT NULL,
	"provider" text NOT NULL,
	"request_count" integer NOT NULL DEFAULT 0,
	"input_tokens" integer NOT NULL DEFAULT 0,
	"output_tokens" integer NOT NULL DEFAULT 0,
	"updated_at" integer NOT NULL,
	PRIMARY KEY("scope", "scope_key", "day", "provider")
);
