import { keccak_256 } from "@noble/hashes/sha3.js";

import type {
  AtomicSettlementIntent,
  AtomicSettlementProposal,
} from "@aurka/shared";

import type { SolverSnapshot } from "./types.js";

/** Pinned identity recorded by TASK99-013; do not silently move this pin. */
export const SWAPVM_UPSTREAM_COMMIT =
  "afd99c408b4ed610027f4426c6f98650acac9f5f" as const;
export const SWAPVM_AQUA_COMMIT =
  "9c5c42e5840e8741fba3597c48456c9510212b66" as const;
export const SWAPVM_SOLIDITY_UTILS_TAG = "6.9.10" as const;
export const SWAPVM_OPENZEPPELIN_TAG = "v5.4.0" as const;
/** Fixed strategy scale leaves room for every bounded fork trade. */
export const UPSTREAM_STATIC_BALANCE_SCALE = 1_000_000n;

export interface UpstreamSwapVMData {
  readonly makerTraits: string;
  readonly orderData: string;
  readonly takerTraitsAndData: string;
  readonly strategy: string;
  readonly strategyHash: string;
  readonly programHash: string;
}

export interface UpstreamSwapVMStrategy {
  readonly strategy: string;
  readonly strategyHash: string;
  readonly program: string;
  readonly orderData: string;
  readonly makerTraits: bigint;
}

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X")
    ? value.slice(2)
    : value;
}

function asHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): Uint8Array {
  const clean = strip0x(value);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean))
    throw new TypeError("Invalid hex bytes");
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function addressBytes(value: string): string {
  const clean = strip0x(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean))
    throw new TypeError(`Invalid address: ${value}`);
  return clean;
}

function word(value: bigint | string | number): string {
  const encoded = typeof value === "bigint" ? value : BigInt(value);
  if (encoded < 0n || encoded >= 1n << 256n)
    throw new RangeError("uint256 overflow");
  return encoded.toString(16).padStart(64, "0");
}

function bytes20Word(value: string): string {
  return addressBytes(value).padStart(64, "0");
}

function paddedBytes(value: string): string {
  const clean = strip0x(value);
  if (clean.length % 2 !== 0) throw new TypeError("Odd-length bytes value");
  return (
    word(clean.length / 2) +
    clean.padEnd(Math.ceil(clean.length / 64) * 64, "0")
  );
}

function abiEncodeBytesUintBytesBytes(
  first: string,
  second: bigint | string,
  third: string,
  fourth: string,
): string {
  const firstTail = paddedBytes(first);
  const thirdTail = paddedBytes(third);
  const fourthTail = paddedBytes(fourth);
  const firstOffset = 32n * 4n;
  const thirdOffset = firstOffset + BigInt(firstTail.length / 2);
  const fourthOffset = thirdOffset + BigInt(thirdTail.length / 2);
  return `0x${[
    word(firstOffset),
    word(second),
    word(thirdOffset),
    word(fourthOffset),
    firstTail,
    thirdTail,
    fourthTail,
  ].join("")}`;
}

function abiEncodeOrder(
  maker: string,
  makerTraits: bigint,
  orderData: string,
): string {
  const tail = paddedBytes(orderData);
  return `0x${[
    word(32),
    bytes20Word(maker),
    word(makerTraits),
    word(96),
    tail,
  ].join("")}`;
}

function rawPerValue(
  value: bigint,
  decimals: number,
  price: bigint,
  priceDecimals: number,
): bigint {
  if (value < 0n || price <= 0n) throw new RangeError("Invalid raw conversion");
  const numerator =
    value * 10n ** BigInt(decimals) * 10n ** BigInt(priceDecimals);
  return (numerator - 1n) / price + 1n;
}

function staticBalances(
  snapshot: SolverSnapshot,
  input: string,
  output: string,
): [bigint, bigint] {
  const inputAsset = snapshot.portfolio.assets.find(
    (asset) => asset.token.toLowerCase() === input.toLowerCase(),
  );
  const outputAsset = snapshot.portfolio.assets.find(
    (asset) => asset.token.toLowerCase() === output.toLowerCase(),
  );
  if (!inputAsset || !outputAsset)
    throw new Error("Upstream pair is not in the reviewed portfolio");
  // The ratio is the oracle's raw-token exchange rate. StaticBalances keeps
  // the VM quote aligned with valueToRaw for the complete AURKA trade value;
  // AURKA still owns the OptionSpace capacity and fee calculation.
  const inputUnit = rawPerValue(
    1n,
    inputAsset.decimals,
    inputAsset.price,
    inputAsset.priceDecimals,
  );
  const outputUnit = rawPerValue(
    1n,
    outputAsset.decimals,
    outputAsset.price,
    outputAsset.priceDecimals,
  );
  const tokenA =
    input.toLowerCase() < output.toLowerCase() ? inputAsset : outputAsset;
  const balanceA = tokenA === inputAsset ? inputUnit : outputUnit;
  const balanceB = tokenA === inputAsset ? outputUnit : inputUnit;
  return [balanceA, balanceB];
}

function reviewedMakerTraits(): bigint {
  return (
    (1n << 254n) |
    (1n << 250n) |
    (1n << 246n) |
    (60n << 208n) |
    (60n << 192n) |
    (40n << 176n) |
    (40n << 160n)
  );
}

