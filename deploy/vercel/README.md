# Vercel frontend manifest

This directory contains the reviewable Vercel configuration for the built trader
frontend. The same configuration is copied to the repository root for the real
Vercel project because the project root must remain the monorepo root. The first
Sepolia deployment uses the reserved Compute Engine IP as a temporary server-
side rewrite. Replace that temporary HTTP destination in both manifests with a
verified HTTPS API hostname once DNS is authorized and configured.

Set these Vercel build variables:

```text
VITE_AURKA_MODE=testnet
VITE_AURKA_CHAIN_ID=11155111
VITE_AURKA_API_URL=/api
VITE_AURKA_AGENT_TEST_MODE=false
```

Only `VITE_*` values are bundled into the browser. Never put `MAINNET_RPC_URL`,
OpenRouter, Privy, Graph, deployer, faucet, or wallet authorization values in
Vercel variables. The `/api` rewrite must terminate at the same verified Sepolia
API deployment as the chain services.

Deploy from the repository root. Vercel's Root Directory is the repository root;
do not select `deploy/vercel` as the project root. Verify a second device can
load `/spaces`, `/trade`, and an encoded Space deep link before treating the
frontend as hosted evidence.
