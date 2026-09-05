import vectors from "../../test-vectors/financial.json" with { type: "json" };
import settlementVectors from "../../test-vectors/settlement.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import {
  BASIS_POINTS,
  FIXED_POINT_SCALE,
  UINT256_MAX,
  applyTrade,
  calculateDirectionalCapacity,
  calculateAssetValue,
  calculateAssetValueDown,
  establishDirectionalCapacity,
  calculateOptionSpaceFee,
  calculatePortfolioValuation,
  distributeFees,
  evaluateConstraints,
  findMaximumSafeFill,
  formatFixed,
} from "../financial.js";
import { computeCapacityEpochId, type CapacityEpoch } from "../epoch.js";
import {
  assertApprovedPriceSnapshot,
  assertFreshPrice,
  assertMinimumTreasuryExchangeValue,
  assertPriceWithinDeviation,
  calculateTreasuryExchangeValues,
  computePortfolioPriceSnapshotHash,
  computeSettlementPriceSnapshotHash,
  type PriceSnapshot,
} from "../price.js";
import {
  calculateDirectSettlement,
  type DirectSettlementInput,
} from "../settlement.js";
import {
  consumeDirectionalCapacity,
  reverseDirectionalCapacity,
} from "../financial.js";

const example = vectors.portfolioExample;
const portfolio = calculatePortfolioValuation(
  example.assets,
  vectors.precision.valueDecimals,
);
const policy = {
  maximumTransactionValue: example.maximumTransactionValue,
  assets: example.assets.map(
    ({ token, minimumWeightBps, maximumWeightBps }) => ({
      token,
      minimumWeightBps,
      maximumWeightBps,
    }),
  ),
};

const fee = {
  baseFeeBps: 20,
  slopeBps: 80,
  maximumFeeBps: 100,
  treasuryBaseFeeBps: 10,
  solverFeeBps: 5,
  protocolFeeBps: 5,
};

const feeAccounting = {
  feeToken: "USDC",
  feePaymentMode: "OUTPUT_TOKEN" as const,
  treasuryRecipient: "treasury",
  solverRecipient: "solver",
  protocolRecipient: "protocol",
};

function snapshot(token: string, id: string, price = 1n): PriceSnapshot {
  return {
    snapshotId: id,
    token,
    price,
    priceDecimals: 0,
    observedAt: 200,
  };
}

function directInput(
  overrides: Partial<DirectSettlementInput> = {},
): DirectSettlementInput {
  const traderInputToken = overrides.traderInputToken ?? "WETH";
  const traderOutputToken = overrides.traderOutputToken ?? "USDC";
  const baseline = overrides.capacityBaselineValue ?? 50_000n;
  const consumedBefore = overrides.consumedBefore ?? 0n;
  const inputSnapshotId = "0x" + "01".repeat(32);
  const outputSnapshotId = "0x" + "02".repeat(32);
  const capacityEpoch: CapacityEpoch = overrides.capacityEpoch ?? {
    positionId: "position:example",
    traderInputToken,
    traderOutputToken,
    balanceSnapshot: "0x" + "0".repeat(63) + "3",
    priceSnapshot: "0x" + "0".repeat(63) + "4",
    portfolioPriceSnapshot: "0x" + "0".repeat(63) + "6",
    policyNonce: 1n,
    riskCertificateHash: "0x" + "0".repeat(63) + "5",
    aquaStrategyHash: "0x" + "0".repeat(63) + "7",
    capacityBaselineValue: baseline,
    consumedBefore,
    chainId: 31337n,
    verifyingContract: "0x1111111111111111111111111111111111111111",
  };
  const priceProtection = overrides.priceProtection ?? {
    traderInputReferencePrice: snapshot(traderInputToken, inputSnapshotId),
    traderInputExecutionPrice: snapshot(traderInputToken, inputSnapshotId),
    traderOutputReferencePrice: snapshot(traderOutputToken, outputSnapshotId),
    traderOutputExecutionPrice: snapshot(traderOutputToken, outputSnapshotId),
    approvedTraderInputSnapshotId: inputSnapshotId,
    approvedTraderOutputSnapshotId: outputSnapshotId,
    traderInputAmount: 50_000n,
    traderOutputAmount: 49_816n,
    traderInputDecimals: 0,
    traderOutputDecimals: 0,
    valueDecimals: 0,
    nowSeconds: 221,
    maximumPriceAgeSeconds: 120,
    maximumPriceDeviationBps: 100,
  };
  const result = {
    portfolio,
    policy,
    fee,
    feeAccounting,
    traderInputToken,
    traderOutputToken,
    requestedValue: 200_000n,
    capacityBaselineValue: baseline,
    consumedBefore,
    capacityEpoch,
    capacityEpochId: computeCapacityEpochId(capacityEpoch),
    priceProtection,
    ...overrides,
  };
  return result;
}

