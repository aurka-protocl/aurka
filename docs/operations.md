# AURKA Phase 5 operations

Local startup requires Node 23.3.0, but no RPC URL, wallet, database credential,
or production secret:

```bash
docker compose -f docker-compose.services.yml up --build
```

The API exposes `/health` for process liveness and `/ready` for measured serving
readiness. `/health` does not imply that dependencies are available. Readiness
returns a timestamped check for the database, RPC chain/finalized head, indexer
checkpoint/lag, Graph sources, worker lease/progress, signer authority/expiry,
and effective registry reads. Every check has one of `configured`, `healthy`,
`unhealthy`, `unknown`, or `disabled`; only measured `healthy` checks satisfy
required live capabilities. Reasons are stable categories and never include
provider error text. Logs are JSON lines with request correlation IDs; fields
containing private keys, secrets, passwords, signatures, or full payloads are
omitted.

Graceful shutdown stops accepting requests before closing the service database.
Mutating API retries are bounded by idempotency keys. Chain log reads use the
bounded retry helper and never retry arbitrary transaction submission.

The service workflow runs migrations, type checks, tests, builds, formatting,
linting, and Docker configuration/build checks. `RPC_URL`, `CHAIN_ID`,
`SETTLEMENT_CONTRACT`, and `INDEX_CONFIRMATIONS` are wired into the service
runtime. The normal fork runner defaults to the real-integration path; fixture
mode must be selected explicitly. Production broadcasting, live log providers,
and public-chain tests remain outside this workflow and require a separate
protected environment.

Risk operations are documented in [`risk-watchtower.md`](./risk-watchtower.md).
The fixture watchtower and wallet adapters never load production credentials;
production signer rotation, certificate submission, and live Graph/Privy tests
require explicit human approval.

## Local verification and readiness — 2026-09-07

Build workspace dependencies before type checking: `pnpm build`. The CI jobs now
follow that order, and the service image includes the watchtower/wallet
workspace dependencies. Graph codegen/WASM compilation is a separate CI step.
The Docker health check inspects `data.status === "ready"`, not HTTP 200 alone.
Readiness probes are single-flight, cached for five seconds by default, and
bounded by a two-second probe timeout. Unknown indexer lag is null; configured
RPC chain failures are reported as errors, and live readiness is held at
`not_ready` while indexer, source, worker, signer, or registry diagnostics are
unknown/unhealthy. A legitimate onchain `PAUSED` risk mode is reported as a
healthy registry check and does not by itself make infrastructure unready. A
fixture service is ready only for its local database-backed capabilities and is
not a production-readiness claim.

The canonical Vite application proxies `/api` to `http://127.0.0.1:8787` and
removes the prefix. Start it with `pnpm --filter @aurka/trader-app dev` (3002).
Production static hosting needs an equivalent reverse proxy; Vite's development
proxy is not bundled in its output. The optional server-only worker module and
its trust requirements are described in
[risk-watchtower.md](./risk-watchtower.md).

The no-RPC CLI uses current-time local demo snapshots that expire after 60
seconds; request a fresh quote after expiry or restart. Its cache is bounded at
1000 pending preparations. Library tests retain the fixed-clock fixture. Neither
provider is a live balance or oracle source.

## Reproducible system verification

The TASK99-013 SwapVM rehearsal uses a pinned Ethereum mainnet fork, real Aqua,
Chainlink reads, and ordinary isolated test wallets:

```bash
pnpm integration:fork-swapvm
```

It runs two custom-funded Spaces through the atomic factory and executes the
actual upstream VM program. Set `AURKA_RELEASE_EVIDENCE_DIR` to retain its
sanitized receipts/traces and dependency evidence. The older
`pnpm integration:fork-real` command remains the Graph/release reference
rehearsal. Set `AURKA_RELEASE_EVIDENCE_DIR` to retain its sanitized release JSON
and wallet evidence; otherwise the runner cleans its temporary resources.

The deterministic system checks are credential-free and use disposable local
resources:

```bash
pnpm integration:local-settlement
pnpm integration:graph-node
pnpm --filter @aurka/services test -- readiness.test.ts risk-runtime.test.ts
pnpm --filter @aurka/services exec node scripts/browser-smoke.mjs
```

The settlement check starts an isolated Anvil chain and verifies signed intent
preparation, quote/solve/unsigned execution, onchain settlement events,
replay-safe projections, and rejection cases. The Graph check starts pinned
local Graph Node/Postgres/IPFS containers and verifies persisted event entities,
consumer queries, finality/lag handling, pagination, and reorg replacement. The
browser check starts the service and the canonical Vite application itself, then
covers desktop/mobile routes, navigation, a real quote/solve/external-signature
flow, unavailable effective risk state, visible errors, and overflow/page-error
checks. It uses the public local test key only; it never broadcasts from the
browser. Each runner owns its processes and temporary database, and the Graph CI
job additionally removes resources by its unique Compose project label.

The browser runner requires the pinned Playwright package and a local browser:

```bash
pnpm install --frozen-lockfile --ignore-scripts=false
pnpm exec playwright install chromium
pnpm integration:browser-smoke
```

CI stores only bounded, non-secret diagnostic summaries and command logs. A
successful build, Graph compilation, HTTP 200, or generated calldata is not
treated as proof of the next boundary.

## Protected external smoke

`.github/workflows/protected-integration.yml` is manual-only and checks out
`main` after a preflight rejects fork dispatches and verifies that the selected
GitHub environment has required-reviewer protection. The read-only mode checks
RPC chain/finalized head and deployed bytecode, Graph deployment/schema/query
freshness, and a configured wallet-policy visibility endpoint. It requires these
environment variables (URLs and tokens are never printed):

```text
AURKA_RPC_URL                  # environment secret
AURKA_CHAIN_ID                 # environment variable
AURKA_SETTLEMENT_CONTRACT      # environment variable
AURKA_POLICY_REGISTRY          # environment variable
AURKA_RISK_REGISTRY            # environment variable
AURKA_GRAPH_ENDPOINT           # environment variable
AURKA_GRAPH_DEPLOYMENT_ID      # environment variable
AURKA_GRAPH_MAX_AGE_SECONDS    # optional environment variable
AURKA_GRAPH_API_KEY            # environment secret, if required
AURKA_WALLET_POLICY_URL        # environment variable
AURKA_WALLET_ID                # environment variable
AURKA_WALLET_POLICY_TOKEN      # environment secret, if required
```

The wallet-policy endpoint must be a read-only `GET` endpoint returning
`{ "enabled": true, "revoked": false, "walletId": "…", "policyFingerprint": "0x…" }`;
the last two fields are optional but validated when present. Missing inputs
produce a `blocked` result and exit status 2; failed checks exit 1. The
write-smoke mode has a distinct protected environment and explicit confirmation
but remains fail-closed until an operator supplies a separately reviewed,
chain-specific write action. No remote write or wallet provisioning is part of
this repository validation.
