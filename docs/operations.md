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

## Local verification and readiness — 2026-09-07

Build workspace dependencies before type checking: `pnpm build`. The CI jobs now
follow that order, and the service image includes the watchtower/wallet
workspace dependencies. Graph codegen/WASM compilation is a separate CI step.
The Docker health check inspects `data.status === "ready"`, not HTTP 200 alone.
Unknown indexer lag is null; configured RPC chain failures are reported as
errors, and live readiness is held at `not_ready` while indexer/risk diagnostics
remain unverified. A healthy fixture container is not production readiness.

Both Vite applications proxy `/api` to `http://127.0.0.1:8787` and remove the
prefix. Start them with `pnpm --filter @aurka/treasury-app dev` (3001) and
`pnpm --filter @aurka/trader-app dev` (3002). Production static hosting needs an
equivalent reverse proxy; Vite's development proxy is not bundled in its output.
The optional server-only worker module and its trust requirements are described
in [risk-watchtower.md](./risk-watchtower.md).

The no-RPC CLI uses current-time local demo snapshots that expire after 60
seconds; request a fresh quote after expiry or restart. Its cache is bounded at
1000 pending preparations. Library tests retain the fixed-clock fixture. Neither
provider is a live balance or oracle source.
