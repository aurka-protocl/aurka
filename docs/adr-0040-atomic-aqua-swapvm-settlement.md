# ADR-0040: atomic direct Aqua/SwapVM settlement

- Status: accepted for AURKA-005
- Date: 2026-09-04
- Scope: one direct pairwise route on the local compatibility boundary

## Decision

`AurkaSwapVMRouter` is the atomic boundary between the AURKA financial model and
token settlement. It accepts one EIP-712 intent from a trader and one EIP-712
proposal from a solver. The router independently reloads policy, risk, the
governance-bound oracle, Aqua balances, and the selected directional capacity
epoch; signed values are commitments, never authority.

The only executable program is `AURKA_DIRECT_PAIR_V1`. Its ABI-encoded fields
are hashed into the proposal and checked against the intent, direction,
strategy, raw amounts, normalized values, and capacity epoch. There is no
arbitrary solver target or uncommitted calldata. The router calls the immutable
`ISwapVM` boundary through `AurkaDirectSwapVM`, which verifies the direct
program's amount/output contract. The adapter intentionally performs no custody
operation; the router then executes the exact Aqua token legs in the same
transaction. A production SwapVM/Aqua deployment remains a separately pinned
integration.

## Atomic sequence

The router validates signatures, deadlines, policy nonce, effective risk hash,
managed assets, portfolio snapshot, price snapshots, and the persisted epoch
before setting replay and capacity state. It then:

1. pulls the trader's gross input token into the router and pushes it into the
   treasury's Aqua virtual balance;
2. pulls the trader output amount from Aqua to the trader;
3. pulls solver and protocol fee shares from Aqua to their signed recipients;
4. retains the treasury fee share in the treasury's Aqua output balance; and
5. reloads every Aqua balance and checks the expected post-state hash.

Any failure reverts the entire transaction. State writes happen before the
external token calls under a reentrancy guard, so a failure rolls them back with
the transfers. Token balance deltas and exact finite approvals reject
fee-on-transfer behavior in the local boundary.

## Signed commitments

The intent domain is `AURKA Direct Settlement` version `1`, with chain ID and
router address. It commits policy, position, trader direction, gross request,
minimum output, partial-fill policy, deadline, nonce, balance snapshot, and
price snapshot, and the governance-authorized Aqua strategy hash. The proposal
commits the intent hash, solver, policy/risk state, raw amounts, all fee
allocations, normalized values, epoch checkpoint, post-state hash, Aqua strategy
hash, and direct-program hash.

The router rejects used intent IDs, trader nonces, and proposal hashes. An
explicit `activateCapacityEpoch` call is required before execution. The capacity
key is position plus `(traderInputToken, traderOutputToken)`. A split fill must
use the same immutable epoch ID and the stored `consumedValue`; it cannot reset
utilization. A reverse direction uses a separate explicitly activated key and
epoch, so it cannot erase forward utilization.

## Fee and price authority

`DirectSettlement` remains the sole source of maximum-safe-fill and fee math.
Fees are paid in the trader output token. The trader receives the net output;
solver and protocol shares leave Aqua; the treasury share remains in Aqua. The
router recomputes the full fee-inclusive portfolio and verifies every raw output
leg against the normalized fee values.

The router consumes a governance-bound `IPriceOracle` adapter. It requires the
oracle's exact snapshot ID, price, decimals, and timestamp for every managed
asset; the pair execution snapshots are also checked against the oracle. The
policy, not the caller, fixes the maximum price age and deviation. The router
uses `block.timestamp` as the only freshness clock, and enforces the
deterministic minimum treasury exchange value with floor input valuation and
ceiling output valuation. No live provider is implemented here.

## Capacity authority and event ABI

The epoch baseline is derived on chain from the authoritative Aqua balances,
governance-bound oracle prices, effective risk limit, policy transaction cap,
and fee-inclusive portfolio constraints. A caller-supplied baseline must equal
that result exactly. The epoch commits the full managed-asset price set and the
position's authorized strategy. Deposits, withdrawals, oracle/price changes,
policy changes, and risk changes therefore either fail against the old epoch or
require a newly activated epoch; a baseline-only reset is not valid.

`CapacityEpochActivated` emits policy ID, position hash, direction, epoch ID,
baseline, policy nonce, risk hash, balance snapshot, pair price snapshot,
complete portfolio price snapshot, strategy hash, and `consumedBefore`.
`FeesRouted` emits the solver, protocol, and retained treasury shares uniformly
in normalized settlement-value units; raw output-token transfer quantities stay
committed in the signed proposal. `TradeExecuted` emits policy ID, position
hash, intent/proposal/epoch IDs, direction, all value legs, total fee, both
capacity checkpoints, and the post-state hash. TypeScript parses these exact
canonical payloads through `protocolEventPayloadSchemas` before projection.

Failed execution does not emit a persistent rejection event. Solidity logs are
rolled back when the transaction reverts, including logs emitted earlier in that
transaction. Indexers therefore classify failed settlement attempts from the
receipt status and decoded revert data; the revert remains the only
settling-path failure contract. A non-settling quote-validation/reporting
endpoint may be added later, but is outside this milestone.

## Explicit non-goals

This ADR does not add a multi-route optimizer, API, database, indexer, Graph,
Privy, frontend, live oracle, production deployment, or production funds. Those
decisions belong to later milestones after the direct calculation is kept
identical in TypeScript and Solidity.
