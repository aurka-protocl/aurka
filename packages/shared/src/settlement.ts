import {
  applyFeeInclusiveTrade,
  calculateOptionSpaceFee,
  calculateUtilization,
  distributeFees,
  evaluateConstraints,
  toUint256,
} from "./financial.js";
import type {
  FinancialFeeConfig,
  FeeAccounting,
  FinancialPolicy,
  FeeDistribution,
  IntegerLike,
  PortfolioValuation,
  ValueTrade,
} from "./financial.js";
import { SETTLEMENT_VALUE_DECIMALS } from "./financial.js";
import { assertCapacityEpoch, type CapacityEpoch } from "./epoch.js";
import {
  assertSettlementPriceProtection,
  type SettlementPriceProtection,
} from "./price.js";
import type { BindingConstraint } from "./trading.js";

/**
 * The five output-token accounting legs of an atomic direct execution. The
 * treasury leg is retained in Aqua; the other three legs leave Aqua.
 */
export interface AtomicSettlementAccounting {
  readonly traderOutputAmount: IntegerLike;
  readonly solverFeeAmount: IntegerLike;
  readonly protocolFeeAmount: IntegerLike;
  readonly treasuryFeeAmount: IntegerLike;
  readonly externalOutputAmount: IntegerLike;
  readonly feeToken: string;
}

export interface AtomicSettlementCommitments {
  readonly intentHash: string;
  readonly proposalHash: string;
  readonly capacityEpochId: string;
  readonly swapVMCalldataHash: string;
  readonly expectedPostStateHash: string;
}

export interface DirectSettlementInput {
  readonly portfolio: PortfolioValuation;
  readonly policy: FinancialPolicy;
  readonly fee: FinancialFeeConfig;
  readonly feeAccounting: FeeAccounting;
  /** Gross value paid by the trader into the treasury. */
  readonly traderInputToken: string;
  /** Value paid by the treasury to the trader, less fees. */
  readonly traderOutputToken: string;
  readonly requestedValue: IntegerLike;
  /** Persist this value for every fill in the same capacity epoch. */
  readonly capacityBaselineValue: IntegerLike;
  /** Gross value already consumed in this direction during the epoch. */
  readonly consumedBefore: IntegerLike;
  readonly capacityEpochId: string;
  readonly capacityEpoch: CapacityEpoch;
  readonly priceProtection: SettlementPriceProtection;
}

export interface DirectSettlementResult {
  readonly requestedValue: bigint;
  readonly maximumSafeValue: bigint;
  readonly executedValue: bigint;
  readonly capacityBaselineValue: bigint;
  readonly consumedBefore: bigint;
  readonly consumedAfter: bigint;
  readonly utilizationBefore: bigint;
  readonly utilizationAfter: bigint;
  readonly traderInputToken: string;
  readonly traderOutputToken: string;
  readonly feeToken: string;
  readonly traderOutputValue: bigint;
  /** Value leaving the treasury, including external fee shares. */
  readonly treasuryOutputValue: bigint;
  readonly fees: FeeDistribution;
  readonly feeAccounting: FeeAccounting;
  readonly capacityEpochId: string;
  readonly initialPortfolio: PortfolioValuation;
  readonly finalPortfolio: PortfolioValuation;
  readonly bindingConstraint: BindingConstraint;
  readonly bindingAsset?: string;
}

function feeFor(
  value: bigint,
  fee: FinancialFeeConfig,
  consumedBefore: bigint,
  consumedAfter: bigint,
  capacityBaseline: bigint,
): FeeDistribution {
  return distributeFees({
    tradeValue: value,
    baseFeeBps: fee.baseFeeBps,
    treasuryBaseFeeBps: fee.treasuryBaseFeeBps,
    solverFeeBps: fee.solverFeeBps,
    protocolFeeBps: fee.protocolFeeBps,
    slopeBps: fee.slopeBps,
    maximumFeeBps: fee.maximumFeeBps,
    utilizationBefore: calculateUtilization(consumedBefore, capacityBaseline),
    utilizationAfter: calculateUtilization(consumedAfter, capacityBaseline),
  });
}

