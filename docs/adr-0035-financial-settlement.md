# ADR-0035: fee-inclusive financial settlement

- Status: accepted for Phase 3.5
- Date: 2026-09-04
- Scope: one deterministic direct pairwise solver

## Decision

The protocol uses trader-centric direction names everywhere:

- `traderInputToken` is paid by the trader and enters the treasury.
- `traderOutputToken` is paid by the treasury and leaves it.

Amounts in the solver are gross value units. Raw token amounts are carried
separately for price protection. There is no multi-route solver, live oracle,
frontend, API, Graph, or production database in this phase. AURKA-005 uses
governance-bound `IPriceOracle` and `ISwapVM` interfaces with deterministic
mocks.

## Capacity and utilization

For a position, direction, accepted balance snapshot, accepted pair price
snapshot, complete managed-asset portfolio price snapshot, authorized Aqua
strategy, effective policy nonce, and effective active risk certificate, the
capacity baseline `C0` is the maximum safe _gross_ value fill at the start of
that epoch. The calculation includes the transaction cap, the treasury's
`traderOutputToken` balance, and every portfolio weight bound. It is not the
current portfolio balance and is not recomputed for each transaction.

The authoritative epoch state is (`capacityEpochId, C0, consumedBefore`).
Utilization is:

```
u = floor(consumedBefore × 10^18 / C0)
```

with `u = 0` for an empty zero-capacity epoch. A fill of gross value `T`
advances `consumedAfter = consumedBefore + T`; a reversal that explicitly undoes
that same directional epoch subtracts the reversed gross value, never below
zero. An independently quoted reverse direction has its own epoch and baseline;
it does not erase the original direction.

`capacityEpochId` is the Solidity-compatible commitment:

```
keccak256(abi.encode(
  keccak256(UTF8(positionId)),
  bytes32(uint256(uint160(traderInputToken))),
  bytes32(uint256(uint160(traderOutputToken))),
  balanceSnapshot,
  priceSnapshot,
  portfolioPriceSnapshot,
  policyNonce,
  activeRiskCertificateHash,
  aquaStrategyHash,
  C0,
  chainId,
  verifyingContract
))
```

For protocol EVM addresses, the token IDs use the zero-left-padded address slot
shown above. Language-neutral symbolic vectors may hash their symbolic token
names, but deployed address-based inputs use the EVM address slot. The
TypeScript and Solidity implementations use the same field order and static ABI
slots. The router derives `C0` from authoritative Aqua balances,
governance-bound oracle prices, effective bounds, the policy cap, and the
fee-inclusive safe-fill search; a submitted baseline must equal that value. The
router persists this ID and advances `consumedBefore` atomically with a
successful transfer.

State transition rules:

| Event                                              | Effect                                            |
| -------------------------------------------------- | ------------------------------------------------- |
| Direct trade                                       | Keep the epoch; add gross value to consumed.      |
| Same-epoch reversal                                | Subtract the reversed gross value from consumed.  |
| New reverse direction                              | Establish a separate direction/epoch.             |
| Deposit or withdrawal                              | New balance snapshot, recompute C0, consumed = 0. |
| Accepted price update                              | New price snapshot, recompute C0, consumed = 0.   |
| Hard-policy update                                 | New policy nonce, old epoch invalid.              |
| Risk certificate activation, expiry, or revocation | New effective risk commitment, old epoch invalid. |

Splitting cannot reset utilization because every quote carries and verifies the
same epoch ID and `consumedBefore`. Changing any committed state creates a
different epoch and is an explicit state transition, not a fee workaround.

## OptionSpace fee curve

Interpretation (a) is selected: 80 bps is the maximum _instantaneous_ premium at
the utilization boundary, not the average premium over a complete capacity
interval. The instantaneous premium is `slopeBps × u²`. A fill charges the
interval average:

```
premiumBpsScaled = ceil(
  slopeBps × (u0² + u0u1 + u1²) / (3 × 10^18)
)
totalFeeBpsScaled = baseFeeBps × 10^18 + premiumBpsScaled
```

The configuration is bounded by:

```
baseFeeBps = 20
slopeBps = 80
baseFeeBps + slopeBps <= maximumFeeBps <= 100
```

Therefore no transaction pays more than 100 bps total. At `[1, 1]` the
instantaneous boundary rate is 100 bps; the average rates for the complete
intervals are:

