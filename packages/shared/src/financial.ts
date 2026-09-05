/**
 * Deterministic, uint256-compatible financial calculations shared by the
 * TypeScript services and the on-chain implementation.
 *
 * Amounts and values are bigint integers. A portfolio's `valueDecimals`
 * chooses the unit in which values are expressed (6 is a useful USD-like
 * unit). Ratios and fractional basis points use FIXED_POINT_SCALE (1e18).
 * No floating point operation is used in this module.
 */

import type { BindingConstraint } from "./trading.js";

export const UINT256_MAX = (1n << 256n) - 1n;
export const BASIS_POINTS = 10_000n;
export const FIXED_POINT_SCALE = 1_000_000_000_000_000_000n;
export const MAXIMUM_TOTAL_FEE_BPS = 100n;
/** Canonical whole-value scale used by direct settlement. */
export const SETTLEMENT_VALUE_DECIMALS = 0;
export const MAX_DECIMALS = 36;

export type IntegerLike = bigint | string;
export type BpsLike = number | IntegerLike;

export interface FinancialAssetInput {
  readonly token: string;
  readonly symbol?: string;
  /** Token balance in the token's smallest unit. */
  readonly balance: IntegerLike;
  readonly decimals: number;
  /** Price in quote units per whole token, with `priceDecimals` decimals. */
  readonly price: IntegerLike;
  readonly priceDecimals: number;
  readonly minimumWeightBps: BpsLike;
  readonly maximumWeightBps: BpsLike;
}

export interface AssetValuation {
  readonly token: string;
  readonly symbol?: string;
  readonly balance: bigint;
  readonly decimals: number;
  readonly price: bigint;
  readonly priceDecimals: number;
  readonly value: bigint;
  /** Conservative (ceiling) weight in basis points. */
  readonly weightBps: bigint;
  readonly minimumWeightBps: bigint;
  readonly maximumWeightBps: bigint;
}

export interface PortfolioValuation {
  readonly valueDecimals: number;
  readonly nav: bigint;
  readonly assets: readonly AssetValuation[];
}

export interface FinancialPolicy {
  readonly maximumTransactionValue: IntegerLike;
  readonly assets: readonly Pick<
    FinancialAssetInput,
    "token" | "minimumWeightBps" | "maximumWeightBps"
  >[];
}

export interface FinancialFeeConfig {
  readonly baseFeeBps: BpsLike;
  /** Maximum instantaneous OptionSpace premium at 100% utilization. */
  readonly slopeBps: BpsLike;
  readonly maximumFeeBps: BpsLike;
  readonly treasuryBaseFeeBps: BpsLike;
  readonly solverFeeBps: BpsLike;
  readonly protocolFeeBps: BpsLike;
}

export interface FeeAccounting {
  readonly feeToken: string;
  readonly feePaymentMode: FeePaymentMode;
  readonly treasuryRecipient: string;
  readonly solverRecipient: string;
  readonly protocolRecipient: string;
}

export interface ValueTrade {
  /** Value paid by the trader and received by the treasury. */
  readonly traderInputToken: string;
  /** Value paid by the treasury and received by the trader. */
  readonly traderOutputToken: string;
  readonly value: IntegerLike;
}

export interface ConstraintViolation {
  readonly constraint: BindingConstraint;
  readonly token?: string;
  readonly actual: bigint;
  readonly bound: bigint;
  readonly excess: bigint;
}

export interface ConstraintEvaluation {
  readonly safe: boolean;
  readonly bindingConstraint: BindingConstraint;
  readonly bindingAsset?: string;
  readonly violations: readonly ConstraintViolation[];
}

export interface SafeFillResult {
  readonly requested: bigint;
  readonly maximumSafeFill: bigint;
  readonly bindingConstraint: BindingConstraint;
  readonly bindingAsset?: string;
  readonly postTrade: PortfolioValuation;
}

