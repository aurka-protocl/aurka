import { describe, expect, it } from "vitest";
import riskVector from "../../test-vectors/risk.json" with { type: "json" };

import {
  addressSchema,
  apiResponseSchema,
  atomicSettlementIntentSchema,
  atomicSettlementProposalSchema,
  decodeProtocolEventLog,
  feeBreakdownSchema,
  hashActiveBounds,
  hashRiskCertificate,
  hashRiskReasonCode,
  parseProtocolEventPayload,
  protocolEventTopic,
  riskCertificateSchema,
  tradeIntentSchema,
  treasuryPolicySchema,
  uint256StringSchema,
} from "../index.js";

const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";
const ADDRESS_C = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}`;

function abiWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return value.slice(2).padStart(64, "0");
}

describe("primitive schemas", () => {
  it("accepts EVM addresses", () => {
    expect(addressSchema.parse(ADDRESS_A)).toBe(ADDRESS_A);
  });

  it("accepts the uint256 boundaries without JSON precision loss", () => {
    expect(uint256StringSchema.parse("0")).toBe("0");
    expect(uint256StringSchema.parse((2n ** 256n - 1n).toString())).toBe(
      (2n ** 256n - 1n).toString(),
    );
  });

  it.each(["-1", "01", "1.5", "1e18", (2n ** 256n).toString()])(
    "rejects non-canonical or overflowing uint256 value %s",
    (value) => {
      expect(uint256StringSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("policy schema", () => {
  const policy = {
    id: "policy:genesis",
    chainId: 31337,
    registry: ADDRESS_A,
    treasury: ADDRESS_B,
    governance: ADDRESS_C,
    assets: [
      {
        token: ADDRESS_A,
        symbol: "USDC",
        decimals: 6,
        minimumWeightBps: 5_500,
        maximumWeightBps: 10_000,
      },
      {
        token: ADDRESS_B,
        symbol: "WETH",
        decimals: 18,
        minimumWeightBps: 0,
        maximumWeightBps: 3_500,
      },
      {
        token: ADDRESS_C,
        symbol: "LINK",
        decimals: 18,
        minimumWeightBps: 0,
        maximumWeightBps: 1_500,
      },
    ],
    maximumTransactionValue: "50000000000",
    quoteTtlSeconds: 60,
    priceMaxAgeSeconds: 120,
    maximumPriceDeviationBps: 100,
    fee: {
      baseFeeBps: 20,
      slopeBps: 80,
      maximumFeeBps: 100,
      treasuryBaseFeeBps: 10,
      solverFeeBps: 5,
      protocolFeeBps: 5,
      treasuryFeeRecipient: ADDRESS_B,
      protocolFeeRecipient: ADDRESS_C,
    },
    nonce: "1",
    paused: false,
  };

  it("accepts the three-asset example policy", () => {
    expect(treasuryPolicySchema.parse(policy).assets).toHaveLength(3);
  });

  it("rejects duplicate managed assets case-insensitively", () => {
    const duplicate = {
      ...policy,
      assets: [policy.assets[0], { ...policy.assets[1], token: ADDRESS_A }],
    };
    expect(treasuryPolicySchema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects a mismatched base-fee distribution", () => {
    const invalid = {
      ...policy,
      fee: { ...policy.fee, solverFeeBps: 6 },
    };
    expect(treasuryPolicySchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a fee cap above the bounded 100 bps maximum", () => {
    const invalid = {
      ...policy,
      fee: { ...policy.fee, maximumFeeBps: 101 },
    };
    expect(treasuryPolicySchema.safeParse(invalid).success).toBe(false);
  });
});

describe("signed-object schemas", () => {
  it("accepts the complete atomic settlement commitments", () => {
    const intent = {
      intentId: HASH,
      policyId: HASH,
      positionIdHash: HASH,
      trader: ADDRESS_A,
      traderInputToken: ADDRESS_B,
      traderOutputToken: ADDRESS_C,
      requestedValue: "200000",
      minimumTraderOutputValue: "49700",
      exactInput: false,
      allowPartialFill: true,
      deadline: 1_800_000_000,
      nonce: "1",
      balanceSnapshot: HASH,
      priceSnapshot: HASH,
      aquaStrategyHash: HASH,
    };
    const proposal = {
      intentHash: HASH,
      solver: ADDRESS_A,
      balancesHash: HASH,
      priceSnapshotHash: HASH,
      policyNonce: "1",
      riskCertificateHash: HASH,
      traderInputToken: ADDRESS_B,
      traderOutputToken: ADDRESS_C,
      traderInputAmount: "50000",
      traderOutputAmount: "49766",
      solverFeeAmount: "25",
      protocolFeeAmount: "25",
      traderInputValue: "50000",
      traderOutputValue: "49766",
      treasuryOutputValue: "49816",
      feeBpsScaled: "46666666666666666667",
      baseFeeAmount: "100",
      treasuryBaseFeeAmount: "50",
      optionSpacePremiumAmount: "134",
      totalFeeAmount: "234",
      treasuryAmount: "184",
      solverAmount: "25",
      protocolAmount: "25",
      feeToken: ADDRESS_C,
      feePaymentMode: "OUTPUT_TOKEN" as const,
      initialPortfolioHash: HASH,
      capacityBaselineValue: "50000",
      consumedBefore: "0",
      consumedAfter: "50000",
      capacityEpochId: HASH,
      utilizationBefore: "0",
      utilizationAfter: "1000000000000000000",
      bindingConstraint: "TRANSACTION_CAP" as const,
      expectedPostStateHash: HASH,
      aquaStrategyHash: HASH,
      swapVMCalldataHash: HASH,
      deadline: 1_800_000_000,
    };
    expect(atomicSettlementIntentSchema.parse(intent)).toMatchObject(intent);
    expect(atomicSettlementProposalSchema.parse(proposal)).toMatchObject(
      proposal,
    );
  });

  it("rejects same-token trade intents", () => {
    const intent = {
      intentId: HASH,
      chainId: 1,
      verifyingContract: ADDRESS_A,
      trader: ADDRESS_B,
      positionId: "position:1",
      traderInputToken: ADDRESS_C,
      traderOutputToken: ADDRESS_C,
      requestedTraderInputAmount: "200000000000",
      exactInput: false,
      allowPartialFill: true,
      minimumAcceptableTraderOutput: "0",
      deadline: 1_800_000_000,
      nonce: "1",
    };
    expect(tradeIntentSchema.safeParse(intent).success).toBe(false);
  });

  it("rejects risk certificates with invalid validity windows", () => {
    const certificate = {
      policyId: HASH,
      chainId: 1,
      verifyingContract: ADDRESS_A,
      signatureVersion: 2,
      riskMode: "CAUTIOUS",
      activeBounds: [],
      activeBoundsHash: HASH,
      maximumTradeValue: "37500000000",
      sourceDigest: HASH,
      reasonCode: HASH,
      issuedAt: 1_800_000_000,
      expiresAt: 1_799_999_999,
      nonce: "2",
      watchtower: ADDRESS_B,
      watchtowerAuthorizationEpoch: "1",
      policyNonce: "1",
    };
    expect(riskCertificateSchema.safeParse(certificate).success).toBe(false);
  });

  it("requires the current certificate signature version and authority epochs", () => {
    const certificate = {
      policyId: HASH,
      chainId: 1,
      verifyingContract: ADDRESS_A,
      signatureVersion: 2,
      riskMode: "CAUTIOUS",
      activeBounds: [],
      activeBoundsHash: HASH,
      maximumTradeValue: "37500000000",
      sourceDigest: HASH,
      reasonCode: HASH,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_100,
      nonce: "2",
      watchtower: ADDRESS_B,
      watchtowerAuthorizationEpoch: "1",
      policyNonce: "1",
    };
    expect(riskCertificateSchema.parse(certificate)).toMatchObject(certificate);
    expect(
      riskCertificateSchema.safeParse({ ...certificate, signatureVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      riskCertificateSchema.safeParse({
        ...certificate,
        watchtowerAuthorizationEpoch: undefined,
      }).success,
    ).toBe(false);
  });

  it("matches the language-neutral RiskModeRegistry v2 vector", () => {
    expect(hashActiveBounds(riskVector.activeBounds)).toBe(
      riskVector.activeBoundsHash,
    );
    expect(hashRiskReasonCode(riskVector.reasonLabel)).toBe(
      riskVector.reasonCode,
    );
    expect(
      hashRiskCertificate({
        policyId: riskVector.policyId,
        chainId: riskVector.chainId,
        verifyingContract: riskVector.verifyingContract,
        riskMode: riskVector.riskMode as "CAUTIOUS",
        activeBoundsHash: riskVector.activeBoundsHash,
        maximumTradeValue: riskVector.maximumTradeValue,
        sourceDigest: riskVector.sourceDigest,
        reasonCode: riskVector.reasonCode,
        issuedAt: riskVector.issuedAt,
        expiresAt: riskVector.expiresAt,
        nonce: riskVector.nonce,
        watchtower: riskVector.watchtower,
        watchtowerAuthorizationEpoch: riskVector.watchtowerAuthorizationEpoch,
        policyNonce: riskVector.policyNonce,
      }),
    ).toBe(riskVector.eip712Digest);
  });
});

describe("response and accounting schemas", () => {
  it("accepts only the canonical settlement event payload", () => {
    const payload = {
      policyId: HASH,
      positionIdHash: HASH,
      traderInputToken: ADDRESS_A,
      traderOutputToken: ADDRESS_B,
      capacityEpochId: HASH,
      capacityBaselineValue: "50000",
      policyNonce: "2",
      riskCertificateHash: HASH,
      balanceSnapshot: HASH,
      priceSnapshot: HASH,
      portfolioPriceSnapshot: HASH,
      aquaStrategyHash: HASH,
      consumedBefore: "0",
    };
    expect(
      parseProtocolEventPayload("CapacityEpochActivated", payload),
    ).toEqual(payload);
    expect(() =>
      parseProtocolEventPayload("CapacityEpochActivated", {
        ...payload,
        positionId: "position:old-wire-format",
      }),
    ).toThrow();
  });

  it("validates discriminated API responses", () => {
    const schema = apiResponseSchema(uint256StringSchema);
    expect(schema.parse({ ok: true, data: "42" })).toEqual({
      ok: true,
      data: "42",
    });
    expect(
      schema.parse({
        ok: false,
        error: { code: "NOT_FOUND", message: "Position was not found" },
      }),
    ).toMatchObject({ ok: false });
  });

  it("requires fee routing to reconcile", () => {
    const fees = {
      baseFeeBps: 20,
      optionSpacePremiumBpsScaled: "80000000000000000000",
      totalFeeBpsScaled: "100000000000000000000",
      baseFeeAmount: "100",
      treasuryBaseFeeAmount: "50",
      optionSpacePremiumAmount: "400",
      totalFeeAmount: "500",
      treasuryAmount: "450",
      solverAmount: "25",
      protocolAmount: "25",
      feeToken: ADDRESS_A,
      feePaymentMode: "OUTPUT_TOKEN",
      treasuryRecipient: ADDRESS_A,
      solverRecipient: ADDRESS_B,
      protocolRecipient: ADDRESS_C,
    };
    expect(feeBreakdownSchema.safeParse(fees).success).toBe(true);
    expect(
      feeBreakdownSchema.safeParse({ ...fees, treasuryAmount: "449" }).success,
    ).toBe(false);
  });

  it("decodes mixed-decimal fee events as normalized values", () => {
    const decoded = decodeProtocolEventLog(
      "FeesRouted",
      [
        protocolEventTopic("FeesRouted"),
        HASH,
        `0x${addressWord(ADDRESS_A)}`,
        `0x${addressWord(ADDRESS_B)}`,
      ],
      `0x${addressWord(ADDRESS_C)}${abiWord(25n)}${abiWord(25n)}${abiWord(184n)}`,
    );

    expect(decoded).toEqual({
      proposalHash: HASH,
      feeToken: ADDRESS_A,
      solver: ADDRESS_B,
      protocolRecipient: ADDRESS_C,
      solverAmount: "25",
      protocolAmount: "25",
      treasuryAmount: "184",
    });
    expect(
      BigInt(decoded.solverAmount as string) +
        BigInt(decoded.protocolAmount as string) +
        BigInt(decoded.treasuryAmount as string),
    ).toBe(234n);
    expect(decoded.solverAmount).not.toBe("25000000");
  });
});
