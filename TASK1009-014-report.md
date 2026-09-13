# TASK1009-014 report

## Implementation

- Added `packages/services/scripts/sepolia-rpc-recovery.mjs` with one
  process-wide JSON-RPC coordinator: identical reads share an in-flight promise,
  `latest`/`finalized` head reads use a five-second cache, writes invalidate
  cached reads and provider snapshots, and HTTP 429/RPC quota errors open a
  bounded cooldown. `Retry-After` is honored; otherwise the cooldown uses
  bounded 2/4/8/16/30-second backoff with jitter. Viem transport retries are
  disabled.
- Persisted `CapacityEpochActivated` evidence atomically under the database
  directory (`/data/sepolia-epoch-events.json` in the hosted deployment).
  Entries are keyed by chain/router/position hash/epoch ID, retain decoded
  fields plus block and transaction identity, restore BigInts, validate the
  deployment envelope, and verify the event block hash before reuse.
- Event discovery checks saved activation receipts first, shares one lookup per
  key, limits each log-search pass to ten requests, and persists its cursor so a
  restart or cooldown resumes instead of replaying history.
- Refactored `sepolia-app.mjs` to build local config/database/API first. Remote
  chain ID, router, and snapshot initialization run in a retry loop after HTTP
  liveness is available. `/health` stays live, `/ready` reports syncing or
  degraded RPC state with `nextRetryAt`, and the provider, agent proposal path,
  and delegated worker remain fail-closed until a fresh snapshot succeeds.
- Added shared stable token metadata caching to `chain-snapshot.mjs`, safe
  `RPC_SYNCING`/rate-limit UI labels in `apps/trader/src/ui.ts`, and the worker
  readiness gate.

## Verification

Passed:

```text
pnpm --filter @aurka/services test       # 15 files, 130 tests
pnpm --filter @aurka/trader-app test     # 2 files, 19 tests
pnpm --filter @aurka/services typecheck
pnpm --filter @aurka/shared typecheck
pnpm build
targeted eslint
targeted prettier --check
```

The new recording tests show the focused request behavior:

| Scenario                                                |               RPC calls |
| ------------------------------------------------------- | ----------------------: |
| Five concurrent identical head reads                    |                       1 |
| Four additional reads inside the five-second head cache |            0 additional |
| Read after a confirmed write invalidates cache          |            1 additional |
| Second request during a `Retry-After: 4` cooldown       |            0 additional |
| One cache-miss discovery pass                           | at most 10 log requests |

The old implementation could issue up to 101 ten-block recent-window calls and
then fall through to an unbounded creation-to-head scan in one attempt. The new
implementation never exceeds ten log requests per pass and records the next
cursor durably.

## Hosted acceptance

- GCP project: `gapwise-505217`; VM: `aurka-sepolia-api` in `us-central1-a`.
- Deployed image: `aurka-sepolia:task1009-014-final3`.
- Deployment used `--preserve-env`; `/srv/aurka/data` was preserved.
- The API container is healthy and the edge is healthy.
- Public Vercel alias: `https://aurka-six.vercel.app`.
- `https://aurka-six.vercel.app/api/health` returned HTTP 200 with the liveness
  payload.
- `https://aurka-six.vercel.app/api/ready` returned HTTP 200 with
  `status: ready`, `chainId: 11155111`, canonical and finalized heads, and no
  required-check reasons. The final deployment reports the absent indexer as
  `disabled` rather than probing it.
- Before recovery, the same public readiness endpoint returned
  `status: not_ready` with `rpc:snapshot_syncing`; `/health` remained HTTP 200
  and the testnet route returned typed HTTP 503 without trading.
- A safe API restart was performed once. After restart the API recovered without
  a container restart loop, reused the durable event file at
  `/data/sepolia-epoch-events.json`, logged `sepolia.chain.ready`, and served a
  fresh live `/testnet` snapshot at block `11690202`.
- The final follow-up image deployment recreated the API container as part of
  the normal compose rollout; it also came up healthy with the same preserved
  event cache.
- No owner-authorized trade or wallet broadcast was performed during acceptance.

## Remaining limitations

Alchemy still intermittently returns HTTP 429 on the configured Sepolia RPC.
This task now contains that failure: liveness stays available, readiness is
accurately degraded, acquisition backs off globally, and recovery happens in
place. A provider quota increase or provider change remains operational relief,
not a code requirement.

The hosted owner-signature/trade demonstration was intentionally not performed.
Keep this task's metadata `complete: false`; this report verifies availability
and recovery but does not claim unrelated strategy, precision, Privy, or
owner-authorization acceptance.
