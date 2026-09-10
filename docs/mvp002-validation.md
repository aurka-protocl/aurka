# MVP-002 validation — 2026-09-09

> The original measurements in this document were made before TASK99-005 and
> describe the retired eleven-step creation path. The current fork path is
> documented in `docs/fork-wallet-space.md`; its fresh-owner measurement is two
> exact token approvals followed by one factory setup transaction per Space.

The fork now supports wallet-created Spaces with separate treasury vaults,
owner-controlled policies, verified funding/allowances, and trading-capacity
authorization. Names and drafts remain authenticated metadata; they cannot
manufacture chain activation.

## Environment

Node 23.3.0; the TASK99-006 release rehearsal uses local Anvil chain 31337
forked from Ethereum block 25500000. USDC uses 6 decimals and WETH 18. Real mode
uses the deployed Aqua registry and a locally deployed Chainlink V3 adapter
reading the pinned ETH/USD and USDC/USD rounds; native 8-decimal answers are
normalized to the whole settlement precision and raw rounds are fingerprinted.
Validation used an injected EIP-1193 wallet in Chromium at desktop and 390px
widths; no normal browser-extension compatibility claim is made.

The default `.fork-space` environment was preserved. The final release runner
retains evidence under `AURKA_RELEASE_EVIDENCE_DIR` when supplied; the checked-
in sanitized summary is `docs/evidence/task99-006-real-release-summary.json`.

## Commands and results

### TASK99-006 real-integration release rehearsal

`pnpm integration:fork-real` passed on the tested checkout. It proved:

- two Alice-owned Spaces created with two exact ERC-20 approvals plus one
  factory setup transaction each;
- actual Aqua `ship(...)` virtual-balance registration, two Bob trades through
  `AURKA_DIRECT_PAIR_V1`, fee conservation, and isolated treasury balances;
- Chainlink-backed quote/settlement using the pinned historical clock and
  explicit integer normalization;
- same-fork Graph Node indexing of two `SpaceInitialized`, two `TradeExecuted`,
  two `FeesRouted`, and policy/status entities, consumed by `/v1/activity`;
- Graph outage returning `503 GRAPH_ACTIVITY_UNAVAILABLE`, followed by a
  successful query after Graph Node restart.

The run writes sanitized contract, Graph, receipt, and wallet evidence to the
directory named by `AURKA_RELEASE_EVIDENCE_DIR`; without that variable it uses a
disposable temporary directory. It does not publish a deployment or expose the
archive RPC credential.

- `pnpm --filter @aurka/services test`: 92 passed, including signature
  isolation, bad/unrelated/wrong-chain receipts, replay rejection, failed setup,
  and orphan recovery.
- `pnpm test`: all workspace suites passed (the final additional receipt-retry
  regression was also run in the service suite).
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed.
- `forge test --match-contract 'AurkaSpaceVaultTest|AurkaPolicyRegistryTest|AurkaSwapVMRouterTest|DirectSettlementTest' --summary`:
  70 passed.
- `pnpm --filter @aurka/services exec node scripts/browser-smoke.mjs`: passed;
  canonical routes, navigation, mobile widths, scoped quotes and Activity.

The final browser flow passed: save/reload two drafts, activate both Spaces with
two approvals plus one factory setup transaction each, quote and settle against
each, confirm the other treasury stays unchanged, then pause/resume and apply a
signed rule update. The sanitized evidence summary records the final setup and
trade hashes; the retained runner directory also contains the complete wallet
transaction list and screenshots.

The older 33-broadcast/eleven-receipt activation result and the earlier local
wallet receipt table are retained in repository history only; they are not the
current creation contract or the TASK99-006 release evidence.

## Recovery and remaining environment limits

The regression suite covers an orphaned setup receipt downgrading the Space and
its events, removing its quote provider, preserving replay protection, and
resuming the missing step. A reverted intended transaction records failure
without advancing setup. RPC outages retain receipt history rather than retrying
funding blindly.

Policy-indexer identity resolution now uses persisted Space IDs even before a
position is active, and repairs old hash aliases during replay. This fixes the
restart conflict exposed by the two-Space flow.

New Spaces use isolated vaults. The pre-existing seeded demo fixtures retain
their documented MockAqua allocation model. Real-mode new Spaces use the actual
Aqua registry and the owner-selected positive USDC/WETH allocation, with exact
token-unit and price-snapshot validation; fixture mode is explicitly labelled
and is not release evidence.
