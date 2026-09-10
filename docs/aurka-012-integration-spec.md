# AURKA-012 integration target and wallet-policy specification

Decision record date: 2026-09-07  
Decision state: candidate proposal for public/production rollout; no public
network deployment, pool, Graph deployment, Privy wallet, or Privy policy is
selected, approved, or verified. TASK99-006 separately verifies an isolated
Ethereum-mainnet fork release candidate; that local selection is reconciled
below and is not a public deployment decision.

TASK99-008 records a separate delegated-wallet implementation decision, not a
new public deployment selection. Its Privy owner/additional-signer arrangement
and policy template are operator inputs pending real read-back. The local Anvil
chain `31337` is not reported as reachable by Privy's hosted broadcaster;
custom-network compatibility, remote policy denial, funding, and receipt proof
remain open.

This document is the handoff artifact for AURKA-014 and AURKA-015. It records
what can be proposed from primary evidence and what still requires an explicit
operator or governance decision. The fixture configuration is intentionally
separate from this proposal and is not a production deployment.

## TASK99-006 reconciliation

The local release candidate selected for TASK99-006 is Ethereum mainnet fork
block `25,500,000`, presented to the app as Anvil chain `31337`. At that pinned
block the runner verifies bytecode for real 1inch Aqua, mainnet USDC/WETH, and
Chainlink ETH/USD and USDC/USD feeds, then reads the feeds through the local
`ChainlinkPriceOracle` adapter. The release path uses AURKA's narrow
`AURKA_DIRECT_PAIR_V1` adapter; it does not claim or invoke the upstream SwapVM
router. A disposable Graph Node stack indexes the same fork RPC and the app
reads confirmed Activity from that GraphQL endpoint.

The exact addresses, runtime hashes, price rounds, Graph deployment identity,
receipt identities, and wallet-journey counts are recorded in
[`docs/evidence/task99-006-real-release-summary.json`](evidence/task99-006-real-release-summary.json)
and the reproducible command is `pnpm integration:fork-real`. This resolves the
local real-integration acceptance gap only. Public deployment, live Privy
custody, an external audit, and competitive DEX-price claims remain separate
gates.

## State vocabulary and current outcome

- Candidate: supported by the cited upstream source, but not chosen for AURKA.
- Selected: chosen by the product/governance owner and recorded with a change
  reference. No live target has this state.
- Approved: the owner has approved exact addresses, hashes, pools, limits, and
  policies for provisioning. No live target has this state.
- Verified: read back from the target chain/Graph/Privy resource and matched to
  the approved record. No live target has this state.
- Fixture-selected: the deterministic compatibility state; it is Anvil/Foundry
  chain `31337`, with generated addresses and fixture observations.
- Local-real-selected: the completed TASK99-006 state; it is an isolated Anvil
  presentation of Ethereum mainnet fork block `25,500,000`, with actual Aqua,
  token, and Chainlink feed identities verified at that snapshot. It is not a
  public or production deployment.

The current recommendation is to investigate Base first for a live pilot, with
Ethereum Mainnet as the conservative reference candidate. This is a proposal,
not user selection. AURKA-014 must not run a protected live smoke until the
missing inputs below are supplied and independently approved.

## Required input register