export interface CalculatedDirectionalCapacity {
  readonly traderInputToken: string;
  readonly traderOutputToken: string;
  /** Capacity established at the start of the current capacity epoch. */
  readonly capacityBaselineValue: bigint;
  /** Net value consumed in this direction since the epoch started. */
  readonly consumedValue: bigint;
  readonly remainingValue: bigint;
  readonly maximumValue: bigint;
  readonly utilization: bigint;
  readonly bindingConstraint: BindingConstraint;
  readonly bindingAsset?: string;
}

export interface DirectionalCapacityState {
  readonly capacityBaselineValue: IntegerLike;
  readonly consumedValue: IntegerLike;
  readonly capacityEpochId?: string;
}

export interface OptionSpaceFee {
  /** Basis points scaled by FIXED_POINT_SCALE; fractional bps remain lossless. */
  readonly feeBpsScaled: bigint;
  readonly premiumBpsScaled: bigint;
  readonly utilizationBefore: bigint;
  readonly utilizationAfter: bigint;
}

export interface FeeDistributionInput {
  readonly tradeValue: IntegerLike;
  readonly baseFeeBps: BpsLike;
  readonly treasuryBaseFeeBps: BpsLike;
  readonly solverFeeBps: BpsLike;
  readonly protocolFeeBps: BpsLike;
  readonly slopeBps: BpsLike;
  readonly maximumFeeBps?: BpsLike;
  readonly utilizationBefore: IntegerLike;
  readonly utilizationAfter: IntegerLike;
}

export interface FeeDistribution {
  readonly baseFeeBps: bigint;
  readonly optionSpacePremiumBpsScaled: bigint;
  readonly totalFeeBpsScaled: bigint;
  readonly baseFeeAmount: bigint;
  readonly treasuryBaseFeeAmount: bigint;
  readonly optionSpacePremiumAmount: bigint;
  readonly totalFeeAmount: bigint;
  readonly treasuryAmount: bigint;
  readonly solverAmount: bigint;
  readonly protocolAmount: bigint;
}

export type FeePaymentMode = "OUTPUT_TOKEN";

export interface FeeInclusiveTrade {
  readonly traderInputToken: string;
  readonly traderOutputToken: string;
  /** Gross value exchanged before the output-token fee is withheld. */
  readonly grossTradeValue: bigint;
  readonly traderOutputValue: bigint;
  readonly feeToken: string;
  readonly fees: FeeDistribution;
}

const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

export function toUint256(value: IntegerLike, label = "value"): bigint {
  const result =
    typeof value === "bigint" ? value : parseCanonicalInteger(value, label);
  if (result < 0n || result > UINT256_MAX) {
    throw new RangeError(`${label} must fit uint256`);
  }
  return result;
}

function parseCanonicalInteger(value: string, label: string): bigint {
  if (!UINT_PATTERN.test(value))
    throw new TypeError(`${label} must be a canonical integer string`);
  return BigInt(value);
}

function checkedAdd(a: bigint, b: bigint, label: string): bigint {
  const result = a + b;
  if (result > UINT256_MAX) throw new RangeError(`${label} overflows uint256`);
  return result;
}

function checkedSub(a: bigint, b: bigint, label: string): bigint {
  if (b > a) throw new RangeError(`${label} underflows uint256`);
  return a - b;
}

function checkedMul(a: bigint, b: bigint, label: string): bigint {
  if (a !== 0n && b > UINT256_MAX / a)
    throw new RangeError(`${label} overflows uint256`);
  return a * b;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n)
    throw new RangeError("Division denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function floorMulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return checkedMul(a, b, "multiplication") / denominator;
}

function bpsOfDown(total: bigint, bps: bigint): bigint {
  return (
    (total / BASIS_POINTS) * bps + ((total % BASIS_POINTS) * bps) / BASIS_POINTS
  );
}

function bpsOfUp(total: bigint, bps: bigint): bigint {
  return (
    (total / BASIS_POINTS) * bps +
    ceilDiv((total % BASIS_POINTS) * bps, BASIS_POINTS)
  );
}

