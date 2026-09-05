# AURKA financial core

Phase 2 uses integer arithmetic so the same vectors can be evaluated by
TypeScript and Solidity. Public monetary values are `bigint` integers in a
declared `valueDecimals` unit. Token balances are smallest-unit integers and
prices are integers with their own `priceDecimals`.

## Rounding and precision

Ratios use `FIXED_POINT_SCALE = 10^18`. Basis points use `10,000`, and a
fractional fee is represented as scaled basis points. Fractional rates are never
converted to JavaScript floating point.

Asset value is calculated as:

```text
ceil(balance × price × 10^valueDecimals /
     (10^tokenDecimals × 10^priceDecimals))
```

Asset values and reported exposure weights round upward. Constraint checks use
the stricter side for each bound: the minimum required value rounds upward and
the maximum allowed value rounds downward. This prevents either a fractional
minimum-weight deficit or a fractional maximum-weight excess from being hidden.

Trades in the solver operate on normalized value units. A trade adds gross fill
value to `traderInputToken` and removes gross fill value from
`traderOutputToken`; the fee-inclusive version retains the treasury fee and
remits external shares, so NAV changes by fee revenue minus external fees.
`findMaximumSafeFill` uses an inclusive binary search with a floored midpoint;
the returned fill is therefore always an integer that passes every constraint.
The search high bound is the minimum of requested value, transaction cap, and
trader-output-asset value because that is the asset leaving the treasury.

`calculateUtilization(consumedBefore, capacity)` returns
`floor(consumedBefore × 1e18 / capacity)`. A zero capacity is treated as fully
utilized when a non-zero amount is consumed and as zero utilization when empty.
OptionSpace uses a capacity epoch: the baseline is the maximum safe gross
directional fill from the epoch's portfolio under the effective policy and price
snapshot. The baseline, epoch ID, and `consumedBefore` value are persisted
across split fills; `calculateDirectionalCapacity` can report that state and
`establishDirectionalCapacity` starts a new epoch.

Trades update consumed value, reverse trades can restore consumed value in the
same epoch, and deposits, withdrawals, accepted price changes, hard-policy nonce
changes, and risk certificate state changes start a new epoch. See
[`adr-0035-financial-settlement.md`](./adr-0035-financial-settlement.md) for the
complete transition table.

## OptionSpace

For directional utilization `u0` and `u1` in `[0, 1]`, represented at 1e18
precision, `slopeBps` is the maximum instantaneous premium at `u = 1`:

```text
premiumBpsScaled = ceil(slopeBps × (u0² + u0u1 + u1²) / (3 × 1e18))
feeBpsScaled = baseFeeBps × 1e18 + premiumBpsScaled
```

The instantaneous curve is `slopeBps × u²`; the charged interval rate is its
average. Policies require `baseFeeBps + slopeBps <= maximumFeeBps <= 100`, so
the total fee is always bounded by 100 bps. The complete fee amount is rounded
up once, rather than rounding base and premium independently.

Fees are withheld from trader output in `traderOutputToken`. The base amount is
allocated proportionally to treasury/solver/protocol; the OptionSpace premium
and all integer remainders go to the treasury, so recipient amounts reconcile
exactly. Treasury post-state previews include solver and protocol transfers.

This interval-average curve is monotonic for non-decreasing utilization.
Splitting a fill preserves the aggregate fee amount and can change the final
treasury state only by per-recipient integer allocation rounding.

The fee-inclusive canonical fill is WETH -> USDC. For a 50,000 gross fill, the
trader receives 49,766 USDC, the solver and protocol each receive 25 USDC, and
the treasury retains 184 USDC. The treasury becomes USDC 550,184, WETH 350,000,
LINK 100,000, NAV 1,000,184. The 200,000 request still has a 50,000 executable
fill because the transaction cap binds first.

The language-neutral vectors are in
[`packages/shared/test-vectors/financial.json`](../packages/shared/test-vectors/financial.json).
They include the $1m 60/30/10 portfolio, its $50k safe fill, the unsafe $62k
proposal, reverse capacity, and the revised
21.066666666666666667/26.666666666666666667/41.6/46.666666666666666667 bps fee
points. The stable price-snapshot commitment excludes fill-specific amounts so
sequential fills can share one approved price epoch; its TypeScript helper is
`computeSettlementPriceSnapshotHash`, matching the router's `abi.encode` field
order. The atomic transfer/accounting fixture is in the `atomicDirectFixture`
section of the settlement vectors.