| Input                  | Required value                                                                                     | State / owner                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Network                | One chain and numeric EVM chain ID                                                                 | Missing; product/governance                 |
| RPC                    | Server-only HTTPS RPC with historical block hashes and a proven `finalized` or `safe` boundary     | Missing; infrastructure                     |
| AURKA policy registry  | Deployed `AurkaPolicyRegistry` address and runtime bytecode hash                                   | Missing; deployment owner                   |
| AURKA risk registry    | Deployed `RiskModeRegistry` address, runtime bytecode hash, and `policyRegistry()` pointer         | Missing; deployment owner                   |
| AURKA router           | Deployed `AurkaSwapVMRouter` address and constructor-bound policy/risk/Aqua/SwapVM addresses       | Missing; deployment owner                   |
| Aqua / SwapVM          | Chain-specific code hashes and exact compatible versions                                           | Reference candidates only; deployment owner |
| Oracle                 | Address, decimals, snapshot ID format, update cadence, price-age and deviation limits              | Missing; risk/governance                    |
| AURKA Graph deployment | Deployment ID, endpoint, schema version, query version, start block                                | Missing; indexer owner                      |
| DEX source             | Uniswap v4 deployment ID, endpoint, schema/query versions, bytes32 pool ID, pool pair and decimals | Missing; market-data owner                  |
| Source quorum          | Independent operators/endpoints, source failure policy, trigger and recovery quorum                | Proposed below; risk committee approval     |
| Policy records         | Position/policy IDs, approved config and hard-bound hashes                                         | Missing; governance                         |
| Privy resources        | Wallet IDs, signer addresses, owner/key-quorum arrangement, policy IDs/fingerprints and expiry     | Missing; custody owner                      |
| Smoke environment      | Protected environment, funded test wallet, finality wait, incident contact and rollback authority  | Missing; operations                         |

No placeholder in
[`risk-runtime.config.template.env`](./examples/risk-runtime.config.template.env)
is a valid address, wallet ID, secret, or endpoint. The template must not be
loaded until every `__MISSING_*__` value has been replaced and the resulting
JSON passes `parseRiskRuntimeConfig`.

## Candidate target matrix

The Aqua and SwapVM addresses in this table are upstream reference addresses,
not proof of an AURKA-compatible deployment. The custom AURKA registries/router
and the oracle are not deployed by this task.

| Candidate        | Chain ID / Graph identifier | Protocol and DEX evidence                                                                                                     | AURKA compatibility status                                                                       | Graph, pool and finality gate                                                                                             | Access requirement                                                         |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Anvil fixture    | `31337` / local only        | Local `MockAqua`, `AurkaDirectSwapVM`, and the checked-in fixture; no upstream deployment claim                               | Fixture-selected and locally buildable; runtime addresses are generated per run                  | Fixture history only; local RPC boundary is test evidence, not production finality                                        | Loopback RPC and fixture Graph transport; no credentials                   |
| Ethereum Mainnet | `1` / `mainnet`             | Aqua and SwapVM list Ethereum; Uniswap v4 `PoolManager` `0x000000000004444c5dc75cB358380D2e3dE08A90`, start block `21688329`  | Aqua/SwapVM references are candidates; AURKA registries/router/oracle missing                    | Official Graph network is supported. AURKA and DEX deployment IDs, pool history, and RPC finalized-boundary proof missing | Graph gateway API key, server-only archive/finality-capable RPC            |
| Base Mainnet     | `8453` / `base`             | Aqua and SwapVM list Base; Uniswap v4 `PoolManager` `0x498581fF718922c3f8e6A244956aF099B2652b2b`, start block `25350988`      | Same missing AURKA deployment and oracle checks                                                  | Official Graph network is supported. Pool ID/history and AURKA subgraph deployment missing                                | Graph gateway API key, server-only historical/finality-capable RPC         |
| Arbitrum One     | `42161` / `arbitrum-one`    | Aqua and SwapVM list Arbitrum; Uniswap v4 `PoolManager` `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`, start block `297842872` | Same missing AURKA deployment and oracle checks; L2 finality semantics need chain-specific proof | Official Graph network is supported. Pool ID/history and AURKA subgraph deployment missing                                | Graph gateway API key, Arbitrum RPC with explicit safe/finalized semantics |
| OP Mainnet       | `10` / `optimism`           | Aqua and SwapVM list Optimism; Uniswap v4 `PoolManager` `0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3`, start block `130947675` | Same missing AURKA deployment and oracle checks; L2 finality semantics need chain-specific proof | Official Graph network is supported. Pool ID/history and AURKA subgraph deployment missing                                | Graph gateway API key, OP RPC with explicit safe/finalized semantics       |

