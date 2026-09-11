# ETHOnline submission packet

Prepared for ETHGlobal ETHOnline 2026. Publishing the final submission remains
the user's explicit action; this file is copy and evidence preparation only.

## Current event constraints

The official
[ETHOnline 2026 details](https://ethglobal.com/events/ethonline2026/info/details)
lists a submission deadline of Sunday, September 13, 2026 at 12:00 pm EDT, a 2–4
minute demo video, and up to three partner-prize selections. The
[prize page](https://ethglobal.com/events/ethonline2026/prizes) says Aqua
accepts local forks for onchain transfer demonstrations and gives higher judging
weight to SwapVM use. Privy requires at least one Privy wallet, a functional
workflow, and at least one control such as policies, signers, key quorums, or
intents. Confirm the deadline and the selected track again in the Hacker
Dashboard before submitting.

## Project copy

### One-line pitch

Offer liquidity within portfolio limits, and let agents trade within permissions
you can revoke.

### Short description

AURKA turns a treasury's portfolio rules into enforceable liquidity. Owners
choose assets, allocation bounds, funding, and trade limits. A deterministic
solver checks current balances, prices, capacity, fees, expiry, and settlement
calldata; an assistant can propose a route but cannot invent values or sign. The
owner can pause and recover a fixed-price Space, then create a new strategy
without reusing the closed identity.

### Architecture

```text
owner rules + balances + oracle snapshot
                  │
         AURKA service / SQLite
       ┌──────────┼──────────┐
   agent tools  deterministic  Graph activity
                solver
                    │ reviewed intent + proposal
     browser wallet or scoped Privy signer
                    │
        AURKA router → Aqua/SwapVM → token transfers
```

OpenRouter interprets intent and chooses tools. Deterministic code calculates
and validates the quote. The wallet boundary signs. Contracts enforce policy,
price, capacity, and settlement. Aqua/SwapVM execution is not an AURKA fee:
VM/Aqua move the routed token balances, while AURKA's configured fee accounting
routes the documented treasury, solver, and protocol fee portions.

## Verified evidence

- [TASK1009-001 report](../.aurkadev/1009/TASK1009-001-report.md): pinned
  upstream Aqua/SwapVM build and real isolated fork settlement.
- [TASK1009-003 report](../.aurkadev/1009/TASK1009-003-report.md): changed-price
  rejection, owner-only dock/withdraw recovery, restart persistence, and a new
  replacement trade.
- [SwapVM evidence](../.aurkadev/1009/TASK1009-001-rehearsal-final2/): local
  sanitized fork manifests and screenshots. These are not public-mainnet
  explorer receipts.
- [Price recovery evidence](../docs/evidence/task1009-003-space-price-recovery.json):
  sanitized local fixture-upstream receipts and state assertions.
- [Browser smoke](../.aurkadev/reviews/TASK99-011-screenshots/browser-smoke.json):
  desktop/mobile routes, deep links, quote, assistant clarification, and no page
  errors.

## Demo script (target 3:30, within the 2–4 minute limit)

1. 0:00–0:35 — create a custom-funded USDC/WETH Space, show portfolio bounds,
   per-trade limit, approvals, expiry, and the test-funds label.
2. 0:35–1:15 — ask the assistant for a supported trade; show the deterministic
   proposal, fee, capacity, expiry, and wallet review.
3. 1:15–2:00 — sign the real fork transaction and show the receipt and changed
   balances. Explain that the receipt is from the named local fork, not a
   public-mainnet explorer.
4. 2:00–2:30 — request a larger or unsupported action and show the typed policy
   rejection without sending an intentionally reverting transaction.
5. 2:30–3:30 — show Stop/recovery only if the scoped live signer has passed
   acceptance. Otherwise show the reproducible owner recovery evidence and label
   it recorded/local, never live.

The fallback recording must use the same labels. It must not present fixture
economics such as `2 WETH → 1 USDC` as a realistic offer.

## Eligibility and limitations

The Aqua selection is supported by the real fork evidence and pinned official-
derived Aqua/SwapVM artifacts, subject to the event's track and commit-history
rules. The Privy selection is not yet claimable: TASK1009-002 found zero
wallets, no policy IDs, and no live signature/revocation/recovery proof. Local
Graph Node evidence is not a Graph-provider prize claim. No public deployment
URL, video, license grant, or final event submission is recorded yet.

The repository is currently `UNLICENSED`; obtain the user's license decision
before promising open-source distribution. Attribute 1inch Aqua/SwapVM and their
vendored licenses, OpenZeppelin, Privy, OpenRouter, Graph Node, and other
third-party dependencies in the final repository/submission as applicable. The
event dashboard must determine Start Fresh versus Continuity; this checkout
contains pre-existing project work and must not be represented as a new project
without the correct track declaration.
