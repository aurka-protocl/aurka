# AURKA Phase 5 service API

The local service is started with:

```bash
pnpm --filter @aurka/services db:migrate
pnpm --filter @aurka/services start
```

`GET /openapi.json` provides the machine-readable route inventory. Every
amount-sized JSON integer is a canonical unsigned decimal string, and every
submitted signed object is parsed with the shared AURKA schemas before storage
or simulation.

`POST /v1/quote` returns the requested amount, maximum safe and executable fill,
price, complete output-token fee breakdown, binding constraint, current and
expected portfolios, policy/risk state, capacity epoch/checkpoint, expiry, and
simulation status. A quote without trader authorization reports
`AUTHORIZATION_PENDING`; it does not claim that a deployed router accepted an
eventual transaction. `POST /v1/solve` returns the same direct proposal
commitments used by AURKA-005 plus the simulation gas estimate. There is no
`maxProposals` input in this direct-only milestone.

`POST /v1/execute` accepts intent and proposal hashes and optionally an external
trader signature. The solver signature is always recovered and verified. It
returns HTTP 202 with the complete ABI calldata for `AurkaSwapVMRouter.execute`;
it never selects or loads a service-held trader private key. When an external
signature is supplied, it is verified and an injected EIP-1193 simulator may run
`eth_call`, but the service still does not submit or claim a chain transaction
in this milestone. The execution remains `PENDING` until a separately authorized
broadcaster reports a real hash. `Idempotency-Key` is supported on all mutating
routes.

Task 7 adds a separate, deterministic risk surface:

```text
POST /v1/risk/evaluate
POST /v1/risk/certificates
GET  /v1/risk/:positionId
```

Risk evaluation accepts a versioned observation set, canonical block/hash map,
hard policy bounds, and governance-approved bound sets. It persists and returns
the integer-only decision, source digest, and active-bounds commitment. Missing,
stale, lagging, unfinalized, wrong-chain, wrong-deployment, or reorged evidence
cannot produce an unearned `NORMAL` state. Certificate submission requires the
v2 signature payload and exact active-bounds commitment. These routes use the
same `Idempotency-Key` behavior as the solver mutations.

Stable error codes include `INVALID_REQUEST`, `POSITION_NOT_FOUND`,
`INTENT_NOT_FOUND`, `OBJECT_NOT_FOUND`, `COMMITMENT_MISMATCH`,
`REQUEST_TOO_LARGE`, and `NOT_FOUND`.

## Corrections verified on 2026-09-07

Responses use `{ok: true, data, requestId}`; failures use
`{ok: false, error: {code, message, details?}, requestId}`. The SDK validates
and unwraps these envelopes. `/openapi.json` now includes shared
request/response JSON Schemas, path and query parameters, and success/error
status definitions. Big integer amounts are decimal strings; bounded counts,
timestamps and chain IDs use the types in their shared schemas.

`POST /v1/intents/prepare` constructs an unsigned intent from the configured
snapshot provider. Inputs are `positionId`, `trader`, `traderInputToken`,
`traderOutputToken`, `requestedValue`, `minimumTraderOutputValue`, `nonce`, and
`deadline`. The local fixture implements preparation; other providers must
implement it or return 503. Preparation does not sign or broadcast.

Risk evaluation is a proposal endpoint. It uses the canonical watchtower
implementation, validates the stored hard policy and server clock, persists
cooldown state, rejects configuration changes without an operator migration, and
disregards caller-supplied recovery state. Worker state has a separate namespace
so public proposals cannot set the worker's recovery configuration.

Risk responses distinguish `proposed`, `certificate`, `certificateState`, and
`effective`. `SIGNED`/`NOT_SUBMITTED` means storage only. Effective values come
from `createRegistryRiskReader` at a canonical finalized block, including the
registry's expiry/revocation fallback. Without that reader, values are null and
source is `UNAVAILABLE`. Configure the actual **risk registry**, separately from
the policy registry, before accepting signed certificates.

`/ready` probes RPC chain identity when configured and reports unknown indexer
lag as null. Live readiness remains `not_ready` until indexer/risk health wiring
is implemented and verified. The optional risk reader reports `unverified`;
unconfigured risk reports `not_configured`. Consumers must inspect `data.status`
in addition to HTTP success. `/health` remains process liveness.

The interactive no-RPC CLI uses `LocalDemoProvider` with current-time snapshots
and a 60-second lifetime. The fixed-clock `FixtureProvider` remains available
for deterministic tests. Prepared demo intents expire and are lost on restart;
they are not production settlement evidence.

Snapshot providers may implement `getPositionSnapshot(positionId)` for capacity
reads that do not yet have an intent. The local demo implements this with its
current clock; the service validates chain/router context for both position and
intent snapshots. Existing providers retain the intent-based fallback.
