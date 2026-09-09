# Activity and earned-fee read model

The service exposes `GET /v1/activity` for the local public/demo scope and
`GET /v1/positions/{id}/fees` for a named treasury configuration. These are
read-only endpoints; they do not infer a caller identity from a supplied
address. A deployment with private positions must add an authorization layer
before exposing those records.

## Supported activity types

`GET /v1/activity` returns one of these explicit `type` values:

- `SWAP`: a prepared, pending, failed, confirmed, or orphaned trade attempt. A
  confirmed swap is emitted only after its `TradeExecuted` and `FeesRouted`
  records are joined.
- `RULE_CHANGE`: a durable owner-authenticated Space create, rule update, or
  activation record.
- `TRADING_STATUS`: a durable pause, resume, or setup-failure record.

Space changes retain their event type, actor, timestamp, status, resulting
state, and optional receipt hash. A draft creation or draft rule edit remains a
draft activity record; it is not rewritten as a confirmed policy update from the
Space's current state. Swap-only fields such as token pair, intent, and proposal
are not required on these records.

The query supports `spaceId` (with legacy `positionId` retained), `type`,
`status`, `chainId`, `from`, `to`, and the existing stable cursor/limit. The
frontend persists these filters in the `/activity` URL and uses the same feed
component for Space Overview's Recent activity.

## Lifecycle ownership

| Display state | Source                                                                           | Meaning                                                                        |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Prepared      | service `executions` row with `submissionState=PREPARED`                         | Unsigned or otherwise not broadcast; no chain evidence and no earned fee       |
| Pending       | service `executions` row with `submissionState=SUBMITTED`                        | A real transaction is known but no qualifying receipt pair is indexed          |
| Confirmed     | canonical `TradeExecuted` + `FeesRouted` logs joined by transaction and proposal | Both settlement and fee accounting evidence are present on the canonical chain |
| Failed        | execution row with `REVERTED` or `DROPPED`                                       | The service recorded a failed or dropped attempt; no earned fee                |
| Orphaned      | previously projected settlement whose canonical log was removed                  | Retained for audit context and excluded from fee totals                        |

Quotes and proposals are not activity by themselves. A prepared execution may
show an estimated fee breakdown, but only a confirmed event pair can produce an
earned treasury fee.

## Fee accounting

`FeesRouted` recipient amounts and `TradeExecuted.totalFeeAmount` are normalized
settlement-value units. The API groups the retained treasury amount by
`feeToken`, reports the solver and protocol shares separately, and never adds
amounts across unlike tokens or labels them as dollars. The aggregation period
and the first/last observed event timestamps are returned with the summary.

The projection is keyed by `(chain, router, transaction, proposal)`. Duplicate
logs update the same row. A removed log marks its settlement orphaned, so the
activity feed preserves the lifecycle transition while the fee query requires an
active, paired, accounting-reconciling record. Space mutation projections use
the existing durable `space_changes` records and are not reconstructed from
current Space state.
