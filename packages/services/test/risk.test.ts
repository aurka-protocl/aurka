import { describe, expect, it } from "vitest";

import {
  closeApiServer,
  createApiServer,
  listenApiServer,
} from "../src/api/server.js";
import { FIXTURE_ADDRESSES, FIXTURE_POSITION_ID } from "../src/fixture.js";
import { hashBytes } from "../src/solver/hash.js";
import { AurkaService } from "../src/service.js";

const BLOCK_HASH = `0x${"10".repeat(32)}`;

function request(sourceId: string, metricValue: string) {
  return {
    id: `${sourceId}:100`,
    sourceId,
    sourceKind: "FIXTURE",
    chainId: 31337,
    deploymentId: "fixture-deployment",
    schemaVersion: "risk-v1",
    queryVersion: "observations-v1",
    signal: "DEX_LIQUIDITY",
    metricValue,
    sampleSize: "10",
    affectedAssets: [FIXTURE_ADDRESSES.usdc],
    indexedBlock: "100",
    indexedBlockHash: BLOCK_HASH,
    observedAt: 200,
    retrievedAt: 200,
    finality: "FINAL",
    payloadHash: hashBytes(`payload:${sourceId}`),
    payload: { sourceId, metricValue },
  };
}

function body() {
  const bounds = [
    {
      token: FIXTURE_ADDRESSES.usdc,
      minimumWeightBps: 5_500,
      maximumWeightBps: 10_000,
      paused: false,
    },
    {
      token: FIXTURE_ADDRESSES.weth,
      minimumWeightBps: 0,
      maximumWeightBps: 3_500,
      paused: false,
    },
    {
      token: FIXTURE_ADDRESSES.link,
      minimumWeightBps: 0,
      maximumWeightBps: 1_500,
      paused: false,
    },
  ];
  return {
    positionId: FIXTURE_POSITION_ID,
    observations: [request("dex-a", "-10"), request("dex-b", "-10")],
    configuration: {
      version: "risk-v1",
      maxObservationAgeSeconds: 120,
      maxIndexedLagBlocks: 2,
      minimumSampleSize: "10",
      requiredQuorum: 2,
      failSafeMode: "CAUTIOUS",
      recoveryQuorum: 2,
      cooldownSeconds: 30,
      thresholds: [
        {
          signal: "DEX_LIQUIDITY",
          cautiousAt: "-10",
          shockAt: "-20",
          pauseAt: "-30",
          affectedAssets: [FIXTURE_ADDRESSES.usdc],
          reasonCode: "LIQUIDITY_DECLINE",
        },
      ],
      boundSets: [
        { mode: "NORMAL", maximumTradeValue: "50000", activeBounds: bounds },
        { mode: "CAUTIOUS", maximumTradeValue: "37500", activeBounds: bounds },
        { mode: "SHOCK", maximumTradeValue: "20000", activeBounds: bounds },
        {
          mode: "PAUSED",
          maximumTradeValue: "0",
          activeBounds: bounds.map((item) => ({ ...item, paused: true })),
        },
      ],
    },
    hardMaximumTradeValue: "50000",
    hardBounds: bounds,
    chainId: 31337,
    deploymentId: "fixture-deployment",
    canonicalBlock: "100",
    canonicalBlockHashes: { "100": BLOCK_HASH },
    nowSeconds: 200,
  };
}

describe("risk API persistence boundary", () => {
  it("evaluates through the idempotent API and exposes the effective state", async () => {
    const service = new AurkaService();
    const handle = createApiServer({ service });
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("API did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const payload = body();
      const first = await fetch(`${base}/v1/risk/evaluate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "risk-1",
        },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      const firstJson = (await first.json()) as {
        data: { evaluation: { mode: string } };
      };
      expect(firstJson.data.evaluation.mode).toBe("CAUTIOUS");
      const replay = await fetch(`${base}/v1/risk/evaluate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "risk-1",
        },
        body: JSON.stringify(payload),
      });
      expect(replay.status).toBe(200);
      const risk = await fetch(`${base}/v1/risk/${FIXTURE_POSITION_ID}`);
      expect(risk.status).toBe(200);
      expect(
        ((await risk.json()) as { data: { effective: { mode: string } } }).data
          .effective.mode,
      ).toBe("CAUTIOUS");
    } finally {
      await closeApiServer(handle);
    }
  });
});
