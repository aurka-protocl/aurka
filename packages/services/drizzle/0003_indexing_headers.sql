CREATE TABLE IF NOT EXISTS "indexing_headers" (
  "chain_id" integer NOT NULL,
  "contract" text NOT NULL,
  "block_number" text NOT NULL,
  "block_hash" text NOT NULL,
  "updated_at" integer NOT NULL,
  PRIMARY KEY("chain_id", "contract", "block_number")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "indexing_headers_block_idx"
  ON "indexing_headers" ("chain_id", "contract", "block_number");
