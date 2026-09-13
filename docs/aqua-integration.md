# Aqua and 1inch SwapVM

AURKA uses [1inch Aqua](https://github.com/1inch/aqua) for managed virtual
liquidity and [SwapVM](https://github.com/1inch/swap-vm) to execute the encoded
order. AURKA adds the Space policy, price, capacity, fee, and final-state rules
around that settlement.

This integration uses Aqua and SwapVM contracts. It does not use the 1inch Swap
API, Pathfinder, or Fusion. The AURKA solver calculates a bounded route from the
Space state; SwapVM then executes that route against the Space's Aqua strategy.

## Contract layout

| Layer              | Contract or artifact                                                    | Role                                                                                                              |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Liquidity          | Pinned 1inch `Aqua`                                                     | Stores the shipped strategy and virtual token balances.                                                           |
| VM                 | Pinned 1inch SwapVM artifact wrapped by `AurkaUpstreamAquaSwapVMRouter` | Parses and executes the approved Aqua instruction program.                                                        |
| AURKA entry point  | `AurkaSepoliaSwapVMRouter`                                              | Checks the intent, policy, price, balance, capacity, calldata, fee, and final state before and after the VM call. |
| Execution helper   | `AurkaSepoliaUpstreamExecutor`                                          | Connects the reduced Sepolia router to the upstream SwapVM and installs the SwapVM guard.                         |
| Validation helpers | `AurkaSepoliaOrderValidator`, `AurkaSepoliaTradeMath`                   | Keep order validation and settlement arithmetic in separately deployed contracts.                                 |
| Portfolio          | `AurkaSpaceVault` and `AurkaSpaceVaultFactory`                          | Create an owner-controlled vault and bind its policy and strategy.                                                |

The generated upstream artifacts are built at:

```text
contracts/out-upstream/Aqua.sol/Aqua.json
contracts/out-upstream/AurkaUpstreamAquaSwapVMRouter.sol/AurkaUpstreamAquaSwapVMRouter.json
```

The full `AurkaSwapVMRouter` and `AurkaDirectSwapVM` are used by local fixture
and regression flows. They are not the reduced Sepolia deployment route.

## How a Space uses Aqua

1. The factory creates the Space vault and binds its owner, policy, token pair,
   AURKA router, and strategy hash.
2. The owner funds the vault with the Space tokens.
3. During initialization, the vault ships its strategy into Aqua with the
   allowed token balances and encoded SwapVM instructions.
4. AURKA stores the strategy hash and checks the exact bytes against Aqua on
   every quote and execution.
5. The capacity epoch records how much value can be traded from the current
   portfolio state. Trades consume capacity; price updates require epoch renewal.

The strategy is immutable for the Space. A changed strategy or incompatible
price encoding requires owner-controlled recovery and a replacement Space; it
cannot be silently substituted during a swap.

## Settlement flow

1. The service reads the policy, vault and Aqua balances, approved prices,
   allocation bounds, fees, and capacity epoch.
2. The deterministic solver calculates a valid amount and creates the intent and
   proposal commitments.
3. The client reviews the quote and signs the intent. A delegated wallet may
   sign the same reviewed route under its Privy policy.
4. `AurkaSepoliaSwapVMRouter` verifies the Space, policy, price snapshot,
   balance snapshot, capacity epoch, amount, minimum return, fee, and exact
   SwapVM calldata.
5. The upstream SwapVM performs the Aqua token movement. AURKA routes the
   configured fee and verifies the final Aqua and portfolio balances.
6. The transaction emits the AURKA and SwapVM events used by the service
   activity view.

## Build and deploy to Sepolia

The deployment uses Ethereum Sepolia (`11155111`) and writes the addresses and
transaction receipts to `deploy/sepolia/sepolia-deployment.json`.

Build the upstream and AURKA artifacts first:

```bash
pnpm contracts:build-upstream
forge build
```

Create `.env.sepolia` from the example and provide a funded deployer and RPC.
The deployer must be separate from the Privy trading wallet. Review the plan
without broadcasting:

```bash
pnpm sepolia:plan
pnpm sepolia:check
```

Deploying creates a new set of contracts and does not replace old contracts on
Sepolia:

```bash
AURKA_SEPOLIA_DEPLOY=true pnpm sepolia:deploy
```

The script deploys the mock USDC/WETH pair, Aqua, the upstream SwapVM wrapper,
the AURKA registries, the Sepolia router and helpers, the vault factory, and the
selected price oracle. In the current profile the oracle is `MockPriceOracle`;
Chainlink mode requires explicit feed addresses.

After deployment, create and fund the demo Space:

```bash
pnpm sepolia:space
```

That setup ships the strategy into Aqua and activates its first capacity epoch.
The deployer-only acceptance trade is:

```bash
pnpm sepolia:trade
```

To renew prices and capacity on the same deployment:

```bash
pnpm sepolia:reactivate
```

## Redeployment rules

Redeployment is appropriate when the router, helper bytecode, Aqua artifact,
tokens, or initial oracle configuration changes. It creates new addresses; the
old deployment, vaults, strategies, and balances remain on Sepolia.

After a redeployment:

1. Keep the new `sepolia-deployment.json` as the active manifest.
2. Create a new Space with `pnpm sepolia:space`; do not reuse a Space bound to
   the old router or strategy.
3. Update the server-side router and token configuration used by delegated
   execution.
4. Verify a fresh strategy ship, capacity activation, quote, and settlement.

Redeployment does not migrate assets automatically. Recover assets from the old
owner-controlled Space first, then fund the replacement Space.

## Local versus Sepolia

Local fixture flows deploy `MockAqua`, `MockPriceOracle`, and
`AurkaDirectSwapVM` on an isolated chain. These support deterministic
development. The Sepolia profile
uses the pinned upstream Aqua/SwapVM artifacts and the reduced AURKA router.
