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

To wire a deployment, provide an operator-owned server module via
`RISK_RUNTIME_MODULE=/absolute/path/runtime.mjs`. It must export
`async createRiskRuntime(service)` returning
`{worker, positions, readRisk?, riskRegistry?}`. Construct the worker with the
service repository/risk service, the configured wallet, request-specific
`authorize` callback, and trusted `RiskWorkerSources` implementations for
context, evaluation, receipts, canonical hashes and finality. `readRisk` can be
created with
`createRegistryRiskReader({rpc, chainId, registry, policyRegistry, maximumAgeSeconds})`.
The two registry addresses are distinct configuration.

The source callbacks must read current chain/policy/watchtower authority and
assemble evaluations from approved Graph sources and versioned configuration.
The wallet requires a live `refreshPolicy` callback and `readRiskAuthority`
callback; neither may accept browser-provided authority. Its RPC adapter uses
`request(method, params)` while service transports use
`request({method, params})`; explicitly bridge these signatures. The runtime
module must arrange its dependencies, including `@aurka/graph` if used; the
stock Docker image runs the local service and does not package an operator
runtime or production Graph sources.

The default CLI starts no signing worker. No selected live deployment, deployed
subgraph, Privy policy provisioning, production runtime module, or live smoke
workflow is supplied by this local validation. Live readiness consequently
remains unverified. These are still required before Task 7 can be complete.