/** Rebuild the fixed-price order identity without proposal-specific amounts. */
export function buildUpstreamSwapVMStrategy(
  snapshot: SolverSnapshot,
  input: string,
  output: string,
): UpstreamSwapVMStrategy {
  if (!snapshot.swapVMGuard)
    throw new Error("Pinned upstream VM guard is not configured");
  const tokenA = input.toLowerCase() < output.toLowerCase() ? input : output;
  const tokenB = tokenA.toLowerCase() === input.toLowerCase() ? output : input;
  const [balanceA, balanceB] = staticBalances(snapshot, input, output);
  const outputBalance =
    (tokenA.toLowerCase() === output.toLowerCase() ? balanceA : balanceB) *
      UPSTREAM_STATIC_BALANCE_SCALE +
    1n;
  const scaledBalanceA =
    tokenA.toLowerCase() === output.toLowerCase()
      ? outputBalance
      : balanceA * UPSTREAM_STATIC_BALANCE_SCALE;
  const scaledBalanceB =
    tokenB.toLowerCase() === output.toLowerCase()
      ? outputBalance
      : balanceB * UPSTREAM_STATIC_BALANCE_SCALE;
  const direction = input.toLowerCase() === tokenA.toLowerCase() ? "80" : "00";
  const program = `0x9040${word(scaledBalanceA)}${word(scaledBalanceB)}5301${direction}`;
  const orderData = `0x${addressBytes(tokenA)}${addressBytes(tokenB)}${addressBytes(snapshot.swapVMGuard)}${strip0x(program)}`;
  const traits = reviewedMakerTraits();
  const strategy = abiEncodeOrder(
    snapshot.feeAccounting.treasuryRecipient,
    traits,
    orderData,
  );
  return {
    strategy,
    strategyHash: asHex(keccak_256(parseHex(strategy))),
    program,
    orderData,
    makerTraits: traits,
  };
}

export function upstreamStrategyMatchesSnapshot(
  snapshot: SolverSnapshot,
  input: string,
  output: string,
): boolean {
  if (!snapshot.swapVMGuard) return true;
  return (
    buildUpstreamSwapVMStrategy(
      snapshot,
      input,
      output,
    ).strategyHash.toLowerCase() === snapshot.aquaStrategyHash.toLowerCase()
  );
}

/** Build the reviewed StaticBalances + LimitSwap order template. */
export function buildUpstreamSwapVMData(
  intent: AtomicSettlementIntent,
  proposal: AtomicSettlementProposal,
  snapshot: SolverSnapshot,
): UpstreamSwapVMData {
  if (!snapshot.swapVMGuard)
    throw new Error("Pinned upstream VM guard is not configured");
  const strategyTemplate = buildUpstreamSwapVMStrategy(
    snapshot,
    intent.traderInputToken,
    intent.traderOutputToken,
  );
  const { orderData, makerTraits } = strategyTemplate;
  const tokenA =
    intent.traderInputToken.toLowerCase() <
    intent.traderOutputToken.toLowerCase()
      ? intent.traderInputToken
      : intent.traderOutputToken;
  // MakerTraits: Aqua mode, pre-transfer-out hook + explicit hook target,
  // and the four official order-data slice indexes 40/40/60/60.
  // The VM executes the pre-fee oracle exchange. AURKA routes solver/protocol
  // shares and pushes the treasury-retained fee back into the same Aqua
  // strategy after the VM pull. This keeps the VM's strict threshold independent
  // of the utilization-dependent OptionSpace fee curve.
  const threshold = word(
    rawPerValue(
      BigInt(proposal.traderInputValue),
      snapshot.priceProtection.traderOutputDecimals,
      BigInt(snapshot.priceProtection.traderOutputExecutionPrice.price),
      snapshot.priceProtection.traderOutputExecutionPrice.priceDecimals,
    ),
  );
  const indexes = [37, 37, 37, 37, 37, 37, 37, 37, 32, 32]
    .map((value) => value.toString(16).padStart(4, "0"))
    .join("");
  const flags = (
    0x51 |
    (intent.traderInputToken.toLowerCase() === tokenA.toLowerCase() ? 0x80 : 0)
  )
    .toString(16)
    .padStart(4, "0");
  const deadline = BigInt(proposal.deadline).toString(16).padStart(10, "0");
  const takerTraitsAndData = `0x${indexes}${flags}${threshold}${deadline}`;
  const strategy = strategyTemplate.strategy;
  const strategyHash = strategyTemplate.strategyHash;
  const programHash = asHex(keccak_256(parseHex(orderData)));
  if (strategyHash.toLowerCase() !== snapshot.aquaStrategyHash.toLowerCase()) {
    throw new Error(
      "Pinned Aqua strategy does not match the reviewed upstream order",
    );
  }
  return {
    makerTraits: `0x${word(makerTraits)}`,
    orderData,
    takerTraitsAndData,
    strategy,
    strategyHash,
    programHash,
  };
}

export function hashUpstreamCalldata(
  directProgram: string,
  upstream: UpstreamSwapVMData,
): string {
  const encoded = abiEncodeBytesUintBytesBytes(
    directProgram,
    BigInt(upstream.makerTraits),
    upstream.orderData,
    upstream.takerTraitsAndData,
  );
  return asHex(keccak_256(parseHex(encoded)));
}
