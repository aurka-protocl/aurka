# Vercel frontend manifest

This directory contains the reviewable Vercel configuration for the built trader
frontend. Before creating a Vercel project, replace `api.example.invalid` in
`vercel.json` with the dedicated API hostname. The placeholder is intentional:
this repository has no authorized public API hostname and must not publish a
fake deployment URL.

Set these Vercel build variables:

```text
VITE_AURKA_MODE=fork
VITE_AURKA_CHAIN_ID=31337
VITE_AURKA_API_URL=/api
```

Only `VITE_*` values are bundled into the browser. Never put `MAINNET_RPC_URL`,
OpenRouter, Privy, Graph, deployer, or wallet authorization values in Vercel
variables. The `/api` rewrite must terminate at the same verified fork-aware API
deployment as the chain and Graph services.

Deploy from the repository root with this directory selected as the Vercel
project root, or copy the manifest to the project root after replacing the API
hostname. Verify a second device can load `/spaces`, `/trade`, and an encoded
Space deep link before treating the frontend as hosted evidence.
