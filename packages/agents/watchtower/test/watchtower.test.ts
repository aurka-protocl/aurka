import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import riskVector from "../../../shared/test-vectors/risk.json" with { type: "json" };

import {
  evaluateRisk,
  hashActiveBounds,
  hashRiskCertificate,
  prepareRiskCertificate,
  type WatchtowerConfiguration,
  type WatchtowerObservation,
} from "../src/index.js";

const HASH = `0x${"11".repeat(32)}`;
const TOKEN = `0x${"22".repeat(20)}`;
const CONFIG: WatchtowerConfiguration = {
  version: "risk-v1",
  maxObservationAgeSeconds: 100,
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
      affectedAssets: [TOKEN],
      reasonCode: "LIQUIDITY_DECLINE",
    },
  ],
  boundSets: [
    {
      mode: "NORMAL",
      maximumTradeValue: "1000",
      activeBounds: [
        {
          token: TOKEN,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
          paused: false,
        },
      ],
    },
    {
      mode: "CAUTIOUS",
      maximumTradeValue: "750",
      activeBounds: [
        {
          token: TOKEN,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
          paused: false,
        },
      ],
    },
    {
      mode: "SHOCK",
      maximumTradeValue: "400",
      activeBounds: [
        {
          token: TOKEN,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
          paused: false,
        },
      ],
    },
    {
      mode: "PAUSED",
      maximumTradeValue: "0",
      activeBounds: [
        {
          token: TOKEN,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
          paused: true,
        },
      ],
    },
  ],
};

function observation(
  sourceId: string,
  metricValue: string,
): WatchtowerObservation {
  return {
    id: `${sourceId}-1`,
    sourceId,
    sourceKind: "FIXTURE",
    chainId: 31_337,
    deploymentId: "deployment",
    schemaVersion: "schema-v1",
    queryVersion: "query-v1",
    signal: "DEX_LIQUIDITY",
    metricValue,
    sampleSize: "10",
    affectedAssets: [TOKEN],
    indexedBlock: "100",
    indexedBlockHash: HASH,
    observedAt: 900,
    retrievedAt: 900,
    finality: "FINAL",
    payloadHash: HASH,
    payload: { metricValue },
  };
}

function input(
  observations: readonly WatchtowerObservation[],
  nowSeconds = 900,
) {
  return {
    observations,
    configuration: CONFIG,
    hardMaximumTradeValue: "1000",
    hardBounds: CONFIG.boundSets[0]!.activeBounds,
    chainId: 31_337,
    deploymentId: "deployment",
    canonicalBlock: 100n,
    canonicalBlockHashes: { "100": HASH },
    nowSeconds,
  };
}

