import { describe, expect, it } from "vitest";

import { entityId, mapIndexedEvent } from "../subgraph/src/mapping.js";

describe("AURKA subgraph mapping identity", () => {
  it("uses the canonical identity for every consumed event", () => {
    for (const name of [
      "CapacityEpochActivated",
      "FeesRouted",
      "TradeExecuted",
      "RiskModeChanged",
      "WatchtowerAuthorizationChanged",
      "PolicyCreated",
      "AssetBoundsUpdated",
      "MaximumTransactionValueUpdated",
      "FeeConfigurationUpdated",
      "PauseStatusUpdated",
      "SettlementConfigurationUpdated",
      "PriceProtectionConfigurationUpdated",
    ]) {
      const mapped = mapIndexedEvent({
        chainId: 31_337,
        contract: "0xABCD",
        transactionHash: "0x1234",
        logIndex: 7,
        blockNumber: 100n,
        blockHash: "0xBEEF",
        name,
        payload: {},
      });
      expect(mapped.id).toBe(entityId(31_337, "0xabcd", "0x1234", 7));
      expect(mapped.eventName).toBe(name);
    }
  });

  it("is invariant under hex case and preserves block provenance", () => {
    expect(
      mapIndexedEvent({
        chainId: 1,
        contract: "0xAa",
        transactionHash: "0xBb",
        logIndex: 0,
        blockNumber: 9n,
        blockHash: "0xCc",
        name: "TradeExecuted",
        payload: { proposalHash: "0x01" },
      }),
    ).toMatchObject({
      id: "1:0xaa:0xbb:0",
      blockNumber: "9",
      blockHash: "0xcc",
      proposalHash: "0x01",
    });
  });
});
