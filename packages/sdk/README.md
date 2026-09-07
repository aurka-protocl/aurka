# @aurka/sdk

Typed browser/Node client for the AURKA service. This private workspace package
is not published to a package registry. Build dependencies with `pnpm build`
from the repository root before starting an application.

```typescript
import { AurkaClient, AurkaError } from "@aurka/sdk";
const client = new AurkaClient({
  baseUrl: "http://127.0.0.1:8787",
  timeout: 30000,
});
const page = await client.listPositions(20);
const next = page.nextCursor
  ? await client.listPositions(20, page.nextCursor)
  : null;
```

The client validates the API `{ok, data, requestId}` envelope and returns
`data`. `AurkaError` preserves the service error code, status, and details.
Transport failures use `NETWORK_ERROR`; a timeout covering headers and body uses
`TIMEOUT`; malformed JSON or a schema mismatch uses `INVALID_RESPONSE`.

Available methods: `health`, `readiness`, `listPositions`, `getPosition`,
`getCapacity`, `prepareIntent`, `submitIntent`, `getIntent`, `listProposals`,
`quote`, `solve`, `execute`, `getExecution`, `evaluateRisk`,
`saveRiskCertificate`, and `getRiskPosition`.

`prepareIntent` accepts a position, trader/token addresses, requested and
minimum output values, nonce, and deadline. The server provider supplies
authoritative policy, portfolio, price, capacity, and settlement commitments.
Unsupported providers return `PREPARATION_UNAVAILABLE`. Pass the returned
unsigned intent to `quote` or `solve`; supply the external trader signature to
`execute` with an idempotency key. Execution returns an unsigned transaction
request and does not broadcast. Amounts remain decimal strings in the shared
schema's units.

`getRiskPosition` separates `proposed`, signed `certificate`, and `effective`.
Without a verified registry read, `effective.source` is `UNAVAILABLE` and its
mode/cap are null. A certificate is not active merely because it was saved.
Readiness reports unknown indexer lag as null; fixture readiness is not a live
production readiness claim. Certificate storage requires a configured risk
registry on the service.

The apps use `{baseUrl: "/api"}`. Their Vite dev proxies forward to port 8787
and strip `/api`; production hosting must configure an equivalent reverse proxy.
No wallet credentials or server signing keys belong in browser configuration.

Tests use a real local HTTP service for envelope/error compatibility and a
stalled response body for timeout handling: `pnpm --filter @aurka/sdk test`.
