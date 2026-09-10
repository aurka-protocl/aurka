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

Node 23.3.0; local Anvil chain 31337 forked from Ethereum block 22400000. USDC
uses 6 decimals and WETH 18. MockAqua and fixed USDC=1/WETH=3200 prices remain
explicit test infrastructure. Validation used an injected EIP-1193 wallet in
Chromium at desktop and 390px widths; no normal browser-extension compatibility
claim is made.

The default `.fork-space` environment was preserved. Fresh evidence lives in
`.fork-space/mvp002-final/evidence/`.

## Commands and results

- `pnpm --filter @aurka/services test`: 76 passed, including signature
  isolation, bad/unrelated/wrong-chain receipts, replay rejection, failed setup,
  and orphan recovery.
- `pnpm test`: all workspace suites passed (the final additional receipt-retry
  regression was also run in the service suite).
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed.
- `forge test --match-contract 'AurkaSpaceVaultTest|AurkaPolicyRegistryTest|AurkaSwapVMRouterTest|DirectSettlementTest' --summary`:
  70 passed.
- `pnpm --filter @aurka/services exec node scripts/browser-smoke.mjs`: passed;
  canonical routes, navigation, mobile widths, scoped quotes and Activity.

```bash
AURKA_FORK_DIR="$PWD/.fork-space/mvp002-final" node --env-file=.env packages/services/scripts/fork-space.mjs
AURKA_FORK_DIR="$PWD/.fork-space/mvp002-final" node packages/services/scripts/fork-spaces-e2e.mjs
```

The fresh browser flow passed: save/reload two drafts, reject the first wallet
request without activation, reload during a submitted setup step, continue
without an extra factory broadcast, activate both Spaces, quote and settle
against each, and assert the other treasury balances stay unchanged.
Pause/resume and signed rule updates yielded durable receipt-backed events.
Updated policy invalidated the previous capacity authorization.

Historical run: there were 33 wallet broadcasts, including exactly two
treasury-factory calls. Each activation required 11 verified setup receipts.
That result is retained as historical evidence only and is not the current
creation contract.

## Chain evidence

| Space                                        | Isolated treasury                            | Activation receipt                                                   |
| -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `space:ae21b604-6755-4f80-b92e-c6fa7e6ae5a3` | `0xe8ce500232a6b3199E14c3e306997bB7FD0B09eB` | `0xab62bb16762b82ac55251bb300447a760e978f9441d95986facec511f69c0b05` |
| `space:ca3ac819-00ec-4a18-a819-d23abbc7e851` | `0x6d169002beCe8Ea3a10fd97115D848Ef268D9656` | `0x1efa46efff632052576fda80f91b3b03a20cafd5216ed2edb8e36cb11ee43115` |

Settlement receipts:

- `0xceff96e05ac67dae68194d949ff48f4e2225f507877d615d47b7961b9c08f3d7`
- `0x45ae06426210d77efd252af69808384fd6c4d03b76a67d6ca47432b786a0771d`

The complete transaction list is in `mvp002-wallet.json`; server-verified setup
receipts are in `../space-setup.json`. Screenshots include
`mvp002-one-active.png`, `mvp002-two-active.png`, both
`mvp002-*-trade-mobile.png` files, and `mvp002-owner-settings.png`.

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
their documented MockAqua allocation model. This remains a local fork demo, with
a fixed initial funding allocation of 35,000 USDC + 5 WETH per new Space.
