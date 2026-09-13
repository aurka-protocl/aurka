---
id: TASK1009-013
title: Fix per-user Privy authorization 503 and actionable wallet errors
status: todo
complete: false
---

# Local verification report

## Cause

The delegated-session factory returned an unavailable singleton adapter when
legacy singleton configuration was incomplete and dropped the injected per-user
wallet resolver. A registered READY agent therefore reached the unavailable
adapter and returned `DELEGATED_UNAVAILABLE`/503 even though its durable Privy
wallet existed.

## Local changes

- Preserved the complete `DelegatedSessionServiceOptions` object on every
  factory return path.
- Required per-user authorization to resolve a durable wallet record, matching
  owner and chain, with typed `AGENT_NOT_FOUND` and
  `DELEGATED_OWNER_UNAUTHORIZED` failures. Unknown per-user wallet addresses
  cannot fall back to the legacy adapter.
- Removed singleton signer-address, signer-ID, and execution-policy-ID gates
  from per-user composition. Existing agents use their persisted IDs; new
  provisioning reports `AGENT_CONFIGURATION_MISSING` when provisioning-only
  values are absent.
- Added safe typed wallet status failures for configuration, timeout, rate
  limit, provider, and policy cases.
- Preserved structured API request IDs in the SDK and showed them in the Agent
  page's expandable support details.

## Local evidence

- `pnpm typecheck` — passed.
- `pnpm test` — passed: 136 services, 64 shared, 16 wallet, 4 SDK, and 21 trader
  tests.
- `pnpm build` — passed.
- `pnpm lint` — passed.
- Focused factory/API regression — passed: authenticated production-style
  authorization succeeds with no singleton wallet ID; unknown wallet and foreign
  owner are rejected; no resolver remains configuration-failed.
- Touched-file Prettier check — passed.

The workspace-wide `pnpm format:check` still reports five unrelated existing
files: `.aurka/sepolia-space-epochs.json`,
`.aurka/sepolia-space-lifecycle.json`, `apps/trader/src/pages/Space.tsx`,
`apps/trader/src/pages/Spaces.tsx`, and
`packages/services/scripts/fork-space-lifecycle.mjs`. They were not changed for
this task.

The commands emitted the existing Node engine warning because this workspace
requests Node 24.x and the local runner is Node 23.3.0; all checks completed
successfully.

## Hosted acceptance

No cloud deployment, hosted database, wallet, key, or signing state was changed.
Deployed revision: **not deployed by design**.

After local acceptance, the remaining steps are to deploy through the existing
authorized path, confirm the existing READY agent authorizes with the legacy
wallet ID still absent, then verify owner-approved start/stop and any worker
progress. Keep `complete: false` until that hosted acceptance is complete.
