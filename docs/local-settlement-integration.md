# Local signed settlement integration

The complete local settlement check runs an isolated Anvil chain and disposable
SQLite database. It compiles the workspace and Solidity artifacts, deploys the
actual policy/risk registries, router, `MockAqua`, `MockPriceOracle`,
`AurkaDirectSwapVM`, and mixed-decimal `MockERC20` fixtures, then reads the
deployed policy and portfolio back through the snapshot provider.

Run it from the repository root:

```bash
pnpm integration:local-settlement
```

The package alias is also available:

```bash
pnpm --filter @aurka/services integration:local-settlement
```

The harness binds Anvil and the API to loopback on disposable ports, uses the
public Anvil mnemonic only for isolated fixture accounts, and removes the
temporary database and child process on success or failure. Anvil output is
discarded because it prints private keys at startup. The final JSON line reports
deployment addresses, transaction hashes, raw/normalized accounting, decoded
event count, projection replay results, and rejection cases.

The SDK obtains the intent, quote, solve result, and unsigned `/v1/execute`
request. The harness signs the returned intent hash with the disposable trader,
sends the API-returned `to`, `data`, and `value` unchanged, waits for a
successful receipt, and passes the actual router logs through the shared event
decoder and `ChainEventIndexer`. The service execution record intentionally
remains `PENDING`: this local milestone has no authorized broadcaster-owned
receipt confirmation API, so the harness never fabricates a confirmed status.