describe("fixed-point portfolio vectors", () => {
  it("values the $1m 60/30/10 example with conservative weights", () => {
    expect(portfolio.nav).toBe(1_000_000n);
    expect(portfolio.assets.map((asset) => asset.value)).toEqual([
      600_000n,
      300_000n,
      100_000n,
    ]);
    expect(portfolio.assets.map((asset) => asset.weightBps)).toEqual([
      6_000n,
      3_000n,
      1_000n,
    ]);
  });

  it("clamps a $200k request at the $50k maximum safe fill", () => {
    const result = findMaximumSafeFill(portfolio, policy, {
      traderInputToken: "WETH",
      traderOutputToken: "USDC",
      requested: example.requestedValue,
    });
    expect(result.maximumSafeFill).toBe(BigInt(example.maximumSafeFill));
    expect(result.bindingConstraint).toBe("TRANSACTION_CAP");
    expect(
      Object.fromEntries(
        result.postTrade.assets.map((asset) => [
          asset.token,
          asset.value.toString(),
        ]),
      ),
    ).toEqual(example.postTradeValues);
  });

  it("identifies a $62k proposal as unsafe", () => {
    const proposed = applyTrade(portfolio, {
      traderInputToken: "WETH",
      traderOutputToken: "USDC",
      value: example.unsafeProposal,
    });
    const evaluation = evaluateConstraints(
      proposed,
      policy,
      BigInt(example.unsafeProposal),
    );
    expect(evaluation.safe).toBe(false);
    expect(
      evaluation.violations.map((violation) => violation.constraint),
    ).toEqual(
      expect.arrayContaining([
        "TRANSACTION_CAP",
        "MINIMUM_WEIGHT",
        "MAXIMUM_WEIGHT",
      ]),
    );
  });

  it("has zero additional same-direction capacity and available reverse capacity", () => {
    const filled = applyTrade(portfolio, {
      traderInputToken: "WETH",
      traderOutputToken: "USDC",
      value: example.maximumSafeFill,
    });
    const same = calculateDirectionalCapacity(filled, policy, "WETH", "USDC");
    const reverse = calculateDirectionalCapacity(
      filled,
      policy,
      "USDC",
      "WETH",
    );
    expect(same.maximumValue).toBe(
      BigInt(example.sameDirectionCapacityAfterFill),
    );
    expect(same.bindingConstraint).toBe("MINIMUM_WEIGHT");
    expect(reverse.maximumValue).toBe(
      BigInt(example.reverseDirectionCapacityAfterFill),
    );
  });

  it("cannot hide a fractional minimum-weight deficit by rounding up", () => {
    const fractional = calculatePortfolioValuation(
      [
        {
          token: "A",
          balance: 1n,
          decimals: 0,
          price: 1n,
          priceDecimals: 0,
          minimumWeightBps: 3_334,
          maximumWeightBps: 10_000,
        },
        {
          token: "B",
          balance: 2n,
          decimals: 0,
          price: 1n,
          priceDecimals: 0,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
        },
      ],
      0,
    );
    const evaluation = evaluateConstraints(fractional, {
      maximumTransactionValue: 1n,
      assets: fractional.assets,
    });
    expect(fractional.assets[0]?.weightBps).toBe(3_334n);
    expect(evaluation.safe).toBe(false);
    expect(evaluation.bindingConstraint).toBe("MINIMUM_WEIGHT");
  });
});