function postTradeFor(
  portfolio: PortfolioValuation,
  traderInputToken: string,
  traderOutputToken: string,
  value: bigint,
  fees: FeeDistribution,
): PortfolioValuation {
  return applyFeeInclusiveTrade(
    portfolio,
    { traderInputToken, traderOutputToken, value } satisfies ValueTrade,
    fees,
  );
}

function assertSettlementDecimalScales(input: DirectSettlementInput): void {
  const inputAsset = input.portfolio.assets.find(
    (asset) =>
      asset.token.toLowerCase() === input.traderInputToken.toLowerCase(),
  );
  const outputAsset = input.portfolio.assets.find(
    (asset) =>
      asset.token.toLowerCase() === input.traderOutputToken.toLowerCase(),
  );
  if (
    !inputAsset ||
    !outputAsset ||
    input.priceProtection.traderInputDecimals !== inputAsset.decimals ||
    input.priceProtection.traderOutputDecimals !== outputAsset.decimals ||
    input.priceProtection.valueDecimals !== SETTLEMENT_VALUE_DECIMALS ||
    input.portfolio.valueDecimals !== SETTLEMENT_VALUE_DECIMALS
  ) {
    throw new RangeError("Settlement decimal scales do not match authority");
  }
}

function findBinding(
  input: DirectSettlementInput,
  baseline: bigint,
  consumed: bigint,
  safeValue: bigint,
  requested: bigint,
): { constraint: BindingConstraint; bindingAsset?: string } {
  const cap = toUint256(
    input.policy.maximumTransactionValue,
    "maximumTransactionValue",
  );
  if (safeValue === cap && requested > cap)
    return { constraint: "TRANSACTION_CAP" };
  const available = baseline >= consumed ? baseline - consumed : 0n;
  if (safeValue === available && requested > available)
    return { constraint: "CAPACITY_EXHAUSTED" };
  if (safeValue === 0n && requested > 0n)
    return { constraint: "MINIMUM_WEIGHT" };
  const probe = safeValue + 1n;
  let probeFees: FeeDistribution;
  try {
    probeFees = feeFor(probe, input.fee, consumed, consumed + probe, baseline);
  } catch {
    return { constraint: "FEE_EXCEEDS_OUTPUT" };
  }
  const evaluation = evaluateConstraints(
    postTradeFor(
      input.portfolio,
      input.traderInputToken,
      input.traderOutputToken,
      probe,
      probeFees,
    ),
    input.policy,
    probe,
  );
  return {
    constraint: evaluation.bindingConstraint,
    ...(evaluation.bindingAsset === undefined
      ? {}
      : { bindingAsset: evaluation.bindingAsset }),
  };
}

/**
 * Solve one direct pairwise fill. Price and capacity commitments are checked
 * before a result is returned; all amounts then use the same fee-inclusive
 * treasury transition.
 */
