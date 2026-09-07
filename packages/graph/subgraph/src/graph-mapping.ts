import {
  BigInt,
  Bytes,
  Entity,
  Value,
  ethereum,
  dataSource,
  store,
} from "@graphprotocol/graph-ts";

function base(event: ethereum.Event): Entity {
  const entity = new Entity();
  const chain = dataSource.context().getBigInt("chainId");
  entity.set(
    "id",
    Value.fromString(
      chain.toString() +
        ":" +
        event.address.toHexString() +
        ":" +
        event.transaction.hash.toHexString() +
        ":" +
        event.logIndex.toString(),
    ),
  );
  entity.set("chainId", Value.fromBigInt(chain));
  entity.set("contract", Value.fromBytes(event.address));
  entity.set("blockNumber", Value.fromBigInt(event.block.number));
  entity.set("blockHash", Value.fromBytes(event.block.hash));
  entity.set("transactionHash", Value.fromBytes(event.transaction.hash));
  entity.set("logIndex", Value.fromBigInt(event.logIndex));
  return entity;
}
function save(kind: string, entity: Entity): void {
  store.set(kind, entity.get("id")!.toString(), entity);
}

export function handleFeesRouted(event: ethereum.Event): void {
  const entity = base(event);
  entity.set(
    "proposalHash",
    Value.fromBytes(event.parameters[0].value.toBytes()),
  );
  entity.set("feeToken", Value.fromBytes(event.parameters[1].value.toBytes()));
  entity.set("solver", Value.fromBytes(event.parameters[2].value.toBytes()));
  entity.set(
    "protocolRecipient",
    Value.fromBytes(event.parameters[3].value.toBytes()),
  );
  entity.set(
    "solverAmount",
    Value.fromBigInt(event.parameters[4].value.toBigInt()),
  );
  entity.set(
    "protocolAmount",
    Value.fromBigInt(event.parameters[5].value.toBigInt()),
  );
  entity.set(
    "treasuryAmount",
    Value.fromBigInt(event.parameters[6].value.toBigInt()),
  );
  save("FeesRouted", entity);
}
export function handleTradeExecuted(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set(
    "positionIdHash",
    Value.fromBytes(event.parameters[1].value.toBytes()),
  );
  entity.set(
    "intentHash",
    Value.fromBytes(event.parameters[2].value.toBytes()),
  );
  entity.set(
    "proposalHash",
    Value.fromBytes(event.parameters[3].value.toBytes()),
  );
  entity.set(
    "capacityEpochId",
    Value.fromBytes(event.parameters[4].value.toBytes()),
  );
  entity.set("trader", Value.fromBytes(event.parameters[5].value.toBytes()));
  entity.set("treasury", Value.fromBytes(event.parameters[6].value.toBytes()));
  entity.set(
    "traderInputToken",
    Value.fromBytes(event.parameters[7].value.toBytes()),
  );
  entity.set(
    "traderOutputToken",
    Value.fromBytes(event.parameters[8].value.toBytes()),
  );
  entity.set(
    "traderInputValue",
    Value.fromBigInt(event.parameters[9].value.toBigInt()),
  );
  entity.set(
    "traderOutputValue",
    Value.fromBigInt(event.parameters[10].value.toBigInt()),
  );
  entity.set(
    "treasuryOutputValue",
    Value.fromBigInt(event.parameters[11].value.toBigInt()),
  );
  entity.set(
    "totalFeeAmount",
    Value.fromBigInt(event.parameters[12].value.toBigInt()),
  );
  entity.set(
    "consumedBefore",
    Value.fromBigInt(event.parameters[13].value.toBigInt()),
  );
  entity.set(
    "consumedAfter",
    Value.fromBigInt(event.parameters[14].value.toBigInt()),
  );
  entity.set(
    "expectedPostStateHash",
    Value.fromBytes(event.parameters[15].value.toBytes()),
  );
  save("TradeExecuted", entity);
  const observation = new Entity();
  const id = entity.get("id")!.toString();
  observation.set("id", Value.fromString(id));
  observation.set("sourceId", Value.fromString("aurka-protocol"));
  observation.set("sourceKind", Value.fromString("AURKA_SUBGRAPH"));
  observation.set(
    "chainId",
    Value.fromBigInt(dataSource.context().getBigInt("chainId")),
  );
  observation.set("deploymentId", Value.fromString("manifest"));
  observation.set("schemaVersion", Value.fromString("risk-v1"));
  observation.set("queryVersion", Value.fromString("observations-v1"));
  observation.set("signal", Value.fromString("AURKA_EXECUTIONS"));
  observation.set("metricValue", Value.fromBigInt(BigInt.fromI32(1)));
  observation.set("sampleSize", Value.fromBigInt(BigInt.fromI32(1)));
  observation.set(
    "affectedAssets",
    Value.fromBytesArray([
      event.parameters[7].value.toBytes(),
      event.parameters[8].value.toBytes(),
    ]),
  );
  observation.set("indexedBlock", Value.fromBigInt(event.block.number));
  observation.set("indexedBlockHash", Value.fromBytes(event.block.hash));
  observation.set("observedAt", Value.fromBigInt(event.block.timestamp));
  observation.set("payloadHash", Value.fromBytes(event.transaction.hash));
  observation.set(
    "payload",
    Value.fromBytes(
      Bytes.fromUTF8(
        '{"transactionHash":"' + event.transaction.hash.toHexString() + '"}',
      ),
    ),
  );
  save("RiskObservation", observation);
}
export function handleRiskModeChanged(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("riskMode", Value.fromI32(event.parameters[1].value.toI32()));
  entity.set(
    "maximumTradeValue",
    Value.fromBigInt(event.parameters[2].value.toBigInt()),
  );
  entity.set(
    "expiresAt",
    Value.fromBigInt(event.parameters[3].value.toBigInt()),
  );
  entity.set("nonce", Value.fromBigInt(event.parameters[4].value.toBigInt()));
  entity.set(
    "watchtower",
    Value.fromBytes(event.parameters[5].value.toBytes()),
  );
  entity.set(
    "certificateHash",
    Value.fromBytes(event.parameters[6].value.toBytes()),
  );
  save("RiskModeChanged", entity);
}
export function handleAssetAdded(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("AssetAdded"));
  entity.set("nonce", Value.fromBigInt(event.parameters[5].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleTreasuryUpdated(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("TreasuryUpdated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[3].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleGovernanceTransferStarted(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("GovernanceTransferStarted"));
  entity.set("nonce", Value.fromBigInt(BigInt.zero()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleGovernanceTransferred(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("GovernanceTransferred"));
  entity.set("nonce", Value.fromBigInt(event.parameters[3].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handlePolicyCreated(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("PolicyCreated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[3].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleAssetBoundsUpdated(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("AssetBoundsUpdated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[4].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleMaximumTransactionValueUpdated(
  event: ethereum.Event,
): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("MaximumTransactionValueUpdated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[2].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleFeeConfigurationUpdated(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("FeeConfigurationUpdated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[1].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handlePauseStatusUpdated(event: ethereum.Event): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("PauseStatusUpdated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[2].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handleSettlementConfigurationUpdated(
  event: ethereum.Event,
): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set("eventName", Value.fromString("SettlementConfigurationUpdated"));
  entity.set("nonce", Value.fromBigInt(event.parameters[4].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
export function handlePriceProtectionConfigurationUpdated(
  event: ethereum.Event,
): void {
  const entity = base(event);
  entity.set("policyId", Value.fromBytes(event.parameters[0].value.toBytes()));
  entity.set(
    "eventName",
    Value.fromString("PriceProtectionConfigurationUpdated"),
  );
  entity.set("nonce", Value.fromBigInt(event.parameters[3].value.toBigInt()));
  entity.set("payload", Value.fromBytes(event.transaction.input));
  save("PolicyMutation", entity);
}