The common upstream reference addresses currently documented by 1inch are:

```text
Aqua registry:  0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
SwapVM router:  0x111111338c5091e8440b67b168bae16a668ac0de
```

Before using either address, the operator must read `eth_getCode`, compare the
runtime bytecode to a pinned upstream artifact, and check the contract's
reported configuration. The local AURKA router is a different contract and must
never be replaced by the upstream SwapVM router merely because the address is
published. The local direct program is `AURKA_DIRECT_PAIR_V1`; the upstream SDK
documents that current Aqua routers support only the Aqua instruction set.

### Compatibility evidence and limitations

- The official 1inch Aqua README describes `ship`, `dock`, `pull`, and `push`,
  and the selected contract returns the exact strategy-byte hash
  `keccak256(strategy)`. Those are the surfaces represented by the local `IAqua`
  boundary.
- The official SwapVM SDK constants and repository list the common router
  address and supported networks. They do not prove that an AURKA custom router,
  oracle, policy registry, or risk registry exists at those addresses.
- The official Uniswap v4 repository publishes network-specific
  `PoolManager`/`PositionManager` addresses and start blocks in `networks.json`.
  It does not supply an AURKA source deployment ID or a pool selection for this
  project. A pool's historical liquidity and volume must be queried only after
  its exact bytes32 pool ID and endpoint are approved.
- The Graph's network pages establish chain identifiers and network support,
  while GraphQL `_meta` plus an RPC-proven canonical block establish the runtime
  check. A Graph response alone is not finality evidence.
- The AURKA-010 runtime requires one `deploymentId` for every source attached to
  a position. Until that contract is intentionally extended, independent quorum
  members must be independent operators/endpoints serving the same approved
  deployment; two metrics, two queries, or two pages from one source are not
  independent evidence.

Primary sources were checked on 2026-09-07:

