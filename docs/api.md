# AURKA Phase 5 service API

The local service is started with:

```bash
pnpm --filter @aurka/services db:migrate
pnpm --filter @aurka/services start
```

`GET /openapi.json` provides the machine-readable route inventory. Every JSON
integer is a canonical unsigned decimal string, and every submitted signed
object is parsed with the shared AURKA schemas before storage or simulation.

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
