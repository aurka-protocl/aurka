# AURKA entry and navigation

The canonical AURKA application is one frontend origin with three primary
destinations: Spaces, Trade, and Activity. Demo and fork environments use the
same shell, routes, and wallet header; the environment only changes the data
adapter and available actions.

## Canonical routes

- `/spaces` lists the available managed portfolios.
- `/spaces/:spaceId` is the Space overview.
- `/spaces/:spaceId/holdings` shows holdings and hard rules.
- `/spaces/:spaceId/settings` shows identity, authority, and environment
  controls when the fork adapter supports them.
- `/trade/:spaceId` is the Space-scoped trade flow.
- `/activity` is the global activity feed.

The root route redirects to `/spaces`. Older `/swap`, `/history`, `/executions`,
`/portfolio`, `/liquidity`, `/holdings`, `/positions`, `/protections`, `/risk`,
and `/status` URLs remain compatibility aliases and redirect into the canonical
concepts. They are not shown as separate primary navigation destinations.

## Wallet state

The header exposes Connect wallet, Connecting, the connected address, wrong
network, unsupported network, and error states. Reading a Space never requests a
signature and the app never switches chains automatically. Account and chain
events clear any in-flight quote, signing, or prepared-transaction context.

## Local development and preview

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @aurka/services start
pnpm app:dev
```

Open <http://127.0.0.1:3002/spaces>. The development server proxies `/api` to
the service at port 8787. To inspect the production bundle, stop the dev app and
run `pnpm app:preview`; it serves the same SPA fallback and `/api` proxy
configuration. Static hosts need an equivalent reverse proxy from `/api` to the
service and must rewrite direct application routes to `index.html`.

The fork runner follows the same single-origin arrangement:

```bash
pnpm fork:start
```

It serves the app at <http://127.0.0.1:3011/spaces>. The manifest identifies the
Space; use its encoded ID in `/spaces/:spaceId/settings` for Alice and
`/trade/:spaceId` for Bob. See [the fork wallet guide](fork-wallet-space.md).
