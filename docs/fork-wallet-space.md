# One Space on an Ethereum fork

AURKA-029 runs the canonical AURKA application against a persistent local
Ethereum fork. All transactions use test funds. The upstream RPC is read only;
nothing is deployed or broadcast on mainnet.

## Start and reset

Prerequisites: Node 23.3.0, pnpm, Foundry (`anvil`, `forge`), and an Ethereum
mainnet archive RPC that can serve block **22400000**. Put `MAINNET_RPC_URL` in
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
reset. Missing or unavailable upstream RPC fails explicitly; this mode never
falls back to demo fixtures. The mocked price expires after 24 hours; reset to
start a new priced scenario. Anvil state is periodically saved and saved on
shutdown. An interrupted initial deployment should be reset.

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
2. Grant USDC allowance to the mocked Aqua contract through the wallet, then
   **Authorize trading capacity** through the wallet. Each action has its own
   submitted/confirmed receipt. No trade occurs yet. The policy is preconfigured
   during deployment; the runner does not continue signing owner actions.
3. Open the same app in another profile at the Space's `/trade/:spaceId` route
   with Bob selected. Connect, request 2 WETH, and inspect the partial fill. At
   the explicitly mocked price of 3,200 reference units/WETH, the request is
   worth 6,400, exceeding the 5,000 limit. The review shows exact raw-token-
   scaled input/output and fee legs.
4. Accept the reviewed amounts. **Approve and sign** requests the required WETH
   allowance and an EIP-712 intent signature. It then simulates the signed
   router transaction. **Prepared** means it has not yet been submitted.
5. **Submit trade**, approve the wallet request, and wait for **Trade:
   confirmed**. Inspect the local receipt hash, block and gas. Both screens
   refresh from the fork; reload them and use **Check last local receipt** to
   query the saved hash.
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
- MockAqua is deliberately an unrestricted test fixture, not production custody
  or a secure external integration. Actual ERC20 transfers occur in Alice's
  account. MockPriceOracle holds fixed USDC=1 and WETH=3200 reference prices.
  FixtureProposalSigner is the public test solver. All are named in the UI and
  deployment manifest. The price is not an executable external market quote.
- Scope is one Space, one direction (Alice acquires WETH), two fork tokens and
  local funds. There is no factory, model, external routing or live deployment.
  Task 030 must extend this actual governance/capacity authority for its
  mandate.
- Standard application startup without `VITE_AURKA_MODE=fork` retains the
  labelled unsigned demo. Fork mode uses the same canonical routes and shell;
  its wallet state is shared by the header, Space settings, and trade flow.

The seeded WETH reference price is 3200 so whole reference-unit fills map
exactly to 18-decimal WETH. This avoids claiming support for nonrepresentable
raw amounts in the current whole-unit settlement model; 030 must retain rounding
checks.
