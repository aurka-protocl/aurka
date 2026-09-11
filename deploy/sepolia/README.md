# AURKA Ethereum Sepolia profile

This profile is deliberately separate from `deploy/hosted-demo`, which remains
the local Anvil/mainnet-fork rehearsal. It deploys the pinned AURKA and 1inch
artifacts to Ethereum Sepolia (`11155111`) and writes a sanitized deployment
manifest. It never stores a private key in the repository.

## Prerequisites

From the repository root:

```bash
pnpm contracts:build-upstream
forge build
cp deploy/sepolia/sepolia.env.example .env.sepolia
```

Fill `.env.sepolia` with a dedicated Sepolia RPC and a funded Sepolia deployer.
The deployer must not be the Privy delegated wallet. The example defaults to a
controlled `MockPriceOracle`; set `AURKA_SEPOLIA_PRICE_MODE=chainlink` only
after supplying verified Sepolia feed addresses.

## Safe commands

These commands do not broadcast transactions:

```bash
pnpm sepolia:plan
pnpm sepolia:check
```

The plan records the current upstream artifact pin and explicitly marks the
sponsor-recommended SwapVM `release/1.0.2` comparison as pending. The current
repository artifact must not be described as release-1.0.2-equivalent until that
review and the affected tests pass.

## Deployment

Review the plan, then opt in explicitly:

```bash
AURKA_SEPOLIA_DEPLOY=true pnpm sepolia:deploy
```

The script deploys, in order:

1. demo USDC (6 decimals) and demo WETH (18 decimals);
2. the pinned 1inch Aqua artifact;
3. the AURKA upstream SwapVM wrapper;
4. the AURKA policy and risk registries;
5. the reduced AURKA Sepolia order validator and settlement math helper;
6. the reduced AURKA Sepolia upstream executor and router;
7. the executor/router initialization and AURKA Space vault factory;
8. either the labelled mock oracle or the configured Chainlink adapter;
9. the one-time policy-registry factory handoff and mock-price setup.

In mock-price mode it sets USDC to `1` and WETH to `3200` in settlement
decimals. This is demo pricing, not Chainlink evidence. The generated
`sepolia-deployment.json` is local deployment state and should be copied into
sanitized evidence only after checking every address and receipt.

After deployment, the owner-only demo setup script creates one funded Space,
ships the reviewed strategy into Aqua, and activates its capacity epoch:

```bash
pnpm sepolia:space
```

For the mock profile, this uses 60,000 demo USDC and 12.5 demo WETH. The
separate acceptance command refreshes the labelled mock prices, opens a fresh
epoch, and executes one bounded deployer-signed SwapVM trade through the live
Sepolia router:

```bash
pnpm sepolia:trade
```

After that acceptance trade consumes its epoch, reopen a new directional epoch
for another live app rehearsal without redeploying:

```bash
pnpm sepolia:reactivate
```

The command refreshes mock prices, simulates the owner-authorized activation,
and then broadcasts it. `AURKA_SEPOLIA_DRY_RUN=true pnpm sepolia:reactivate`
performs only the read/simulation checks. The newly derived baseline reflects
the current portfolio weights; it can be lower than the policy maximum after a
previous trade reaches an asset bound.

The acceptance command is deployer-only evidence for the Aqua/SwapVM path; it
does not substitute for the separate Privy wallet, policy, delegated trade,
Graph, or hosted-runtime gates.

## Per-user Privy agent wizard

The Sepolia app includes a per-user agent route at `/agent`. A visitor connects
an injected Ethereum wallet, signs the login challenge, and clicks through the
four-step wizard. The backend provisions one dedicated Privy wallet for that
owner, creates an owner-specific recovery policy, funds the wallet with the
deployed mock WETH/USDC and Sepolia ETH, and stores the reviewed mandate.

The browser never receives Privy credentials, policy JSON, quorum IDs, or
authorization keys. The server worker continues bounded evaluations after the
browser is closed. The owner can later stop/revoke the agent and recover one
reviewed token at a time to the authenticated wallet.

Run the detailed acceptance procedure in
`.aurkadev/1009/TASK1009-008-manual-test.md`. Set `AURKA_ALLOWED_ORIGINS` to the
exact hosted HTTPS origin when deploying outside localhost. The faucet limits in
the environment example are testnet-only controls, not production deposit or
withdrawal support.

## Run the active testnet app

Start the Sepolia API gateway, then start the browser app with:

```bash
pnpm app:testnet
```

This selects Ethereum Sepolia (`11155111`) and points the Vite proxy at the
gateway on port `8797`. The browser uses `/api/testnet` for chain-backed reads;
the legacy local-fork gateway is not part of this app path.

## Size result

The original `AurkaSwapVMRouter` remains the full local regression artifact and
is too large for public deployment. The Sepolia profile uses
`AurkaSepoliaSwapVMRouter`, which keeps the policy/risk/oracle/replay checks and
the pinned upstream SwapVM path while placing order parsing, settlement math,
and token movement in separately deployed helpers:

- Sepolia router runtime/initcode: `22,822` / `41,268` bytes;
- upstream executor runtime/initcode: `5,960` / `7,734` bytes;
- order validator runtime/initcode: `989` / `1,015` bytes;
- trade math runtime/initcode: `8,856` / `8,882` bytes.

All are below EIP-170 (`24,576`) and EIP-3860 (`49,152`). The deployment script
checks the generated artifacts again before broadcasting.

The local acceptance proof is
`forge test --match-contract AurkaSepoliaUpstreamSwapVMRouterTest`. It deploys
the pinned Aqua/SwapVM artifacts, ships a real strategy, uses the router
allowance boundary, and asserts the Aqua, trader, solver, and protocol balance
deltas.

## Required environment

See [`sepolia.env.example`](./sepolia.env.example). In particular:

- `AURKA_SEPOLIA_RPC_URL` must resolve to chain `11155111`;
- `AURKA_SEPOLIA_PRIVATE_KEY` is a dedicated deployer key and is never exposed
  to Vite or the browser;
- `AURKA_SEPOLIA_PRICE_MODE` is `mock` or `chainlink`;
- Chainlink mode requires both feed addresses and does not invent defaults;
- `AURKA_SEPOLIA_SWAPVM_OWNER_ADDRESS` may transfer ownership to a separately
  controlled address, otherwise the deployer owns the wrapper.
