# AURKA product walkthrough and manual test guide

This guide is for the local AURKA demo. It explains the complete Space and trade
journey in plain language, gives a short hackathon script, and records the
boundary between a quote/preparation and an actual settlement.

## What the demo means

The local service starts with a deterministic, organization-owned example named
**Canonical local treasury**. Its holdings and policy are fixture data returned
by the local API. The fixture is useful for explaining the product, but it is
not a wallet, live market data, a production treasury, or a claim about a real
portfolio.

The amounts below are in **normalized settlement value units**. The fixture's
value scale is `0`; no USD or other currency denomination is established. A
quote, solve result, signature, or unsigned transaction preparation is a preview
or draft. It does not submit a transaction, move funds, create fee revenue, or
prove a completed trade. The browser flow intentionally ends at the unsigned
boundary; the local settlement proof remains a separate integration check.

Effective risk authority is unavailable in this fixture. The protections page
must say that clearly. Its simulated tightening control is an isolated
illustration and must not be presented as an active risk-registry update.

## Start, refresh, and reset

Prerequisites: Node.js 23.3.0 (the version in `.node-version`) and pnpm 10.13.1.

Install and build once from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Start the API and canonical app in separate terminals:

```bash
pnpm --filter @aurka/services start
pnpm --filter @aurka/trader-app dev
```

Open:

- Canonical AURKA app: <http://127.0.0.1:3002/spaces>
- API health: <http://127.0.0.1:8787/health>

The default service uses its configured local database. For an isolated manual
run, point `DATABASE_URL` at a new temporary file when starting the API:

```bash
MANUAL_DB_DIR="$(mktemp -d)"
DATABASE_URL="$MANUAL_DB_DIR/service.sqlite" pnpm --filter @aurka/services start
```

The canonical Vite app proxies `/api` to port 8787. If the API uses another
port, export `AURKA_SERVICE_URL` before starting the app. There is no second
frontend origin or role switch.

Stop the three processes with `Ctrl-C`. To reset a manual run, stop the API and
start it with a new explicitly named temporary database directory. Remove only
that temporary directory after confirming its path; never remove a repository or
broad system directory. Ordinary browser refreshes and direct links such as
`/spaces`, `/spaces/:spaceId`, `/spaces/:spaceId/holdings`,
`/spaces/:spaceId/settings`, `/trade/:spaceId`, and `/activity` are the
canonical routes. Older `/holdings`, `/protections`, and `/swap` links remain
redirecting aliases.

## Measured end-to-end walkthrough

The following values are from the local fixture and are the values asserted by
the browser smoke test. They are not invented presentation examples.

1. **Open the demo.** Start at `/spaces`. The page says what AURKA does,
   identifies this as a local demo, and offers the next action without requiring
   a wallet, account, protocol knowledge, or an API call.

2. **Understand who supplies liquidity.** Open the configured Space and choose
   **Holdings & rules**. The selected source is **Canonical local treasury**,
   described as an organization-owned local example. The current portfolio is
   `1,000,000` value units with scale `0`:

   | Asset | Balance/value shown by the fixture | Allocation |
   | ----- | ---------------------------------: | ---------: |
   | USDC  |                            600,000 |     60.00% |
   | WETH  |                            300,000 |     30.00% |
   | LINK  |                            100,000 |     10.00% |

   The allocation chart has an equivalent text label. Rules are visible as
   ranges: USDC `55–100%`, WETH `0–35%`, and LINK `0–15%`. The per-trade cap is
   `50,000` value units. For WETH → USDC, directional capacity is `50,000` and
   the current safe maximum is also `50,000`; capacity is directional, not the
   treasury's total liquidity.

3. **Explain the boundary.** Open **Settings** for the Space. The hard policy is
   a portfolio boundary: the solver cannot propose a trade whose expected result
   violates the configured ranges or cap. It is not a guarantee against market
   losses. Settings and environment details are read-only in the demo.

