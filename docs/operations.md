# AURKA Phase 5 operations

Local startup requires no RPC URL, wallet, database credential, or production
secret:

```bash
docker compose -f docker-compose.services.yml up --build
```

The API exposes `/health` for process liveness and `/ready` for database, RPC
mode, and indexer-lag diagnostics. Logs are JSON lines with request correlation
IDs; fields containing private keys, secrets, passwords, signatures, or full
payloads are omitted.

Graceful shutdown stops accepting requests before closing the service database.
Mutating API retries are bounded by idempotency keys. Chain log reads use the
bounded retry helper and never retry arbitrary transaction submission.

The service workflow runs migrations, type checks, tests, builds, formatting,
linting, and Docker configuration/build checks. `RPC_URL`, `CHAIN_ID`,
`SETTLEMENT_CONTRACT`, and `INDEX_CONFIRMATIONS` are wired into the service
runtime; the default remains fixture-only. Production broadcasting, live log
providers, and live chain tests remain outside this workflow and require a
separate protected environment.

Risk operations are documented in [`risk-watchtower.md`](./risk-watchtower.md).
The fixture watchtower and wallet adapters never load production credentials;
production signer rotation, certificate submission, and live Graph/Privy tests
require explicit human approval.