describe("deterministic watchtower", () => {
  it("requires quorum and triggers at threshold exact values", () => {
    expect(
      evaluateRisk(input([observation("a", "-10"), observation("b", "-10")]))
        .mode,
    ).toBe("CAUTIOUS");
    expect(
      evaluateRisk(input([observation("a", "-9"), observation("b", "-9")]))
        .mode,
    ).toBe("NORMAL");
    expect(
      evaluateRisk(input([observation("a", "-20"), observation("b", "-20")]))
        .mode,
    ).toBe("SHOCK");
  });

  it("fails safe for stale, reorged, or missing evidence", () => {
    expect(evaluateRisk(input([])).mode).toBe("CAUTIOUS");
    expect(
      evaluateRisk(
        input([
          observation("a", "0"),
          { ...observation("b", "0"), observedAt: 700 },
        ]),
      ).failSafe,
    ).toBe(true);
    expect(
      evaluateRisk({
        ...input([observation("a", "0")]),
        canonicalBlockHashes: { "100": `0x${"33".repeat(32)}` },
      }).mode,
    ).toBe("CAUTIOUS");
  });

  it("does not loosen before cooldown and commits exact bounds", async () => {
    const shock = evaluateRisk(
      input([observation("a", "-20"), observation("b", "-20")]),
    );
    const held = evaluateRisk({
      ...input([observation("a", "0"), observation("b", "0")]),
      currentState: {
        mode: shock.mode,
        activeBounds: shock.selectedBounds,
        activeBoundsHash: shock.activeBoundsHash,
        sourceDigest: shock.sourceDigest,
        maximumTradeValue: shock.maximumTradeValue,
        changedAt: 900,
        cooldownUntil: 930,
      },
    });
    expect(held.mode).toBe("SHOCK");
    const recovered = evaluateRisk({
      ...input([observation("a", "0"), observation("b", "0")], 940),
      currentState: {
        mode: shock.mode,
        activeBounds: shock.selectedBounds,
        activeBoundsHash: shock.activeBoundsHash,
        sourceDigest: shock.sourceDigest,
        maximumTradeValue: shock.maximumTradeValue,
        changedAt: 900,
        cooldownUntil: 930,
      },
    });
    expect(recovered.mode).toBe("NORMAL");
    expect(recovered.activeBoundsHash).toBe(
      hashActiveBounds(recovered.selectedBounds),
    );
    const certificate = await prepareRiskCertificate({
      policyId: HASH,
      chainId: 31_337,
      verifyingContract: TOKEN,
      evaluation: recovered,
      issuedAt: 940,
      expiresAt: 1_000,
      nonce: "1",
      watchtower: TOKEN,
      watchtowerAuthorizationEpoch: "1",
      policyNonce: "1",
    });
    expect(certificate.evaluation.activeBoundsHash).toBe(
      recovered.activeBoundsHash,
    );
  });

  it("matches the shared EIP-712 v2 risk certificate vector", () => {
    const evaluation = {
      version: riskVector.version,
      mode: riskVector.riskMode as "CAUTIOUS",
      reasonCode: riskVector.reasonLabel,
      evidenceSummary: "vector",
      selectedBounds: riskVector.activeBounds,
      maximumTradeValue: riskVector.maximumTradeValue,
      activeBoundsHash: riskVector.activeBoundsHash,
      sourceDigest: riskVector.sourceDigest,
      evaluatedAt: riskVector.issuedAt,
      indexedThroughBlock: "1",
      affectedAssets: [] as string[],
      previousMode: "NORMAL" as const,
      validObservationCount: 1,
      sourceCount: 1,
      failSafe: false,
    } as const;
    expect(
      hashRiskCertificate({
        policyId: riskVector.policyId,
        chainId: riskVector.chainId,
        verifyingContract: riskVector.verifyingContract,
        evaluation,
        issuedAt: riskVector.issuedAt,
        expiresAt: riskVector.expiresAt,
        nonce: riskVector.nonce,
        watchtower: riskVector.watchtower,
        watchtowerAuthorizationEpoch: riskVector.watchtowerAuthorizationEpoch,
        policyNonce: riskVector.policyNonce,
      }),
    ).toBe(riskVector.eip712Digest);
  });

  it("verifies a low-s certificate signature against the configured watchtower", async () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    const address = `0x${Array.from(keccak_256(publicKey.slice(1)).slice(-20), (item) => item.toString(16).padStart(2, "0")).join("")}`;
    const evaluation = {
      version: "risk-v1",
      mode: "CAUTIOUS" as const,
      reasonCode: "LIQUIDITY_DECLINE",
      evidenceSummary: "signature",
      selectedBounds: CONFIG.boundSets[1]!.activeBounds,
      maximumTradeValue: "750",
      activeBoundsHash: hashActiveBounds(CONFIG.boundSets[1]!.activeBounds),
      sourceDigest: HASH,
      evaluatedAt: 900,
      indexedThroughBlock: "100",
      affectedAssets: [TOKEN],
      previousMode: "NORMAL" as const,
      validObservationCount: 2,
      sourceCount: 2,
      failSafe: false,
    };
    const draft = {
      policyId: HASH,
      chainId: 31_337,
      verifyingContract: TOKEN,
      evaluation,
      issuedAt: 900,
      expiresAt: 1_000,
      nonce: "1",
      watchtower: address,
      watchtowerAuthorizationEpoch: "1",
      policyNonce: "1",
    };
    const { hashRiskCertificate: digest } = await import("../src/index.js");
    const digestValue = digest(draft);
    const signed = secp256k1.sign(
      Uint8Array.from(digestValue.slice(2).match(/../g)!, (item) =>
        Number.parseInt(item, 16),
      ),
      privateKey,
      { prehash: false, format: "recovered" },
    );
    const signature = `0x${Array.from(signed.slice(1), (item) => item.toString(16).padStart(2, "0")).join("")}${(signed[0]! + 27).toString(16).padStart(2, "0")}`;
    await expect(
      prepareRiskCertificate({ ...draft, signature }),
    ).resolves.toMatchObject({ signature });
  });
});
