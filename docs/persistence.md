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
block number and hash per chain/contract, and every verified block header in an
indexed range is retained. RPC reads are retried at most three times with
bounded exponential delay. A removed log is marked instead of deleted, then
derived capacity epochs are rebuilt in block/log order from the remaining raw
events. On restart, a changed checkpoint walks retained headers to a canonical
common ancestor, removes the entire orphaned branch transactionally, and replays
replacement logs. This handles empty blocks as well as duplicate delivery
without treating the read model as contract authority.

The read model includes policies, managed assets, risk certificates, positions,
capacity epochs, signed intents/proposals, quotes, executions, agent roles,
versioned risk observations/evaluations, watchtower jobs, wallet policy
fingerprints, risk audit events, idempotency responses, checkpoints, and raw
events. Risk observations and decisions retain source, deployment, block,
finality, hash, and configuration provenance; no private authorization key or
Privy app secret is persisted.
