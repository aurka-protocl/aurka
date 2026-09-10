# ADR-0043: real Aqua/SwapVM settlement for the reviewed pair

- Status: accepted and live-fork verified in TASK99-013
- Date: 2026-09-10
- Scope: the bounded USDC/WETH Space route on the isolated Ethereum fork

## Decision

Keep `AurkaSwapVMRouter` as the authenticated entry point and add an explicit
`executeWithSwapVM` route. It performs all existing AURKA policy, risk, price,
capacity, signature, and post-state checks, then calls the pinned official
SwapVM implementation through the local `AurkaUpstreamAquaSwapVMRouter` wrapper.
The wrapper only supplies the official `LimitOpcodes` dispatch and a stable
marker; it does not change SwapVM or Aqua behavior.

The existing `execute` route and `AurkaDirectSwapVM` remain an explicitly named
fixture/reference path. A real-mode manifest selects
`AURKA_UPSTREAM_LIMIT_SWAP_V1`; it never falls back to the reference adapter.

## Pinned implementation

| Component      | Pin / artifact                                           | Role                                                         |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| SwapVM         | `1inch/swap-vm@afd99c408b4ed610027f4426c6f98650acac9f5f` | `SwapVM`, `LimitSwapVMRouter`, official Aqua-aware transfers |
| Aqua           | `1inch/aqua@9c5c42e5840e8741fba3597c48456c9510212b66`    | Real virtual balances and maker-wallet allowance boundary    |
| Solidity utils | `1inch/solidity-utils@6.9.10`                            | Official SwapVM dependency                                   |
| OpenZeppelin   | `openzeppelin-contracts@v5.4.0`                          | Official SwapVM dependency                                   |
| Compiler       | AURKA `0.8.28`; upstream wrapper `0.8.30`                | Separate Foundry build; no pragma rewrite                    |

The local wrapper is in `contracts/upstream/` and is built by
`pnpm contracts:build-upstream`. Its source and artifact hashes are recorded by
the fork runner. The official license notices remain in the vendored sources.

## Reviewed program

The only enabled template is a sorted two-token order for the policy's USDC and
WETH assets, with the public execution direction WETH → USDC. The order is
`abi.encode(ISwapVM.Order)` and therefore includes the outer tuple offset; its
hash is `keccak256(strategy)` and must equal the Aqua strategy hash.

The order data is exactly:

```text
tokenA (20 bytes) || tokenB (20 bytes) || guard (20 bytes) ||
0x90 0x40 balanceA balanceB || 0x53 0x01 direction
```

`0x90` is the official `StaticBalances` instruction and `0x53` is the official
`LimitSwap` instruction. `balanceA` and `balanceB` are the raw-token amount for
one AURKA value unit, calculated from the governance-bound oracle snapshot. The
order has Aqua mode, a pre-transfer-out hook, and an explicit hook target. The
hook is `AurkaSwapVMExecutionGuard`; the maker-trait slice indexes are
`40/40/60/60`, so the program begins at order-data byte 60.

The packed taker data is 59 bytes: ten slice indexes, flags, a 32-byte strict
output threshold, and a five-byte deadline. Flags are exact-input, strict
threshold, Aqua push, and the direction bit. The strict threshold is the pre-fee
oracle output for the signed AURKA fill. Unsupported pairs, reverse directions,
malformed lengths, wrong opcodes, changed slices, and changed amount/deadline
fields revert.

## Settlement sequence and authorities

```text
Trader --approve/transferFrom--> AurkaSwapVMRouter
  │                                  │ temporary input custody only
  │                                  └─approve + swap(order,takerData)──────┐
  │                                                                         ▼
  │                    official SwapVM ── Aqua.push ──> maker wallet/input balance
  │                           │
  │                           ├─ preTransferOut ──> ExecutionGuard
  │                           │                         │ only pinned VM
  │                           │                         └─ active AURKA context
  │                           └─ Aqua.pull(maker, orderHash, output, router)
  │                                                                         │
  └<---------------------- router: net output ------------------------------┤
                         router: solver fee + protocol fee -----------------┤
                         router: Aqua.push(treasury fee) -------------------┘
```

Each leg has one transfer owner:

