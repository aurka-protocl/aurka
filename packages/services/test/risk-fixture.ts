import { FIXTURE_ADDRESSES, FIXTURE_POSITION_ID } from "../src/fixture.js";
import { hashBytes } from "../src/solver/hash.js";
const BLOCK_HASH = `0x${"10".repeat(32)}`;

export function request(sourceId: string, metricValue: string) {
  return {
    id: `${sourceId}:100`,
    sourceId,
    sourceKind: "FIXTURE" as const,
    chainId: 31337,
    deploymentId: "fixture-deployment",
    schemaVersion: "risk-v1",
    queryVersion: "observations-v1",
    signal: "DEX_LIQUIDITY" as const,
    metricValue,
    sampleSize: "10",
    affectedAssets: [FIXTURE_ADDRESSES.usdc],
    indexedBlock: "100",
    indexedBlockHash: BLOCK_HASH,
    observedAt: 200,
    retrievedAt: 200,
    finality: "FINAL" as const,
    payloadHash: hashBytes(`payload:${sourceId}`),
    payload: { sourceId, metricValue },
  };
}

export function body() {
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
      failSafeMode: "CAUTIOUS" as const,
      recoveryQuorum: 2,
      cooldownSeconds: 30,
      thresholds: [
        {
          signal: "DEX_LIQUIDITY" as const,
          cautiousAt: "-10",
          shockAt: "-20",
          pauseAt: "-30",
          affectedAssets: [FIXTURE_ADDRESSES.usdc],
          reasonCode: "LIQUIDITY_DECLINE",
        },
      ],
      boundSets: [
        {
          mode: "NORMAL" as const,
          maximumTradeValue: "50000",
          activeBounds: bounds,
        },
        {
          mode: "CAUTIOUS" as const,
          maximumTradeValue: "37500",
          activeBounds: bounds,
        },
        {
          mode: "SHOCK" as const,
          maximumTradeValue: "20000",
          activeBounds: bounds,
        },
        {
          mode: "PAUSED" as const,
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
