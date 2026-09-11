# AURKA integration boundaries

Status: TASK99-013 real-fork SwapVM path is implemented and live-fork verified.
TASK99-006's prior direct-path release candidate remains a separate reference.
TASK99-009 configuration verification is blocked by missing Privy resource
inputs in this checkout. The fixture configuration remains an explicit
compatibility test path. The AURKA-012 candidate and policy decision record is
in [`aurka-012-integration-spec.md`](./aurka-012-integration-spec.md).

## Trade assistant result handling (TASK99-010)

The trade assistant is server-configured and its package start/migration
commands load the root `.env` when present. `POST /v1/agent/propose` returns a
typed clarification, read-only rules answer, unsupported-action guidance,
deterministic trade block, usable `READY` proposal, or safe `UNAVAILABLE` code.
Only `READY` proposals can enter browser wallet review or the delegated worker;
the latter never reserves a budget or signs for clarification, read-only, or
unavailable results. OpenRouter keys remain server-only, and provider response
bodies are not copied into API responses or logs.

## TASK99-013 selected real-fork SwapVM path

The task-specific runner is `pnpm integration:fork-swapvm`. It starts an
isolated Ethereum mainnet fork, deploys the pinned official-derived
`AurkaUpstreamAquaSwapVMRouter` with the real Aqua app, creates two
independently custom-funded Spaces through the atomic factory, and executes both
trades through upstream `StaticBalances` and `LimitSwap` instructions. It fails
closed if the manifest does not identify the upstream engine, the upstream
wrapper is not built, or the real Aqua/Chainlink dependencies have no code at
the pinned fork block. It never broadcasts to Ethereum mainnet.

The router's `executeWithSwapVM` entry owns AURKA validation and calls the
official VM. The VM owns the principal Aqua push/pull; AURKA owns recipient fee
transfers and pushes the treasury-retained fee back into Aqua. The strict VM
threshold is the pre-fee oracle exchange; `OptionSpaceFee` remains the source of
truth for utilization-dependent fees and all AURKA post-state checks.

## TASK99-006 selected real-fork release candidate (reference)

The reproducible release rehearsal is `pnpm integration:fork-real`. It starts an
isolated Anvil fork of Ethereum mainnet at block `25,500,000` (local chain ID
`31337`), deploys the AURKA contracts into that fork, and connects a disposable
Graph Node/Postgres/IPFS stack to the same RPC. It never broadcasts to Ethereum
mainnet and does not require Privy for the ordinary browser wallet journey.

| Component | Selected integration                                                                                                                                                   | Truthful boundary                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Aqua      | Real 1inch Aqua at `0x499943e74fb0ce105688beee8ef2abec5d936d31`                                                                                                        | Actual `ship` virtual balances and maker-wallet allowances; the factory performs no mock `seed` call.                                         |
| Assets    | Mainnet USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` and WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`                                                        | Fork-only test funding is used for Alice/Bob; no public token transfer occurs.                                                                |
| Prices    | Locally deployed `ChainlinkPriceOracle` adapter reading ETH/USD `0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419` and USDC/USD `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6` | Native 8-decimal rounds are validated and normalized to whole settlement units; raw round data and the normalized snapshot are fingerprinted. |
| Execution | `AurkaUpstreamAquaSwapVMRouter` / `AURKA_UPSTREAM_LIMIT_SWAP_V1`                                                                                                       | TASK99-013's pinned official-derived VM path; `AurkaDirectSwapVM` remains fixture/reference only.                                             |
| Indexing  | Graph Node `v0.41.2`, Postgres `14.11`, IPFS Kubo `v0.17.0`                                                                                                            | The temporary manifest points at the fork's deployed AURKA addresses and the app reads confirmed Activity from its GraphQL endpoint.          |
| Wallets   | Ordinary EIP-1193 test wallets derived only inside the disposable Anvil                                                                                                | Alice owns both Spaces; Bob signs the two trades. Privy remains a separate production custody gate.                                           |

The runner writes a sanitized `release.json` when `AURKA_RELEASE_EVIDENCE_DIR`
is supplied. It records the fork/deployment identity, contract addresses, Graph
entity receipt hashes/counts, wallet journey evidence, and Graph outage/restart
result. The checked-in subgraph manifest remains a fixture template so a public
deployment cannot be implied by running code generation alone.

