# AURKA

AURKA lets portfolio owners offer tokens for swaps within allocation ranges and
per-trade limits. A **Space** is a portfolio held in a dedicated on-chain vault.
The solver calculates an executable swap amount and fee; contracts validate
settlement against the Space's constraints.

For example, a Space can require USDC to remain at least 55% of its value. A
swap that would cross that boundary is reduced for review or rejected. Market
movements can still change allocations; Spaces do not automatically rebalance.

[App](https://aurka-six.vercel.app)

## Features

- Create and fund separate Spaces with owner-authorized configuration.
- Quote and execute swaps through Aqua and SwapVM with allocation, capacity and
  price checks.
- Create a per-user Privy trading wallet, fund it with test assets and authorize
  a bounded trading mandate.
- Use Gemini through Vertex AI for chat and trade proposals. The solver
  validates proposals before delegated signing.
- Inspect agent decisions and transaction activity, stop trading permissions and
  recover tokens to the owner wallet.

The current deployment uses Ethereum Sepolia, mock USDC/WETH and demo oracle
prices. Agent wallets are operator-managed through Privy. This is a hackathon
prototype; live flows depend on RPC availability, current prices, capacity and
configured providers. It is not audited for production funds.

## Architecture

| Component         | Implementation                                                       |
| ----------------- | -------------------------------------------------------------------- |
| Frontend          | React, Vite, TypeScript; hosted on Vercel                            |
| API and worker    | Node.js, SQLite, persistent Google Cloud Compute Engine service      |
| Settlement        | Solidity, Aqua liquidity, SwapVM execution and AURKA policy checks   |
| Delegated wallets | Privy wallet provisioning, signing policies, revocation and recovery |
| Model access      | Vertex AI, `gemini-3.1-flash-lite`, server-side credentials          |

The API reads chain state for quotes and checks commitments before execution.
Agent evaluations run on the server independently of the browser. Chat does not
authorize transactions.

## Run locally against Sepolia

Requirements: **Node.js 24**, **pnpm 10.13.1**, Foundry with Solidity **0.8.28**
and **0.8.30**, and a Sepolia RPC endpoint.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
forge build
pnpm contracts:build-upstream
cp deploy/sepolia/sepolia.env.example .env.sepolia
```
## Try the app

1. Open **Spaces** and inspect a Space's holdings, allocation ranges and
   available capacity.
2. In **Trade**, connect a Sepolia wallet with the deployment's mock tokens.
   Request a quote, review the amounts and fee, then approve and submit through
   the wallet.
3. In **Automated trading**, create a trading wallet, add test funds and select
   a Space. Set the input amount, total budget, minimum rate and expiry, then
   sign the instructions.
4. Follow the agent activity and receipt links. Stop the agent before recovering
   its tokens to your owner wallet.
