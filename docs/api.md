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

Read-only activity is available at `GET /v1/activity`, with cursor pagination
and optional Space (`spaceId`, with legacy `positionId`), type (`SWAP`,
`RULE_CHANGE`, or `TRADING_STATUS`), chain, lifecycle-status, and time filters.
Treasury fee summaries are available at `GET /v1/positions/{id}/fees`. See
[`activity-and-fees.md`](./activity-and-fees.md) for the source-of-truth and
reorg semantics. Prepared quotes and unsigned transaction requests never count
as earned revenue. Space change records include the durable actor, event type,
resulting state, status, and optional receipt evidence; they do not fabricate
swap fields.

Space management is exposed through the persistent Space read model:

```text
GET  /v1/spaces?ownerAddress=0x…&limit=20&cursor=…
GET  /v1/spaces/:id
GET  /v1/spaces/:id/changes
POST /v1/spaces/prepare
POST /v1/spaces/confirm
```

`prepare` returns the exact EIP-712 domain, typed data, payload hash, nonce, and
five-minute deadline for `CREATE`, `UPDATE`, `ACTIVATE`, `PAUSE`, or `RESUME`.
`confirm` recovers the signer against the recorded owner/controller, checks the
exact draft and current nonce, rejects expiry/replay, persists the state and
emits a durable Space change record. The no-RPC local demo creates isolated
logical allocations; a fork keeps policy writes on the selected chain authority
and does not load a server-held owner key. The generic API accepts authenticated
fork names and drafts; its confirmations are labelled `signed-metadata-only` and
do not change onchain rules. Generic fork `ACTIVATE`/`PAUSE`/`RESUME` still
return `FORK_SPACE_CHAIN_OPERATION_UNSUPPORTED`. Its `receiptHash` input remains
rejected with `UNVERIFIED_SPACE_RECEIPT`.

The local fork gateway supplies the real wallet transaction path:

```text
POST /fork/spaces/prepare  {spaceId, operation?: "ACTIVATE"|"UPDATE"|"PAUSE"|"RESUME"|"REACTIVATE"}
POST /fork/spaces/confirm  {spaceId, operation?, step, hash}
POST /fork/spaces/confirm  {spaceId, operation?, batch: true, atomic: true,
                            batchId, batchPlanId, batchCommitment, hashes}
POST /fork/spaces/reconcile {spaceId, operation?, batch: true,
                             status: 500|600, atomic, batchId,
                             batchPlanId, batchCommitment, hashes}
```

These fork-only endpoints return a plain JSON setup response: either
`{complete:false, spaceId, ownerAddress, treasury, step, total, label, transaction}`
or `{complete:true, space}`. When an EIP-5792 atomic setup is available, the
incomplete response also contains `batch`, `batchPlanId`, and `batchCommitment`.
The browser sends the prepared transaction or wallet call batch through the
owner wallet. Confirmation checks the configured chain, canonical successful
receipt, authorized caller, destination, exact calldata/value, preparation
block, and receipt reuse. A submitted hash alone cannot activate a Space.

Creation deploys an idempotent, owner-scoped `AurkaSpaceVault` through
`AurkaSpaceVaultFactory`, creates/configures its policy, transfers **35,000 USDC
and 5 WETH** from the owner, approves MockAqua from that treasury, registers
those virtual balances, and authorizes the supported WETH→USDC capacity. The
supported fork assets are mainnet USDC (6 decimals) and WETH (18 decimals).
Initial bounds must include that disclosed funding allocation. The vault owner
may withdraw funds or revoke allowances; it does not give another Space access
to this inventory. MockAqua and fixed reference prices remain local test
infrastructure.

The server persists setup steps, verified receipts, and receipt reuse protection
atomically in `space-setup.json` beside the fork database. The browser persists
submitted hashes while waiting. Retry/reload resumes verified steps; failed
wallet transactions do not advance setup. A verified status-500 atomic revert
records failed history and releases the old wallet identity for a fresh batch. A
status-600 result may continue only from a server-verified successful direct
prefix; ambiguous or unavailable evidence stays pending for reconciliation.
Restart discovers completed Spaces and verifies their chain evidence before
registering snapshot/quote providers. Orphaned receipts downgrade the affected
Space and change records; verified missing steps can be retried. RPC outages
keep receipt history and block dependent trading.

Save the signed draft first, then prepare `UPDATE` to apply its reviewed bounds
and limit. Rule/pause receipts produce durable Space-scoped change records.
Registry nonce changes invalidate old quote/capacity authorizations; the owner
must authorize fresh capacity after changing policy. Metadata confirmations are
shown separately from receipt-backed policy changes.

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

The guided swap uses `POST /v1/intents/prepare-token`. It accepts the same
context plus `requestedTraderInputAmount` in the input token’s smallest units.
The configured provider converts that amount to settlement value using its
authoritative token metadata and price snapshot before constructing the intent;
the browser never derives a quote from a rounded display price.

Risk evaluation is a proposal endpoint. It uses the canonical watchtower
implementation, validates the stored hard policy and server clock, persists
cooldown state, rejects configuration changes without an operator migration, and
disregards caller-supplied recovery state. Worker state has a separate namespace
so public proposals cannot set the worker's recovery configuration.

Risk responses distinguish `proposed`, `certificate`, `certificateState`, and
`effective`. `SIGNED`/`NOT_SUBMITTED` means storage only. Effective values come
from `createRegistryRiskReader` at a canonical finalized block, including the
registry's expiry/revocation fallback. Without that reader, values are null and
source is `UNAVAILABLE`. A `configuration` object is returned when an evaluation
has been persisted; it is null before the first evaluation, so clients do not
guess trigger, cooldown, or recovery timings. Configure the actual **risk
registry**, separately from the policy registry, before accepting signed
certificates.

`/ready` returns the measured, timestamped readiness checks for the database,
RPC chain/finalized head, indexer checkpoint/lag, Graph sources, worker, signer,
and effective registry. Check states are explicit: `configured`, `healthy`,
`unhealthy`, `unknown`, or `disabled`. Required live checks must be measured
`healthy`; missing indexer lag remains `null`. Consumers must inspect
`data.status` and `data.reasons` in addition to HTTP success. `/health` remains
process liveness and does not imply serving readiness. Fixture mode is limited
to local database-backed capabilities and is not a production-readiness claim.

The interactive no-RPC CLI uses `LocalDemoProvider` with current-time snapshots
and a 60-second lifetime. The fixed-clock `FixtureProvider` remains available
for deterministic tests. Prepared demo intents expire and are lost on restart;
they are not production settlement evidence.

Snapshot providers may implement `getPositionSnapshot(positionId)` for capacity
reads that do not yet have an intent. The local demo implements this with its
current clock; the service validates chain/router context for both position and
intent snapshots. Existing providers retain the intent-based fallback. Space and
position read endpoints use that provider to refresh the durable portfolio,
policy nonce, bounds, fee configuration, and source metadata before responding.
A provider failure returns `SNAPSHOT_UNAVAILABLE` and dependent trading remains
blocked; a stale authoritative snapshot returns `SNAPSHOT_STALE`. Explicit
fork/RPC mode requires a provider that implements `getPositionSnapshot` and
never falls back to `FixtureProvider`.
