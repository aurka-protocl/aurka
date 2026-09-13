import type {
  AtomicSettlementIntent,
  AtomicSettlementProposal,
} from "@aurka/shared";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { buildUpstreamStrategy } from "@aurka/shared";

import type { SolverSnapshot } from "./types.js";

/** Pinned identity recorded by TASK99-013; do not silently move this pin. */
export const SWAPVM_UPSTREAM_COMMIT =
  "afd99c408b4ed610027f4426c6f98650acac9f5f" as const;
export const SWAPVM_AQUA_COMMIT =
  "9c5c42e5840e8741fba3597c48456c9510212b66" as const;
export const SWAPVM_SOLIDITY_UTILS_TAG = "6.9.10" as const;
export const SWAPVM_OPENZEPPELIN_TAG = "v5.4.0" as const;
/** Fixed strategy scale leaves room for every bounded fork trade. */
export { UPSTREAM_STATIC_BALANCE_SCALE } from "@aurka/shared";
export { buildLegacyHardcodedOrderStrategy } from "@aurka/shared";

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

function parseHex(value: string): Uint8Array {
  const clean = strip0x(value);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean))
    throw new TypeError("Invalid hex bytes");
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function asHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function word(value: bigint | string | number): string {
  const encoded = typeof value === "bigint" ? value : BigInt(value);
  if (encoded < 0n || encoded >= 1n << 256n)
    throw new RangeError("uint256 overflow");
  return encoded.toString(16).padStart(64, "0");
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

/** Rebuild the fixed-price order identity without proposal-specific amounts. */
export function buildUpstreamSwapVMStrategy(
  snapshot: SolverSnapshot,
  input: string,
  output: string,
): UpstreamSwapVMStrategy {
  if (!snapshot.swapVMGuard)
    throw new Error("Pinned upstream VM guard is not configured");
  const inputAsset = snapshot.portfolio.assets.find(
    (asset) => asset.token.toLowerCase() === input.toLowerCase(),
  );
  const outputAsset = snapshot.portfolio.assets.find(
    (asset) => asset.token.toLowerCase() === output.toLowerCase(),
  );
  if (!inputAsset || !outputAsset)
    throw new Error("Upstream pair is not in the reviewed portfolio");
  return buildUpstreamStrategy({
    maker: snapshot.feeAccounting.treasuryRecipient,
    guard: snapshot.swapVMGuard,
    traderInput: inputAsset,
    traderOutput: outputAsset,
  });
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
    (BigInt(proposal.traderInputValue) *
      10n ** BigInt(snapshot.priceProtection.traderOutputDecimals) *
      10n **
        BigInt(
          snapshot.priceProtection.traderOutputExecutionPrice.priceDecimals,
        ) -
      1n) /
      BigInt(snapshot.priceProtection.traderOutputExecutionPrice.price) +
      1n,
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
