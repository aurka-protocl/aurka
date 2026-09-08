# Activity and earned-fee read model

The service exposes `GET /v1/activity` for the local public/demo scope and
`GET /v1/positions/{id}/fees` for a named treasury configuration. These are
read-only endpoints; they do not infer a caller identity from a supplied
address. A deployment with private positions must add an authorization layer
before exposing those records.

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
active, paired, accounting-reconciling record.
