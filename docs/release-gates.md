# AURKA release-gate and independent-review packet

Status: **blocked — local verification complete, external release evidence
missing**  
Date: 2026-09-07 (America/Mexico_City)  
Task: AURKA-015  
Tested checkout: `HEAD b1c52ca` plus the uncommitted working-tree changes
present in this checkout. There is no immutable release revision yet.

This is the durable, non-secret handoff for the final verification gate. It is
not an audit report, deployment approval, or production-readiness claim.

## Decision

Do not release or deploy. The local implementation and deterministic system
checks pass, but the following gates remain open:

- no independent external security/custody reviewer, identity, scope, date, or
  verification reference has been supplied;
- no production chain, Aqua/SwapVM/oracle deployment, Graph deployment or DEX
  source has been selected and verified;
- no real Privy wallet/policy IDs, fingerprints, authorization arrangement, or
  policy read-back has been supplied;
- the protected GitHub environment and required reviewers have not been
  verified, and the protected smoke has not run against real inputs;
- no live operational recovery or transaction evidence exists.

The local protected-smoke run is missing these exact inputs: `AURKA_RPC_URL`,
`AURKA_CHAIN_ID`, `AURKA_SETTLEMENT_CONTRACT`, `AURKA_POLICY_REGISTRY`,
`AURKA_RISK_REGISTRY`, `AURKA_GRAPH_ENDPOINT`, `AURKA_GRAPH_DEPLOYMENT_ID`,
`AURKA_WALLET_POLICY_URL`, and `AURKA_WALLET_ID`. The corresponding API
keys/tokens remain intentionally unprovided.

The local direct-settlement, Graph Node, readiness, browser, and workflow
results are useful prerequisites only. They do not close these gates.

## Scope and architecture

The review scope is the local AURKA-003 through AURKA-014 implementation and the
release controls that consume it:

```text
governance policy
      ├──> RiskModeRegistry <── signed, tightening-only watchtower certificate
      └──> AurkaSwapVMRouter / SettlementAuthority
                                  └── direct Aqua/SwapVM-compatible settlement

RPC + Graph observations ──> provenance/finality checks ──> canonical evaluator
                                                          └──> risk API/worker
                                                               └── scoped wallet

SDK/API intent preparation ──> direct solver ──> signed proposal
                                              └── unsigned transaction request
                                                   └── external trader authorization

chain events ──> indexer + Graph mapping ──> projections/readiness/UI
```

The trust boundaries are:

| Boundary          | Authoritative control                                                                                            | Untrusted input that must not widen authority                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Policy and risk   | Governance-owned hard bounds; registry effective views; EIP-712 v2 certificate epochs/nonces                     | Solver values, caller time, stale certificates, client-supplied recovery state        |
| Settlement        | Router reloads policy/risk/price/balances and verifies hashes, epochs, signatures, exact deltas and post-state   | Solver calldata, arbitrary targets, unsupported tokens, fee-on-transfer behavior      |
| Risk data         | Canonical chain reader, source provenance, finality and freshness checks; integer-only evaluator                 | Graph freshness labels, malformed/partial data, missing quorum, prose/LLM output      |
| Custody           | Separate execution/risk roles, structured certificate validation, chain/target/selector/cap checks, default deny | Browser code, app IDs, arbitrary RPC methods, private keys, unreviewed policy changes |
| Projection and UI | Onchain events and verified checkpoints; explicit unavailable/error states                                       | HTTP 200 alone, proposed risk treated as effective, fabricated financial values       |

## Version and configuration inventory

These are the versions and local boundaries actually tested. Production values
are intentionally absent until selected and approved.

| Item                  | Current local value                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / pnpm           | Fresh host checks used Node `23.3.0`; the pinned `.node-version` and Docker container use Node `22.14.0`; pnpm `10.13.1`                                         |
| Solidity / router ABI | Solidity `0.8.28`; router ABI version `AURKA-005`; `execute` selector `0xd93c3663`                                                                               |
| Direct program        | `AURKA_DIRECT_PAIR_V1`; one deterministic direct pair only                                                                                                       |
| Risk certificates     | `RiskCertificate` EIP-712 signature version `2`; domain name `AURKA RiskModeRegistry`; certificate type includes policy nonce and watchtower authorization epoch |
| Settlement signatures | EIP-712 domain name `AURKA Direct Settlement`, version `1`; router/verifying contract and chain are bound                                                        |
| Privy client          | `@privy-io/node@0.34.0`; no live wallet or policy provisioned                                                                                                    |
| Graph local stack     | Graph Node `v0.41.2`, Postgres `14.11`, IPFS `v0.17.0`; Graph CLI `0.98.1`, mapping API `0.0.9`                                                                  |
| Local chain           | Anvil/Foundry chain `31337`; fixture addresses are generated per run                                                                                             |
| Local source labels   | AURKA observation `schemaVersion=risk-v1`, `queryVersion=observations-v1`; Uniswap source remains the proposed `fixture-dex-v1` only                             |

