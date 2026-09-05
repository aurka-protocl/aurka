# ADR 0041: deterministic solver and service boundary

Status: accepted for the local Phase 5 milestone

## Context

AURKA-005 fixes one direct pairwise settlement boundary: an intent and proposal
commit to policy/risk state, a price epoch, a capacity checkpoint, the direct
program, Aqua balances, fees, and the expected post-state. Services must quote
and simulate against those same values without becoming an authority for onchain
state.

## Decision

Add one local `@aurka/services` package with four narrow layers:

1. `DirectSolver` calls shared `calculateDirectSettlement`, binds raw token
   amounts to the executable fill, constructs the complete AURKA-005 proposal,
   signs it through an injected `ProposalSigner`, and requires successful router
   simulation.
2. `OptimizedSolver` is a closed registry of explicitly allowlisted strategies.
   It is empty in this milestone and falls back to the direct solver. Candidates
   are ranked by executable value, trader output, lower fee, lower gas, then
   proposal hash. Failed, stale, unsigned, or mismatched proposals never rank.
3. The versioned `/v1` HTTP API uses Node's HTTP server and shared Zod schemas.
   Execute returns an unsigned transaction request unless an already-authorized
   external trader signature is supplied. No Phase 5 process owns a trader or
   production execution key.
4. SQLite with Drizzle schema/migrations stores durable read-model state. Raw
   chain events are keyed by chain, contract, transaction, and log index.
   Projection writes are transactional; duplicate logs are upserts, and a
   removed log rebuilds derived capacity state from all remaining raw events.

The local default fixture signer exists only to make deterministic CI proposals
recoverable ECDSA signatures. Production deployments must inject a custody-
backed signer and must not reuse that fixture key.

## API surface

```text
GET  /health
GET  /ready
GET  /openapi.json
GET  /v1/positions
GET  /v1/positions/:id
GET  /v1/positions/:id/capacity?traderInputToken=&traderOutputToken=
POST /v1/intents
GET  /v1/intents/:id
POST /v1/quote
POST /v1/solve
GET  /v1/intents/:id/proposals
POST /v1/execute
GET  /v1/executions/:hash
```

Mutating routes accept `Idempotency-Key`; the key is scoped to method and path
and the response is stored before the request is considered complete.

## Persistence and indexing

The migration covers positions, policies, managed assets, risk certificates,
intents, proposals, quotes, executions, directional capacity epochs, agent
identities, checkpoints, idempotency keys, and raw chain events. Monetary
integers remain canonical decimal strings. Onchain contracts and events remain
authoritative; this database is a restartable projection only.

Indexer jobs use bounded retries for RPC log reads, deterministic block/log
ordering, confirmations, and a checkpoint per chain/contract. Reorg recovery is
represented by `removed` logs and a transactional projection rebuild. A live RPC
source is intentionally an interface; the default fixture has no credentials.

## Consequences

The local Phase 5 service can produce the same $50,000 fill and 234-unit fee as
the shared and Solidity vectors, while API and persistence failures are typed
and testable. It does not add a live chain client, multi-route solver, Graph
watchtower, Privy wallet, SDK, frontend, production database, or deployment.

Before live Phase 5 operation, the target chain's RPC/log source, production
Aqua/SwapVM deployment, signer boundary, and independent security review must be
selected and validated separately.
