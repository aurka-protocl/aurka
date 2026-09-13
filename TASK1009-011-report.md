# TASK1009-011 report

## Implementation

- Added a narrow provider transport boundary and Vertex adapter using
  `@google/genai` in Vertex mode. Hosted configuration selects the explicit
  `gemini-3.1-flash-lite` model in the `global` location. OpenRouter remains an
  explicit local option; Vertex failures never fall back to OpenRouter or test
  mode.
- Kept the existing discovery, Space-condition, deterministic quote and
  simulation tools. Gemini function calls, multi-turn tool messages and thought
  signatures are mapped at the adapter boundary; private reasoning is not
  returned to the UI.
- Added durable owner/agent/session activity events, deduplication, paginated
  authenticated activity and status endpoints, provider/model/latency/token
  telemetry, daily owner/global request-token reservations, and bounded tool
  context.
- Added persisted evaluation timestamps, next-run scheduling, exponential retry
  backoff with jitter, a one-evaluation global concurrency default, and a
  180-second worker lease. Worker shutdown clears scheduling without starting a
  final tick.
- Added activity UI to the Agent page. It shows state, provider/model, last/next
  check, remaining budget, confirmed trades, expiry and compact owner-scoped
  events with Sepolia transaction links. Polling pauses while the page is hidden
  and cached activity is cleared on account changes.
- Fixed per-user delegated operation so a legacy singleton Privy wallet is not
  required when the durable per-user wallet resolver is configured.

## Exact model and pricing source

The selected model is `gemini-3.1-flash-lite`; no `gemini-3.6-flash-lite` ID is
used. Google documents this model's function calling and structured output on
the
[Gemini 3.1 Flash-Lite model page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite).
Current standard global pricing checked on 2026-09-12 is
$0.25 per million
input tokens and $1.50 per million output tokens, from
[Vertex AI pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).
The adapter uses the official
[Google Gen AI Node SDK Vertex mode](https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview).

## GCP actions

- Project: `gapwise-505217`.
- VM: `aurka-sepolia-api`, zone `us-central1-a`.
- Confirmed `aiplatform.googleapis.com` enabled and project billing enabled.
- The VM originally used the default Compute Engine service account with only
  `roles/editor` and no OAuth scopes in its instance configuration.
- Created `aurka-vertex-runtime@gapwise-505217.iam.gserviceaccount.com`, granted
  `roles/aiplatform.user`, attached it to the VM, and restored the
  `cloud-platform` OAuth scope. No service-account key was created or copied.
- ADC probe from inside the API container returned a valid short-lived token
  without printing it. A minimal prediction probe from that same container
  returned HTTP 200 with model version `gemini-3.1-flash-lite`.

The runtime env now contains the non-secret Vertex settings and keeps
`AURKA_AGENT_TEST_MODE=false`. Existing server-only Privy values were preserved
in place and were not copied into the repository or local build context.

## Caps and operational defaults

`AURKA_AI_MAX_TOOL_ROUNDS=4`, `AURKA_AI_MAX_CONCURRENCY=1`,
`AURKA_AI_TIMEOUT_MS=60000`, owner daily request/token caps `100/100000`, global
daily request/token caps `500/500000`, worker scan interval 15 seconds, and
worker lease 180 seconds. Paid model evaluations are gated by durable
`nextCheckAt`, so the scan interval is not the paid-call interval.

## Verification

Passed:

```text
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @aurka/shared test       # 60 passed
pnpm --filter @aurka/services test     # 127 passed
pnpm --filter @aurka/trader-app test   # 19 passed
```

The Vertex transport fixture tests cover function-call mapping,
thought-signature preservation, usage mapping, explicit provider selection and
rejection of an unknown provider. The workspace reports Node 23.3.0 locally
while the project engine and deployment image use Node 24; the commands emitted
the existing engine warning locally.

## Manual guide

1. Open the Trader app and connect the owner wallet to Sepolia.
2. On Automated trading, create the private trading wallet, add the displayed
   starting balance, choose a supported Space and pair, review the limits, and
   approve/start the rules.
3. The Agent activity card shows why a check is waiting, the next scheduled
   check, budget and expiry. Submitted and confirmed operations include a
   Sepolia explorer link.
4. Stop from the trading status card. Wait for stop confirmation before using
   the owner-approved recovery action to return reviewed test balances.

## Hosted acceptance and remaining blockers

The code, GCP ADC path and live Vertex prediction path are verified. Full
TASK1009-011 completion remains gated by a real owner-controlled hosted
demonstration: browser authentication, a real per-user Privy wallet with
approved funding and mandate, Vertex tool-call evaluation, Privy signing, a
Sepolia settlement receipt, browser-close worker continuation, stop/revocation,
recovery receipt, and a second-owner isolation check. Those actions require a
wallet/funds and owner signatures, so no deterministic test-mode transaction is
being presented as Vertex acceptance. Keep the task metadata `complete: false`
until those receipts and activity IDs are captured.

The final image `aurka-sepolia:task1009-011-final` is active on the configured
VM. Its compiled Vertex adapter completed an in-container function-tool request
with ADC (`provider=vertex`, model `gemini-3.1-flash-lite`), and the deployed
database contains both `agent_activity_events` and `agent_provider_usage`. The
hosted API health gate is currently blocked before HTTP startup by the existing
Sepolia Alchemy RPC quota: the app's initial `eth_getLogs`/`eth_call` snapshot
requests receive HTTP 429, so the API container restarts and the edge
returns 502. This is recorded as a deployment blocker rather than bypassed with
OpenRouter or test mode.

The full workspace `pnpm test` run passed (237 tests), and the affected source
files pass targeted Prettier checks. The repository-wide `pnpm format:check`
still reports only the two generated `.aurka` runtime JSON files, which were
left untouched to preserve existing local state.
