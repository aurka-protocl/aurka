/**
 * Lossless presentation helpers for values crossing the API/UI boundary.
 *
 * These functions deliberately do not use JavaScript Number for financial
 * quantities. Token balances and settlement values remain integer strings or
 * bigint values until they are rendered for a person.
 */

import type { AssetSnapshot, PortfolioSnapshot } from "./portfolio.js";
import { MAX_DECIMALS, UINT256_MAX } from "./financial.js";

const SIGNED_INTEGER = /^-?(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export type SignedIntegerLike = bigint | string;

function assertDecimals(decimals: number): void {
  if (
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMALS
  ) {
    throw new RangeError(
      `Decimals must be an integer from 0 to ${MAX_DECIMALS}`,
    );
  }
}

function parseSignedInteger(value: SignedIntegerLike, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!SIGNED_INTEGER.test(value))
    throw new TypeError(`${label} must be a canonical integer string`);
  return BigInt(value);
}

/** Format an integer in a declared decimal scale without rounding. */
export function formatDecimalUnits(
  value: SignedIntegerLike,
  decimals = 0,
): string {
  assertDecimals(decimals);
  const integer = parseSignedInteger(value, "value");
  const negative = integer < 0n;
  const magnitude = negative ? -integer : integer;
  const unit = 10n ** BigInt(decimals);
  const whole = magnitude / unit;
  const fraction = magnitude % unit;
  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;
  return `${negative ? "-" : ""}${whole}.${fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "")}`;
}

/**
 * Parse a human decimal into smallest units exactly. Values with more
 * fractional digits than the declared scale are rejected instead of rounded.
 */
export function parseDecimalUnits(
  value: string,
  decimals: number,
  label = "amount",
): bigint {
  assertDecimals(decimals);
  const match = DECIMAL.exec(value);
  if (!match) {
    throw new TypeError(
      `${label} must be a plain decimal string without signs, exponents or grouping`,
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError(
      `${label} has ${fraction.length} fractional digits; at most ${decimals} are supported`,
    );
  }
  const scaled = BigInt(`${match[1]}${fraction.padEnd(decimals, "0")}`);
  if (scaled > UINT256_MAX) throw new RangeError(`${label} must fit uint256`);
  return scaled;
}

/** Format a raw token balance using the decimals declared for that token. */
export function formatTokenAmount(
  rawAmount: SignedIntegerLike,
  decimals: number,
): string {
  return formatDecimalUnits(rawAmount, decimals);
}

/** Format a normalized settlement value. Its denomination is intentionally not inferred. */
export function formatValueAmount(
  value: SignedIntegerLike,
  valueDecimals: number,
): string {
  return formatDecimalUnits(value, valueDecimals);
}

/** Format a price using the price scale supplied by the authoritative snapshot. */
export function formatPrice(
  price: SignedIntegerLike,
  priceDecimals: number,
): string {
  return formatDecimalUnits(price, priceDecimals);
}

/** Parse a non-negative token amount and keep the result in uint256 range. */
export function parseTokenAmount(value: string, decimals: number): bigint {
  return parseDecimalUnits(value, decimals, "token amount");
}

/** Format integer basis points as an exact percentage (for example 5500 → 55.00%). */
export function formatBasisPoints(value: number | bigint | string): string {
  const bps =
    typeof value === "number"
      ? (() => {
          if (!Number.isSafeInteger(value))
            throw new RangeError("Basis points must be a safe integer");
          return BigInt(value);
        })()
      : parseSignedInteger(value, "basis points");
  if (bps < 0n || bps > 10_000n)
    throw new RangeError("Basis points must be between 0 and 10,000");
  const whole = bps / 100n;
  const fraction = (bps % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}%`;
}

/** Format a scaled basis-point value, preserving fractional basis points. */
export function formatScaledBasisPoints(
  value: SignedIntegerLike,
  scaleDecimals = 18,
): string {
  return `${formatDecimalUnits(value, scaleDecimals)} bps`;
}

export function findPortfolioAsset(
  snapshot: PortfolioSnapshot,
  token: string,
): AssetSnapshot | undefined {
  const normalized = token.toLowerCase();
  return snapshot.assets.find(
    (asset) => asset.token.toLowerCase() === normalized,
  );
}

export type SnapshotFreshness = "fresh" | "stale" | "unknown";

export function snapshotFreshness(
  observedAt: number,
  nowSeconds: number,
  maximumAgeSeconds?: number,
): SnapshotFreshness {
  if (
    !Number.isSafeInteger(observedAt) ||
    !Number.isSafeInteger(nowSeconds) ||
    observedAt < 0 ||
    nowSeconds < observedAt
  ) {
    return "unknown";
  }
  if (maximumAgeSeconds === undefined) return "fresh";
  if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 0)
    throw new RangeError("Maximum snapshot age must be a non-negative integer");
  return nowSeconds - observedAt <= maximumAgeSeconds ? "fresh" : "stale";
}

export function formatSnapshotAge(
  observedAt: number,
  nowSeconds: number,
): string {
  if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(nowSeconds))
    return "age unavailable";
  if (nowSeconds < observedAt) return "clock context unavailable";
  const age = nowSeconds - observedAt;
  if (age < 60) return `${age}s ago`;
  if (age < 3_600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86_400) return `${Math.floor(age / 3_600)}h ago`;
  return `${Math.floor(age / 86_400)}d ago`;
}

export function bindingConstraintLabel(constraint: string): string {
  const labels: Record<string, string> = {
    REQUESTED_AMOUNT: "requested amount",
    TRANSACTION_CAP: "per-trade cap",
    AVAILABLE_BALANCE: "available balance",
    CAPACITY_EXHAUSTED: "directional capacity",
    MINIMUM_WEIGHT: "minimum allocation",
    MAXIMUM_WEIGHT: "maximum allocation",
    RISK_LIMIT: "risk limit",
    FEE_EXCEEDS_OUTPUT: "fee versus output",
    PAUSED: "paused asset",
    NONE: "no binding constraint",
  };
  return labels[constraint] ?? constraint;
}