- [1inch Aqua README and deployments](https://github.com/1inch/aqua) — current
  Aqua/SwapVM references, network list, and interface behavior.
- [1inch SwapVM README](https://github.com/1inch/swap-vm) and
  [SwapVM SDK contract constants](https://github.com/1inch/sdks/blob/master/typescript/swap-vm/src/swap-vm-contract/constants.ts)
  — router address, supported networks, and Aqua-only instruction warning.
- [Uniswap v4 subgraph networks](https://raw.githubusercontent.com/Uniswap/v4-subgraph/main/networks.json)
  and [schema](https://github.com/Uniswap/v4-subgraph/blob/main/schema.graphql)
  — deployment addresses/start blocks and `PoolHourData` fields.
- The Graph
  [supported networks](https://thegraph.com/docs/en/supported-networks/),
  [Ethereum](https://thegraph.com/docs/en/supported-networks/mainnet/),
  [Base](https://thegraph.com/docs/en/supported-networks/base/),
  [Arbitrum One](https://thegraph.com/docs/en/supported-networks/arbitrum-one/),
  and [OP Mainnet](https://thegraph.com/docs/en/supported-networks/optimism/)
  pages — chain IDs and Graph network support.
- The Graph
  [GraphQL API](https://thegraph.com/docs/en/subgraphs/querying/graphql-api/),
  [gateway query guidance](https://thegraph.com/docs/en/gateways/subgraphs/consumer-side/serving-queries/),
  and
  [API-key guidance](https://thegraph.com/docs/en/subgraphs/providers/subgraph-studio/managing-api-keys/)
  — query and access boundaries.
- Privy [policy overview](https://docs.privy.io/controls/policies/overview),
  [Ethereum policy examples](https://docs.privy.io/controls/policies/example-policies/ethereum),
  [typed-data RPC](https://docs.privy.io/api-reference/wallets/ethereum/eth-signtypeddata-v4),
  [transaction RPC](https://docs.privy.io/api-reference/wallets/ethereum/eth-send-transaction),
  [authorization signatures](https://docs.privy.io/api-reference/authorization-signatures),
  and
  [owner/signer permissions](https://docs.privy.io/controls/authorization-keys/owners/overview)
  — policy syntax, owner boundaries, request shape, and response behavior.

## Source independence and calibration proposal

The proposed live configuration uses integer values only. It is a calibration
starting point for governance review, not an approved threshold set.

| Signal              | Sign and integer unit                                                                           | Observation window / sample                                                                                   | Freshness and lag                                                                                     | Missing or invalid data                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `DEX_LIQUIDITY`     | Signed basis points: `(current - previous) * 10000 / previous`; negative means decline          | Two consecutive completed one-hour `PoolHourData` records; `sampleSize` is the current hour transaction count | Proposed `maxObservationAgeSeconds=7200`; exact chain-specific lag is pending RPC/indexer measurement | Reject zero baseline, missing hour, nonconsecutive hour, stale row, bad metadata, or bad block hash |
| `DEX_VOLUME`        | Nonnegative USD micro-units, truncated to six decimals; positive means more volume              | One completed hour; `sampleSize` is the current hour transaction count                                        | Same proposed two-hour freshness budget and measured lag gate                                         | Reject malformed decimal, missing hour, stale row, bad metadata, or bad block hash                  |
| `DIRECTIONAL_FLOW`  | Signed USD micro-units; positive must mean net outflow from the managed portfolio               | Proposed one-hour window; sample is count of included finalized transfers/swaps                               | Configuration must bind source query version and lag budget                                           | Missing source is a failure, not zero flow; no live adapter is selected                             |
| `AURKA_EXECUTIONS`  | Nonnegative finalized execution count                                                           | Proposed one-hour window; sample is included event count                                                      | Same source and RPC finality check                                                                    | Missing indexer data fails safe; no live adapter is selected                                        |
| `AURKA_REVERTS`     | Nonnegative finalized revert count                                                              | Proposed one-hour window; sample is included event count                                                      | Same source and RPC finality check                                                                    | Missing indexer data fails safe; no live adapter is selected                                        |
| `BOUNDARY_PRESSURE` | Signed basis points of worst bound excess; positive means pressure beyond the governed boundary | Proposed one-hour window; sample is included portfolio snapshots                                              | Must be calculated from the approved policy/order and finalized block                                 | No snapshot or stale policy state fails safe; no live adapter is selected                           |

The checked-in Uniswap adapter implements only the first two rows. Its schema
version and query version must be recorded per source. In particular, the
absolute volume metric must not be described as a low-volume signal: a
low-volume trigger needs a separately versioned signed-baseline adapter.

### Proposed starting configuration and replay vectors

For a two-member independent source set, propose `requiredQuorum=2`,
`recoveryQuorum=2`, `failSafeMode=CAUTIOUS`, and a 30-minute recovery cooldown.
Use `minimumSampleSize` and exact lag/age budgets only after inspecting a
calibration export; `20` samples and `7200` seconds are illustrative review
values, not approvals. The hard cap and bound sets are always read from the
approved onchain policy; the watchtower may only select pre-approved tighter
sets. `hashActiveBounds` and `hashRiskConfiguration` are the commitments, not
human-readable labels.

Illustrative liquidity replay with two valid independent sources and a
governance-approved threshold set:

| Metric            |   Threshold | Result at `threshold - 1`, exact, `threshold + 1` |
| ----------------- | ----------: | ------------------------------------------------- |
| Liquidity caution | `-1000` bps | no caution, `CAUTIOUS`, `CAUTIOUS`                |
| Liquidity shock   | `-2000` bps | no shock, `SHOCK`, `SHOCK`                        |
| Liquidity pause   | `-3000` bps | no pause, `PAUSED`, `PAUSED`                      |

Negative thresholds use `metric <= threshold`; nonnegative thresholds use
`metric >= threshold`. A threshold hit by only one source does not trigger that
mode at quorum two. The same two sources reporting both liquidity and volume
remain two sources, not four. Recovery requires every required signal/source to
have valid fresh evidence, the recovery quorum, and the persisted cooldown;
omitting the client-supplied state cannot bypass it.

Failure vectors that must remain fail-safe:

1. One of two required endpoints times out: `sourceFailures` is non-empty and
   the evaluator returns `CAUTIOUS` (or the approved `PAUSED` fail-safe), never
   unrestricted `NORMAL`.
2. One row is one block beyond the approved finality boundary or its canonical
   hash changes: that row is invalid and cannot count toward recovery.
3. A policy nonce, hard-bound hash, or authorization epoch changes between
   evaluation and signing: the worker discards the certificate and re-reads
   state.
4. A certificate expires or its watchtower is revoked: effective state comes
   from the registry and falls back to the hard policy; stored signed data is
   not reported as effective.

## Wallet policy specification

There are two distinct policies, two signer roles, and two separate wallet
resources. The execution signer may submit only a previously validated router
execution. The risk signer may sign/submit only a risk certificate. Owners or an
approved key quorum retain policy, signer, export, pause, and rotation
authority. The agents are additional signers with scoped policies.

The local `WalletPolicy` model in `packages/wallet/src/index.ts` is not a Privy
policy JSON. It is a local second boundary. Its generated fingerprints,
`allowedMethods`, selector `0xd93c3663` (`execute`) and selector `0x6ffaee92`
(`submitRiskCertificate`) must be derived from the pinned ABI. Local simulation
uses a separate canonical RPC; `eth_call` is not a Privy policy permission in
this specification.

### Enforceable boundaries

| Control                       | Privy policy                                                                              | Local AURKA adapter                                                              | Onchain registry                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Chain and target              | `ethereum_transaction.chain_id`, `to`; typed-data `chainId`, `verifyingContract`          | Re-checks chain ID, target and canonical calldata                                | EIP-712 domain binds chain and registry address              |
| Method and selector           | `eth_sendTransaction`, `eth_signTypedData_v4`, `ethereum_calldata.function_name` with ABI | Exact selector, ABI decode/re-encode, role and operation                         | Only exposed registry/router functions and signature checks  |
| Assets, amounts, native value | Static allowlists/caps through transaction/calldata conditions and condition sets         | Decoded token allowlist, per-call amounts, value and hard-cap checks             | Router/policy accounting and hard policy                     |
| Bounds commitment             | Typed-data `activeBoundsHash` can be restricted to approved hash values                   | Exact `hashActiveBounds`, feasibility, approved hash list                        | Exact ABI hash and no widening versus hard bounds            |
| Time                          | System time and typed message `expiresAt` upper bound                                     | Policy/action/certificate validity and current time                              | Certificate expiry and `block.timestamp`                     |
| Authority / nonce / epochs    | Not dynamically tied to AURKA state                                                       | Fresh policy, registry, signer and authority reads before/after signing and send | Policy nonce, watchtower epoch, sequential certificate nonce |
| Evidence / finality           | Not expressible                                                                           | Graph provenance, source digest, finality, canonical block/hash                  | Not an oracle or finality authority                          |
| Governance/admin              | Omitted methods/targets default deny; no wildcard allow                                   | Role and target/selector checks                                                  | Governance-only functions enforce `msg.sender`               |

Privy policies default to deny when no rule matches and deny rules take
precedence. Do not add a wildcard `ALLOW`. A broad wildcard `DENY` can also
shadow intended allow rules, so explicit allow rules plus omitted actions are
preferred. Key export, wallet/policy updates, signer changes, arbitrary
transfers, approvals, delegate calls, `personal_sign`, raw signing, and all
unknown methods are excluded.

### Execution policy (submit only `execute`)

Create one policy per chain and reviewed execution scope. The following is the
actual Privy rule shape; angle-bracket values are explicit missing inputs and
the ABI value must be the complete JSON function entry generated from
`packages/wallet/src/routerAbi.ts`, not a hand-shortened ABI.

```json
{
  "version": "1.0",
  "name": "AURKA execution <MISSING_CHAIN> <MISSING_REVISION>",
  "chain_type": "ethereum",
  "rules": [
    {
      "name": "Allow AURKA execute on the selected chain",
      "method": "eth_sendTransaction",
      "action": "ALLOW",
      "conditions": [
        {
          "field_source": "ethereum_transaction",
          "field": "chain_id",
          "operator": "eq",
          "value": "<MISSING_CHAIN_ID>"
        },
        {
          "field_source": "ethereum_transaction",
          "field": "to",
          "operator": "eq",
          "value": "<MISSING_AURKA_ROUTER_ADDRESS>"
        },
        {
          "field_source": "ethereum_transaction",
          "field": "value",
          "operator": "eq",
          "value": "0x0"
        },
        {
          "field_source": "ethereum_calldata",
          "field": "function_name",
          "abi": "<MISSING_COMPLETE_EXECUTE_FUNCTION_ABI_JSON>",
          "operator": "eq",
          "value": "execute"
        }
      ]
    }
  ]
}
```

The approved condition-set values, or equivalent explicit `in` conditions, must
contain only the reviewed input/output/fee assets. The rules must also cap every
decoded token amount at the approved execution ceiling and keep
`intent.policyId`, `intent.deadline`, `proposal.deadline`, and the direct
program within the reviewed position. If Privy cannot decode a nested tuple
field in the submitted rule, leave that constraint to the local adapter and do
not broaden the remote rule; the local adapter must reject before calling Privy.
The router selector and the full tuple re-encoding remain mandatory in both
layers.

### Risk policy (sign and submit only certificates)

The risk policy has a fixed EIP-712 domain and a fixed policy ID. It allows
typed-data signing only for `RiskCertificate`, then allows a transaction only to
the risk registry and only for `submitRiskCertificate`. The message conditions
below are supported Privy typed-data condition fields; hash values, cap, policy
ID, and expiry remain unresolved until governance approval.

```json
{
  "version": "1.0",
  "name": "AURKA risk <MISSING_CHAIN> <MISSING_REVISION>",
  "chain_type": "ethereum",
  "rules": [
    {
      "name": "Allow the AURKA risk domain",
      "method": "eth_signTypedData_v4",
      "action": "ALLOW",
      "conditions": [
        {
          "field_source": "ethereum_typed_data_domain",
          "field": "name",
          "operator": "eq",
          "value": "AURKA RiskModeRegistry"
        },
        {
          "field_source": "ethereum_typed_data_domain",
          "field": "version",
          "operator": "eq",
          "value": "2"
        },
        {
          "field_source": "ethereum_typed_data_domain",
          "field": "chainId",
          "operator": "eq",
          "value": "<MISSING_CHAIN_ID>"
        },
        {
          "field_source": "ethereum_typed_data_domain",
          "field": "verifyingContract",
          "operator": "eq",
          "value": "<MISSING_RISK_REGISTRY_ADDRESS>"
        },
        {
          "field_source": "ethereum_typed_data_message",
          "field": "policyId",
          "operator": "eq",
          "value": "<MISSING_POLICY_ID>",
          "typed_data": {
            "types": {
              "RiskCertificate": [
                { "name": "policyId", "type": "bytes32" },
                { "name": "riskMode", "type": "uint8" },
                { "name": "activeBoundsHash", "type": "bytes32" },
                { "name": "maximumTradeValue", "type": "uint256" },
                { "name": "sourceDigest", "type": "bytes32" },
                { "name": "reasonCode", "type": "bytes32" },
                { "name": "issuedAt", "type": "uint64" },
                { "name": "expiresAt", "type": "uint64" },
                { "name": "nonce", "type": "uint256" },
                { "name": "watchtower", "type": "address" },
                { "name": "watchtowerAuthorizationEpoch", "type": "uint256" },
                { "name": "policyNonce", "type": "uint256" }
              ]
            },
            "primary_type": "RiskCertificate"
          }
        },
        {
          "field_source": "ethereum_typed_data_message",
          "field": "activeBoundsHash",
          "operator": "in",
          "value": ["<MISSING_APPROVED_BOUNDS_HASH>"],
          "typed_data": {
            "types": {
              "RiskCertificate": [
                { "name": "policyId", "type": "bytes32" },
                { "name": "riskMode", "type": "uint8" },
                { "name": "activeBoundsHash", "type": "bytes32" },
                { "name": "maximumTradeValue", "type": "uint256" },
                { "name": "sourceDigest", "type": "bytes32" },
                { "name": "reasonCode", "type": "bytes32" },
                { "name": "issuedAt", "type": "uint64" },
                { "name": "expiresAt", "type": "uint64" },
                { "name": "nonce", "type": "uint256" },
                { "name": "watchtower", "type": "address" },
                { "name": "watchtowerAuthorizationEpoch", "type": "uint256" },
                { "name": "policyNonce", "type": "uint256" }
              ]
            },
            "primary_type": "RiskCertificate"
          }
        }
      ]
    },
    {
      "name": "Allow certificate submission to the AURKA risk registry",
      "method": "eth_sendTransaction",
      "action": "ALLOW",
      "conditions": [
        {
          "field_source": "ethereum_transaction",
          "field": "chain_id",
          "operator": "eq",
          "value": "<MISSING_CHAIN_ID>"
        },
        {
          "field_source": "ethereum_transaction",
          "field": "to",
          "operator": "eq",
          "value": "<MISSING_RISK_REGISTRY_ADDRESS>"
        },
        {
          "field_source": "ethereum_transaction",
          "field": "value",
          "operator": "eq",
          "value": "0x0"
        },
        {
          "field_source": "ethereum_calldata",
          "field": "function_name",
          "abi": "<MISSING_COMPLETE_SUBMIT_RISK_CERTIFICATE_FUNCTION_ABI_JSON>",
          "operator": "eq",
          "value": "submitRiskCertificate"
        }
      ]
    }
  ]
}
```

Before provisioning, expand the approved hash `in` list to exactly the
governance-approved bound hashes and add typed-data conditions for the approved
maximum cap and signer expiry. Privy cannot compare the bounds array to the live
policy, recompute the source digest, verify a watchtower authorization epoch, or
prove the risk mode is a tightening relative to the onchain hard policy. Those
checks remain mandatory in the local adapter and registry.

### Local policy records

For the selected fixture/live scope, the local records use:

```text
Execution role: allowedMethods = ["eth_call", "eth_sendTransaction"]
                 allowedSelectors = ["0xd93c3663"]
Risk role:      allowedMethods = ["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"]
                 allowedSelectors = ["0x6ffaee92"]
```

The local `calldataRules` are populated according to the adapter's generated ABI
layout handling; an empty remote rule list is never a reason to skip the
adapter's exact decode, asset, amount, cap, authority, expiry, signature, and
simulation checks. Policy fingerprints are recorded after creation and are
re-read before and after each mutable operation.

## Provisioning and verification runbook

This is a proposed protected runbook. It is not authorization to execute any
remote action. The words “create”, “attach”, and “send” below refer to the
future approved environment only.

### Prepare the approval packet

1. Select one candidate row and record a change ID, numeric chain ID, RPC
   provider, finality method, and finality freshness/lag budgets.
2. Deploy or identify the three AURKA contracts with the audited local artifact
   versions. Record addresses, runtime bytecode hashes, constructor arguments,
   `riskRegistry.policyRegistry()`, router immutables, and oracle configuration.
3. Select the AURKA Graph deployment and two independent serving endpoints.
   Record deployment ID, schema/query versions, mapping start block, indexing
   status, error state, and a saved query response containing `_meta`.
4. Select the DEX deployment and one exact bytes32 pool ID only after checking
   token addresses, decimals, consecutive completed-hour history, minimum sample
   size, stale data behavior, and the approved metric units.
5. Export a calibration window with at least the approved sample size. Have the
   risk committee approve threshold, quorum, fail-safe, recovery, cooldown,
   hard-cap, and bound-set values. Compute and record `hashRiskConfiguration`
   and `hashActiveBounds`.
6. Record the Privy owner/key-quorum, separate execution/risk signer addresses,
   policy references, validity windows, condition-set IDs, and expected
   fingerprints. Keep app secrets and authorization keys in the runtime secret
   store only.

### Provision in the protected environment

1. Create/update the two Privy policies with the exact JSON shapes above. Use
   `eth_signTypedData_v4` and `eth_sendTransaction` only. Do not enable
   wildcard, raw signing, `personal_sign`, transfers, approvals, governance
   selectors, export, policy, owner, signer, or wallet-management actions.
2. Attach each additional signer to only its role policy. Have the owner/key
   quorum authorize the policy and signer changes. Save the returned policy
   metadata and fingerprint in the approval packet.
3. Configure AURKA-010 through the non-secret environment template. Keep
   `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, Graph API keys, and authorization-key
   material outside the file and inject them at runtime.
4. Start the server-only runtime module. Verify its RPC chain, registry pointer,
   policy nonce, hard bounds hash, watchtower authorization/epoch, signer
   status, Graph deployment and finality boundary before enabling the worker.

### Verify before any broadcast

1. Read back every address and code hash from RPC at the same canonical
   boundary. Fail on any mismatch, missing code, stale block, or unknown oracle.
2. Query both Graph endpoints at the explicit finalized block. Require matching
   deployment/schema/query identity, no indexing errors, canonical metadata,
   valid row hashes, and the approved observation units. Check that the two
   endpoints are genuinely independent operators, not two URLs for one backend.
3. Run the deterministic replay vectors and a negative vector for each policy
   boundary: wrong chain, target, selector, asset, amount, value, expiry, policy
   ID, bounds hash, nonce, epoch, signer, and arbitrary calldata.
4. Generate one certificate from current canonical state. Recover its signer,
   compare the domain and all authority fields, and run `eth_call` through the
   separate RPC. A successful simulation is not proof of finality.
5. If the approval explicitly includes a live smoke, submit exactly one
   low-capacity test certificate with the risk signer, wait for the chain's
   approved finality boundary, verify the receipt and `RiskModeChanged` event,
   and read `currentRiskMode`, effective cap, and effective bounds back from the
   registry. Store the transaction and block evidence. Do not execute a trade in
   this task.
6. Revoke the test signer or disable the test policy as approved, verify the
   registry's effective fallback after revocation/expiry, and record the result.

### Rollback, revocation, and rotation

- If any preflight check fails, stop the worker and do not broadcast. Restore
  only local configuration to the last approved version; do not delete database
  workflow state.
- For a live incident, the human governance owner pauses the AURKA policy and/or
  calls `RiskModeRegistry.setWatchtower(policyId, watchtower, false)` from the
  governance authority. The operator then confirms `isRiskActive`/effective
  reads at a canonical finalized block.
- In Privy, revoke or pause the affected additional signer policy. Owners/key
  quorums, not the signer, perform policy/signer changes. Verify the policy
  fingerprint and signer status are disabled before restarting any worker.
- For rotation, revoke the old signer, increment/observe its authorization
  epoch, provision a replacement with the same or narrower policy, verify the
  new address and fingerprint, and discard all certificates from the old epoch.
- If a receipt is orphaned by a reorg, retain the outbox record, return the
  workflow to `SUBMITTED`, and retry the same idempotent request only after
  canonical state and nonce are re-read. Never mark a stored signed certificate
  effective without a finalized registry read.

## Handoff

AURKA-014 receives the selected chain, exact contract addresses and hashes,
Graph deployment/pool/query records, policy fingerprints, protected smoke
environment, and the final replay output. AURKA-015 receives the approval packet
and must obtain independent review; this document and local fake/fixture tests
do not satisfy that gate. Until those inputs exist, the live acceptance items
for AURKA-007 remain open.
