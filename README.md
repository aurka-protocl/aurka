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
local deterministic solver/API/persistence/indexer service package; multi-route
optimization, live integrations, agents, and the application remain later
phases.

## Requirements

- Node.js 22 or newer
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
  Drizzle/SQLite repository, deterministic event indexer, local fixture, Docker
  Compose, and simulation CI.
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
