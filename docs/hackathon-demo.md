# Hackathon MVP demo: configurable Spaces and the live trade agent

This is a three-minute, fork-only demo. It uses public Anvil test accounts and
must never be pointed at a personal wallet or a production RPC signer. The demo
proves owner-selected USDC/WETH funding, deterministic portfolio rules, an
OpenRouter tool-calling proposal, and explicit browser-wallet approval.

## Start one persistent environment

Prerequisites are Node 23.3, pnpm, Foundry, and an Ethereum archive RPC able to
read block `25500000`. Put only the archive URL in the root `.env`:

```sh
MAINNET_RPC_URL=https://your-archive-rpc.example
```

Start the persistent fork, API, and app from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm fork:start
```

The runner uses an isolated Anvil fork at `http://127.0.0.1:8545`, the API at
`http://127.0.0.1:8797`, and the app at `http://127.0.0.1:3011/spaces`. It
persists chain state, service data, setup plans, and the manifest under
`.fork-space/`. Keep that directory intact when resuming. To discard only this
disposable scenario, stop the runner and run:

```sh
pnpm fork:reset
```

For parallel work, set `AURKA_FORK_DIR`, `AURKA_FORK_RPC_PORT`,
`AURKA_FORK_API_PORT`, and `AURKA_FORK_APP_PORT` to a separate directory and
free ports. The runner starts the API and Vite app itself; do not start a second
service against the same fork directory.

## Wallet and funding

Use a separate browser profile with the standard public Anvil test mnemonic. Add
a custom network with chain ID `31337`, currency `ETH`, and RPC
`http://127.0.0.1:8545`. Alice is account index 0 and Bob is account index 1.
The runner seeds test USDC/WETH and ETH only; the public mnemonic is not a
secret and must not be used for real funds.

Alice opens `/spaces/new`, connects the owner wallet, and enters both starting
amounts in the Funding & limit step. Inputs are decimal strings: USDC is
converted at 6 decimals and WETH at 18 decimals using exact integer parsing.
Both must be positive. Negative values, exponents, excess precision, zero
amounts, insufficient token balance, and a starting allocation outside the
current price-snapshot bounds are rejected before activation. The review shows
the chosen allocation, token balances, ETH gas balance, per-trade limit, and the
exact funding values.

On a new fork Space, the owner approves only the exact missing USDC/WETH
allowances to the displayed factory spender. After those prerequisites, the
wallet approves exactly one `createAndInitializeSpace` transaction. That call
pulls the reviewed amounts, creates the isolated vault and policy, registers the
Aqua strategy, and activates capacity atomically. No separate capacity
transaction is part of normal creation. If the owner edits the draft, the old
plan and setup hashes are not reused.

## Live agent journey

The OpenRouter key is server-only. Configure it in `.env` using the existing
names; never put it in `VITE_*` variables, prompts, browser storage, or logs:

```sh
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=replace-me
OPENROUTER_MODEL=openrouter/free
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TIMEOUT_MS=15000
OPENROUTER_MAX_TOOL_CALLS=4
OPENROUTER_MAX_CONCURRENT_PROPOSALS=2
```

The app exposes only `GET /v1/agent/status` configuration state and
`POST /v1/agent/propose`. In Trade, Bob asks for a supported exchange and the
server requires the model to invoke tools for current Space discovery,
conditions, a deterministic quote, and proposal simulation. Server validation
owns chain, wallet, allowlisted token, amount, balance, policy, price snapshot,
capacity, and expiry checks. The model cannot sign, execute, alter policy, or
provide authoritative calldata. User text and Space names are treated as
untrusted content.

The card displays the selected Space, pay/receive amounts, fees, deterministic
minimum received, expiry, rule binding, current and expected portfolio, gas
simulation state, explanation, and a sanitized tool trace. It is labeled
“AI-assisted, wallet-approved.” Choosing “Use values in wallet review” copies
the verified amount, token direction, and Space into the existing manual flow;
Bob must request a fresh quote, review current state, sign the EIP-712 intent,
and approve the wallet transaction. Account, chain, policy, capacity, price, or
expiry changes invalidate the review. Missing credentials, timeout, malformed
provider output, cancellation, or upstream failure renders “Agent unavailable”
and leaves manual trading available.

