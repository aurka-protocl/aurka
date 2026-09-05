# AURKA Phase 5 persistence and indexing

`packages/services/drizzle/0000_initial.sql` is the first Drizzle SQLite
migration. `ServiceDatabase` applies migrations on startup with foreign keys,
WAL mode for file databases, and a five-second busy timeout. Large financial
values are stored as text so SQLite cannot coerce them through floating-point or
signed 64-bit representations.

Raw event identity is:

```text
(chainId, contract, transactionHash, logIndex)
```

The unique key makes replay idempotent. A checkpoint stores the last accepted
block number and hash per chain/contract. RPC reads are retried at most three
times with bounded exponential delay. A removed log is marked instead of
deleted, then derived capacity epochs are rebuilt in block/log order from the
remaining raw events. This handles duplicate delivery, process restart, and a
short reorg without treating the read model as contract authority.

The read model includes policies, managed assets, risk certificates, positions,
capacity epochs, signed intents/proposals, quotes, executions, agent roles,
idempotency responses, checkpoints, and raw events. The Phase 5 indexer does not
implement a Graph watchtower or risk scoring.
