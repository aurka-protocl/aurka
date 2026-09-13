import { keccak_256 } from "@noble/hashes/sha3.js";

/** The scale used by the reviewed StaticBalances SwapVM program. */
export const UPSTREAM_STATIC_BALANCE_SCALE = 1_000_000n;

export interface UpstreamStrategyAsset {
  readonly token: string;
  readonly decimals: number;
  readonly price: bigint | string;
  readonly priceDecimals: number;
}

export interface UpstreamStrategyInput {
  /** The address used as the immutable SwapVM order maker (the Space vault). */
  readonly maker: string;
  readonly guard: string;
  readonly traderInput: UpstreamStrategyAsset;
  readonly traderOutput: UpstreamStrategyAsset;
  /** Kept configurable for local fork fixtures with deliberately distinct spaces. */
  readonly balanceScale?: bigint;
}

export interface UpstreamStrategy {
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

function paddedBytes(value: string): string {
  const clean = strip0x(value);
  if (clean.length % 2 !== 0) throw new TypeError("Odd-length bytes value");
  return (
    word(clean.length / 2) +
    clean.padEnd(Math.ceil(clean.length / 64) * 64, "0")
  );
}

function encodeOrder(
  maker: string,
  makerTraits: bigint,
  orderData: string,
): string {
  const tail = paddedBytes(orderData);
  return `0x${[
    word(32),
    addressBytes(maker).padStart(64, "0"),
    word(makerTraits),
    word(96),
    tail,
  ].join("")}`;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function rawPerValue(asset: UpstreamStrategyAsset): bigint {
  const price = BigInt(asset.price);
  if (price <= 0n) throw new RangeError("Price must be positive");
  if (
    !Number.isInteger(asset.decimals) ||
    asset.decimals < 0 ||
    !Number.isInteger(asset.priceDecimals) ||
    asset.priceDecimals < 0
  )
    throw new RangeError("Asset decimals must be non-negative integers");
  return ceilDiv(10n ** BigInt(asset.decimals + asset.priceDecimals), price);
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

/**
 * Build the exact immutable order identity consumed by both Space setup and
 * the solver. Token ordering is lexical and the output-token rounding unit is
 * attached to that token's balance, regardless of which direction is quoted.
 */
export function buildUpstreamStrategy(
  input: UpstreamStrategyInput,
): UpstreamStrategy {
  const traderInput = {
    ...input.traderInput,
    token: `0x${addressBytes(input.traderInput.token)}`,
  };
  const traderOutput = {
    ...input.traderOutput,
    token: `0x${addressBytes(input.traderOutput.token)}`,
  };
  if (traderInput.token.toLowerCase() === traderOutput.token.toLowerCase())
    throw new RangeError("SwapVM strategy requires two distinct tokens");
  const tokenA =
    traderInput.token.toLowerCase() < traderOutput.token.toLowerCase()
      ? traderInput
      : traderOutput;
  const tokenB = tokenA === traderInput ? traderOutput : traderInput;
  const inputUnit = rawPerValue(traderInput);
  const outputUnit = rawPerValue(traderOutput);
  const scale = input.balanceScale ?? UPSTREAM_STATIC_BALANCE_SCALE;
  if (scale <= 0n)
    throw new RangeError("Strategy balance scale must be positive");
  const outputBalance = outputUnit * scale + 1n;
  const balanceA = tokenA === traderOutput ? outputBalance : inputUnit * scale;
  const balanceB = tokenB === traderOutput ? outputBalance : outputUnit * scale;
  const direction = tokenA === traderInput ? "80" : "00";
  const program = `0x9040${word(balanceA)}${word(balanceB)}5301${direction}`;
  const orderData = `0x${addressBytes(tokenA.token)}${addressBytes(tokenB.token)}${addressBytes(input.guard)}${strip0x(program)}`;
  const makerTraits = reviewedMakerTraits();
  const strategy = encodeOrder(input.maker, makerTraits, orderData);
  return {
    strategy,
    strategyHash: asHex(keccak_256(parseHex(strategy))),
    program,
    orderData,
    makerTraits,
  };
}

/**
 * Reproduce the pre-TASK1009-012 USDC-first encoding for diagnosis only. It is
 * intentionally not accepted by the solver or setup path.
 */
export function buildLegacyHardcodedOrderStrategy(input: {
  readonly maker: string;
  readonly guard: string;
  readonly usdc: UpstreamStrategyAsset;
  readonly weth: UpstreamStrategyAsset;
  readonly balanceScale?: bigint;
}): UpstreamStrategy {
  const scale = input.balanceScale ?? UPSTREAM_STATIC_BALANCE_SCALE;
  const usdc = { ...input.usdc, token: `0x${addressBytes(input.usdc.token)}` };
  const weth = { ...input.weth, token: `0x${addressBytes(input.weth.token)}` };
  const program = `0x9040${word(rawPerValue(usdc) * scale + 1n)}${word(rawPerValue(weth) * scale)}530100`;
  const orderData = `0x${addressBytes(usdc.token)}${addressBytes(weth.token)}${addressBytes(input.guard)}${strip0x(program)}`;
  const makerTraits = reviewedMakerTraits();
  const strategy = encodeOrder(input.maker, makerTraits, orderData);
  return {
    strategy,
    strategyHash: asHex(keccak_256(parseHex(strategy))),
    program,
    orderData,
    makerTraits,
  };
}
