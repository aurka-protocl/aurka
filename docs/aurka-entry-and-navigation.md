# AURKA entry and navigation

This is the copy and route contract for the two local AURKA applications. It
keeps the first visit useful without requiring protocol identifiers, while
leaving technical inspection available for later work.

## First-visit flow

Both apps open on a role-specific orientation page:

1. Explain that an organization offers assets as treasury liquidity under
   portfolio rules.
2. Explain that another person can request a swap against that liquidity.
3. State `Local demo` and either `No wallet connected` or `Read-only example`.
4. Offer the two starting actions: `Explore a demo treasury` and `Try a swap`.
5. Explain the journey as holdings → rules → permitted swap → fee/review →
   resulting holdings.

The trader’s guided `/swap` route uses the configured local fixture and a public
fixture address to request a quote without asking the visitor for an address,
position ID, nonce, or hash. It stops at a quote or unsigned preview; it does
not imply a wallet connection or broadcast a transaction. The existing `/trade`
route remains available as the developer-oriented form.

## Plain-language destinations

| App      | Primary destinations                                                   | Technical compatibility routes                     |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Treasury | Start here, Treasury overview, Holdings & rules, Protections, Activity | `/dashboard`, `/positions`, `/risk`, `/executions` |
| Trader   | Start here, Swap, Swap activity, Treasury space                        | `/dashboard`, `/trade`, `/portfolio`, `/history`   |

System diagnostics live at `/status` in both apps. They are deliberately not
part of the value proposition and remain useful when the service is down.

## Shared terminology

- **Treasury:** an organization’s assets made available for exchange.
- **Holdings:** the balances currently shown for that treasury.
- **Rule:** a portfolio range or transaction limit the treasury accepts.
- **Swap:** an exchange of one asset for another.
- **Position:** the AURKA record connecting one treasury to its holdings and
  rules.
- **Quote:** a time-limited estimate, not a completed trade.
- **Proposal:** a solver’s candidate settlement for a reviewed intent, not a
  broadcast.
- **Execution:** a settlement record that may be prepared, submitted, or
  confirmed.

## Hosting configuration

Set `VITE_AURKA_TREASURY_URL` and `VITE_AURKA_TRADER_URL` when the applications
are hosted at known public URLs. In Vite development, blank values resolve to
the current host on ports 3001 and 3002. In a production build with blank
values, the apps use `/treasury/` and `/trader/` as same-host defaults; a
reverse proxy or explicit URLs are required for another deployment shape.