| Utilization interval |                Total rate |
| -------------------- | ------------------------: |
| `[0, 0.2]`           | 21.066666666666666667 bps |
| `[0, 0.5]`           | 26.666666666666666667 bps |
| `[0, 0.9]`           |                  41.6 bps |
| `[0, 1]`             | 46.666666666666666667 bps |

The complete fee amount is rounded up once. Split execution uses the same
persisted utilization intervals and is equivalent to one fill within the
documented integer allocation tolerance (two value units in the canonical
example).

## Fee accounting

The trader pays the fee in `traderOutputToken`; it is withheld from trader
output, not added to trader input:

```
totalFee = ceil(T × totalFeeBpsScaled / (10,000 × 10^18))
traderOutputValue = T - totalFee
treasuryOutputValue = T - treasuryFee
```

The settlement transfer order is:

1. trader transfers gross `traderInputToken` value to the treasury;
2. treasury transfers `traderOutputValue` to the trader;
3. treasury transfers solver and protocol fee shares to their recipients;
4. treasury retains its fee share in `traderOutputToken`;
5. the fee-inclusive post-state is checked against policy bounds.

The treasury portfolio includes only the treasury. Solver and protocol
recipients are external to it. The base fee is allocated as 10 bps treasury, 5
bps solver, and 5 bps protocol; all OptionSpace premium and integer remainder
accrues to treasury. `FeeAccounting` records the fee token, payment mode, and
all three recipient identifiers.

## Corrected canonical example

The fee-free 60/30/10 portfolio has 600,000 USDC, 300,000 WETH, and 100,000
LINK, with a 50,000 maximum transaction value. A 200,000 request therefore
executes at 50,000 gross; the transaction cap binds. The direction is WETH ->
USDC:

```
trader pays WETH                         50,000
trader receives USDC                    49,766
solver receives USDC                       25
protocol receives USDC                     25
treasury retains USDC fee                 184
```

The 46.666666666666666667 bps interval-average rate produces fee 234 (base 100
plus premium 134). The final treasury state is:

```
USDC  550,184
WETH  350,000
LINK  100,000
NAV   1,000,184
```

The original “exactly 55/35/10 after fees” statement was incorrect. The
fee-inclusive weights are approximately 55.0083% USDC, 34.9936% WETH, and
9.9982% LINK, and pass the conservative bounds. The canonical safe fill remains
50,000 because the transaction cap binds before the corrected fee-inclusive
bounds.

## Price protection

The price provider remains behind `PriceOracle` in TypeScript and `IPriceOracle`
in Solidity. The settlement configuration binds an oracle address to each
policy/position. Phase 3.5 uses a deterministic mock through that interface; it
does not implement a live provider.

Direct settlement requires both assets' reference and execution snapshots,
approved snapshot IDs, raw token amounts, token decimals, price decimals, and
the current timestamp. Token decimals are read from policy state and the
protocol value scale is the constant `SETTLEMENT_VALUE_DECIMALS = 0`; supplied
scales must match. The router ignores the caller's advisory `nowSeconds` and
uses the settlement block timestamp; the policy fixes the allowed age and
deviation. It rejects future or stale snapshots, token/snapshot identity
mismatches, and execution prices outside the configured absolute deviation.

For an exchange, the treasury input value is floored and the treasury output
value is ceiled:

```
treasuryInputValue  = floor(inputAmount × inputPrice)
treasuryOutputValue = ceil(outputAmount × outputPrice)
minimumInput        = ceil(treasuryOutputValue × (10,000 - deviationBps)
                            / 10,000)
```

The settlement is accepted only when `treasuryInputValue >= minimumInput`. This
deterministic check makes rounding conservative in both directions. After
settlement, the router reloads authoritative Aqua balances and oracle prices,
recomputes the entire normalized portfolio, and compares it with the committed
fee-inclusive post-state before accepting the transaction.

## Phase 4 gate

The AURKA-005 gate is implemented by
[`adr-0040-atomic-aqua-swapvm-settlement.md`](./adr-0040-atomic-aqua-swapvm-settlement.md):
its local direct router persists the capacity epoch, consumes approved snapshots
through the adapter boundary, performs the five accounting legs atomically, and
advances the epoch state in the same transaction. No optimized solver or live
external integration is approved by this ADR.
