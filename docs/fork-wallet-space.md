# Spaces on an Ethereum fork

The canonical AURKA application can run against a persistent local Ethereum
fork. The default fork mode uses the real Aqua deployment and Chainlink V3
rounds from a pinned Ethereum snapshot; fixture mode is explicit. All local
transactions use test funds. The upstream RPC is read only; nothing is deployed
or broadcast on mainnet.

## Start and reset

Prerequisites: Node 23.3.0, pnpm, Foundry (`anvil`, `forge`), and an Ethereum
mainnet archive RPC that can serve block **25500000**. Put `MAINNET_RPC_URL` in
the root `.env`. Do not supply a production signing key. This runner ignores
`DEPLOYER_PRIVATE_KEY`. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm fork:start
```

The command builds the project and contracts and starts Anvil at
`http://127.0.0.1:8545`, the API at `http://127.0.0.1:8797`, and one application
at `http://127.0.0.1:3011/spaces`. Alice and Bob use the same origin and select
the same Space through `/spaces/:spaceId/settings` and `/trade/:spaceId`. Ports
are fixed and must be free. Stop with Ctrl-C. The chain state, service database,
epoch commitments, and public deployment manifest are saved under `.fork-space/`
(gitignored). Start again to reuse them. Do not delete individual files; after
stopping the runner, reset the entire test environment with:

```sh
pnpm fork:reset
```

Reset discards this local scenario, redeploys, and funds the dedicated accounts
again. Wallets may cache nonces: clear their local activity/nonce data after a
reset. Missing or unavailable upstream RPC fails explicitly; real mode never
falls back to demo fixtures. Anvil state is periodically saved and saved on
shutdown. An interrupted initial deployment should be reset. Fixture mode is
explicit: set `AURKA_FORK_INTEGRATION=fixture` and use a separate fork
directory.

## Wallet setup

Use a separate browser profile and a wallet containing only public Anvil test
accounts. Add a custom network named **AURKA fork**, chain ID **31337**,
currency **ETH**, RPC **http://127.0.0.1:8545**; leave the explorer blank.

The runner uses Anvil's standard public test mnemonic and derivation path
`m/44'/60'/0'/0`. To obtain the test mnemonic locally without copying any
project credentials, run a separate `anvil --host 127.0.0.1 --port 18545`, read
its default test mnemonic from its startup output, and stop that temporary
process. Import that mnemonic into the separate test wallet. Never import a
personal wallet into this test profile or send real funds to these publicly
known accounts.

- Alice: account index 0, `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`. She is
  both treasury and policy governance.
- Bob: account index 1, `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`.
- Protocol fee recipient: account index 2; the manifest also identifies the
  public test solver fee recipient.

### Single-transaction Space creation

New fork Spaces use an ordinary `eth_sendTransaction` to
`AurkaSpaceVaultFactory.createAndInitializeSpace`. The reviewed call deploys the
deterministic owner vault, pulls exactly the owner-selected USDC and WETH
amounts shown in the signed draft, configures the policy and price protection,
calls the real Aqua `ship(...)` registration with the exact strategy bytes,
derives capacity from the post-funding onchain state, and activates trading.
There is no normal `wallet_getCapabilities` probe, `wallet_sendCalls` batch,
separate capacity transaction, or eleven-transaction fallback.

If the owner has insufficient allowance, the review shows one exact approval for
each required token to the factory spender. Those approvals are separate
prerequisites and are counted honestly; the subsequent creation remains one
setup transaction. Existing sufficient allowance is reused. A submitted setup
hash is stored before confirmation, and pending, missing, reverted, replaced, or
fork-mismatched hashes remain actionable without an automatic replacement.

Actual fork tokens:

| Token | Ethereum address                             | Decimals |
| ----- | -------------------------------------------- | -------- |
| USDC  | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6        |
| WETH  | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18       |

Alice starts with 70,000 USDC and 10 WETH; Bob with 10,000 USDC and 10 WETH,
plus test ETH for gas. USDC comes from a fork-only impersonated holder; WETH is
obtained through the real WETH deposit function. No token code is replaced.

## Alice and Bob journey

1. Open the canonical app, open the Space's Settings route, choose Alice in the
   wallet, and connect on chain 31337. Inspect holdings, controlling account,
   40% maximum WETH allocation, and the 5,000 reference-unit transaction limit.
2. Choose **Create Space**. Enter and review the exact owner-selected USDC/WETH
   funding, bounds, limit, and any token approval spender shown by the app.
   Approve only the disclosed USDC/WETH prerequisites if requested, then approve
   the one factory setup transaction. The Space is ready only after its
   canonical receipt and initialized state are verified; no Grant allowance or
   Authorize capacity step follows.
3. Open the same app in another profile at the Space's `/trade/:spaceId` route
   with Bob selected. Connect, request the supported WETH amount, and inspect
   the quote. The screen identifies the real Chainlink source, its normalized
   settlement precision, and the raw-round evidence in the fork manifest. The
   review shows exact raw-token-scaled input/output and fee legs.