## Graph and Privy pin (AURKA-007)

The implementation was pinned on 2026-09-05 against the current official
documentation:

- [The Graph GraphQL API](https://thegraph.com/docs/en/subgraphs/querying/graphql-api/)
  is consumed with server-only HTTP `POST` requests. Queries use deterministic
  ID cursors (`id_gt`, ascending ID order), and `_meta` is retained as
  provenance (deployment, indexing-error flag, and indexed block).
- [The Graph gateway query guidance](https://thegraph.com/docs/en/gateways/subgraphs/consumer-side/serving-queries/)
  and
  [API-key management](https://thegraph.com/docs/en/subgraphs/providers/subgraph-studio/managing-api-keys/)
  are operational references. API keys are sent as a bearer token by
  `@aurka/graph` and are never part of browser-facing code or logs.
- [Privy policy controls](https://docs.privy.io/controls/policies/overview) are
  treated as a second default-deny boundary. The local policy model allows only
  explicit EVM methods, selectors, chain, target, assets, amount/value, and
  expiry; policy DENY remains authoritative.
- [Privy owners and signers](https://docs.privy.io/controls/authorization-keys/owners/overview)
  define the authority split: owners retain policy/signer administration while
  additional signers may transact only within their policy.
- [Privy authorization signatures](https://docs.privy.io/api-reference/authorization-signatures)
  are required by the production adapter for sensitive wallet RPC calls.
- The Node integration uses the current
  [`@privy-io/node`](https://docs.privy.io/basics/nodeJS/advanced/migrating-from-server-auth)
  surface, pinned to `0.34.0` in `packages/wallet/package.json`. The deprecated
  `@privy-io/server-auth` package is not used. App secrets and any signing
  material are runtime-only.

## Delegated Privy execution decision (TASK99-008)

The installed `@privy-io/node@0.34.0` surface supports the route selected for
the bounded agent pilot: a dedicated Ethereum wallet has an owner key quorum and
a separate additional signer with one restrictive policy override. The owner
remains the only authority for wallet/policy/signer administration and export;
the additional signer can transact only within its policy. Bob's browser address
is not the Privy owner and is not the agent wallet. Bob's browser EIP-712
signature is AURKA's session consent, binding Bob, the agent address, chain,
Space allowlist, token direction, integer caps, nonce, and expiry.

The operator command is read-only by default. The package script loads `.env`
when present (`--env-file-if-exists`); the explicit form is useful when checking
that the root environment is the one being inspected:

```sh
pnpm privy:delegated                 # sanitized check; never creates a wallet
node --env-file=.env packages/wallet/scripts/privy-delegated-wallet.mjs check
pnpm privy:delegated template         # print the candidate policy shape only
PRIVY_DELEGATED_PROVISION=true pnpm privy:delegated provision
```

Provisioning requires pre-created, reviewed Privy owner/signer IDs plus two
policies and the explicit opt-in. `PRIVY_DELEGATED_RECOVERY_POLICY_ID` is the
wallet's one base policy and permits only owner-destination ERC-20 transfers;
`PRIVY_DELEGATED_POLICY_ID` is the additional signer's override and permits only
the reviewed router execution and exact input-token approval. It is idempotent,
refuses to mutate an existing wallet whose owner, base recovery policy,
additional signer, override policy, or chain type does not match, and prints
only wallet/policy IDs, address, signer attachment, and rule metadata. It never
prints `PRIVY_APP_SECRET`, authorization contexts, or keys.

The check also reads both configured key quorums through the installed
`@privy-io/node@0.34.0` API (`client.keyQuorums().get(...)`). It derives the
public SPKI key in memory, verifies the configured authorization material is a
P-256 key registered in the intended quorum, and verifies that the returned
threshold can be satisfied. The wallet and policy calls use the SDK's callable
services (`client.wallets()` and `client.policies()`); they are not property
accessors. `PRIVY_APP_ID` is the server-only app identifier; the old
`NEXT_PUBLIC_PRIVY_APP_ID` name is not used for backend authentication. Readback
rejects extra base policies, additional signers, signer override policies, or
unexpected `ALLOW` methods in either reviewed policy.

The bundled server modules expose the policy readback, additional-signer revoke,
request authorization, and `recoverDelegatedFunds` callbacks. The recovery
callback receives only the session ID, Bob's already-authenticated destination,
the reviewed one-token amount, the consumed authorization hash, and the
server-selected canonical RPC route. It uses the Privy owner/recovery
authorization path and exact token transfers; it does not call the delegated
additional signer, accept arbitrary recipients/tokens, or expose a private key
to AURKA. The UI signs the recovery intent in the browser after Stop, and the
service blocks recovery while any submitted or ambiguous trade lacks a receipt.
The bundled demo callback accepts one exact token transfer per recovery
authorization so each result has one durable receipt/hash. The recovery UI
therefore submits input and output as separate signed operations. Recovery
policy readback also requires the transfer function, configured owner
destination, token contract, and amount cap.

The new delegated adapter is a distinct execution boundary. In the selected
`sign-and-broadcast` route, Privy signs an exact transaction and AURKA submits
the returned RLP to the configured canonical fork RPC. This same route is used
for owner recovery after Stop. The remote delegated policy is limited to the
reviewed Ethereum chain, typed-data domain, the configured exact router function
(`executeWithSwapVM` for the TASK99-013 final path), zero-value router call, and
an input-token `approve` whose function, spender, and amount cap are all decoded
by Privy. Set `PRIVY_DELEGATED_ROUTER_METHOD=execute` only for the legacy
reference deployment. The `privy` broadcast mode remains available for a
supported hosted route but is not claimed as live evidence here. AURKA enforces
the session Space/pair/direction, integer per-trade and cumulative budgets,
count, expiry, delegated identity, exact ABI re-encoding, token balance, router
allowance, refreshed nonce, chain RPC, and target `eth_call` before every send.
The settlement contracts remain authoritative for intent/proposal signatures,
policy/risk/price/balance commitments, and accounting. Privy policy enforcement
is not claimed to provide AURKA's cumulative budget or nested settlement
semantics.

The implementation deliberately does not claim a live proof in this checkout.
TASK99-009 ran the root check and found `PRIVY_APP_ID`, the wallet/policy/target
configuration, and the live fork binding absent; it therefore did not contact
Privy, fund a wallet, revoke a signer, or broadcast a transaction. The complete
sanitized result is `.aurkadev/reviews/TASK99-009-report.md` with
machine-readable evidence at `docs/evidence/task99-009-live-privy.json`. The
TASK99-006 runner uses loopback Anvil chain `31337`, while Privy's hosted
broadcast path has not been proven to reach that local RPC or its generated
contracts. A supported Privy custom-network setup, real wallet/policy readback,
funded test wallet, remote denial check, and confirmed receipt are required
before this gate can be marked complete. No local signer or private key is
substituted for that evidence. Stop disables local signing first and then
invokes the operator-owned revoke callback; already-broadcast transactions are
reconciled rather than duplicated. Test-fund recovery remains an owner/operator
action and is not exposed through the delegated signer.

Graph finality is not inferred from a subgraph response alone. The adapter
compares `_meta.block` and every observation block against an injected canonical
chain reader, configured lag/finality limits, and block hashes. The documented
Graph block-hash limitation for non-final state is why normalization alone
reports `UNFINALIZED`; only the checked source query can report `FINAL`.

The risk-runtime DEX source remains `fixture-dex-v1` on Anvil/Foundry chain
`31337`; it is not used to claim competitive market pricing in the TASK99-006
settlement rehearsal. There is no public DEX deployment or public subgraph
selected in this milestone. The checked-in subgraph manifest contains reviewed
fixture addresses; the release runner creates a temporary manifest with the
actual fork deployment addresses.

The watchtower consumes the normalized observations and produces a pure integer
decision. A prose explanation is post-decision only. It cannot alter mode,
thresholds, bounds, maximum transaction value, certificate fields, or wallet
actions.

## Reviewed upstreams

The upstream contracts were reviewed on 2026-09-04 before the local adapter was
implemented:

- [1inch Aqua](https://github.com/1inch/aqua), current `main` at
  `9c5c42e5840e8741fba3597c48456c9510212b66`.
- [1inch SwapVM](https://github.com/1inch/swap-vm), pinned for TASK99-013 at
  `afd99c408b4ed610027f4426c6f98650acac9f5f`.
- The [SwapVM SDK](https://github.com/1inch/swap-vm-sdk) documents the current
  `AquaSwapVMRouter` reference address as
  `0x111111338c5091e8440b67b168bae16a668ac0de`.
- The current [Aqua README](https://github.com/1inch/aqua) lists the Aqua
  registry reference as `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` and the
  SwapVM router reference as `0x111111338c5091e8440b67b168bae16a668ac0de`.

The selected `0x499943...` Aqua address is used by the real-mode fork runner.
Every address still requires chain-specific bytecode, immutables, and deployment
verification; the TASK99-013 runner records the selected Aqua, token, oracle,
and locally deployed wrapper runtime code hashes rather than treating an address
alone as proof. The wrapper constructor binds Aqua, WETH, and owner; the AURKA
router binds the wrapper as its immutable SwapVM and Aqua app.

The addresses above are reference data, not settlement targets in this
repository. Automated tests never broadcast to or call a live network.

## Fixture compatibility boundary (explicit fallback)

The original deterministic fixture environment is Anvil/Foundry chain `31337`:

| Component | Selected artifact                                              | Role                                                                                         |
| --------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Aqua      | `MockAqua`                                                     | Local virtual-balance fixture implementing the reviewed `IAqua` pull/push surface.           |
| SwapVM    | `AurkaDirectSwapVM` / `ISwapVM` program `AURKA_DIRECT_PAIR_V1` | Explicit fixture/reference adapter only; real mode uses the pinned upstream-derived wrapper. |
| Oracle    | Governance-bound `IPriceOracle`                                | Interface only; the deterministic mock is used locally and no live oracle is deployed.       |

The AURKA compatibility interfaces use Solidity `0.8.28`. The reviewed upstream
sources retain their own source licenses and are vendored as pinned submodules;
the wrapper is compiled separately with Solidity `0.8.30`.

## Interface commitment

Hashes below are `keccak256(UTF-8(canonical signatures joined by LF))`. They are
documentation fingerprints for the reviewed function surface, not Solidity
interface IDs.

`IAqua` canonical signature list:

```text
rawBalances(address,address,bytes32,address)(uint248,uint8)
safeBalances(address,address,bytes32,address,address)(uint256,uint256)
ship(address,bytes,address[],uint256[])(bytes32)
dock(address,bytes32,address[])
pull(address,bytes32,address,uint256,address)
push(address,address,bytes32,address,uint256)
```

Interface hash:
`0x478b137ac45364c01ade750cb033ec160566360920ad86e66d314ca3779951db`.

`ISwapVM` canonical signature list:

```text
hash((address,uint256,bytes))(bytes32)
quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)
swap((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)
```

Interface hash:
`0x174449ed93e32df5dc7a8c9fd4e9fe8ae402a4986b3ead08d788ca9ba73ae6a8`.

The router binds the reference direct-program arguments or the upstream order,
program, packed taker data, and their proposal hash to its own address and
chain. The upstream path calls `quote` and then `swap` with the exact input;
both the order hash and pre-fee output are checked before finalization. Aqua is
called only through the immutable app/registry address and exact token
approvals. The oracle address and price-age/deviation policy are
governance-bound and included in the policy nonce transition. See
[`adr-0043-real-swapvm-settlement.md`](./adr-0043-real-swapvm-settlement.md) for
the transfer-owner and direct-call-bypass analysis.

## Testing and deployment policy

`contracts/test/mocks/MockAqua.sol` and `MockERC20.sol` provide deterministic
local settlement fixtures. `contracts/script/deploy-settlement.sh` supports
simulation-first deployment when registry and Aqua addresses are supplied by
environment variables. Live-network integration is intentionally separate and
manual; no CI job receives production keys or broadcasts funds.

## Integration corrections — 2026-09-07

`pnpm --filter @aurka/graph subgraph:build` performs Graph code generation and
compiles the actual AssemblyScript mapping to WASM. Its handlers persist trade,
fee, policy, risk-mode and execution-observation entities. The checked-in
manifest is still a fixture template; `pnpm integration:fork-real` proves the
same mapping against a deployed Graph Node and actual fork transactions.

`GraphSignalSource` queries `riskObservations` and `_meta` at an explicit
RPC-proven finalized block. It verifies chain identity, deployment, canonical
hashes, freshness and lag. Normalization alone yields `UNFINALIZED`; it cannot
prove chain finality. Observation payload bytes are decoded before validation.

`UniswapV4SignalSource` implements the official
[Uniswap v4 PoolHourData schema](https://github.com/Uniswap/v4-subgraph/blob/main/schema.graphql).
Operators must select the deployment, chain and bytes32 pool ID. It uses two
consecutive completed hours at the finalized snapshot. Liquidity change is
signed basis points relative to the preceding hour; volume is integer USD
micro-units, truncated at six decimal places. Zero liquidity baselines, missing
hours, stale data and noncanonical metadata are rejected. Thresholds must use
these units. Two signals from one source do not constitute two independent
quorum members. No live deployment or economic calibration has been validated.

## AURKA-011 actual Graph Node integration

The repository now has a real local indexing check at
`packages/services/scripts/local-graph-node-e2e.mjs`. It starts a disposable
Anvil chain, deploys the actual AURKA registries/router and fixture contracts,
starts Graph Node/Postgres/IPFS with pinned images (`graph-node:v0.41.2`,
`postgres:14.11`, `kubo:v0.17.0`), creates a temporary manifest from the
deployed addresses and start blocks, then deploys it with the official
[Graph CLI deployment flow](https://thegraph.com/docs/en/subgraphs/guides/near/).
GraphQL, admin, status, and IPFS ports are random loopback bindings; the
container reaches Anvil through `host.docker.internal`. Every process, network,
database, and temporary manifest is removed on success or failure.

Run it from the repository root:

```bash
pnpm integration:graph-node
```

The command proves persisted `PolicyMutation`, `RiskModeChanged`, `FeesRouted`,
`TradeExecuted`, and `RiskObservation` entities from real receipt events. It
also checks same-transaction log indexes, normalized fee units, payload bytes,
deployment identity, two actual observation rows across ID-cursor pages,
`observedAt` filtering, lag rejection, and orphan removal after an Anvil
rewind/replacement. The consumer query uses an RPC-supplied boundary block;
Anvil does not provide production finalized/safe semantics, so the harness
reports the boundary as local `FINAL` only and makes no live-chain finality
claim.

Graph Node `v0.41.2` may return null historical `_meta.block.hash` and
`timestamp` fields. `GraphSignalSource` therefore requires the historical block
number and deployment/error metadata, while canonical RPC hashes and each
mapping-written `indexedBlockHash` remain mandatory reorg evidence. This keeps
the local compatibility check explicit without treating the latest subgraph head
as finalized. The
[Graph Node tooling documentation](https://thegraph.com/docs/en/indexing/tooling/graph-node/)
also advises keeping admin/status/Postgres private; this harness binds those
interfaces only to loopback and uses no credentials.

The Privy adapter uses the installed `@privy-io/node@0.34.0` native
`wallets().ethereum().signTypedData` and `sendTransaction` methods, their actual
snake-case authorization/domain fields, and native `signature`/`hash` results.
It signs only a structured v2 risk certificate after validating domain, policy,
preapproved bounds hash, cap, expiry, nonce and authorization epoch. It recovers
the signer, refreshes policy/authority around signing, decodes exact Solidity
calldata, verifies chain identity, runs `eth_call`, and checks policy again
before sending. Retries use a deterministic Privy idempotency key. Server
request authorization must follow the pinned SDK and
[Privy's server authorization guidance](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server).
Mocked native-client tests establish request compatibility; real Privy policies,
authorization signatures and live calls remain deployment validation gates.

## AURKA-010 trusted watchtower runtime

`@aurka/services/risk-runtime` provides the server-only composition for the
certificate worker. It binds canonical RPC readers, reviewed Graph sources, the
pinned Privy wallet adapter, and request-specific authorization behind
`createRiskRuntime(service)`. The default CLI remains credential-free and does
not start the worker unless `RISK_RUNTIME_MODULE` is explicitly configured.

The configuration contract and environment names are documented in
`docs/risk-watchtower.md`. It requires distinct policy-registry, risk-registry
and router addresses, explicit position/policy mappings, approved configuration
and hard-bounds hashes, source deployment/query versions, freshness/lag budgets,
and server wallet references. Secrets are referenced by environment-variable
name or server module; they are not part of `RISK_POSITIONS_JSON`.

Run the local composition test with:

```bash
pnpm --filter @aurka/services test -- risk-runtime.test.ts
```

This proves adapter composition and recovery against fake transports only. No
live deployment, selected Graph endpoint, Privy policy, or production
transaction is asserted by the repository.
