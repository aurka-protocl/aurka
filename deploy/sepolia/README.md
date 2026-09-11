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

The deployment script does not mint tokens, create a Space, provision Privy,
publish a Graph deployment, or claim a successful SwapVM trade. Those remain
explicit acceptance gates in `TASK1009-005`.

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

All are below EIP-170 (`24,576`) and EIP-3860 (`49,152`). The deployment
script checks the generated artifacts again before broadcasting.

The local acceptance proof is `forge test --match-contract
AurkaSepoliaUpstreamSwapVMRouterTest`. It deploys the pinned Aqua/SwapVM
artifacts, ships a real strategy, uses the router allowance boundary, and
asserts the Aqua, trader, solver, and protocol balance deltas.

## Required environment

See [`sepolia.env.example`](./sepolia.env.example). In particular:

- `AURKA_SEPOLIA_RPC_URL` must resolve to chain `11155111`;
- `AURKA_SEPOLIA_PRIVATE_KEY` is a dedicated deployer key and is never exposed
  to Vite or the browser;
- `AURKA_SEPOLIA_PRICE_MODE` is `mock` or `chainlink`;
- Chainlink mode requires both feed addresses and does not invent defaults;
- `AURKA_SEPOLIA_SWAPVM_OWNER_ADDRESS` may transfer ownership to a separately
  controlled address, otherwise the deployer owns the wrapper.