export function calculateDirectSettlement(
  input: DirectSettlementInput,
): DirectSettlementResult {
  const requested = toUint256(input.requestedValue, "requestedValue");
  const consumed = toUint256(input.consumedBefore, "consumedBefore");
  const baseline = toUint256(
    input.capacityBaselineValue,
    "capacityBaselineValue",
  );
  if (consumed > baseline)
    throw new RangeError("Consumed value exceeds capacity baseline");
  if (
    input.feeAccounting.feePaymentMode !== "OUTPUT_TOKEN" ||
    input.feeAccounting.feeToken.toLowerCase() !==
      input.traderOutputToken.toLowerCase()
  ) {
    throw new RangeError("Fees must be paid in the trader output token");
  }
  if (
    toUint256(input.capacityEpoch.capacityBaselineValue, "epoch baseline") !==
      baseline ||
    toUint256(input.capacityEpoch.consumedBefore, "epoch consumedBefore") !==
      consumed
  ) {
    throw new RangeError("Capacity epoch state does not match settlement");
  }
  if (
    input.capacityEpoch.traderInputToken.toLowerCase() !==
      input.traderInputToken.toLowerCase() ||
    input.capacityEpoch.traderOutputToken.toLowerCase() !==
      input.traderOutputToken.toLowerCase()
  ) {
    throw new RangeError("Capacity epoch direction does not match settlement");
  }
  assertSettlementDecimalScales(input);
  assertCapacityEpoch(input.capacityEpoch, input.capacityEpochId);
  if (
    input.priceProtection.traderInputReferencePrice.token.toLowerCase() !==
      input.traderInputToken.toLowerCase() ||
    input.priceProtection.traderOutputReferencePrice.token.toLowerCase() !==
      input.traderOutputToken.toLowerCase()
  ) {
    throw new RangeError("Price protection tokens do not match settlement");
  }
  assertSettlementPriceProtection(input.priceProtection);

  const cap = toUint256(
    input.policy.maximumTransactionValue,
    "maximumTransactionValue",
  );
  let low = 0n;
  let high = requested < cap ? requested : cap;
  const remaining = baseline - consumed;
  if (high > remaining) high = remaining;
  const outputAsset = input.portfolio.assets.find(
    (asset) =>
      asset.token.toLowerCase() === input.traderOutputToken.toLowerCase(),
  );
  if (!outputAsset)
    throw new RangeError(
      "Asset " + input.traderOutputToken + " is not in portfolio",
    );
  if (high > outputAsset.value) high = outputAsset.value;
  while (low < high) {
    const mid = low + (high - low + 1n) / 2n;
    try {
      const fees = feeFor(mid, input.fee, consumed, consumed + mid, baseline);
      const postTrade = postTradeFor(
        input.portfolio,
        input.traderInputToken,
        input.traderOutputToken,
        mid,
        fees,
      );
      if (evaluateConstraints(postTrade, input.policy, mid).safe) low = mid;
      else high = mid - 1n;
    } catch {
      high = mid - 1n;
    }
  }

  const executed = low;
  const fees = feeFor(
    executed,
    input.fee,
    consumed,
    consumed + executed,
    baseline,
  );
  const finalPortfolio = postTradeFor(
    input.portfolio,
    input.traderInputToken,
    input.traderOutputToken,
    executed,
    fees,
  );
  const option = calculateOptionSpaceFee(
    input.fee.baseFeeBps,
    input.fee.slopeBps,
    calculateUtilization(consumed, baseline),
    calculateUtilization(consumed + executed, baseline),
    input.fee.maximumFeeBps,
  );
  const binding =
    executed < requested
      ? findBinding(input, baseline, consumed, executed, requested)
      : { constraint: "NONE" as const };
  return {
    requestedValue: requested,
    maximumSafeValue: executed,
    executedValue: executed,
    capacityBaselineValue: baseline,
    consumedBefore: consumed,
    consumedAfter: consumed + executed,
    utilizationBefore: option.utilizationBefore,
    utilizationAfter: option.utilizationAfter,
    traderInputToken: input.traderInputToken,
    traderOutputToken: input.traderOutputToken,
    feeToken: input.traderOutputToken,
    traderOutputValue: executed - fees.totalFeeAmount,
    treasuryOutputValue: executed - fees.treasuryAmount,
    fees,
    feeAccounting: input.feeAccounting,
    capacityEpochId: input.capacityEpochId,
    initialPortfolio: input.portfolio,
    finalPortfolio,
    bindingConstraint: binding.constraint,
    ...(binding.bindingAsset === undefined
      ? {}
      : { bindingAsset: binding.bindingAsset }),
  };
}

export const solveDirectPair = calculateDirectSettlement;
