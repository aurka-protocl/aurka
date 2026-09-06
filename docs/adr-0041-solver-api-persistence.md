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
   signs it through an injected `ProposalSigner`, and runs deterministic
   preflight; exact router simulation is required once trader authorization is
   available at execution.
2. This milestone is direct pairwise only. `OptimizedSolver` is a compatibility
   wrapper with no route parameter and delegates to the one direct solver;
   multi-route optimization is explicitly deferred. No caller-supplied route or
   arbitrary calldata can enter the settlement path.
3. The versioned `/v1` HTTP API uses Node's HTTP server and shared Zod schemas.
   Every success envelope is checked against its route-specific response schema.
   Execute returns the exact ABI calldata for `AurkaSwapVMRouter.execute`; it
   remains a pending request until a separately authorized broadcaster exists.
   An optional external trader signature is verified and used for exact
   `eth_call`, but is never treated as submitted.
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
ordering, confirmations, and a checkpoint per chain/contract. Every sync checks
the checkpoint block hash, deletes the replaced block and descendants in one
projection transaction, rewinds to the verified ancestor, and replays the
replacement range. Empty ranges advance only to a verified block hash. A live
RPC source is intentionally an interface; the default fixture has no
credentials.

## Consequences

The local Phase 5 service can produce the same $50,000 fill and 234-unit fee as
the shared and Solidity vectors, while API and persistence failures are typed
and testable. Quotes and configured-RPC solves report `AUTHORIZATION_PENDING`
until a trader signature permits exact `eth_call`; local fixture preflight
remains explicit. The CLI wires chain, router, confirmation, and RPC settings
into that boundary, but a production snapshot/log provider and broadcaster are
still not supplied. It does not add a multi-route solver, Graph watchtower,
Privy wallet, SDK, frontend, production database, or deployment.

Before live Phase 5 operation, the target chain's RPC/log source, production
Aqua/SwapVM deployment, signer boundary, and independent security review must be
selected and validated separately.
