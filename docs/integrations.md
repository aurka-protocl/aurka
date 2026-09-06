# AURKA integration boundaries

Status: reviewed for AURKA-005 and AURKA-007; local deterministic adapters only.

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

Graph finality is not inferred from a subgraph response alone. The adapter
compares `_meta.block` and every observation block against an injected canonical
chain reader, configured lag/finality limits, and block hashes. The documented
Graph block-hash limitation for non-final state is why an observation can be
`SAFE` or rejected rather than being treated as final.

The initial DEX source is `fixture-dex-v1` on Anvil/Foundry chain `31337` only.
There is no production DEX subgraph ID, network, or live smoke test selected in
this milestone. `packages/graph/subgraph/subgraph.yaml` therefore contains
reviewed fixture addresses; replacing them is a separately approved deployment
decision.

The watchtower consumes the normalized observations and produces a pure integer
decision. A prose explanation is post-decision only. It cannot alter mode,
thresholds, bounds, maximum transaction value, certificate fields, or wallet
actions.

## Reviewed upstreams

The upstream contracts were reviewed on 2026-09-04 before the local adapter was
implemented:

- [1inch Aqua](https://github.com/1inch/aqua), current `main` at
  `9c5c42e5840e8741fba3597c48456c9510212b66`.
- [1inch SwapVM](https://github.com/1inch/swap-vm), current `main` at
  `f09a41e689240adc645934f965c8061749397cd2`.
- The [SwapVM SDK](https://github.com/1inch/swap-vm-sdk) documents the current
  `AquaSwapVMRouter` reference address as
  `0x111111338c5091e8440b67b168bae16a668ac0de`.
- The [Aqua documentation](https://github.com/1inch/aqua) documents the
  network-specific Aqua deployment; the commonly published reference address is
  `0x499943e74fb0ce105688beee8ef2abec5d936d31`.

The addresses above are reference data, not settlement targets in this
repository. Automated tests never broadcast to or call a live network.

## Selected Phase 4 boundary

The supported deterministic test environment is Anvil/Foundry chain `31337`:

| Component | Selected artifact                                              | Role                                                                                          |
| --------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Aqua      | `MockAqua`                                                     | Local virtual-balance fixture implementing the reviewed `IAqua` pull/push surface.            |
| SwapVM    | `AurkaDirectSwapVM` / `ISwapVM` program `AURKA_DIRECT_PAIR_V1` | Immutable local adapter boundary for one direct pair; no arbitrary target or solver calldata. |
| Oracle    | Governance-bound `IPriceOracle`                                | Interface only; the deterministic mock is used locally and no live oracle is deployed.        |

The local compatibility interfaces use Solidity `0.8.28` so they can be tested
with the repository toolchain. The reviewed upstream sources currently use their
own source licenses and a newer compiler; they are not vendored or redistributed
by the local fixture.

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

The router binds `DIRECT_PROGRAM_ID`, every direct-program argument, the
proposal hash, and the EIP-712 domain to its own address and chain. The
immutable `ISwapVM` adapter is called with the exact input amount and its
returned order hash and amounts are checked before Aqua custody changes. Aqua is
called only through the immutable `IAqua` address and only with exact token
amount approvals. The oracle address and price-age/deviation policy are
governance-bound and included in the policy nonce transition.

## Testing and deployment policy

`contracts/test/mocks/MockAqua.sol` and `MockERC20.sol` provide deterministic
local settlement fixtures. `contracts/script/deploy-settlement.sh` supports
simulation-first deployment when registry and Aqua addresses are supplied by
environment variables. Live-network integration is intentionally separate and
manual; no CI job receives production keys or broadcasts funds.
