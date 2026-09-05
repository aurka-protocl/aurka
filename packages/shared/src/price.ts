import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import {
  BASIS_POINTS,
  UINT256_MAX,
  calculateAssetValue,
  calculateAssetValueDown,
  toUint256,
} from "./financial.js";
import type { BpsLike, FinancialAssetInput, IntegerLike } from "./financial.js";
import {
  addressSchema,
  bpsSchema,
  bytes32Schema,
  tokenDecimalsSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";

export interface PriceSnapshot {
  readonly snapshotId: string;
  readonly token: string;
  readonly price: IntegerLike;
  readonly priceDecimals: number;
  readonly observedAt: number;
}

/** The protocol depends on this interface; no live oracle is implemented in Phase 3.5. */
export interface PriceOracle {
  getPrice(token: string): Promise<PriceSnapshot>;
}

export interface TreasuryExchangeInput {
  readonly traderInputAmount: IntegerLike;
  readonly traderInputDecimals: number;
  readonly traderInputPrice: IntegerLike;
  readonly traderInputPriceDecimals: number;
  readonly traderOutputAmount: IntegerLike;
  readonly traderOutputDecimals: number;
  readonly traderOutputPrice: IntegerLike;
  readonly traderOutputPriceDecimals: number;
  readonly valueDecimals?: number;
}

export interface SettlementPriceProtection {
  readonly traderInputReferencePrice: PriceSnapshot;
  readonly traderInputExecutionPrice: PriceSnapshot;
  readonly traderOutputReferencePrice: PriceSnapshot;
  readonly traderOutputExecutionPrice: PriceSnapshot;
  readonly approvedTraderInputSnapshotId: string;
  readonly approvedTraderOutputSnapshotId: string;
  /** Raw smallest-unit amounts committed by the proposed execution. */
  readonly traderInputAmount: IntegerLike;
  /** Raw output amount leaving the treasury, including external fee shares. */
  readonly traderOutputAmount: IntegerLike;
  readonly traderInputDecimals: number;
  readonly traderOutputDecimals: number;
  /** Must match policy metadata for both pair tokens. */
  readonly valueDecimals: number;
  readonly nowSeconds: number;
  readonly maximumPriceAgeSeconds: number;
  readonly maximumPriceDeviationBps: BpsLike;
}

export interface TreasuryExchangeValues {
  /** Floor: value received by the treasury is never overstated. */
  readonly treasuryInputValue: bigint;
  /** Ceiling: value sent by the treasury is never understated. */
  readonly treasuryOutputValue: bigint;
  readonly minimumTreasuryInputValue: bigint;
  readonly maximumDeviationBps: bigint;
}

export const priceSnapshotSchema = z
  .object({
    snapshotId: bytes32Schema,
    token: addressSchema,
    price: uint256StringSchema.refine(
      (value) => value !== "0",
      "Price must be positive",
    ),
    priceDecimals: tokenDecimalsSchema,
    observedAt: unixTimestampSchema,
  })
  .strict();

export const priceProtectionConfigSchema = z
  .object({
    priceMaxAgeSeconds: z.number().int().positive().max(86_400),
    maximumPriceDeviationBps: bpsSchema,
  })
  .strict();

export const settlementPriceProtectionSchema = z
  .object({
    traderInputReferencePrice: priceSnapshotSchema,
    traderInputExecutionPrice: priceSnapshotSchema,
    traderOutputReferencePrice: priceSnapshotSchema,
    traderOutputExecutionPrice: priceSnapshotSchema,
    approvedTraderInputSnapshotId: bytes32Schema,
    approvedTraderOutputSnapshotId: bytes32Schema,
    traderInputAmount: uint256StringSchema,
    traderOutputAmount: uint256StringSchema,
    traderInputDecimals: tokenDecimalsSchema,
    traderOutputDecimals: tokenDecimalsSchema,
    valueDecimals: tokenDecimalsSchema,
    nowSeconds: unixTimestampSchema,
    maximumPriceAgeSeconds: z.number().int().positive().max(86_400),
    maximumPriceDeviationBps: bpsSchema,
  })
  .strict();

export type PriceSnapshotSchema = z.infer<typeof priceSnapshotSchema>;
export type PriceProtectionConfig = z.infer<typeof priceProtectionConfigSchema>;
export type SettlementPriceProtectionSchema = z.infer<
  typeof settlementPriceProtectionSchema
>;

function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function hexSlot(value: string, label: string): Uint8Array {
  if (!bytes32Schema.safeParse(value).success)
    throw new TypeError(`${label} must be bytes32`);
  return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function addressSlot(value: string): Uint8Array {
  if (!addressSchema.safeParse(value).success)
    throw new TypeError("Price token must be an EVM address");
  return Uint8Array.from(
    ("0".repeat(24) + value.slice(2)).match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

function uintSlot(value: IntegerLike | number, label: string): Uint8Array {
  const integer = typeof value === "number" ? BigInt(value) : value;
  return Uint8Array.from(
    toUint256(integer, label).toString(16).padStart(64, "0").match(/.{2}/g) ??
      [],
    (pair) => Number.parseInt(pair, 16),
  );
}

function concatSlots(slots: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(slots.length * 32);
  slots.forEach((slot, index) => result.set(slot, index * 32));
  return result;
}

function snapshotSlots(snapshot: PriceSnapshot): Uint8Array[] {
  return [
    addressSlot(snapshot.token),
    hexSlot(snapshot.snapshotId, "snapshotId"),
    uintSlot(snapshot.price, "price"),
    uintSlot(snapshot.priceDecimals, "priceDecimals"),
    uintSlot(snapshot.observedAt, "observedAt"),
  ];
}

/**
 * Solidity-compatible hash of stable price commitments used by the atomic
 * router. Fill amounts and current time are intentionally excluded so a
 * split fill reuses one approved price epoch.
 */
export function computeSettlementPriceSnapshotHash(
  input: SettlementPriceProtection,
): string {
  const slots = [
    addressSlot(input.traderInputReferencePrice.token),
    addressSlot(input.traderOutputReferencePrice.token),
    ...snapshotSlots(input.traderInputReferencePrice),
    ...snapshotSlots(input.traderInputExecutionPrice),
    ...snapshotSlots(input.traderOutputReferencePrice),
    ...snapshotSlots(input.traderOutputExecutionPrice),
    hexSlot(input.approvedTraderInputSnapshotId, "approved input snapshot"),
    hexSlot(input.approvedTraderOutputSnapshotId, "approved output snapshot"),
    uintSlot(input.traderInputDecimals, "input decimals"),
    uintSlot(input.traderOutputDecimals, "output decimals"),
    uintSlot(input.valueDecimals, "value decimals"),
    uintSlot(input.maximumPriceAgeSeconds, "maximum price age"),
    uintSlot(input.maximumPriceDeviationBps, "maximum price deviation"),
  ];
  return bytesToHex(keccak_256(concatSlots(slots)));
}

/**
 * Solidity-compatible hash of the complete managed-asset oracle set:
 * `keccak256(abi.encode(tokens, PriceSnapshot[]))`.
 */
export function computePortfolioPriceSnapshotHash(
  snapshots: readonly PriceSnapshot[],
): string {
  const tokenTail = [
    uintSlot(snapshots.length, "portfolio snapshot length"),
    ...snapshots.map((snapshot) => addressSlot(snapshot.token)),
  ];
  const snapshotTail = [
    uintSlot(snapshots.length, "portfolio snapshot length"),
    ...snapshots.flatMap(snapshotSlots),
  ];
  return bytesToHex(
    keccak_256(
      concatSlots([
        uintSlot(64, "portfolio token offset"),
        uintSlot(64 + tokenTail.length * 32, "portfolio price offset"),
        ...tokenTail,
        ...snapshotTail,
      ]),
    ),
  );
}

function scale10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError("Price decimals must be an integer from 0 to 36");
  }
  return 10n ** BigInt(decimals);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n)
    throw new RangeError("Division denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function checkedMul(a: bigint, b: bigint, label: string): bigint {
  if (a !== 0n && b > UINT256_MAX / a)
    throw new RangeError(`${label} overflows uint256`);
  return a * b;
}

function ceilMulDivBySmall(
  value: bigint,
  multiplier: bigint,
  denominator: bigint,
): bigint {
  return (
    (value / denominator) * multiplier +
    ceilDiv((value % denominator) * multiplier, denominator)
  );
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function requireDeviation(value: BpsLike): bigint {
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new RangeError("Deviation must be a non-negative safe integer");
  }
  const deviation =
    typeof value === "number" ? BigInt(value) : toUint256(value);
  if (deviation > BASIS_POINTS)
    throw new RangeError("Deviation must be at most 10,000 bps");
  return deviation;
}

export function assertFreshPrice(
  snapshot: PriceSnapshot,
  nowSeconds: number,
  maxAgeSeconds: number,
): void {
  requireTimestamp(snapshot.observedAt, "observedAt");
  requireTimestamp(nowSeconds, "nowSeconds");
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError("maxAgeSeconds must be a positive safe integer");
  }
  if (toUint256(snapshot.price, "price") === 0n)
    throw new RangeError("Price must be positive");
  scale10(snapshot.priceDecimals);
  if (snapshot.observedAt > nowSeconds)
    throw new RangeError("Price is from the future");
  if (nowSeconds - snapshot.observedAt > maxAgeSeconds)
    throw new RangeError("Price is stale");
}

export const validatePriceFreshness = assertFreshPrice;

/** Bind execution to the token and price snapshot selected by the quote. */
export function assertApprovedPriceSnapshot(
  snapshot: PriceSnapshot,
  expectedToken: string,
  approvedSnapshotId: string,
): void {
  if (snapshot.token.toLowerCase() !== expectedToken.toLowerCase())
    throw new RangeError("Price token does not match approved token");
  if (!bytes32Schema.safeParse(snapshot.snapshotId).success)
    throw new RangeError("Price snapshot ID is not a bytes32 value");
  if (!bytes32Schema.safeParse(approvedSnapshotId).success)
    throw new RangeError("Approved snapshot ID is not a bytes32 value");
  if (snapshot.snapshotId.toLowerCase() !== approvedSnapshotId.toLowerCase())
    throw new RangeError("Price snapshot ID is not approved");
}

export const validateApprovedPriceSnapshot = assertApprovedPriceSnapshot;

/** Reject an execution price outside the configured deviation from its quote price. */
export function assertPriceWithinDeviation(
  reference: PriceSnapshot,
  actual: PriceSnapshot,
  maximumDeviationBps: BpsLike,
): void {
  if (reference.token.toLowerCase() !== actual.token.toLowerCase())
    throw new RangeError("Price token mismatch");
  const referencePrice = toUint256(reference.price, "reference price");
  const actualPrice = toUint256(actual.price, "actual price");
  if (referencePrice === 0n || actualPrice === 0n)
    throw new RangeError("Price must be positive");
  const referenceScale = scale10(reference.priceDecimals);
  const actualScale = scale10(actual.priceDecimals);
  const referenceNormalized = checkedMul(
    referencePrice,
    actualScale,
    "reference price scale",
  );
  const actualNormalized = checkedMul(
    actualPrice,
    referenceScale,
    "actual price scale",
  );
  const difference =
    actualNormalized >= referenceNormalized
      ? actualNormalized - referenceNormalized
      : referenceNormalized - actualNormalized;
  const deviation = requireDeviation(maximumDeviationBps);
  if (
    checkedMul(difference, BASIS_POINTS, "price deviation") >
    checkedMul(referenceNormalized, deviation, "price deviation bound")
  ) {
    throw new RangeError("Price deviation exceeds policy");
  }
}

export const validatePriceDeviation = assertPriceWithinDeviation;

/**
 * The treasury must receive at least (1 - deviation) of the value it sends.
 * Input is floored and output is ceiled before this check, so rounding cannot
 * make an unsafe exchange appear safe.
 */
export function calculateMinimumTreasuryInputValue(
  treasuryOutputValue: IntegerLike,
  maximumDeviationBps: BpsLike,
): bigint {
  const output = toUint256(treasuryOutputValue, "treasuryOutputValue");
  const deviation = requireDeviation(maximumDeviationBps);
  return ceilMulDivBySmall(output, BASIS_POINTS - deviation, BASIS_POINTS);
}

export function assertMinimumTreasuryExchangeValue(
  treasuryInputValue: IntegerLike,
  treasuryOutputValue: IntegerLike,
  maximumDeviationBps: BpsLike,
): TreasuryExchangeValues {
  const input = toUint256(treasuryInputValue, "treasuryInputValue");
  const output = toUint256(treasuryOutputValue, "treasuryOutputValue");
  const deviation = requireDeviation(maximumDeviationBps);
  const minimumInput = calculateMinimumTreasuryInputValue(output, deviation);
  if (input < minimumInput)
    throw new RangeError("Treasury exchange value below minimum");
  return {
    treasuryInputValue: input,
    treasuryOutputValue: output,
    minimumTreasuryInputValue: minimumInput,
    maximumDeviationBps: deviation,
  };
}

export function calculateTreasuryExchangeValues(
  input: TreasuryExchangeInput,
  maximumDeviationBps: BpsLike,
): TreasuryExchangeValues {
  const valueDecimals = input.valueDecimals ?? 6;
  const inputAsset = {
    token: "input",
    balance: input.traderInputAmount,
    decimals: input.traderInputDecimals,
    price: input.traderInputPrice,
    priceDecimals: input.traderInputPriceDecimals,
    minimumWeightBps: 0,
    maximumWeightBps: 10_000,
  } satisfies FinancialAssetInput;
  const outputAsset = {
    token: "output",
    balance: input.traderOutputAmount,
    decimals: input.traderOutputDecimals,
    price: input.traderOutputPrice,
    priceDecimals: input.traderOutputPriceDecimals,
    minimumWeightBps: 0,
    maximumWeightBps: 10_000,
  } satisfies FinancialAssetInput;
  const treasuryInputValue = calculateAssetValueDown(inputAsset, valueDecimals);
  const treasuryOutputValue = calculateAssetValue(outputAsset, valueDecimals);
  return assertMinimumTreasuryExchangeValue(
    treasuryInputValue,
    treasuryOutputValue,
    maximumDeviationBps,
  );
}

/** Validate every price commitment used by direct settlement. */
export function assertSettlementPriceProtection(
  input: SettlementPriceProtection,
): TreasuryExchangeValues {
  const references = [
    input.traderInputReferencePrice,
    input.traderOutputReferencePrice,
  ];
  const executions = [
    input.traderInputExecutionPrice,
    input.traderOutputExecutionPrice,
  ];
  for (const snapshot of [...references, ...executions]) {
    assertFreshPrice(snapshot, input.nowSeconds, input.maximumPriceAgeSeconds);
  }
  assertApprovedPriceSnapshot(
    input.traderInputExecutionPrice,
    input.traderInputReferencePrice.token,
    input.approvedTraderInputSnapshotId,
  );
  assertApprovedPriceSnapshot(
    input.traderOutputExecutionPrice,
    input.traderOutputReferencePrice.token,
    input.approvedTraderOutputSnapshotId,
  );
  assertPriceWithinDeviation(
    input.traderInputReferencePrice,
    input.traderInputExecutionPrice,
    input.maximumPriceDeviationBps,
  );
  assertPriceWithinDeviation(
    input.traderOutputReferencePrice,
    input.traderOutputExecutionPrice,
    input.maximumPriceDeviationBps,
  );
  return calculateTreasuryExchangeValues(
    {
      traderInputAmount: input.traderInputAmount,
      traderInputDecimals: input.traderInputDecimals,
      traderInputPrice: input.traderInputExecutionPrice.price,
      traderInputPriceDecimals: input.traderInputExecutionPrice.priceDecimals,
      traderOutputAmount: input.traderOutputAmount,
      traderOutputDecimals: input.traderOutputDecimals,
      traderOutputPrice: input.traderOutputExecutionPrice.price,
      traderOutputPriceDecimals: input.traderOutputExecutionPrice.priceDecimals,
      valueDecimals: input.valueDecimals,
    },
    input.maximumPriceDeviationBps,
  );
}
