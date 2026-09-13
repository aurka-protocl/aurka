# TASK1009-012 — Strategy parity and price reliability

Status: implementation complete; live owner-authorized acceptance remains
pending (`complete: false` in the task file).

## Verified cause

The affected Space `space:487748ea-34ac-4f04-b929-40ae0c41d5de` shipped the
legacy USDC-first strategy:

- shipped/legacy hash:
  `0x2490f3518c0f7867254cadad52b2776c9f6a0cf307489c6cff241adeea2e7332`
- canonical current-price hash:
  `0x0d593ff2db42d1df1c46e9105d5bb77b04dc7f0e18764659ca9e014f07f8aebb`

The mismatch is encoding/order drift, not oracle age. The hosted API now reports
`STRATEGY_MISMATCH` (HTTP 409), marks the Space non-tradable, and returns only
sanitized owner-recovery instructions. Timestamp refreshes do not rewrite or
conceal the immutable strategy.

## Implemented

- Added pure `buildUpstreamStrategy` in
  `packages/shared/src/upstream-strategy.ts`; lifecycle creation, Sepolia seed
  setup, solver encoding, parity tests and readback diagnosis use the same
  builder.
- Preserved reviewed maker traits, address ordering, token-associated balances,
  output `+1` rounding, direction flag, ABI encoding and the existing upstream
  pin.
- Kept recovery owner-only: pause → dock → exact vault-balance withdrawal → new
  Space identity. No recovery transaction or automatic fund movement was
  submitted.
- Added typed `STRATEGY_MISMATCH` state/error and distinct
  price-renewal/stale-price behavior across service, API, cards, detail, Trade
  and agent eligibility.
- Added integer-only downward amount adjustment with explicit user review. The
  0.001 WETH fixture produces 0.0009375 WETH supported and 0.0000625 WETH
  remainder; no approval/signature is requested before acceptance.
- Added persistent event evidence/search progress and startup reconciliation
  retry for transient RPC/event failures.
- Added process-shared RPC read deduplication/cooldown and fail-closed chain
  readiness.
- Split proactive price timestamp refresh from capacity renewal. The operator
  pins status reads to one block, refreshes with a 60-second margin before the
  120-second price limit, persists a bounded 48-operation budget, records
  unknown outcomes, and exposes last success/next attempt/failures/budget state.

## Tests

- `pnpm --filter @aurka/shared test`: 4 files, 64 passed
- `pnpm --filter @aurka/services test`: 16 files, 134 passed
- `pnpm --filter @aurka/trader-app test`: 2 files, 20 passed
- `pnpm lint`: passed
- shared/services/trader typechecks: passed
- `pnpm build`: passed
- `pnpm contracts:build-upstream`: passed
- Focused Solidity suites: Sepolia upstream 1 passed; upstream router 3 passed;
  Space creation/recovery 9 passed

## Hosted verification

- Backend release: `aurka-sepolia:task1009-012-final4`
- VM API, edge and price operator containers: healthy
- `http://136.65.161.166/ready`: observed HTTP 200 `ready` after a successful
  refresh; it correctly reports not-ready while a refresh transaction is in
  flight.
- Operator state is persistent and shows successful price-only operations with
  `capacityRenewed: false`; the seed capacity remained separate from timestamp
  refreshes.
- Seed prepare + quote succeeded on the canonical strategy. The affected Space
  returned: `STRATEGY_MISMATCH`, `executable: false`, and the recovery message
  above.
- Frontend production deployment: `https://aurka-six.vercel.app`; the deployed
  bundle contains the owner-repair and amount-review labels.

## Remaining acceptance

No approved owner wallet session/signature was available for the required
destructive recovery, new Space creation, or real WETH → USDC transfer.
Therefore I did not pause/dock/withdraw, create a replacement on-chain identity,
sign an approval/intent, or broadcast a swap. The existing seed and user funds
were preserved. The task must remain incomplete until an approved test owner
completes the hosted recovery/new-Space flow and one small real swap with
receipt and balance deltas.
