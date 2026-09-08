# AURKA risk watchtower operations

Task 7 is fixture-only by default. The watchtower is a pure function over a
canonical observation set and versioned governance configuration. It has four
ordered modes: `NORMAL`, `CAUTIOUS`, `SHOCK`, and `PAUSED`. A valid decision can
only tighten the hard policy; `CAUTIOUS` and `SHOCK` use exactly 75% and 40% of
the hard transaction cap, floored in integer units, and `PAUSED` uses zero.

## Evidence and fail-safe behavior

Graph observations retain source/deployment/query provenance, payload hash,
observed/retrieved time, indexed block/hash, and finality. Before evaluation,
the source is compared with the configured canonical chain reader. Missing,
stale, future, lagging, unfinalized, wrong-chain, wrong-deployment, duplicate,
or reorged evidence is rejected. No invalid or insufficient evidence can earn
`NORMAL`; the configured fail-safe mode is selected and recovery requires the
larger recovery quorum plus the completed cooldown.

The source digest and ordered `keccak256(abi.encode(ActiveAssetBound[]))` hash
are persisted with every evaluation. The EIP-712 domain is
`AURKA RiskModeRegistry`, version `2`, and binds chain ID and registry address.
Immediately before signing/submission, operators must re-read policy nonce,
watchtower authorization epoch, certificate nonce, and registry address. A
changed value invalidates the pending certificate.

## Signer separation and rotation

The execution signer may call only approved router selectors and the risk signer
may submit only approved risk-registry certificates. Neither signer has owner,
governance, policy, signer-management, key-export, arbitrary-transfer,
delegate-call, or wildcard permissions. The local adapter validates the same
chain, target, selector, calldata layout, asset, cap, fingerprint, expiry,
pause, and revocation conditions before Privy RPC.

To rotate a signer, a human owner pauses the old policy, revokes the old signer,
increments the authorization epoch, provisions the replacement with the same or
narrower reviewed policy, and verifies a new policy fingerprint. Pending
certificates from the old epoch are discarded. Authorization private keys and
Privy app secrets are injected at runtime only and are never stored in the
database, fixtures, logs, browser, or CI artifacts.

## Jobs, incidents, and recovery

Evaluation and renewal jobs use deterministic IDs. A worker claims a queued job
transactionally, records attempts, and returns it to the queue after a
ten-second retry delay on failure. A worker restart therefore cannot duplicate a
completed evaluation or certificate. Receipt status, certificate expiry, signer
status, Graph freshness, RPC chain identity/lag, database connectivity, and job
state are operational diagnostics; Graph is not settlement or price authority.

If evidence is unavailable, keep the last effective tightening or enter the
configured fail-safe state and escalate. If a policy, registry, chain, signer,
nonce, epoch, or bounds hash changes during preflight, stop and re-evaluate. Any
live Graph/Privy smoke test or production transaction requires a protected,
human-approved environment and is not part of pull-request CI.

## Worker wiring and recovery — 2026-09-07

`RiskCertificateWorker` persists the signed certificate before sending, retries
the same calldata, and waits for a canonical finalized receipt before marking it
active. An orphaned receipt returns the workflow to `SUBMITTED`. Renewal uses
current authority/nonce and occurs near expiry. Jobs have 120-second reclaimable
leases and attempt fencing; the polling loop retries after ten seconds and waits
for an in-progress pass during shutdown. Wallet submission must preserve its
deterministic idempotency key when a send response is lost.

Migrations `0005_risk_states.sql` and `0006_risk_workflows.sql` persist recovery
state and the transaction lifecycle. Public proposal state and worker state are
separate. Configuration changes require an operator migration; never delete
worker state simply to bypass cooldown. A recorded signed certificate is not
proof of current onchain effect; use the effective registry read.

## Trusted runtime composition — AURKA-010

The reusable server composition lives in `packages/services/src/risk-runtime.ts`
and is exported as `@aurka/services/risk-runtime`. The default CLI still starts
no signing worker. An operator opts in with
`RISK_RUNTIME_MODULE=/absolute/path/runtime.mjs`; the module exports
`async createRiskRuntime(service)` and may delegate to
`createRiskRuntime(service)` from the built services package. This explicit hook
is the boundary that prevents an unrelated environment variable from starting a
signer.

The built-in composition reads these public deployment variables:

```text
RISK_CHAIN_ID
RISK_RPC_URL
RISK_POLICY_REGISTRY
RISK_RISK_REGISTRY
RISK_ROUTER
RISK_WALLET_ID
RISK_WALLET_POLICY_REFERENCE
RISK_FINALITY_MAX_AGE_SECONDS
RISK_POSITIONS_JSON
RISK_WALLET_POLICY_MODULE          # local operator module reference
RISK_AUTHORIZATION_MODULE          # local operator module reference
RISK_CERTIFICATE_LIFETIME_SECONDS  # optional
RISK_RENEWAL_LEAD_SECONDS          # optional
```

`RISK_POSITIONS_JSON` is an array of reviewed position records. Each record
binds `positionId`, `policyId`, `watchtower`, one `deploymentId`, the complete
versioned `configuration`, `approvedConfigurationHash`,
`approvedHardBoundsHash`, and one or more unique Graph source records. A source
specifies `sourceId`, `sourceKind`, endpoint, deployment ID, `schemaVersion`,
`queryVersion`, freshness/lag budgets, and an explicit bytes32 `poolId` for a
DEX source. `apiKeyEnv` names an environment variable; the key itself is never
placed in this JSON, source payload, database, or browser request. Hashes are
computed with the exported `hashRiskConfiguration` and shared `hashActiveBounds`
functions. All sources for one position intentionally share the configured
deployment because the evaluation request has one trusted deployment context.

The optional server-only policy module exports
`getWalletPolicy(walletId, reference)`. The authorization module exports
`authorize(request)` and returns `{signatures: string[]}`. With no injected test
wallet, the composition creates the pinned `@privy-io/node@0.34.0` adapter from
the standard Privy environment and refreshes policy/authority through the server
callbacks. It explicitly bridges Privy's positional `request(method, params)` to
the service transport's object-shaped request.

At composition and evaluation time the runtime checks the RPC chain ID, the risk
registry's policy-registry pointer, finalized-block age, policy nonce, hard
bounds, approved hashes, watchtower authorization/epoch, next certificate nonce,
signer status, source identity and Graph provenance. The worker repeats mutable
authority checks immediately before signing and submission. A source outage is
carried as `sourceFailures` into the evaluator and therefore selects the
configured fail-safe mode; it cannot silently become a `NORMAL` result. The
runtime returns the worker, configured positions, canonical `readRisk` reader,
registry address, sources and parsed configuration for diagnostics.

Deterministic local composition and lifecycle coverage is runnable with:

```bash
pnpm --filter @aurka/services test -- risk-runtime.test.ts
```

The test uses fake RPC/Graph transports and a local test key only. It covers
trigger, sign, submit, canonical receipt, effective read, renewal, reorg
recovery, revoked authorization and Graph outage fail-safe behavior. It is not
evidence for any live RPC, Graph deployment, Privy policy or production key.

The stock Docker image runs the local service and does not package an operator
runtime or production Graph sources. Selected live targets, source calibration,
Privy policy provisioning and protected smoke execution remain deployment work
for AURKA-012/013/014.

The default CLI starts no signing worker. No selected live deployment, deployed
subgraph, Privy policy provisioning, production runtime module, or live smoke
workflow is supplied by this local validation. Live readiness consequently
remains unverified.
