# Hosted demo runbook

This is the reviewable deployment packet for TASK1009-004. It is not a hosted
deployment record: no cloud resource, DNS record, public URL, or Privy wallet
was created by this task.

## Composition

The persistent-host manifest in
[`deploy/hosted-demo/docker-compose.yml`](../deploy/hosted-demo/docker-compose.yml)
contains the complete fork-aware composition:

```text
HTTPS edge (Caddy)
  ├── /       → built trader static files
  ├── /api    → fork-runtime gateway → API + SQLite
  └── /rpc    → filtered-rpc-proxy → internal Anvil

fork-runtime → Anvil mainnet fork + fork lifecycle/API process
graph-node   → same-fork Graph Node → Postgres + IPFS
```

The chain and SQLite state use the `fork-state` volume. Graph Postgres/IPFS and
Caddy state have separate durable volumes. GraphQL, Graph admin, Graph status,
IPFS, Anvil, and the runtime's raw ports are not routed by Caddy. Graph's host
operator ports are bound to loopback only for the deployment command.

The public JSON-RPC proxy accepts bounded read methods and
`eth_sendRawTransaction` only. It rejects JSON-RPC batches,
`eth_sendTransaction`, all `anvil_*`/`evm_*` reset and impersonation methods,
unlocked-account methods, and debug/admin methods. Requests are body-limited,
time-limited, and rate limited. The proxy is covered by
`packages/services/test/filtered-rpc-proxy.test.mjs`.

## Provisioning checklist

Use a dedicated host with at least 4 vCPU, 8 GB RAM, 80 GB SSD, daily volume
backups, and enough egress for a small judging session. Final provider pricing,
DNS, and any managed backup cost must be quoted and approved before creation;
this repository does not select a provider or authorize paid resources.

1. Copy `.env.hosted.example` to `.env.hosted` on the host. Set the domain,
   archive RPC, Graph database password, and optional server-only OpenRouter
   values. Do not commit this file or place any of these values in a Vite
   variable.
2. Verify the compose expansion without starting anything:

   ```sh
   docker compose --env-file .env.hosted -f deploy/hosted-demo/docker-compose.yml config --quiet
   ```

3. Start the durable services. The runner uses the proven real configuration:
   Ethereum mainnet fork block `25500000`, chain `31337`, real Aqua and
   Chainlink reads, and the pinned upstream SwapVM wrapper.

   ```sh
   docker compose --env-file .env.hosted -f deploy/hosted-demo/docker-compose.yml up -d --build
   ```

4. Deploy the subgraph from the operator host. The command reads the runtime's
   deployment identity, substitutes the exact addresses/start block into a
   temporary manifest, and uses Graph admin/IPFS ports bound to loopback:

   ```sh
   AURKA_HOSTED_RUNTIME_URL=http://127.0.0.1:8797 \
   AURKA_HOSTED_GRAPHQL_URL=http://127.0.0.1:18000 \
   AURKA_HOSTED_GRAPH_ADMIN_URL=http://127.0.0.1:18020 \
   AURKA_HOSTED_IPFS_URL=http://127.0.0.1:15001/api/v0 \
   pnpm hosted:graph-deploy
   ```

5. Check from the host and then from a second network/device:

   ```sh
   curl -fsS "https://${DEMO_DOMAIN}/api/health"
   curl -fsS "https://${DEMO_DOMAIN}/api/ready"
   curl -fsS "https://${DEMO_DOMAIN}/api/fork/identity"
   ```

   `/ready` must show healthy required dependencies, and the fork identity,
   Graph deployment, contract addresses, and public RPC URL must describe the
   same fork generation. A failed health check must remain visible to the
   operator; it is not converted into a successful page.

## Backup, restart, and rollback

Before a planned restart, record the fork generation and back up all four state
sets. The SQLite file must be copied while the service is stopped or using a
SQLite-consistent backup command. Never reset the chain while a judge session is
active.

```sh
docker compose --env-file .env.hosted -f deploy/hosted-demo/docker-compose.yml stop edge rpc-proxy fork-runtime graph-node
docker run --rm -v aurka_fork-state:/data -v "$PWD/backups:/backup" alpine \
  tar -czf /backup/fork-state-$(date -u +%Y%m%dT%H%M%SZ).tgz -C /data .
docker compose --env-file .env.hosted -f deploy/hosted-demo/docker-compose.yml start fork-runtime graph-node rpc-proxy edge
```

The actual Compose volume name is project-prefixed; replace `aurka_fork-state`
with the name reported by `docker volume ls`. Back up `graph-postgres`,
`graph-ipfs`, and `caddy-data` separately. A normal restart must preserve
`forkGeneration`, the deployment block/hash, SQLite activity, and the Graph
deployment; it must not replay transactions or re-enable a revoked Privy signer.

Rollback means stop public edge traffic, preserve the current volumes, deploy
the previously reviewed image/configuration, and run the identity/readiness
checks again. A chain-state restore is coordinated with SQLite and Graph
restore/redeployment; `pnpm fork:reset`, Anvil admin RPC, impersonation, and
unlocked-account sending are operator-only recovery tools and are not public
routes.

## Scoped access

The public experience is read/explore plus normal browser-wallet flows on test
funds. Privy delegated signing is not enabled merely because app credentials
exist. It requires the missing wallet/policy resources and a completed live
acceptance matrix from TASK1009-002. A single funded operator wallet must not be
shared with arbitrary visitors; any writable live session is presenter-scoped
and authenticated.