4. **Request a trade.** Follow **Trade this Space** or open `/trade/:spaceId`.
   The guided form starts with WETH → USDC and requested amount `200,000`.
   Choose **Get quote**. The review says:

   - requested: `200,000 WETH`;
   - executable: `50,000 WETH`;
   - expected receive: `49,766 USDC`;
   - total fee: `234` normalized settlement value units;
   - binding rule: the `50,000` per-trade cap;
   - remainder: `150,000 WETH` is not executable under this quote.

   The fee display identifies `184` value units as the treasury-retained
   portion. It is quote evidence, not earned revenue.

5. **Read the resulting portfolio preview.** The expected post-trade preview is
   derived from the server quote, not from a browser-side guess:

   - USDC: `600,000 → 550,184`;
   - WETH: `300,000 → 350,000`;
   - LINK: `100,000 → 100,000`;
   - portfolio value: `1,000,000 → 1,000,184` value units.

   These are expected values for the proposed trade. The current holdings do not
   mutate in the browser because nothing has settled.

6. **Review and prepare.** Check the plain-language confirmation box and select
   **Prepare unsigned transaction**. The activity page records a prepared,
   unsigned item. It says that no wallet was connected, nothing was broadcast,
   and no funds moved. The treasury activity page has no confirmed fee entry; a
   prepared quote is not fee revenue.

7. **Test stale and changed state.** Change the input after a quote: the review
   is cleared and a fresh quote is required. Use **Refresh quote**: the review
   is cleared and preparation is disabled until the refreshed quote is accepted.
   Wait for the quote expiry boundary or run the automated scenario: an expired
   quote cannot be prepared, and the user must request a new quote.

8. **Find current activity and status.** Use **Activity** to distinguish no
   activity, prepared activity, and confirmed activity. In this browser flow
   only the prepared state is reached. Use **Status** to see service and
   capability diagnostics. Missing effective risk, history, live identity,
   wallet connectivity, and live settlement are shown as unavailable rather than
   filled with inferred values.

### Confirmed local-settlement path

AURKA-009 supplies a separate, successful local settlement proof. Run
`pnpm integration:local-settlement` to deploy the disposable Anvil contracts,
sign the exact intent, submit the SDK/API-generated transaction, and project the
actual receipt events. Its confirmed result is `50,000` executed value units,
`49,766` trader output value units, `184` value units retained by the treasury,
and post-settlement holdings of USDC `550,184`, WETH `350,000`, and LINK
`100,000`. The event projection consumes `50,000` directional capacity.

That command is the confirmed activity path and is intentionally separate from
the browser smoke fixture: it uses Anvil and cleans its temporary API, chain,
and database resources when finished. The browser walkthrough must continue to
describe its own prepared record as **Prepared — unsigned, not submitted** and
must not import the confirmed result into the no-RPC demo.

## Two-minute hackathon script

“AURKA lets an organization publish the portfolio boundary it is willing to
accept, then lets a trader request liquidity against that boundary. I’ll start
with the local treasury demo, so every number you see is labeled fixture data.

“The Canonical local treasury has 1,000,000 normalized value units: 600,000
USDC, 300,000 WETH, and 100,000 LINK. Its rules allow USDC from 55% to 100%,
WETH from 0% to 35%, LINK from 0% to 15%, and cap one trade at 50,000 value
units. The WETH-to-USDC capacity page makes the direction explicit.

“Now I request 200,000 WETH for USDC. The service returns a partial-fill review:
50,000 WETH is executable, 49,766 USDC is expected, and the quoted fee is 234
value units, with 184 shown as the treasury-retained portion. The remaining
150,000 WETH is outside this quote because of the per-trade cap. The preview
shows USDC moving to 550,184 and WETH to 350,000, with expected portfolio value
1,000,184.

“I confirm the review and prepare an unsigned transaction. This is where the
current browser demo stops: no wallet is connected, nothing is broadcast, and
the holdings and fee activity do not claim a completed settlement. Activity
records the prepared draft, while the protections screen separately explains
that effective risk authority is unavailable and that its liquidity-drop
illustration is simulated. That separation is the product's trust boundary.”

