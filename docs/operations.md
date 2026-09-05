# AURKA Phase 5 operations

Local startup requires no RPC URL, wallet, database credential, or production
secret:

```bash
docker compose -f docker-compose.services.yml up --build
```

The API exposes `/health` for process liveness and `/ready` for database,
fixture-RPC, and indexer-lag diagnostics. Logs are JSON lines with request
correlation IDs; fields containing private keys, secrets, passwords, signatures,
or full payloads are omitted.

Graceful shutdown stops accepting requests before closing the service database.
Mutating API retries are bounded by idempotency keys. Chain log reads use the
bounded retry helper and never retry arbitrary transaction submission.

The service workflow runs migrations, type checks, tests, builds, formatting,
linting, and Docker configuration/build checks. Production broadcasting and live
chain tests remain outside this workflow and require a separate protected
environment.
