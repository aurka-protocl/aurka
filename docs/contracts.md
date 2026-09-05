# Phase 3, 3.5, and AURKA-005 contracts

Phase 3 establishes the hard-policy and temporary-risk boundary. Phase 3.5
defines the financial transition, and AURKA-005 adds the narrow atomic direct
settlement adapter described in
[`adr-0040-atomic-aqua-swapvm-settlement.md`](./adr-0040-atomic-aqua-swapvm-settlement.md).

## Authority model

`AurkaPolicyRegistry` stores a treasury's hard limits. Only the current treasury
governance address can add assets, update limits and fee recipients, pause the
policy, change the treasury address, or initiate a two-step governance transfer.
Every effective policy mutation increments `policyNonce` so later signed quotes
can reject policy races.

`RiskModeRegistry` accepts EIP-712 risk certificates signed by a
governance-authorized watchtower. A certificate:

- is bound to the current chain and registry contract by its EIP-712 domain;
- uses signature version 2, which signs the current policy nonce and the
  watchtower authorization epoch;
- uses a strictly sequential per-policy nonce;
- must be active at submission and has an explicit expiration;
- includes the hash of an ordered, complete set of active asset bounds;
- may raise minimum weights, lower maximum weights, reduce transaction capacity,
  pause individual assets, or pause the entire policy;
- cannot add assets, widen any bound, increase capacity, change recipients, or
  move funds.

Expired or revoked certificates automatically fall back to the hard policy. A
revocation also advances the watchtower authorization epoch, so reauthorizing
the same address cannot reactivate an already accepted certificate or accept a
pending signature from the previous authorization epoch. Every hard-policy
mutation increments the policy nonce; certificates must sign the current nonce,
so a pending signature cannot be rebound to a later policy version. A policy
update or managed-asset addition invalidates the old certificate before
effective bounds are read. Non-PAUSED certificates must have aggregate minimum
bounds no greater than 10,000 bps and aggregate maximum bounds no less than
10,000 bps. A hard-policy pause always overrides active risk state.
`rawActiveRisk` exposes stored certificate data, `isRiskActive` reports current
effectiveness, and settlement must consume only the effective views.

The version-2 EIP-712 struct appends `watchtowerAuthorizationEpoch` and
`policyNonce` to the certificate fields, and the domain version is `2`.
Version-1 signatures are intentionally not accepted or transformed: after this
format is deployed, watchtowers must sign a new certificate against the current
policy nonce and authorization epoch.

## Financial libraries

`PortfolioBounds` consumes normalized integer asset values. It provides NAV,
token/price decimal normalization, conservative weight reporting, exact
minimum/maximum value checks, post-trade previews, binding constraints, and a
flooring binary search for maximum safe fill. Minimum bounds use a rounded-up
required value and maximum bounds use a rounded-down allowed value.

`DirectSettlement` applies the same persistent capacity baseline, epoch ID, and
consumed-before value to a direct pairwise fill, then previews the fee-inclusive
treasury state. The public direction is trader-centric: `traderInputToken`
enters the treasury and `traderOutputToken` leaves it. `AurkaSwapVMRouter`
reloads every managed balance and normalized value from the governance-bound
`IPriceOracle`, while `PriceProtection` checks raw exchange amounts, policy
freshness, deviation, and minimum treasury exchange value before direct
settlement returns a fill. No live oracle is deployed.

`AurkaSwapVMRouter` is the only Phase 4 execution surface in this milestone. It
verifies trader/solver EIP-712 objects, requires an explicitly activated
position-direction epoch, checks the current Aqua virtual-balance snapshot,
executes the immutable `ISwapVM` direct adapter for `AURKA_DIRECT_PAIR_V1`,
routes exact output-token amounts, and reloads all Aqua balances before emitting
`TradeExecuted`. Local `MockAqua`, `MockPriceOracle`, and `MockERC20` fixtures
are deterministic; official upstream versions and the interface fingerprints are
recorded in [`integrations.md`](./integrations.md).

`OptionSpaceFee` uses `1e18` fixed-point utilization and the bounded
interval-average curve in ADR 0035. The policy enforces a maximum total fee of
100 bps. Fees are rounded once, paid in `traderOutputToken`, and routed to
treasury, solver, and protocol with exact reconciliation. Treasury fee revenue
is retained in that output token; solver and protocol transfers leave the
treasury's post-trade output balance. `FeesRouted` reports every recipient share
in normalized settlement-value units so its three values reconcile across token
decimal configurations. The signed proposal separately commits the raw
`solverFeeAmount` and `protocolFeeAmount` used for ERC-20 transfers.

Settlement failures revert atomically, so no rejection event is retained;
indexers classify failed attempts from receipt status and decoded revert data.

## Commands

```bash
forge fmt --check
forge build --sizes
forge test -vvv
forge snapshot --check
```

The tests include exact boundary checks, fuzzed maximal-fill and monotonic-fee
properties, certificate replay/expiry/signature tests, authorization tests, and
stateful portfolio invariants.

The `Deploy contracts` GitHub workflow is manual, defaults to simulation, and
uses the protected `contract-deployment` environment. Broadcasting requires an
explicit workflow input plus `MAINNET_RPC_URL` and `DEPLOYER_PRIVATE_KEY`
environment secrets. Local `.env` values are never uploaded automatically.

`contracts/script/deploy-settlement.sh` is simulation-first and requires
explicit `AURKA_POLICY_REGISTRY`, `AURKA_RISK_REGISTRY`, and
`AURKA_AQUA_ADDRESS`, and `AURKA_SWAPVM_ADDRESS` environment values. The
settlement simulation workflow is manually triggered; it never broadcasts or
receives production keys.