function weightBps(value: bigint, nav: bigint, roundUp: boolean): bigint {
  let low = 0n;
  let high = BASIS_POINTS;
  if (roundUp) {
    while (low < high) {
      const mid = low + (high - low) / 2n;
      if (bpsOfDown(nav, mid) >= value) high = mid;
      else low = mid + 1n;
    }
    return low;
  }
  while (low < high) {
    const mid = low + (high - low + 1n) / 2n;
    if (bpsOfUp(nav, mid) <= value) low = mid;
    else high = mid - 1n;
  }
  return low;
}

function scale10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `Decimals must be an integer from 0 to ${MAX_DECIMALS}`,
    );
  }
  return 10n ** BigInt(decimals);
}

function normalizeToken(token: string): string {
  if (typeof token !== "string" || token.trim() === "")
    throw new TypeError("Token is required");
  return token.toLowerCase();
}

function requireBps(value: BpsLike, label: string): bigint {
  const bps = (() => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be a non-negative safe integer`);
      return BigInt(value);
    }
    return toUint256(value, label);
  })();
  if (bps > BASIS_POINTS)
    throw new RangeError(`${label} must be at most 10,000 bps`);
  return bps;
}

function policyBounds(
  policy: FinancialPolicy,
  token: string,
): { minimum: bigint; maximum: bigint } {
  const normalized = normalizeToken(token);
  const bound = policy.assets.find(
    (asset) => normalizeToken(asset.token) === normalized,
  );
  if (!bound) throw new RangeError(`Asset ${token} is not managed by policy`);
  return {
    minimum: requireBps(bound.minimumWeightBps, "minimumWeightBps"),
    maximum: requireBps(bound.maximumWeightBps, "maximumWeightBps"),
  };
}

function validatePolicy(policy: FinancialPolicy): void {
  const seen = new Set<string>();
  let minimumTotal = 0n;
  let maximumTotal = 0n;
  for (const asset of policy.assets) {
    const token = normalizeToken(asset.token);
    if (seen.has(token))
      throw new RangeError(`Duplicate policy asset ${asset.token}`);
    seen.add(token);
    const minimum = requireBps(asset.minimumWeightBps, "minimumWeightBps");
    const maximum = requireBps(asset.maximumWeightBps, "maximumWeightBps");
    if (minimum > maximum)
      throw new RangeError(`Minimum exceeds maximum for ${asset.token}`);
    minimumTotal += minimum;
    maximumTotal += maximum;
  }
  if (minimumTotal > BASIS_POINTS || maximumTotal < BASIS_POINTS) {
    throw new RangeError("Policy weights cannot describe a complete portfolio");
  }
  toUint256(policy.maximumTransactionValue, "maximumTransactionValue");
}

/**
 * Value = ceil(balance × price × 10^valueDecimals /
 * (10^balanceDecimals × 10^priceDecimals)).
 */
export function calculateAssetValue(
  asset: Pick<
    FinancialAssetInput,
    "balance" | "decimals" | "price" | "priceDecimals"
  >,
  valueDecimals = 6,
): bigint {
  const balance = toUint256(asset.balance, "balance");
  const price = toUint256(asset.price, "price");
  if (price === 0n) throw new RangeError("Price must be positive");
  const numerator = checkedMul(
    checkedMul(balance, price, "balance × price"),
    scale10(valueDecimals),
    "value scaling",
  );
  const denominator = checkedMul(
    scale10(asset.decimals),
    scale10(asset.priceDecimals),
    "decimal scaling",
  );
  return ceilDiv(numerator, denominator);
}

/** The same valuation with flooring, used when conservatively valuing treasury input. */
export function calculateAssetValueDown(
  asset: Pick<
    FinancialAssetInput,
    "balance" | "decimals" | "price" | "priceDecimals"
  >,
  valueDecimals = 6,
): bigint {
  const balance = toUint256(asset.balance, "balance");
  const price = toUint256(asset.price, "price");
  if (price === 0n) throw new RangeError("Price must be positive");
  const numerator = checkedMul(
    checkedMul(balance, price, "balance × price"),
    scale10(valueDecimals),
    "value scaling",
  );
  const denominator = checkedMul(
    scale10(asset.decimals),
    scale10(asset.priceDecimals),
    "decimal scaling",
  );
  return numerator / denominator;
}

/** Calculate NAV and conservative (ceiling) exposure weights. */
export function calculatePortfolioValuation(
  assets: readonly FinancialAssetInput[],
  valueDecimals = 6,
): PortfolioValuation {
  if (assets.length === 0)
    throw new RangeError("Portfolio must contain an asset");
  const seen = new Set<string>();
  const raw = assets.map((asset) => {
    const token = normalizeToken(asset.token);
    if (seen.has(token))
      throw new RangeError(`Duplicate portfolio asset ${asset.token}`);
    seen.add(token);
    const minimumWeightBps = requireBps(
      asset.minimumWeightBps,
      `${asset.token}.minimumWeightBps`,
    );
    const maximumWeightBps = requireBps(
      asset.maximumWeightBps,
      `${asset.token}.maximumWeightBps`,
    );
    if (minimumWeightBps > maximumWeightBps)
      throw new RangeError(`Minimum exceeds maximum for ${asset.token}`);
    return {
      token: asset.token,
      ...(asset.symbol === undefined ? {} : { symbol: asset.symbol }),
      balance: toUint256(asset.balance, `${asset.token}.balance`),
      decimals: asset.decimals,
      price: toUint256(asset.price, `${asset.token}.price`),
      priceDecimals: asset.priceDecimals,
      value: calculateAssetValue(asset, valueDecimals),
      weightBps: 0n,
      minimumWeightBps,
      maximumWeightBps,
    } satisfies AssetValuation;
  });
  const nav = raw.reduce(
    (sum, asset) => checkedAdd(sum, asset.value, "NAV"),
    0n,
  );
  if (nav === 0n) throw new RangeError("Portfolio NAV must be positive");
  const valued = raw.map((asset) => ({
    ...asset,
    weightBps: weightBps(asset.value, nav, true),
  }));
  return { valueDecimals, nav, assets: valued };
}

export const calculatePortfolio = calculatePortfolioValuation;

function assetIndex(portfolio: PortfolioValuation, token: string): number {
  const normalized = normalizeToken(token);
  const index = portfolio.assets.findIndex(
    (asset) => normalizeToken(asset.token) === normalized,
  );
  if (index < 0) throw new RangeError(`Asset ${token} is not in portfolio`);
  return index;
}

/** Apply a value-denominated trade while preserving NAV. */
export function applyTrade(
  portfolio: PortfolioValuation,
  trade: ValueTrade,
): PortfolioValuation {
  const value = toUint256(trade.value, "trade value");
  if (value === 0n) return portfolio;
  if (
    normalizeToken(trade.traderInputToken) ===
    normalizeToken(trade.traderOutputToken)
  ) {
    throw new RangeError("Trade assets must differ");
  }
  const inputIndex = assetIndex(portfolio, trade.traderInputToken);
  const outputIndex = assetIndex(portfolio, trade.traderOutputToken);
  const input = portfolio.assets[inputIndex];
  const output = portfolio.assets[outputIndex];
  if (!input || !output) throw new Error("Portfolio asset lookup failed");
  const updated = portfolio.assets.map((asset, index) => {
    if (index === inputIndex)
      return {
        ...asset,
        value: checkedAdd(asset.value, value, "trader input"),
      };
    if (index === outputIndex)
      return {
        ...asset,
        value: checkedSub(asset.value, value, "trader output"),
      };
    return asset;
  });
  const valued = updated.map((asset) => ({
    ...asset,
    weightBps: weightBps(asset.value, portfolio.nav, true),
  }));
  return { ...portfolio, assets: valued };
}

export const applyTradeToPortfolio = applyTrade;

/**
 * Apply a trader-paid output-token fee to the treasury portfolio.
 *
 * The trader pays the gross input value and receives gross value minus the
 * fee in traderOutputToken. The treasury retains its fee share; solver and
 * protocol shares leave the treasury, so the treasury's output balance is
 * reduced by the trader output plus those external shares.
 */
export function applyFeeInclusiveTrade(
  portfolio: PortfolioValuation,
  trade: ValueTrade,
  fees: FeeDistribution,
): PortfolioValuation {
  const value = toUint256(trade.value, "trade value");
  if (value === 0n) return portfolio;
  if (
    normalizeToken(trade.traderInputToken) ===
    normalizeToken(trade.traderOutputToken)
  ) {
    throw new RangeError("Trade assets must differ");
  }
  const inputIndex = assetIndex(portfolio, trade.traderInputToken);
  const outputIndex = assetIndex(portfolio, trade.traderOutputToken);
  const input = portfolio.assets[inputIndex];
  const output = portfolio.assets[outputIndex];
  if (!input || !output) throw new Error("Portfolio asset lookup failed");
  const externalFees = checkedAdd(
    fees.solverAmount,
    fees.protocolAmount,
    "external fee amounts",
  );
  if (fees.totalFeeAmount > value)
    throw new RangeError("Fee exceeds output trade value");
  if (externalFees > value)
    throw new RangeError("External fee exceeds output trade value");
  const traderOutputValue = value - fees.totalFeeAmount;
  const outputValueLeavingTreasury = checkedAdd(
    traderOutputValue,
    externalFees,
    "output settlement value",
  );
  const updatedValues = portfolio.assets.map((asset, index) => {
    if (index === inputIndex)
      return checkedAdd(asset.value, value, "trader input");
    if (index === outputIndex)
      return checkedSub(
        asset.value,
        outputValueLeavingTreasury,
        "trader output after fees",
      );
    return asset.value;
  });
  const nav = updatedValues.reduce(
    (sum, assetValue) => checkedAdd(sum, assetValue, "NAV"),
    0n,
  );
  if (nav === 0n) throw new RangeError("Portfolio NAV must be positive");
  const assets = portfolio.assets.map((asset, index) => ({
    ...asset,
    value: updatedValues[index] ?? asset.value,
    weightBps: weightBps(updatedValues[index] ?? asset.value, nav, true),
  }));
  return { ...portfolio, nav, assets };
}

export const applyFeeInclusiveTradeToPortfolio = applyFeeInclusiveTrade;

/** Evaluate every hard policy constraint and return all violations. */
export function evaluateConstraints(
  portfolio: PortfolioValuation,
  policy: FinancialPolicy,
  tradeValue = 0n,
): ConstraintEvaluation {
  validatePolicy(policy);
  const amount = toUint256(tradeValue, "trade value");
  const violations: ConstraintViolation[] = [];
  const cap = toUint256(
    policy.maximumTransactionValue,
    "maximumTransactionValue",
  );
  if (amount > cap) {
    violations.push({
      constraint: "TRANSACTION_CAP",
      actual: amount,
      bound: cap,
      excess: amount - cap,
    });
  }
  for (const asset of portfolio.assets) {
    const bounds = policyBounds(policy, asset.token);
    const minimumExposure = weightBps(asset.value, portfolio.nav, false);
    if (asset.value < bpsOfUp(portfolio.nav, bounds.minimum)) {
      violations.push({
        constraint: "MINIMUM_WEIGHT",
        token: asset.token,
        actual: minimumExposure,
        bound: bounds.minimum,
        excess: bounds.minimum - minimumExposure,
      });
    }
    if (asset.value > bpsOfDown(portfolio.nav, bounds.maximum)) {
      violations.push({
        constraint: "MAXIMUM_WEIGHT",
        token: asset.token,
        actual: asset.weightBps,
        bound: bounds.maximum,
        excess: asset.weightBps - bounds.maximum,
      });
    }
  }
  const first = violations[0];
  return {
    safe: violations.length === 0,
    bindingConstraint: first?.constraint ?? "NONE",
    ...(first?.token === undefined ? {} : { bindingAsset: first.token }),
    violations,
  };
}

export const validateConstraints = evaluateConstraints;
export const evaluatePostTradeState = evaluateConstraints;
export const detectBindingConstraint = evaluateConstraints;

/**
 * Find the maximum safe integer value. Binary search intentionally floors its
 * midpoint, so a fill is never rounded upward into an unsafe state.
 */
export function findMaximumSafeFill(
  portfolio: PortfolioValuation,
  policy: FinancialPolicy,
  trade: Omit<ValueTrade, "value"> & { readonly requested: IntegerLike },
): SafeFillResult {
  validatePolicy(policy);
  const requested = toUint256(trade.requested, "requested amount");
  const cap = toUint256(
    policy.maximumTransactionValue,
    "maximumTransactionValue",
  );
  const output =
    portfolio.assets[assetIndex(portfolio, trade.traderOutputToken)];
  if (!output) throw new Error("Output asset lookup failed");
  let low = 0n;
  let high = requested < cap ? requested : cap;
  if (high > output.value) high = output.value;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const postTrade = applyTrade(portfolio, { ...trade, value: mid });
    if (evaluateConstraints(postTrade, policy, mid).safe) low = mid;
    else high = mid - 1n;
  }
  const postTrade = applyTrade(portfolio, { ...trade, value: low });
  const evaluation = evaluateConstraints(postTrade, policy, low);
  const unsafeBinding =
    low < requested
      ? findFirstUnsafeBinding(portfolio, policy, trade, low, requested)
      : { constraint: "NONE" as BindingConstraint };
  return {
    requested,
    maximumSafeFill: low,
    bindingConstraint: unsafeBinding.constraint,
    ...(unsafeBinding.bindingAsset === undefined
      ? evaluation.bindingAsset === undefined
        ? {}
        : { bindingAsset: evaluation.bindingAsset }
      : { bindingAsset: unsafeBinding.bindingAsset }),
    postTrade,
  };
}

function findFirstUnsafeBinding(
  portfolio: PortfolioValuation,
  policy: FinancialPolicy,
  trade: Omit<ValueTrade, "value"> & { readonly requested: IntegerLike },
  safeFill: bigint,
  requested: bigint,
): { constraint: BindingConstraint; bindingAsset?: string } {
  const cap = toUint256(
    policy.maximumTransactionValue,
    "maximumTransactionValue",
  );
  if (safeFill === cap && requested > cap)
    return { constraint: "TRANSACTION_CAP" };
  const output =
    portfolio.assets[assetIndex(portfolio, trade.traderOutputToken)];
  if (output && safeFill === output.value && requested > output.value)
    return { constraint: "AVAILABLE_BALANCE", bindingAsset: output.token };
  if (output && safeFill + 1n > output.value)
    return { constraint: "AVAILABLE_BALANCE", bindingAsset: output.token };
  const unsafe = evaluateConstraints(
    applyTrade(portfolio, { ...trade, value: safeFill + 1n }),
    policy,
    safeFill + 1n,
  );
  return {
    constraint: unsafe.bindingConstraint,
    ...(unsafe.bindingAsset === undefined
      ? {}
      : { bindingAsset: unsafe.bindingAsset }),
  };
}

export const maximumSafeFill = findMaximumSafeFill;

/** Return a utilization ratio (scaled by 1e18) for consumed/capacity. */
export function calculateUtilization(
  consumedValue: IntegerLike,
  capacityValue: IntegerLike,
): bigint {
  const consumed = toUint256(consumedValue, "consumedValue");
  const capacity = toUint256(capacityValue, "capacityValue");
  if (capacity === 0n) return consumed === 0n ? 0n : FIXED_POINT_SCALE;
  if (consumed > capacity)
    throw new RangeError("Consumed value cannot exceed capacity");
  return floorMulDiv(consumed, FIXED_POINT_SCALE, capacity);
}

/**
 * Establish or read a directed capacity epoch.
 *
 * Without an explicit state, the current safe fill is established as the
 * baseline and utilization is zero. Callers that execute sequential fills
 * must carry the original baseline and consumed value forward; recomputing a
 * baseline for every transaction would incorrectly reset OptionSpace fees.
 */
export function calculateDirectionalCapacity(
  portfolio: PortfolioValuation,
  policy: FinancialPolicy,
  traderInputToken: string,
  traderOutputToken: string,
  state?: DirectionalCapacityState,
): CalculatedDirectionalCapacity {
  const current = findMaximumSafeFill(portfolio, policy, {
    traderInputToken,
    traderOutputToken,
    requested: UINT256_MAX,
  });
  const baseline = state
    ? toUint256(state.capacityBaselineValue, "capacityBaselineValue")
    : current.maximumSafeFill;
  const consumed = state ? toUint256(state.consumedValue, "consumedValue") : 0n;
  const utilization = calculateUtilization(consumed, baseline);
  const remaining = baseline >= consumed ? baseline - consumed : 0n;
  return {
    traderInputToken,
    traderOutputToken,
    capacityBaselineValue: baseline,
    consumedValue: consumed,
    remainingValue: remaining,
    maximumValue: current.maximumSafeFill,
    utilization,
    bindingConstraint: current.bindingConstraint,
    ...(current.bindingAsset === undefined
      ? {}
      : { bindingAsset: current.bindingAsset }),
  };
}

export function establishDirectionalCapacity(
  portfolio: PortfolioValuation,
  policy: FinancialPolicy,
  traderInputToken: string,
  traderOutputToken: string,
): DirectionalCapacityState {
  const capacity = calculateDirectionalCapacity(
    portfolio,
    policy,
    traderInputToken,
    traderOutputToken,
  );
  return {
    capacityBaselineValue: capacity.capacityBaselineValue,
    consumedValue: 0n,
  };
}

export function consumeDirectionalCapacity(
  state: DirectionalCapacityState,
  value: IntegerLike,
): DirectionalCapacityState {
  const baseline = toUint256(
    state.capacityBaselineValue,
    "capacityBaselineValue",
  );
  const consumed = toUint256(state.consumedValue, "consumedValue");
  const amount = toUint256(value, "consumed value");
  if (consumed > baseline || amount > baseline - consumed) {
    throw new RangeError("Directional capacity is exhausted");
  }
  return {
    ...state,
    capacityBaselineValue: baseline,
    consumedValue: consumed + amount,
  };
}

/** Reverse flow restores the same epoch's directional consumption. */
export function reverseDirectionalCapacity(
  state: DirectionalCapacityState,
  value: IntegerLike,
): DirectionalCapacityState {
  const baseline = toUint256(
    state.capacityBaselineValue,
    "capacityBaselineValue",
  );
  const consumed = toUint256(state.consumedValue, "consumedValue");
  const amount = toUint256(value, "reverse value");
  if (amount > consumed)
    throw new RangeError("Reverse value exceeds directional consumption");
  return {
    ...state,
    capacityBaselineValue: baseline,
    consumedValue: consumed - amount,
  };
}

/**
 * Compute the bounded OptionSpace interval-average fee in scaled basis points.
 *
 * `slopeBps` is the maximum instantaneous premium at u=1. The instantaneous
 * premium curve is slopeBps × u², so the average premium over [u0,u1] is
 * slopeBps × (u0² + u0u1 + u1²) / 3. Charging the interval average makes the
 * fee amount additive for sequential execution while keeping the rate bounded
 * by baseFeeBps + slopeBps.
 */
export function calculateOptionSpaceFee(
  baseFeeBps: BpsLike,
  slopeBps: BpsLike,
  utilizationBefore: IntegerLike,
  utilizationAfter: IntegerLike,
  maximumFeeBps: BpsLike = 100n,
): OptionSpaceFee {
  const base = requireBps(baseFeeBps, "baseFeeBps");
  const slope = requireBps(slopeBps, "slopeBps");
  const u0 = toUint256(utilizationBefore, "utilizationBefore");
  const u1 = toUint256(utilizationAfter, "utilizationAfter");
  const maximum = requireBps(maximumFeeBps, "maximumFeeBps");
  if (
    maximum > MAXIMUM_TOTAL_FEE_BPS ||
    base > maximum ||
    base + slope > maximum
  )
    throw new RangeError("Invalid fee cap");
  if (u0 > FIXED_POINT_SCALE || u1 > FIXED_POINT_SCALE)
    throw new RangeError("Utilization must be between 0 and 1");
  if (u1 < u0)
    throw new RangeError("Utilization cannot decrease for a directional fill");
  const quadraticSum =
    checkedMul(u1, u1, "u1²") +
    checkedMul(u0, u1, "u0 × u1") +
    checkedMul(u0, u0, "u0²");
  const premium = ceilDiv(
    checkedMul(slope, quadraticSum, "OptionSpace fee"),
    3n * FIXED_POINT_SCALE,
  );
  const fee = checkedAdd(
    checkedMul(base, FIXED_POINT_SCALE, "base fee"),
    premium,
    "fee bps",
  );
  if (fee > maximum * FIXED_POINT_SCALE)
    throw new RangeError("Calculated fee exceeds fee cap");
  return {
    feeBpsScaled: fee,
    premiumBpsScaled: fee - checkedMul(base, FIXED_POINT_SCALE, "base fee"),
    utilizationBefore: u0,
    utilizationAfter: u1,
  };
}

export const calculateOptionSpaceFeeBps = calculateOptionSpaceFee;

export function calculateOptionSpacePremiumBps(
  baseFeeBps: BpsLike,
  slopeBps: BpsLike,
  utilizationBefore: IntegerLike,
  utilizationAfter: IntegerLike,
): bigint {
  return calculateOptionSpaceFee(
    baseFeeBps,
    slopeBps,
    utilizationBefore,
    utilizationAfter,
  ).premiumBpsScaled;
}

function feeAmount(tradeValue: bigint, feeBpsScaled: bigint): bigint {
  return ceilDiv(
    checkedMul(tradeValue, feeBpsScaled, "fee amount"),
    BASIS_POINTS * FIXED_POINT_SCALE,
  );
}

/** Calculate rounded-up fees and distribute all rounding remainder to treasury. */
export function distributeFees(input: FeeDistributionInput): FeeDistribution {
  const tradeValue = toUint256(input.tradeValue, "tradeValue");
  const base = requireBps(input.baseFeeBps, "baseFeeBps");
  const treasuryBase = requireBps(
    input.treasuryBaseFeeBps,
    "treasuryBaseFeeBps",
  );
  const solver = requireBps(input.solverFeeBps, "solverFeeBps");
  const protocol = requireBps(input.protocolFeeBps, "protocolFeeBps");
  if (treasuryBase + solver + protocol !== base)
    throw new RangeError("Base fee distribution must equal baseFeeBps");
  const option = calculateOptionSpaceFee(
    base,
    input.slopeBps,
    input.utilizationBefore,
    input.utilizationAfter,
    input.maximumFeeBps ?? 100n,
  );
  const baseAmount = feeAmount(tradeValue, base * FIXED_POINT_SCALE);
  // Round the complete fee once. Rounding base and premium independently can
  // make a one-unit trade pay more than its mathematically bounded fee.
  const totalAmount = feeAmount(tradeValue, option.feeBpsScaled);
  const solverAmount = floorMulDiv(baseAmount, solver, base === 0n ? 1n : base);
  const protocolAmount = floorMulDiv(
    baseAmount,
    protocol,
    base === 0n ? 1n : base,
  );
  const treasuryBaseAmount = baseAmount - solverAmount - protocolAmount;
  const treasuryAmount = totalAmount - solverAmount - protocolAmount;
  return {
    baseFeeBps: base,
    optionSpacePremiumBpsScaled: option.premiumBpsScaled,
    totalFeeBpsScaled: option.feeBpsScaled,
    baseFeeAmount: baseAmount,
    treasuryBaseFeeAmount: treasuryBaseAmount,
    optionSpacePremiumAmount: totalAmount - baseAmount,
    totalFeeAmount: totalAmount,
    treasuryAmount,
    solverAmount,
    protocolAmount,
  };
}

export function formatFixed(value: bigint, decimals = 18): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `Decimals must be an integer from 0 to ${MAX_DECIMALS}`,
    );
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = magnitude / unit;
  const fraction = magnitude % unit;
  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}
