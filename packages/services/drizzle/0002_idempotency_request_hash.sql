CREATE TABLE idempotency_keys_new (
  key text PRIMARY KEY NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  request_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'COMPLETED',
  status_code integer,
  response_json text,
  created_at integer NOT NULL
);
--> statement-breakpoint
INSERT INTO idempotency_keys_new (key, method, path, request_hash, status, status_code, response_json, created_at)
SELECT key, method, path, '', 'COMPLETED', status_code, response_json, created_at
FROM idempotency_keys;
--> statement-breakpoint
DROP TABLE idempotency_keys;
--> statement-breakpoint
ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;
