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
transactionally, records attempts, and returns it to the queue with bounded
backoff on failure. A worker restart therefore cannot duplicate a completed
evaluation or certificate. Receipt status, certificate expiry, signer status,
Graph freshness, RPC chain identity/lag, database connectivity, and job state
are operational diagnostics; Graph is not settlement or price authority.

If evidence is unavailable, keep the last effective tightening or enter the
configured fail-safe state and escalate. If a policy, registry, chain, signer,
nonce, epoch, or bounds hash changes during preflight, stop and re-evaluate. Any
live Graph/Privy smoke test or production transaction requires a protected,
human-approved environment and is not part of pull-request CI.