OpenRouter’s current tool-calling exchange is the documented chat-completions
loop: a tool-call assistant message is followed by tool results and another
completion request. See the
[official tool-calling guide](https://openrouter.ai/docs/guides/features/tool-calling)
and
[official chat completions reference](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request?explorer=true).

## Delegated agent-wallet journey (TASK99-008)

This is a separate, explicitly opt-in custody path. Bob first connects his
browser wallet and reviews the dedicated Privy agent address, eligible Space,
USDC/WETH direction, per-trade cap, cumulative integer-token budget, maximum
trade count, slippage limit, and short expiry. His EIP-712 signature authorizes
that exact session. The address is not Bob's browser wallet and is not Alice's
Space owner; it must be funded independently with only the displayed demo
budget. Bob must separately approve the exact missing token allowance to the
settlement router. Those one-time funding/approval transactions are visible and
are never delegated to the agent.

After authorization, “Start one bounded worker tick” uses the same OpenRouter
tool loop and deterministic solver described above, but passes the dedicated
agent address as trader. AURKA reserves the integer budget atomically, refreshes
the wallet policy, balances, allowance, quote, capacity, price, chain, and
nonce, re-encodes and simulates the exact router calldata, and then asks Privy
to sign/broadcast. The browser is not prompted for each authorized trade. A
Privy policy restricts the relevant Ethereum typed-data domain and router/value
target; AURKA owns session limits and exact nested calldata checks; the
settlement contracts remain authoritative. A receipt timeout or provider
ambiguity pauses reconciliation and never triggers a duplicate send.

Bob can see the agent address, wallet/policy status, remaining budget, expiry,
last proposal, and actual transaction hash in Trade/Activity. Stop disables
local signing before requesting the operator-owned Privy revoke. A transaction
already broadcast may still confirm; the UI reconciles it. The “Recover reviewed
test funds to Bob” control is available after Stop, expiry, or exhaustion: Bob
signs exact input/output token amounts and the separate owner/operator recovery
module executes them. Recovery pauses if a submitted trade still lacks a
receipt; the delegated signer never receives transfer or withdrawal permission.

The live proof is not present in this checkout. The isolated demo fork is
loopback Anvil `31337`; no claim is made that a hosted Privy broadcaster can
reach it. Run the sanitized check and provide a supported custom-network/live
route before funding anything:

```sh
pnpm privy:delegated
pnpm privy:delegated template
PRIVY_DELEGATED_PROVISION=true pnpm privy:delegated provision
```

The required live wallet/policy readback, remote denial check, real Privy
signature, funded agent, and confirmed receipt belong in
`.aurkadev/reviews/TASK99-008-report.md`; this remains a bounded implementation
and manual-evidence checklist, not a production-funds claim.

## Three-minute script

1. Alice creates one Space with non-default values such as `12345.678900` USDC
   and `2.25` WETH, then reviews its current price-snapshot allocation and
   bounds. The exact values must fit the chosen bounds and Alice’s seeded
   balance.
2. Alice approves the exact token prerequisites and the one factory setup
   transaction. Wait for the app’s canonical receipt verification before
   trading.
3. Bob opens the Trade route, connects account index 1, asks the assistant for a
   small WETH → USDC trade, and inspects the before/after allocation and every
   fee. The current deployment exposes only this initialized directional
   capacity; a USDC → WETH request remains explicit and blocked. Use the card
   only after a fresh manual quote and wallet review.
4. Bob signs and submits the reviewed trade. Distinguish “submitted,”
   “confirmed,” and “awaiting indexing”; an indexed Activity item is not
   fabricated when Graph is unavailable or lagging.
5. Ask for a larger amount that breaches the Space’s current transaction cap or
   portfolio bound. The deterministic solver returns the actual blocking rule
   and numbers; the UI does not claim that an unverified amount is safe.
6. Inspect Alice’s vault balance and Bob’s token balance. Alice’s treasury funds
   move to Bob only through the verified settlement; Bob’s input and the
   explicitly routed fees are shown separately. ETH gas is separate from token
   conservation.

## Recovery and evidence

If a wallet rejects or leaves a transaction pending, reload the same app and use
the setup “Check again” action. Saved hashes are scoped to owner, chain, Space,
fork generation, operation, and immutable plan commitment. A pending, missing,
reverted, or fork-mismatched transaction is reconciled before retry; the app
never blindly rebroadcasts funding. A changed funding draft requires a new owner
signature and plan.

For reproducible injected-wallet checks, use the existing disposable command:

```sh
pnpm integration:fork-wallet
```

That is test-wallet evidence, not proof that every browser extension works.
Manual extension evidence, a live OpenRouter request, model identifier,
sanitized tool trace, and confirmed trade hash must be recorded separately in
`.aurkadev/reviews/TASK99-007-report.md`. The ordinary demo still uses
browser-wallet approval when delegated Privy prerequisites are unavailable.
Delegated Privy remains an opt-in pilot and its live gates are recorded in
`.aurkadev/reviews/TASK99-008-report.md`. Graph pagination, provenance, and lag
follow-ups from TASK99-006 remain open.