| Leg                   |                                     Amount | Owner / authority                                     | Proof                                                     |
| --------------------- | -----------------------------------------: | ----------------------------------------------------- | --------------------------------------------------------- |
| Trader input custody  |               `proposal.traderInputAmount` | AURKA router; trader's ERC-20 allowance               | ERC-20 balance delta, then router approval is zeroed      |
| Maker input credit    |                       same VM input amount | official SwapVM → Aqua `push`; maker approved Aqua    | Aqua `Pushed(maker, swapVM, orderHash, tokenIn, amount)`  |
| Maker output debit    |                          VM pre-fee output | official SwapVM → Aqua `pull`; maker approved Aqua    | Aqua `Pulled(maker, swapVM, orderHash, tokenOut, amount)` |
| Trader output         |              `proposal.traderOutputAmount` | AURKA router                                          | exact recipient balance delta                             |
| Solver fee            |                 `proposal.solverFeeAmount` | AURKA router, signed solver recipient                 | exact recipient balance delta and `FeesRouted`            |
| Protocol fee          |               `proposal.protocolFeeAmount` | AURKA router, policy recipient                        | exact recipient balance delta and `FeesRouted`            |
| Treasury-retained fee | VM output minus the three paid output legs | AURKA router pushes it back to the same Aqua strategy | Aqua `Pushed` plus final raw-balance check                |

The VM amount is deliberately the pre-fee exchange amount. The AURKA output
amount is the fee-inclusive treasury withdrawal
(`trader output + solver fee + protocol fee`). The difference is the
utilization-dependent treasury fee and is returned to Aqua. Thus there is one VM
output pull, no duplicate maker output pull, and no intermediary residual. The
final strategy delta is:

```text
input token:  + proposal.traderInputAmount
output token: - (proposal.traderOutputAmount
                 + proposal.solverFeeAmount
                 + proposal.protocolFeeAmount)
```

`OptionSpaceFee` remains the source of truth for the fee curve and rounding. The
VM only computes the fixed oracle-rate exchange. AURKA computes the utilization
interval, fee cap, bounds, capacity consumption, minimum received, and expected
post-portfolio. The router rejects if the upstream quote or swap does not equal
the signed pre-fee raw output; it then reloads Aqua and the authoritative
portfolio before emitting `UpstreamSwapVMExecuted`, `FeesRouted`, and
`TradeExecuted`.

## Direct-call bypass proof

A strategy is shipped under `app = address(swapVM)`, not under the AURKA entry
router. A caller can therefore reach the official VM, but cannot satisfy the
embedded guard. The guard rejects every caller except the immutable SwapVM,
requires the VM-reported taker to be the immutable AURKA router, and forwards
the order hash, maker, pair, and exact amounts to the router's active execution
context. The router context is created only after all signed validation and is
deleted immediately after the VM call under `nonReentrant`; its zero/default
state rejects replay, wrong Space/strategy, wrong trader, changed direction, or
changed amounts. A direct upstream call consequently fails at `preTransferOut`
before Aqua output is pulled. Direct calls to the AURKA context are also
rejected because only the guard may call it.

The order hash binds the complete maker, traits, hook target, pair, and program
bytes. AURKA separately binds the signed direct accounting proof and the packed
upstream calldata hash. The policy registry binds the strategy hash, treasury,
assets, oracle, policy nonce, and capacity epoch. This is why a precheck alone
cannot be bypassed by calling the upstream VM with altered calldata.

## Failure and migration behavior

Every external leg is inside the single transaction. A failed quote, opcode,
hook, Aqua push/pull, recipient transfer, final balance, portfolio, or event
commitment reverts all token, capacity, nonce, and context changes. Existing
saved drafts/calldata are not reinterpreted: the service selects the upstream
selector only when the manifest exposes `swapVMGuard` and the upstream strategy
hash matches; otherwise the explicit reference selector is used. Operators must
redeploy an isolated fork with `pnpm fork:reset` to change execution mode.

The live fork runner records the selected fork block, code hashes, constructor
addresses, two independently custom-funded Spaces, real VM receipts/traces,
exact balance deltas, and a deliberate direct upstream-call rejection before
this ADR is considered fully verified.