The upstream research references, local interface hashes, policy JSON, selector
inventory, and missing production values are recorded in
[`docs/integrations.md`](./integrations.md) and
[`docs/aurka-012-integration-spec.md`](./aurka-012-integration-spec.md).

## Acceptance-to-evidence matrix

`PASS (local)` means the local implementation or deterministic fixture was
tested. `BLOCKED` means the required external or independent evidence is absent;
it is not inferred from a successful build or mock.

| Original gate                              | Owner / follow-up                                  | Exact artifact or command                                                                                     | Environment and result                                                                                                               | Release state              |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| AURKA-005 independent audit                | Independent reviewer; user to appoint              | AURKA-005 unchecked audit item; audit report and reviewer verification reference                              | No external reviewer or report supplied                                                                                              | **BLOCKED**                |
| AURKA-005 live Aqua/SwapVM/oracle boundary | Deployment owner; AURKA-012 decision record        | `docs/integrations.md`; `docs/aurka-012-integration-spec.md`; selected deployment bytecode/code-hash evidence | Only Anvil `31337` `MockAqua`/`AurkaDirectSwapVM` fixture exists                                                                     | **BLOCKED**                |
| AURKA-007 live Graph and Privy selection   | Product/governance, infrastructure, custody owners | AURKA-012 candidate matrix and policy JSON; protected workflow inputs                                         | Candidates and policies are proposals; no selected deployment, pool, wallet, or policy read-back                                     | **BLOCKED**                |
| AURKA-007 real default-deny policies       | Custody owner                                      | Privy policy IDs/fingerprints plus read-only policy verification artifact                                     | Local fake/native-client denial tests pass; no real policy was provisioned                                                           | **BLOCKED**                |
| AURKA-007 protected live smoke             | Operations; AURKA-014 workflow                     | `.github/workflows/protected-integration.yml`; `packages/services/scripts/protected-smoke.mjs`                | Local invocation returns `status=blocked`, `reason=missing_inputs` for nine absent `AURKA_*` deployment/wallet inputs; no remote run | **BLOCKED**                |
| AURKA-007 independent review               | Independent reviewer; AURKA-015                    | Review identity, independence statement, scope, dated findings, and verification                              | The repository review is an implementation self-review, not independent evidence                                                     | **BLOCKED**                |
| AURKA-008 dependency release gate          | AURKA-007 and release owner                        | AURKA-008 unchecked dependency item; SDK/app local checks                                                     | SDK and apps pass locally, but live/review dependency remains open                                                                   | **BLOCKED**                |
| AURKA-009 signed local settlement          | AURKA-009 / AURKA-014                              | `pnpm integration:local-settlement` and `packages/services/scripts/local-settlement-e2e.mjs`                  | Anvil `31337`; 3 indexed receipt events, restart/replay projection, and six rejection cases passed                                   | PASS (local)               |
| AURKA-011 actual indexing                  | AURKA-011 / AURKA-014                              | `pnpm integration:graph-node`; `packages/services/scripts/local-graph-node-e2e.mjs`                           | Disposable Graph Node stack; deployment/query, pagination, finality/lag, and orphan replacement passed                               | PASS (local)               |
| AURKA-013 measured readiness               | AURKA-013 / AURKA-014                              | `packages/services/test/readiness.test.ts`; Docker body-based `/ready` check                                  | Fixture container returned `ok=true`, `status=ready`; failure/recovery diagnostics covered in tests                                  | PASS (fixture/local)       |
| AURKA-014 browser and workflow gates       | AURKA-014                                          | `pnpm integration:browser-smoke`; `.github/workflows/integration.yml`                                         | 16 desktop/mobile route checks plus quote/solve/external-signature/unsigned-tx/error checks passed                                   | PASS (local)               |
| AURKA-015 final release decision           | AURKA-015                                          | This packet and the task report                                                                               | Residual risks and owners are named; external gates remain explicitly open                                                           | PASS (reconciliation only) |

