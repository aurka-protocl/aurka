# Financial display contract

The apps use the existing shared response schemas as their source of truth.
Presentation helpers in `packages/shared/src/presentation.ts` format values for
people but do not calculate quotes, capacity, prices, or policy outcomes.

## Field-to-source map

| User-facing value                   | Authoritative source                                                                                    | Unit / interpretation                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token balance                       | `Position.currentPortfolio.assets[].balance`                                                            | Smallest token unit; render with the same asset’s `decimals`.                                                                                           |
| Token price                         | `Quote.referencePrice` and `referencePriceDecimals`, or an asset snapshot’s `price` and `priceDecimals` | Quote units per whole token. The UI does not infer USD.                                                                                                 |
| Portfolio value                     | `PortfolioSnapshot.nav` and `valueDecimals`                                                             | Normalized settlement value units. The current fixture uses scale 0; the denomination is not established.                                               |
| Asset value                         | `PortfolioSnapshot.assets[].value` and parent `valueDecimals`                                           | Normalized settlement value units at the snapshot.                                                                                                      |
| Allocation                          | `PortfolioSnapshot.assets[].weightBps`                                                                  | Integer basis points; 10,000 bps is 100%.                                                                                                               |
| Allocation rule                     | `Position.policy.assets[].minimumWeightBps` / `maximumWeightBps`                                        | Integer basis points, read-only policy data.                                                                                                            |
| Per-trade cap                       | `Position.policy.maximumTransactionValue`                                                               | Normalized settlement value units; not a token balance.                                                                                                 |
| Requested / safe / executable value | `Quote.requestedTraderInputAmount`, `maximumSafeTraderInputAmount`, `executableTraderInputAmount`       | Normalized settlement value units. Partial fills are explicit when executable is lower than requested.                                                  |
| Trader input/output amounts         | Solved `AtomicSettlementProposal.traderInputAmount` / `traderOutputAmount`                              | Raw token units; render using the matching portfolio asset’s `decimals` and `symbol`.                                                                   |
| Fee amount                          | `Quote.fees.totalFeeAmount` and `treasuryAmount`                                                        | Normalized settlement value units in the quote calculation. `feeToken` identifies the output-token accounting leg; it does not change the value scale.  |
| Fee rate                            | `Quote.fees.totalFeeBpsScaled`                                                                          | Basis points scaled by 10^18; preserve fractional basis points.                                                                                         |
| Binding rule                        | `Quote.bindingConstraint` and optional `bindingAsset`                                                   | Server/evaluator result; presentation maps the enum to plain language.                                                                                  |
| Before / expected after             | `Quote.currentPortfolio` / `expectedPostTradePortfolio`                                                 | Quote-backed snapshots. They are previews, not completed settlement evidence.                                                                           |
| Snapshot age / context              | `PortfolioSnapshot.observedAt`, `blockNumber`, `snapshotHash`                                           | Timestamp and chain evidence shown alongside values; stale snapshots remain marked stale.                                                               |
| Capacity                            | `DirectionalCapacity`                                                                                   | Directional value for the selected input/output pair, with `bindingConstraint`, `remainingValue`, epoch and expiry. It is not total treasury liquidity. |

## Boundaries

The local fixture is a demo with no connected wallet and no broadcast. A quote,
solve result, or unsigned transaction preparation does not mean funds moved.
Missing price denomination, unavailable history, stale snapshots, unavailable
risk authority, and missing activity are displayed as unavailable rather than
filled with inferred balances, dollars, P&L, APY, fee revenue, or protection.

Raw addresses, hashes, block identifiers, and signed-domain fields remain in
expandable technical details. A preview may show normalized value changes even
when a provider cannot supply a safe post-trade raw balance; the UI does not
invent that balance.