describe("OptionSpace fixed-point vectors", () => {
  it.each(vectors.optionSpaceFees)(
    "calculates $feeBps bps at $fill",
    (vector) => {
      const result = calculateOptionSpaceFee(
        "20",
        "80",
        "0",
        vector.utilizationAfter,
      );
      expect(result.feeBpsScaled.toString()).toBe(vector.feeBpsScaled);
      expect(formatFixed(result.feeBpsScaled)).toBe(
        vector.feeBps.replace(/\.0$/, ""),
      );
    },
  );

  it("is monotonic in utilization and never overflows uint256 inputs", () => {
    let previous = 0n;
    for (let i = 0n; i <= 100n; i += 1n) {
      const current = calculateOptionSpaceFee(
        "20",
        "80",
        "0",
        (i * FIXED_POINT_SCALE) / 100n,
      ).feeBpsScaled;
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    expect(() => calculateOptionSpaceFee(UINT256_MAX, "0", "0", "0")).toThrow();
    expect(() =>
      calculateOptionSpaceFee("20", "80", "0", FIXED_POINT_SCALE + 1n),
    ).toThrow();
    expect(
      calculateOptionSpaceFee("20", "80", FIXED_POINT_SCALE, FIXED_POINT_SCALE)
        .feeBpsScaled,
    ).toBe(100n * FIXED_POINT_SCALE);
  });

  it("rounds fee amounts up and reconciles distribution", () => {
    const fee = distributeFees({
      tradeValue: "1",
      baseFeeBps: "20",
      treasuryBaseFeeBps: "10",
      solverFeeBps: "5",
      protocolFeeBps: "5",
      slopeBps: "80",
      utilizationBefore: "0",
      utilizationAfter: FIXED_POINT_SCALE,
    });
    expect(fee.totalFeeAmount).toBe(1n);
    expect(fee.treasuryAmount + fee.solverAmount + fee.protocolAmount).toBe(
      fee.totalFeeAmount,
    );
    expect(fee.treasuryAmount).toBeGreaterThanOrEqual(fee.solverAmount);
  });

  it("does not make splitting materially cheaper than a single fill", () => {
    const one = distributeFees({
      tradeValue: "50000",
      baseFeeBps: "20",
      treasuryBaseFeeBps: "10",
      solverFeeBps: "5",
      protocolFeeBps: "5",
      slopeBps: "80",
      utilizationBefore: "0",
      utilizationAfter: FIXED_POINT_SCALE,
    });
    const first = distributeFees({
      tradeValue: "25000",
      baseFeeBps: "20",
      treasuryBaseFeeBps: "10",
      solverFeeBps: "5",
      protocolFeeBps: "5",
      slopeBps: "80",
      utilizationBefore: "0",
      utilizationAfter: FIXED_POINT_SCALE / 2n,
    });
    const second = distributeFees({
      tradeValue: "25000",
      baseFeeBps: "20",
      treasuryBaseFeeBps: "10",
      solverFeeBps: "5",
      protocolFeeBps: "5",
      slopeBps: "80",
      utilizationBefore: FIXED_POINT_SCALE / 2n,
      utilizationAfter: FIXED_POINT_SCALE,
    });
    expect(
      first.optionSpacePremiumAmount + second.optionSpacePremiumAmount,
    ).toBeGreaterThanOrEqual(one.optionSpacePremiumAmount);
    expect(
      first.optionSpacePremiumAmount +
        second.optionSpacePremiumAmount -
        one.optionSpacePremiumAmount,
    ).toBeLessThanOrEqual(2n);
  });

  it("uses the documented basis-point precision", () => {
    expect(BASIS_POINTS).toBe(10_000n);
    expect(FIXED_POINT_SCALE).toBe(1_000_000_000_000_000_000n);
  });
});

describe("fee-inclusive direct settlement", () => {
  it("keeps the $50,000 gross safe fill but records fee-inclusive balances", () => {
    const result = calculateDirectSettlement(
      directInput({ requestedValue: example.requestedValue }),
    );
    expect(result.maximumSafeValue).toBe(
      BigInt(settlementVectors.correctedFill.maximumExecutableFill),
    );
    expect(result.bindingConstraint).toBe("TRANSACTION_CAP");
    expect(result.traderInputToken).toBe("WETH");
    expect(result.traderOutputToken).toBe("USDC");
    expect(result.feeToken).toBe("USDC");
    expect(result.feeAccounting).toMatchObject({
      feePaymentMode: "OUTPUT_TOKEN",
      treasuryRecipient: "treasury",
      solverRecipient: "solver",
      protocolRecipient: "protocol",
    });
    expect(result.capacityEpochId).toBe(
      settlementVectors.canonical200000Request.capacityEpochId,
    );
    expect(result.fees.totalFeeAmount).toBe(
      BigInt(settlementVectors.canonical200000Request.totalFeeAmount),
    );
    expect(result.fees.baseFeeAmount).toBe(100n);
    expect(result.fees.treasuryBaseFeeAmount).toBe(50n);
    expect(result.fees.optionSpacePremiumAmount).toBe(134n);
    expect(result.fees.treasuryAmount).toBe(184n);
    expect(result.fees.solverAmount).toBe(25n);
    expect(result.fees.protocolAmount).toBe(25n);
    expect(result.traderOutputValue).toBe(49_766n);
    expect(result.finalPortfolio.nav).toBe(1_000_184n);
    expect(
      Object.fromEntries(
        result.finalPortfolio.assets.map((asset) => [
          asset.token,
          asset.value.toString(),
        ]),
      ),
    ).toEqual({ USDC: "550184", WETH: "350000", LINK: "100000" });
  });

  it("rejects caller-controlled decimal scales", () => {
    const base = directInput();
    for (const priceProtection of [
      { ...base.priceProtection, traderInputDecimals: 18 },
      { ...base.priceProtection, traderOutputDecimals: 6 },
      { ...base.priceProtection, valueDecimals: 6 },
    ]) {
      expect(() =>
        calculateDirectSettlement({ ...base, priceProtection }),
      ).toThrow("Settlement decimal scales do not match authority");
    }
  });

  it("caps direct fills by the treasury output balance, not input balance", () => {
    const asymmetricPortfolio = calculatePortfolioValuation(
      [
        {
          token: "USDC",
          balance: 700_000n,
          decimals: 0,
          price: 1n,
          priceDecimals: 0,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
        },
        {
          token: "WETH",
          balance: 100_000n,
          decimals: 0,
          price: 1n,
          priceDecimals: 0,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
        },
        {
          token: "LINK",
          balance: 200_000n,
          decimals: 0,
          price: 1n,
          priceDecimals: 0,
          minimumWeightBps: 0,
          maximumWeightBps: 10_000,
        },
      ],
      0,
    );
    const broadPolicy = {
      maximumTransactionValue: 200_000n,
      assets: asymmetricPortfolio.assets.map(({ token }) => ({
        token,
        minimumWeightBps: 0,
        maximumWeightBps: 10_000,
      })),
    };
    const result = calculateDirectSettlement(
      directInput({
        portfolio: asymmetricPortfolio,
        policy: broadPolicy,
        capacityBaselineValue: 200_000n,
        requestedValue: 150_000n,
      }),
    );
    expect(result.maximumSafeValue).toBe(150_000n);
  });

  it("supports a fee-inclusive reverse trade with its own direction", () => {
    const forward = calculateDirectSettlement(
      directInput({ requestedValue: 50_000n }),
    );
    const reverse = calculateDirectSettlement(
      directInput({
        portfolio: forward.finalPortfolio,
        traderInputToken: "USDC",
        traderOutputToken: "WETH",
        requestedValue: 50_000n,
        feeAccounting: { ...feeAccounting, feeToken: "WETH" },
        priceProtection: {
          ...directInput().priceProtection,
          traderInputReferencePrice: snapshot("USDC", "0x" + "01".repeat(32)),
          traderInputExecutionPrice: snapshot("USDC", "0x" + "01".repeat(32)),
          traderOutputReferencePrice: snapshot("WETH", "0x" + "02".repeat(32)),
          traderOutputExecutionPrice: snapshot("WETH", "0x" + "02".repeat(32)),
          approvedTraderInputSnapshotId: "0x" + "01".repeat(32),
          approvedTraderOutputSnapshotId: "0x" + "02".repeat(32),
        },
      }),
    );
    expect(reverse.maximumSafeValue).toBe(50_000n);
    expect(reverse.finalPortfolio.assets[0]!.value).toBe(600_184n);
    expect(reverse.finalPortfolio.assets[1]!.value).toBe(300_184n);
  });

  it("makes sequential and split execution equivalent within fee rounding", () => {
    const first = calculateDirectSettlement(
      directInput({ requestedValue: 25_000n }),
    );
    const second = calculateDirectSettlement(
      directInput({
        portfolio: first.finalPortfolio,
        requestedValue: 25_000n,
        consumedBefore: first.consumedAfter,
      }),
    );
    const whole = calculateDirectSettlement(
      directInput({ requestedValue: 50_000n }),
    );
    expect(first.utilizationAfter).toBe(FIXED_POINT_SCALE / 2n);
    expect(second.utilizationAfter).toBe(FIXED_POINT_SCALE);
    expect(first.fees.totalFeeAmount + second.fees.totalFeeAmount).toBe(
      whole.fees.totalFeeAmount,
    );
    expect(second.finalPortfolio.nav - whole.finalPortfolio.nav).toBe(2n);
    expect(
      second.finalPortfolio.assets[0]!.value -
        whole.finalPortfolio.assets[0]!.value,
    ).toBe(2n);
  });

  it("does not reset directional utilization on reverse flow", () => {
    const consumed = consumeDirectionalCapacity(
      { capacityBaselineValue: 50_000n, consumedValue: 0n },
      25_000n,
    );
    expect(
      calculateDirectionalCapacity(portfolio, policy, "USDC", "WETH", consumed),
    ).toMatchObject({
      capacityBaselineValue: 50_000n,
      consumedValue: 25_000n,
      remainingValue: 25_000n,
      utilization: FIXED_POINT_SCALE / 2n,
    });
    const restored = reverseDirectionalCapacity(consumed, 25_000n);
    expect(restored).toEqual({
      capacityBaselineValue: 50_000n,
      consumedValue: 0n,
    });
  });

  it("rebases capacity only when the effective portfolio or policy changes", () => {
    const changedPolicy = {
      maximumTransactionValue: 200_000n,
      assets: [
        { token: "USDC", minimumWeightBps: 5_500, maximumWeightBps: 10_000 },
        { token: "WETH", minimumWeightBps: 0, maximumWeightBps: 3_400 },
        { token: "LINK", minimumWeightBps: 0, maximumWeightBps: 1_500 },
      ],
    };
    const policyCapacity = establishDirectionalCapacity(
      portfolio,
      changedPolicy,
      "WETH",
      "USDC",
    );
    expect(policyCapacity.capacityBaselineValue).toBe(40_000n);

    const priceChanged = calculatePortfolioValuation(
      example.assets.map((asset) =>
        asset.token === "WETH"
          ? { ...asset, price: "8", priceDecimals: 1 }
          : asset,
      ),
      vectors.precision.valueDecimals,
    );
    const priceCapacity = establishDirectionalCapacity(
      priceChanged,
      { ...changedPolicy, assets: policy.assets },
      "WETH",
      "USDC",
    );
    expect(priceCapacity.capacityBaselineValue).toBe(83_000n);
  });

  it("starts a new capacity epoch after deposits and withdrawals", () => {
    const capacityPolicy = { ...policy, maximumTransactionValue: 200_000n };
    const deposited = calculatePortfolioValuation(
      example.assets.map((asset) =>
        asset.token === "USDC" ? { ...asset, balance: "620000" } : asset,
      ),
      vectors.precision.valueDecimals,
    );
    const depositCapacity = establishDirectionalCapacity(
      deposited,
      capacityPolicy,
      "WETH",
      "USDC",
    );
    expect(depositCapacity.capacityBaselineValue).toBe(57_000n);
    expect(depositCapacity.consumedValue).toBe(0n);

    const withdrawn = calculatePortfolioValuation(
      example.assets.map((asset) =>
        asset.token === "WETH" ? { ...asset, balance: "290000" } : asset,
      ),
      vectors.precision.valueDecimals,
    );
    const withdrawalCapacity = establishDirectionalCapacity(
      withdrawn,
      capacityPolicy,
      "WETH",
      "USDC",
    );
    expect(withdrawalCapacity.capacityBaselineValue).toBe(55_500n);
    expect(withdrawalCapacity.consumedValue).toBe(0n);
  });

  it("binds settlement to the price snapshots and raw exchange values", () => {
    const base = directInput();
    expect(() =>
      calculateDirectSettlement({
        ...base,
        priceProtection: {
          ...base.priceProtection,
          traderInputExecutionPrice: {
            ...base.priceProtection.traderInputExecutionPrice,
            observedAt: 100,
          },
        },
      }),
    ).toThrow("Price is stale");
    expect(() =>
      calculateDirectSettlement({
        ...base,
        priceProtection: {
          ...base.priceProtection,
          traderInputExecutionPrice: {
            ...base.priceProtection.traderInputExecutionPrice,
            observedAt: 222,
          },
        },
      }),
    ).toThrow("Price is from the future");
    expect(() =>
      calculateDirectSettlement({
        ...base,
        priceProtection: {
          ...base.priceProtection,
          traderInputExecutionPrice: snapshot("USDC", "0x" + "01".repeat(32)),
        },
      }),
    ).toThrow("Price token does not match approved token");
    expect(() =>
      calculateDirectSettlement({
        ...base,
        priceProtection: {
          ...base.priceProtection,
          traderInputExecutionPrice: snapshot(
            "WETH",
            "0x" + "01".repeat(32),
            102n,
          ),
        },
      }),
    ).toThrow("Price deviation exceeds policy");
    expect(() =>
      calculateDirectSettlement({
        ...base,
        priceProtection: {
          ...base.priceProtection,
          traderInputAmount: 49_000n,
          traderOutputAmount: 50_000n,
        },
      }),
    ).toThrow("Treasury exchange value below minimum");
  });

  it("changes the epoch commitment when the active risk certificate changes", () => {
    const base = directInput();
    const changedEpoch = {
      ...base.capacityEpoch,
      riskCertificateHash: "0x" + "06".repeat(32),
    };
    expect(() =>
      calculateDirectSettlement({
        ...base,
        capacityEpoch: changedEpoch,
      }),
    ).toThrow("Capacity epoch commitment does not match settlement");
  });

  it("reports exhausted directional capacity separately from portfolio bounds", () => {
    const result = calculateDirectSettlement(
      directInput({ requestedValue: 1n, consumedBefore: 50_000n }),
    );
    expect(result.maximumSafeValue).toBe(0n);
    expect(result.bindingConstraint).toBe("CAPACITY_EXHAUSTED");
  });
});

describe("price protection", () => {
  it("rejects stale snapshots and excessive deviation", () => {
    expect(() =>
      assertFreshPrice(
        {
          snapshotId: `0x${"01".repeat(32)}`,
          token: "USDC",
          price: 1n,
          priceDecimals: 0,
          observedAt: 100,
        },
        221,
        120,
      ),
    ).toThrow("Price is stale");
    expect(() =>
      assertFreshPrice(
        {
          snapshotId: `0x${"01".repeat(32)}`,
          token: "USDC",
          price: 1n,
          priceDecimals: 0,
          observedAt: 222,
        },
        221,
        120,
      ),
    ).toThrow("Price is from the future");
    expect(() =>
      assertPriceWithinDeviation(
        {
          snapshotId: `0x${"01".repeat(32)}`,
          token: "USDC",
          price: 100n,
          priceDecimals: 2,
          observedAt: 200,
        },
        {
          snapshotId: `0x${"02".repeat(32)}`,
          token: "USDC",
          price: 102n,
          priceDecimals: 2,
          observedAt: 200,
        },
        100,
      ),
    ).toThrow("Price deviation exceeds policy");
  });

  it("requires the approved snapshot identity and token", () => {
    const snapshot = {
      snapshotId: `0x${"01".repeat(32)}`,
      token: "USDC",
      price: 1n,
      priceDecimals: 0,
      observedAt: 200,
    };
    expect(() =>
      assertApprovedPriceSnapshot(snapshot, "USDC", snapshot.snapshotId),
    ).not.toThrow();
    expect(() =>
      assertApprovedPriceSnapshot(snapshot, "WETH", snapshot.snapshotId),
    ).toThrow("Price token does not match approved token");
    expect(() =>
      assertApprovedPriceSnapshot(snapshot, "USDC", `0x${"02".repeat(32)}`),
    ).toThrow("Price snapshot ID is not approved");
  });

  it("uses conservative exchange values and a deterministic minimum", () => {
    expect(
      calculateAssetValue(
        {
          balance: 1n,
          decimals: 6,
          price: 1n,
          priceDecimals: 8,
        },
        6,
      ),
    ).toBe(1n);
    expect(
      calculateAssetValueDown(
        {
          balance: 1n,
          decimals: 6,
          price: 1n,
          priceDecimals: 8,
        },
        6,
      ),
    ).toBe(0n);
    const values = calculateTreasuryExchangeValues(
      {
        traderInputAmount: 1_000n,
        traderInputDecimals: 0,
        traderInputPrice: 1n,
        traderInputPriceDecimals: 0,
        traderOutputAmount: 1_000n,
        traderOutputDecimals: 0,
        traderOutputPrice: 1n,
        traderOutputPriceDecimals: 0,
        valueDecimals: 0,
      },
      100,
    );
    expect(values.treasuryInputValue).toBe(1_000n);
    expect(values.treasuryOutputValue).toBe(1_000n);
    expect(values.minimumTreasuryInputValue).toBe(990n);
    expect(() =>
      assertMinimumTreasuryExchangeValue(990n, 1_000n, 100),
    ).not.toThrow();
    expect(() =>
      assertMinimumTreasuryExchangeValue(991n, 1_000n, 100),
    ).not.toThrow();
    expect(() => assertMinimumTreasuryExchangeValue(989n, 1_000n, 100)).toThrow(
      "Treasury exchange value below minimum",
    );
  });

  it("keeps the stable price commitment unchanged when a fill is split", () => {
    const input = {
      traderInputReferencePrice: snapshot(
        "0x1111111111111111111111111111111111111111",
        `0x${"01".repeat(32)}`,
      ),
      traderInputExecutionPrice: snapshot(
        "0x1111111111111111111111111111111111111111",
        `0x${"01".repeat(32)}`,
      ),
      traderOutputReferencePrice: snapshot(
        "0x2222222222222222222222222222222222222222",
        `0x${"02".repeat(32)}`,
      ),
      traderOutputExecutionPrice: snapshot(
        "0x2222222222222222222222222222222222222222",
        `0x${"02".repeat(32)}`,
      ),
      approvedTraderInputSnapshotId: `0x${"01".repeat(32)}`,
      approvedTraderOutputSnapshotId: `0x${"02".repeat(32)}`,
      traderInputAmount: 50_000n,
      traderOutputAmount: 49_816n,
      traderInputDecimals: 0,
      traderOutputDecimals: 0,
      valueDecimals: 0,
      nowSeconds: 1_000,
      maximumPriceAgeSeconds: 120,
      maximumPriceDeviationBps: 100,
    };
    const split = {
      ...input,
      traderInputAmount: 25_000n,
      traderOutputAmount: 24_957n,
    };
    expect(computeSettlementPriceSnapshotHash(input)).toBe(
      computeSettlementPriceSnapshotHash(split),
    );
  });

  it("commits EVM token IDs as Solidity address slots", () => {
    const epoch = directInput().capacityEpoch;
    expect(
      computeCapacityEpochId({
        ...epoch,
        traderInputToken: "0x1111111111111111111111111111111111111111",
        traderOutputToken: "0x2222222222222222222222222222222222222222",
      }),
    ).toBe(
      "0x79e73f79c44641ae27fe06d3773753b8cfb7673d805e25a6605bc00b20bceb28",
    );
  });

  it("commits every managed-asset oracle snapshot in canonical ABI order", () => {
    expect(
      computePortfolioPriceSnapshotHash([
        snapshot(
          "0x2222222222222222222222222222222222222222",
          `0x${"11".repeat(32)}`,
        ),
        snapshot(
          "0x1111111111111111111111111111111111111111",
          `0x${"22".repeat(32)}`,
        ),
        snapshot(
          "0x3333333333333333333333333333333333333333",
          `0x${"33".repeat(32)}`,
        ),
      ]),
    ).toBe(
      "0xd518c0831cb2fa0308ac785aa88d062f5b278019cfc16fc1d369799570209ebf",
    );
  });
});
