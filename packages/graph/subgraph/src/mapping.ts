/**
 * Mapping identity rules used by the generated subgraph mapping. The runtime
 * adapter keeps the same identity format so replay and Graph results can be
 * compared without relying on entity arrival order.
 */
export function entityId(
  chainId: number,
  contract: string,
  transactionHash: string,
  logIndex: number,
): string {
  return `${chainId}:${contract.toLowerCase()}:${transactionHash.toLowerCase()}:${logIndex}`;
}

export interface IndexedEvent {
  readonly chainId: number;
  readonly contract: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The production Graph AssemblyScript mapping uses this same event identity.
 * Keeping the projection normalizer free of arrival-order state makes replay,
 * duplicate delivery, and replacement-block tests deterministic.
 */
export function mapIndexedEvent(event: IndexedEvent): Record<string, unknown> {
  return {
    id: entityId(
      event.chainId,
      event.contract,
      event.transactionHash,
      event.logIndex,
    ),
    chainId: event.chainId,
    contract: event.contract.toLowerCase(),
    blockNumber: event.blockNumber.toString(),
    blockHash: event.blockHash.toLowerCase(),
    transactionHash: event.transactionHash.toLowerCase(),
    logIndex: event.logIndex,
    eventName: event.name,
    ...event.payload,
  };
}

// Handler names are kept explicit so the manifest and the replay harness share
// one reviewed event surface. A deployment-specific AssemblyScript wrapper can
// convert graph-ts events to IndexedEvent without changing these identities.
export function handleTradeExecuted(
  event: IndexedEvent,
): Record<string, unknown> {
  return mapIndexedEvent(event);
}

export function handleFeesRouted(event: IndexedEvent): Record<string, unknown> {
  return mapIndexedEvent(event);
}

export function handleRiskModeChanged(
  event: IndexedEvent,
): Record<string, unknown> {
  return mapIndexedEvent(event);
}

export function handlePolicyMutation(
  event: IndexedEvent,
): Record<string, unknown> {
  return mapIndexedEvent(event);
}
