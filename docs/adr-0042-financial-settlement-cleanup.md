# ADR-0042: Phase 3.5 financial-settlement cleanup

- Status: accepted for AURKA-005
- Date: 2026-09-05
- Scope: one deterministic direct pairwise settlement before live Aqua/SwapVM
  integration

## Decision

AURKA uses a trader-centric, gross-value settlement model. The trader pays
`traderInputToken`; the treasury pays `traderOutputToken`. Fees are paid in the
trader output token and withheld from the trader's gross output. The only local
execution route is `AURKA_DIRECT_PAIR_V1`, selected by one deterministic solver.
Multi-route optimization, frontend/API/Graph/Privy work, live oracle deployment,
and production Aqua/SwapVM deployment remain out of scope.

## Capacity baseline and utilization

For each `(position, traderInputToken, traderOutputToken)` direction, an epoch
starts with an authoritative state:

```text
C0 = maximum safe gross fill at epoch start
u  = floor(consumedBefore × 1e18 / C0)
```

`C0` is derived by the settlement authority from the policy transaction cap,
effective risk cap, authoritative Aqua balances, governance-bound oracle prices,
effective portfolio bounds, and the fee-inclusive post-trade constraint. It is
not the current portfolio balance and is not recalculated for each transaction.
The submitted baseline must equal the derived value exactly.

Successful fills advance `consumedAfter = consumedBefore + grossFill`. Every
split fill carries the same epoch ID and the stored checkpoint, so splitting
cannot reset utilization or lower the OptionSpace rate. A reverse direction is a
separate directional epoch; a same-direction reversal is only a future,
explicitly authorized state transition and cannot reduce consumption below zero.

The epoch commits position, direction, balance snapshot, pair price snapshot,
complete managed-asset price snapshot, policy nonce, active risk certificate,
authorized Aqua strategy, baseline, chain ID, and verifying router. Therefore:

| State change          | Required result                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| Trade                 | Keep epoch and add gross consumed value.                                              |
| Split trade           | Same epoch/checkpoint; aggregate fees remain equal within integer rounding tolerance. |
| Reverse direction     | Independent key and independently activated baseline.                                 |
| Deposit or withdrawal | Old balance snapshot fails; activate a new epoch after recomputing `C0`.              |
| Price/oracle update   | Old complete price snapshot fails; activate a new epoch.                              |
| Policy or risk update | Nonce/risk commitment fails; activate a new epoch.                                    |
| Baseline-only edit    | Rejected because baseline is derived from authoritative state.                        |

## Bounded fee curve

Interpretation (a) is selected: 80 bps is the maximum instantaneous OptionSpace
premium at `u = 1`, not the average premium for a complete interval. The
instantaneous premium is `80 × u²`; a fill over `[u0,u1]` charges its integral
average:

```text
premiumBpsScaled = ceil(80 × (u0² + u0u1 + u1²) / (3 × 1e18))
totalFeeBpsScaled = 20 × 1e18 + premiumBpsScaled
```

The policy enforces `baseFeeBps = 20`, `slopeBps = 80`, and
`maximumFeeBps <= 100`, with base-fee shares 10/5/5 bps for treasury/solver/
protocol. The resulting boundary total is exactly 100 bps and every lower
interval is bounded. The language-neutral replacement examples are:

| Interval         |          Average total rate |
| ---------------- | --------------------------: |
| `[0, 0.2]`       |   21.066666666666666667 bps |
| `[0, 0.5]`       |   26.666666666666666667 bps |
| `[0, 0.9]`       |                    41.6 bps |
| `[0, 1]`         |   46.666666666666666667 bps |
| boundary `[1,1]` | 100 bps instantaneous total |

The complete fee amount is rounded up once. Sequential execution uses the
persisted interval endpoints, making it additive except for the documented small
integer allocation remainder.

## Complete accounting and canonical example

For gross value `T`:

```text
totalFee             = ceil(T × totalFeeBpsScaled / (10,000 × 1e18))
traderOutputValue    = T - totalFee
treasuryOutputValue  = T - treasuryFee
```

The router performs these atomic legs: trader input into Aqua, net output to the
trader, solver fee to the signed solver, protocol fee to the policy recipient,
and treasury fee retained in Aqua. The solver and protocol amounts are included
in the treasury output depletion and in the final portfolio calculation. No fee
is silently omitted from expected or final balances.

For the 60/30/10 portfolio and a `$200,000` request, the corrected maximum
executable fill remains `$50,000` because the `$50,000` transaction cap binds
before the fee-inclusive portfolio limits. The 46.666666666666666667 bps
interval-average fee is 234 value units:

```text
trader pays WETH                 50,000
trader receives USDC             49,766
solver receives USDC                  25
protocol receives USDC                25
treasury retains USDC                184

treasury after: USDC 550,184 / WETH 350,000 / LINK 100,000
treasury NAV: 1,000,184
```

Thus the post-trade weights are not exactly 55/35/10; fees increase NAV and
produce approximately 55.0083% / 34.9936% / 9.9982%. The original exact-weight
claim is replaced by this fee-inclusive state.

## Price protection

`PriceOracle` (TypeScript) and `IPriceOracle` (Solidity) are interfaces. The
policy/position settlement configuration binds the Solidity oracle address; the
local implementation is deterministic `MockPriceOracle`. The policy owns the
maximum age (120 seconds by default) and maximum deviation (100 bps by default),
and changes increment the policy nonce.

The router uses `block.timestamp`, never the caller's advisory clock, to check
freshness. Token decimal metadata comes from the policy registry, and the
protocol value scale is the constant `SETTLEMENT_VALUE_DECIMALS = 0`; caller
supplied decimal fields must match these values. It requires exact oracle price,
price decimals, snapshot ID, and timestamp for every managed asset. Pair
execution snapshots must match the oracle. The treasury input value is floored,
output value is ceiled, and settlement requires:

```text
minimumInput = ceil(treasuryOutputValue × (10,000 - deviationBps) / 10,000)
treasuryInputValue >= minimumInput
```

This is a deterministic minimum treasury exchange-value check with conservative
rounding. After the token legs, the router reloads Aqua balances and oracle
prices, recomputes every normalized asset value, and compares the authoritative
post-state with the signed commitment. No external live oracle is implemented in
this milestone.

## Cross-language and event contract

`packages/shared` owns the schemas, exact ABI-slot epoch commitment, price-set
commitment, fee math, and language-neutral vectors. `DirectSettlement.sol` and
`OptionSpaceFee.sol` use the same formulas and rounding. The router calls the
immutable `ISwapVM` boundary through `AurkaDirectSwapVM`, then executes the
exact Aqua legs. The adapter does not introduce an optimized route or an
arbitrary solver target.

`CapacityEpochActivated` and `TradeExecuted` have strict shared payload schemas;
they include the policy/position/epoch identifiers, policy and risk state,
balance and complete price commitments, strategy, all value/fee legs, capacity
checkpoints, and post-state hash. The service indexer accepts these canonical
ABI-decoded fields and resolves a position hash to a known local position ID.
Settlement failures are intentionally not represented by a rejection event: the
execution transaction reverts atomically and therefore discards all logs.
Indexers classify failed attempts using receipt status and decoded revert data.
