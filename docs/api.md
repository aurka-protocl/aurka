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
simulation status. `POST /v1/solve` returns the same direct proposal commitments
used by AURKA-005 plus the simulation gas estimate.

`POST /v1/execute` accepts intent and proposal hashes and optionally an external
trader signature. The solver signature is always recovered and verified. Without
an external trader signature it returns HTTP 202 with an unsigned transaction
request; it never selects or loads a service-held trader private key.
`Idempotency-Key` is supported on all mutating routes.

Stable error codes include `INVALID_REQUEST`, `POSITION_NOT_FOUND`,
`INTENT_NOT_FOUND`, `OBJECT_NOT_FOUND`, `COMMITMENT_MISMATCH`,
`REQUEST_TOO_LARGE`, and `NOT_FOUND`.
