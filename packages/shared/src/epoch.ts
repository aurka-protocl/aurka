import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import { toUint256 } from "./financial.js";
import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  uint256StringSchema,
} from "./primitives.js";
import type { IntegerLike } from "./financial.js";

/** Immutable inputs identifying one directional capacity epoch. */
export interface CapacityEpoch {
  readonly positionId: string;
  readonly traderInputToken: string;
  readonly traderOutputToken: string;
  readonly balanceSnapshot: string;
  readonly priceSnapshot: string;
  /** Hash of the authoritative price set for every managed asset. */
  readonly portfolioPriceSnapshot: string;
  readonly policyNonce: IntegerLike;
  readonly riskCertificateHash: string;
  /** Governance/treasury-authorized Aqua strategy bound to the position. */
  readonly aquaStrategyHash: string;
  readonly capacityBaselineValue: IntegerLike;
  readonly consumedBefore: IntegerLike;
  readonly chainId: IntegerLike;
  readonly verifyingContract: string;
}

export interface CapacityEpochCommitment extends CapacityEpoch {
  readonly capacityEpochId: string;
}

export const capacityEpochSchema = z
  .object({
    positionId: identifierSchema,
    traderInputToken: z.string().min(1).max(128),
    traderOutputToken: z.string().min(1).max(128),
    balanceSnapshot: bytes32Schema,
    priceSnapshot: bytes32Schema,
    portfolioPriceSnapshot: bytes32Schema,
    policyNonce: uint256StringSchema,
    riskCertificateHash: bytes32Schema,
    aquaStrategyHash: bytes32Schema,
    capacityBaselineValue: uint256StringSchema,
    consumedBefore: uint256StringSchema,
    chainId: uint256StringSchema,
    verifyingContract: addressSchema,
  })
  .strict();

export const capacityEpochCommitmentSchema = capacityEpochSchema
  .extend({ capacityEpochId: bytes32Schema })
  .strict();

function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function hashIdentifier(value: string): string {
  if (value.length === 0) throw new TypeError("Epoch identifier is required");
  return bytesToHex(
    keccak_256(Uint8Array.from(value, (char) => char.charCodeAt(0))),
  );
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function bytes32(value: string, label: string): Uint8Array {
  if (!bytes32Schema.safeParse(value).success)
    throw new TypeError(label + " must be bytes32");
  return hexToBytes(value.slice(2));
}

function uint256(value: IntegerLike, label: string): Uint8Array {
  const result = toUint256(value, label);
  return hexToBytes(result.toString(16).padStart(64, "0"));
}

function tokenId(value: string): Uint8Array {
  // Solidity commits EVM token addresses as bytes32(uint256(uint160(token))).
  // Keep symbolic fixture identifiers useful for language-neutral vectors, but
  // use the address slot whenever the protocol value is an actual token.
  if (addressSchema.safeParse(value).success) return addressSlot(value);
  return bytes32(hashIdentifier(value), "token ID");
}

function addressSlot(value: string): Uint8Array {
  if (!addressSchema.safeParse(value).success)
    throw new TypeError("Epoch verifyingContract must be an EVM address");
  return hexToBytes(value.slice(2).padStart(64, "0"));
}

function concatSlots(slots: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(slots.length * 32);
  slots.forEach((slot, index) => result.set(slot, index * 32));
  return result;
}

/** Solidity-compatible keccak256(abi.encode(...)) epoch commitment. */
export function computeCapacityEpochId(epoch: CapacityEpoch): string {
  return bytesToHex(
    keccak_256(
      concatSlots([
        bytes32(hashIdentifier(epoch.positionId), "position ID"),
        tokenId(epoch.traderInputToken),
        tokenId(epoch.traderOutputToken),
        bytes32(epoch.balanceSnapshot, "balanceSnapshot"),
        bytes32(epoch.priceSnapshot, "priceSnapshot"),
        bytes32(epoch.portfolioPriceSnapshot, "portfolioPriceSnapshot"),
        uint256(epoch.policyNonce, "policyNonce"),
        bytes32(epoch.riskCertificateHash, "riskCertificateHash"),
        bytes32(epoch.aquaStrategyHash, "aquaStrategyHash"),
        uint256(epoch.capacityBaselineValue, "capacityBaselineValue"),
        uint256(epoch.chainId, "chainId"),
        addressSlot(epoch.verifyingContract),
      ]),
    ),
  );
}

export function assertCapacityEpoch(
  epoch: CapacityEpoch,
  expectedCapacityEpochId: string,
): void {
  if (!bytes32Schema.safeParse(expectedCapacityEpochId).success)
    throw new TypeError("capacityEpochId must be bytes32");
  if (
    computeCapacityEpochId(epoch).toLowerCase() !==
    expectedCapacityEpochId.toLowerCase()
  ) {
    throw new RangeError("Capacity epoch commitment does not match settlement");
  }
}