## Changes since the 2026-09-06 review

The current task reports record the following local corrections, all covered by
the fresh matrix below: shared SDK envelope/error handling; proxy and port
alignment; authoritative intent preparation; UI unavailable/error states;
persisted risk cooldown and quorum fail-safe behavior; canonical evaluator use;
effective-vs-proposed risk separation; native Privy request/response handling;
durable worker lease/receipt/reorg handling; Graph AssemblyScript mapping and
schema-compatible observation queries; readiness diagnostics; and deterministic
CI, browser, settlement, and Graph Node runners.

Those corrections resolve local implementation findings. They do not constitute
independent security, custody, live deployment, or protected-environment
evidence.

## Fresh local validation

Commands were run on the tested checkout identified above. Exit status was zero
unless explicitly noted.

| Check                                                                           | Result                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --ignore-scripts=false`                         | PASS; lockfile current                                                                               |
| `pnpm build`                                                                    | PASS; all workspace packages and both applications built                                             |
| `pnpm typecheck`                                                                | PASS; all workspace packages and both applications                                                   |
| `pnpm lint` / `pnpm format:check` / `git diff --check`                          | PASS                                                                                                 |
| `pnpm test`                                                                     | PASS; 112 TypeScript tests: shared 50, services 44, watchtower 5, Graph 7, wallet 3, SDK 3           |
| `forge fmt --check && forge build --sizes && forge snapshot --check`            | PASS; router runtime `24,492` bytes, only `84` bytes below EIP-170                                   |
| `forge test -vvv`                                                               | PASS; 116 Solidity tests, 0 failed; fuzz runs 514 and invariants 128 × 8,192 calls                   |
| `pnpm --filter @aurka/graph subgraph:build`                                     | PASS; codegen and WASM mapping compilation                                                           |
| `docker compose -f docker-compose.services.yml config --quiet`                  | PASS                                                                                                 |
| `docker build -f packages/services/Dockerfile -t aurka-services:task015 .`      | PASS; legacy Docker builder warning only                                                             |
| disposable `aurka-services:task015` container + `/ready` body and Docker health | PASS; fixture mode returned `ok=true`, `status=ready`; Docker health `healthy`; container removed    |
| `pnpm integration:local-settlement`                                             | PASS; signed local execution, event projection, replay/restart and six rejection cases               |
| `pnpm integration:graph-node`                                                   | PASS; Graph Node `v0.41.2`, two paginated observations, lag/finality rejection and reorg replacement |
| `pnpm integration:browser-smoke`                                                | PASS; 16 route/viewport checks and settlement-preparation/error checks                               |
| `node packages/services/scripts/protected-smoke.mjs` with no external inputs    | Expected BLOCKED; missing RPC, contract, Graph, wallet-policy and wallet identifiers                 |

Foundry emitted non-fatal target-discovery and stale invariant-cache warnings;
the test and snapshot commands still exited successfully. Build output also
contains known Rollup annotation and Node experimental-module warnings.

## Operational recovery evidence

Local tests and integration runners cover wrong-chain and stale/finalized RPC,
source failure/staleness, insufficient risk quorum, persisted cooldown across
restart, revoked/expired signer, stalled worker and reclaimed lease, receipt
loss, reorg downgrade/replacement, duplicate event replay, stale settlement
commitments, modified signatures, expired intents, and Docker readiness
recovery. These are deterministic doubles/local infrastructure scenarios.

Not evidenced: recovery of a real Graph deployment, a real RPC reorg, a real
Privy signer/policy, a production certificate submission, or a live settlement.

## Handoff and owners

1. Product/governance must select the target chain, contracts, DEX/pools, hard
   bounds, quorum and finality budgets.
2. Infrastructure must deploy/verify the selected contracts and Graph source,
   provide canonical/finalized RPC and Graph deployment evidence, and configure
   the protected GitHub environment with required reviewers.
3. Custody must provision separate execution/risk wallets and default-deny
   policies, then supply only non-secret IDs/fingerprints for read-only smoke.
4. An independent reviewer must record identity/independence, scope, dated
   findings and verification of any fixes. Security/custody findings must return
   for reviewer verification; this task cannot self-close them.
5. After those artifacts exist, rerun the protected read-only smoke, record the
   exact workflow run and artifacts, run any separately approved write smoke,
   and update this decision. Deployment remains a separate authorized action.

Until then AURKA-005, AURKA-007, AURKA-008, and AURKA-015 remain blocked where
their records say so. No unsupported completion claim is made.