## Manual acceptance checklist

Run the checklist at desktop `1280px`, mobile `390px`, and narrow `320px` wide
browser viewports. Record any failure using the issue template below.

| Scenario         | Action                                                 | Expected result                                                                                                   |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Entry            | Open `/spaces`                                         | Purpose, demo status, and next actions are understandable without an account.                                     |
| Holdings         | Open `/spaces/:spaceId/holdings`                       | Source identity, balances, allocations, rules, cap, and directional capacity are visible and labeled.             |
| Rules            | Open `/spaces/:spaceId/settings`                       | Space identity and authority are visible; demo settings are accurately read-only.                                 |
| Quote            | Request the default WETH → USDC swap                   | Requested, executable, receive, fee, binding rule, partial remainder, and expected portfolio values are readable. |
| Space            | Select a different Space                               | The selected Space name and source-backed values update; no unexplained source is implied.                        |
| Changed input    | Edit the amount after a quote                          | The old review is removed and a new quote is required.                                                            |
| Refresh          | Click Refresh quote                                    | The old confirmation is cleared and preparation stays disabled until re-accepted.                                 |
| Duplicate click  | Prepare the same accepted quote twice                  | The request is idempotent and activity does not duplicate the preparation.                                        |
| Rejected request | Submit zero or another invalid amount                  | An announced, actionable error appears and the page remains usable.                                               |
| Expiry           | Wait for or simulate quote expiry, then try to prepare | Preparation is rejected/disabled and the user is directed to request a fresh quote.                               |
| Activity         | Open activity before and after preparation             | Empty activity has a useful next step; prepared activity is not called confirmed; no fee revenue is claimed.      |
| Status/error     | Stop the API, then open holdings, swap, and status     | The explanation and recovery action remain visible; errors are announced; unavailable data is not fabricated.     |
| Navigation       | Refresh and open deep links directly                   | Canonical Space, Trade, and Activity routes load without relying on prior navigation.                             |
| Layout           | Resize to all three widths                             | No page-level horizontal overflow; amounts and table/card content remain readable.                                |
| Touch            | Inspect primary controls at 390px and 320px            | Interactive targets are at least 36px in both dimensions and have visible labels.                                 |
| Keyboard         | Tab through navigation, forms, checkbox, and buttons   | Order is logical, controls are reachable, headings are semantic, and focused controls have a visible outline.     |
| Non-color cues   | Inspect statuses, warnings, and charts                 | Meaning is available in text/labels, not by color alone; allocation has a text equivalent.                        |

### Issue template

```text
Title:
Page / route:
Action:
Expected result:
Actual result:
Viewport (width × height):
Browser / OS:
Steps to reproduce:
Screenshot or recording (if useful):
Does it involve demo, prepared, or confirmed state?
```

## Automated evidence

From the repository root, run:

```bash
pnpm integration:browser-smoke
```

This command builds the workspace, starts the actual local service and the
canonical Vite app, uses a disposable database, drives the browser at
1280/390/320px, checks API-backed values and state transitions, and cleans up
its owned processes and database. It covers canonical deep links, Back/Forward,
Space-scoped quote/solve, mobile menu behavior, unknown-Space handling, API
proxy JSON, and browser page-error detection. For retained diagnostics, set
`AURKA_ARTIFACT_DIR` to an explicitly created directory before running the
runner.

Automation demonstrates reproducibility and data boundaries. It is not human
comprehension evidence.

## Human comprehension follow-up

Human testing has **not yet been performed** and no participant feedback is
recorded. Ask someone unfamiliar with AURKA to use the demo without explaining
the answers, then record their exact responses to:

1. Whose assets are shown on the holdings page?
2. What does one of the rules limit?
3. What happens when the trader requests `200,000` WETH?
4. Did funds move after the browser prepared the unsigned transaction?

Record confusion, incorrect answers, and the screen where the misunderstanding
occurred. Do not describe the automated smoke result as usability validation by
people.