4. Accept the reviewed amounts. **Review and sign exact trade** requests the
   required WETH allowance and an EIP-712 intent signature. It then simulates
   the signed router transaction. **Prepared** means it has not yet been
   submitted.
5. **Submit exact trade**, approve the wallet request, and wait for **Saved
   transaction confirmed**. Inspect the local receipt hash, block and gas. Both
   screens refresh from the fork; reload them and use **Check last local
   receipt** to query the saved hash.
6. Check WETH conservation between Alice and Bob and USDC conservation across
   Alice, Bob, solver and protocol. Fees retained by Alice are part of her net
   balance change, not an extra transfer. Gas changes ETH separately.
7. Alice can pause, resume, revoke USDC allowance, or lower the transaction cap.
   Pausing or changing policy nonce invalidates old authorization. Authorize a
   fresh capacity after reviewing rules and holdings. A consumed capacity cannot
   be reset by clicking authorize again without a new policy authority state.
8. Reject a wallet request, switch account/network, try an expired quote, and
   try trading while paused. None should produce a confirmed trade. Quote and
   prepared state are invalidated when wallet context or relevant state changes.

## Integration checks

For the full TASK99-006 release rehearsal, use one command. It starts a fresh
real fork, deploys a same-fork Graph Node stack, runs the two-Space Alice/Bob
journey, verifies Graph-backed Activity, simulates a Graph outage/restart, and
writes sanitized evidence when `AURKA_RELEASE_EVIDENCE_DIR` is set:

```sh
pnpm integration:fork-real
```

With a freshly reset runner active in one terminal, run in another:

```sh
pnpm integration:fork-wallet
```

This uses Playwright Chromium with an injected **EIP-1193 test wallet** backed
by only the dedicated Anvil accounts. It signs real EIP-712 payloads and sends
real fork transactions through the browser flow. It is not an unsigned
preparation check and is not a third-party wallet-extension compatibility claim.
The test leaves the policy paused. Reset before rerunning. Install the
Playwright Chromium browser if missing with
`pnpm exec playwright install chromium`.

Evidence is written to `.fork-space/evidence/`: transaction hashes, balance
reconciliation, wallet review text, and desktop/390px screenshots. A human can
repeat the steps above with an independently installed wallet extension.

Other required regression checks:

```sh
pnpm build
pnpm typecheck
pnpm integration:local-settlement
forge test --match-contract 'AurkaPolicyRegistryTest|AurkaSwapVMRouterTest|DirectSettlementTest'
```

## Boundaries and handoff to 030

- `packages/services/scripts/chain-snapshot.mjs` is shared with the existing
  local settlement harness. Its policy, virtual holdings and oracle reads are
  pinned to one block. Fork-specific composition supplies saved onchain epoch
  authority and current consumption. The fixed demo provider is not
  instantiated.
- `GET /fork` on the local gateway exposes the manifest, chain-backed position,
  actual Alice/Bob/fee-recipient balances, capacity and observed block.
  `GET /fork/owner?action=…` prepares owner calldata only; the connected owner
  wallet must authorize and submit it. These are local development endpoints.
- The existing quote/solve/execute API and router calldata/signature
  verification perform trading. Router events are ingested from the same fork
  and replayed idempotently after restart. Browser receipt checks use the actual
  submitted hash; the legacy API's synthetic pending preparation identifier is
  not a chain hash.
- Real mode uses the deployed Aqua contract at
  `0x499943e74fb0ce105688beee8ef2abec5d936d31`, and the locally deployed
  `ChainlinkPriceOracle` reads the pinned ETH/USD and USDC/USD rounds. The
  adapter normalizes those 8-decimal answers to the whole settlement units used
  by this MVP and fingerprints both raw and normalized values.
  `AurkaDirectSwapVM` is the narrow AURKA execution adapter; upstream SwapVM is
  not claimed. `FixtureProposalSigner` remains the public test solver. The
  manifest labels every fixture and real dependency.
- New user Spaces use the typed factory entry point and the two fork tokens. The
  predefined demo Spaces retain their seeded fixture allocations. The factory
  keeps owner governance on each policy and finalized vault; it has no owner
  withdrawal path or arbitrary-call surface. Fixture mode retains the explicit
  MockAqua seed path and is never presented as real integration evidence.
- Standard application startup without `VITE_AURKA_MODE=fork` retains the
  labelled unsigned demo. Fork mode uses the same canonical routes and shell;
  its wallet state is shared by the header, Space settings, and trade flow.

The runner’s pre-seeded fixture Spaces retain their documented preset balances;
new real-mode Spaces use the exact owner-selected funding in each signed draft.
Fixture mode uses a seeded WETH reference price of 3200 so whole reference-unit
fills map exactly to 18-decimal WETH. Real mode uses the pinned Chainlink round
and explicitly records whole-settlement-unit normalization; it does not silently
pretend fixture precision is market precision.
