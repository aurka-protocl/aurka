# AURKA

AURKA is an agentic, portfolio-constrained liquidity protocol. Treasuries define
the portfolio states they are willing to accept; solvers discover transactions
that remain inside those rules, and contracts independently verify settlement.

## Implementation status

Phases 1–3 establish the pnpm monorepo, shared runtime schemas and financial
core, and the Foundry policy/risk contract suite. Phase 3.5 resolves capacity,
bounded fees, complete fee accounting, direct pairwise settlement previews, and
deterministic price protection. AURKA-005 adds an atomic, local direct
Aqua-compatible settlement adapter with signed commitments. AURKA-006 adds the
local deterministic solver/API/persistence/indexer service package. MVP-002 adds
persistent multiple Spaces, owner-signed lifecycle mutations, isolated local
demo allocations, and wallet-created fork Spaces with separate treasury vaults
and receipt-verified policy, funding, and capacity setup.

## Requirements

- Node.js 23.3.0 (see `.node-version`)
- pnpm 10.13.1

## Development

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Workspace packages live in `apps/*`, `packages/*`, and `packages/agents/*`.
`@aurka/shared` is the canonical source for cross-layer data contracts. Monetary
amounts are represented at JSON boundaries as unsigned base-10 integer strings,
which avoids precision loss and forces callers to make token decimals explicit.

## Current package

- `@aurka/shared`: addresses, amounts, policies, risk certificates, trade
  intents, solver proposals, quotes, positions, executions, events, and API
  response schemas.
- `@aurka/services`: direct solver, closed optimized-solver boundary, `/v1` API,
  Drizzle/SQLite repository, persistent Space management, deterministic event
  indexer, local fixture, Docker Compose, and simulation CI.
- `contracts`: governance-owned hard policies, signed tightening-only risk
  certificates, maximum-safe-fill verification, bounded OptionSpace fees, and
  the atomic direct settlement router.

Contract design and commands are documented in
[`docs/contracts.md`](docs/contracts.md). GitHub Actions run TypeScript and
Foundry checks independently; CI never receives the local `.env` file.

## Safety

This repository is under active development. It is not audited and must not be
used with production funds.

# aurka

## SDK and local applications

Run `pnpm install --frozen-lockfile` and `pnpm build` at the repository root.
Start the API with `pnpm --filter @aurka/services start` (port 8787), then the
canonical app with `pnpm --filter @aurka/trader-app dev` (port 3002). The app's
development proxy forwards `/api` to the API with that prefix removed. It
exposes Spaces, Trade, and Activity from one frontend origin; the former
treasury package is retained as historical source while its product surfaces are
served by the canonical app.

The trader can prepare an intent, quote, solve, and request unsigned execution
calldata after supplying an external trader signature. It does not broadcast.
Unavailable balances, P&L, history feeds and effective risk are labeled as such.
See [SDK usage](packages/sdk/README.md), [API semantics](docs/api.md), and
[watchtower runtime requirements](docs/risk-watchtower.md). For the complete
local product journey, measured demo values, manual acceptance checklist, and
issue template, see the [product walkthrough](docs/product-walkthrough.md).

## Fork Space creation validation

With an Ethereum archive `MAINNET_RPC_URL` in `.env`, build with
`pnpm build && forge build`. Start an isolated validation environment without
resetting the default fork:

```bash
AURKA_FORK_DIR="$PWD/.fork-space/mvp002-validation" node --env-file=.env packages/services/scripts/fork-space.mjs
```

In another terminal, run the two-Space browser flow against a fresh validation
fork (it uses that fork's public test wallets and real local transactions):

```bash
AURKA_FORK_DIR="$PWD/.fork-space/mvp002-validation" node packages/services/scripts/fork-spaces-e2e.mjs
```

The flow creates drafts in the UI, activates independent funded treasuries,
quotes/trades against both, and checks receipt-backed policy changes. Evidence
is written under the selected fork directory's `evidence/`.
`AURKA_SPACE_IDS=id1,id2` resumes checks for existing Spaces after a
service/fork restart. The injected EIP-1193 test wallet does not establish
compatibility with every browser extension.
