import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import {
  addressSchema,
  bytes32Schema,
  identifierSchema,
  transactionHashSchema,
  uint256StringSchema,
  unixTimestampSchema,
} from "./primitives.js";

export const protocolEventNameSchema = z.enum([
  "PositionCreated",
  "PolicyUpdated",
  "IntentCreated",
  "ProposalSubmitted",
  "ProposalSelected",
  "CapacityEpochActivated",
  "FeesRouted",
  "RiskModeChanged",
  "QuoteInvalidated",
  "TradeExecuted",
  "AgentPaused",
]);

const capacityEpochActivatedPayloadSchema = z
  .object({
    policyId: bytes32Schema,
    positionIdHash: bytes32Schema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    capacityEpochId: bytes32Schema,
    capacityBaselineValue: uint256StringSchema,
    policyNonce: uint256StringSchema,
    riskCertificateHash: bytes32Schema,
    balanceSnapshot: bytes32Schema,
    priceSnapshot: bytes32Schema,
    portfolioPriceSnapshot: bytes32Schema,
    aquaStrategyHash: bytes32Schema,
    consumedBefore: uint256StringSchema,
  })
  .strict();

/**
 * Fee recipient amounts are normalized settlement values, not ERC-20 base
 * units. `feeToken` identifies the output token in which the raw transfers
 * occurred; those raw quantities are committed separately by the proposal.
 */
const feesRoutedPayloadSchema = z
  .object({
    proposalHash: bytes32Schema,
    feeToken: addressSchema,
    solver: addressSchema,
    protocolRecipient: addressSchema,
    solverAmount: uint256StringSchema,
    protocolAmount: uint256StringSchema,
    treasuryAmount: uint256StringSchema,
  })
  .strict();

const tradeExecutedPayloadSchema = z
  .object({
    policyId: bytes32Schema,
    positionIdHash: bytes32Schema,
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    capacityEpochId: bytes32Schema,
    trader: addressSchema,
    treasury: addressSchema,
    traderInputToken: addressSchema,
    traderOutputToken: addressSchema,
    traderInputValue: uint256StringSchema,
    traderOutputValue: uint256StringSchema,
    treasuryOutputValue: uint256StringSchema,
    totalFeeAmount: uint256StringSchema,
    consumedBefore: uint256StringSchema,
    consumedAfter: uint256StringSchema,
    expectedPostStateHash: bytes32Schema,
  })
  .strict();

export const protocolEventPayloadSchemas = {
  CapacityEpochActivated: capacityEpochActivatedPayloadSchema,
  FeesRouted: feesRoutedPayloadSchema,
  TradeExecuted: tradeExecutedPayloadSchema,
} as const;

const routerEventSignatures = {
  CapacityEpochActivated:
    "CapacityEpochActivated(bytes32,bytes32,address,address,bytes32,uint256,uint256,bytes32,bytes32,bytes32,bytes32,bytes32,uint256)",
  FeesRouted:
    "FeesRouted(bytes32,address,address,address,uint256,uint256,uint256)",
  TradeExecuted:
    "TradeExecuted(bytes32,bytes32,bytes32,bytes32,bytes32,address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes32)",
} as const;

function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function topicFor(name: keyof typeof routerEventSignatures): string {
  return bytesToHex(
    keccak_256(
      Uint8Array.from(routerEventSignatures[name], (char) =>
        char.charCodeAt(0),
      ),
    ),
  );
}

function words(data: string): string[] {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(data))
    throw new TypeError("Event data must contain complete ABI words");
  return data.slice(2).match(/.{64}/g) ?? [];
}

function addressWord(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError("Event address topic must be one ABI word");
  if (!/^0{24}/i.test(value.slice(2, 26)))
    throw new TypeError("Event address word has non-zero padding");
  return "0x" + value.slice(-40).toLowerCase();
}

function bytes32Word(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError("Event topic must be bytes32");
  return value.toLowerCase();
}

function uintWord(value: string): string {
  return BigInt(`0x${value}`).toString();
}

function requiredWord(words: readonly string[], index: number): string {
  const value = words[index];
  if (value === undefined) throw new TypeError("Malformed ABI event word");
  return value;
}

/** Return the topic-0 hash for one of the router's canonical events. */
export function protocolEventTopic(
  name: keyof typeof routerEventSignatures,
): string {
  return topicFor(name);
}

/**
 * Decode the static ABI logs emitted by AurkaSwapVMRouter. Dynamic event
 * payloads are intentionally unsupported so malformed logs fail closed.
 */
export function decodeProtocolEventLog(
  name: ProtocolEventName,
  topics: readonly string[],
  data: string,
): Record<string, unknown> {
  if (!(name in routerEventSignatures))
    throw new TypeError(`No settlement ABI is registered for ${name}`);
  if (
    topics[0]?.toLowerCase() !==
    topicFor(name as keyof typeof routerEventSignatures)
  )
    throw new TypeError("Event signature does not match event name");
  const indexed = topics.slice(1).map(bytes32Word);
  const decoded = words(data);
  if (name === "CapacityEpochActivated") {
    if (indexed.length !== 3 || decoded.length !== 10)
      throw new TypeError("Malformed CapacityEpochActivated log");
    return capacityEpochActivatedPayloadSchema.parse({
      policyId: indexed[0],
      positionIdHash: indexed[1],
      traderInputToken: addressWord(requiredWord(indexed, 2)),
      traderOutputToken: addressWord(`0x${requiredWord(decoded, 0)}`),
      capacityEpochId: bytes32Word(`0x${requiredWord(decoded, 1)}`),
      capacityBaselineValue: uintWord(requiredWord(decoded, 2)),
      policyNonce: uintWord(requiredWord(decoded, 3)),
      riskCertificateHash: bytes32Word(`0x${requiredWord(decoded, 4)}`),
      balanceSnapshot: bytes32Word(`0x${requiredWord(decoded, 5)}`),
      priceSnapshot: bytes32Word(`0x${requiredWord(decoded, 6)}`),
      portfolioPriceSnapshot: bytes32Word(`0x${requiredWord(decoded, 7)}`),
      aquaStrategyHash: bytes32Word(`0x${requiredWord(decoded, 8)}`),
      consumedBefore: uintWord(requiredWord(decoded, 9)),
    });
  }
  if (name === "FeesRouted") {
    if (indexed.length !== 3 || decoded.length !== 4)
      throw new TypeError("Malformed FeesRouted log");
    return feesRoutedPayloadSchema.parse({
      proposalHash: requiredWord(indexed, 0),
      feeToken: addressWord(requiredWord(indexed, 1)),
      solver: addressWord(requiredWord(indexed, 2)),
      protocolRecipient: addressWord(`0x${requiredWord(decoded, 0)}`),
      solverAmount: uintWord(requiredWord(decoded, 1)),
      protocolAmount: uintWord(requiredWord(decoded, 2)),
      treasuryAmount: uintWord(requiredWord(decoded, 3)),
    });
  }
  if (name === "TradeExecuted") {
    if (indexed.length !== 3 || decoded.length !== 13)
      throw new TypeError("Malformed TradeExecuted log");
    return tradeExecutedPayloadSchema.parse({
      policyId: requiredWord(indexed, 0),
      positionIdHash: requiredWord(indexed, 1),
      intentHash: requiredWord(indexed, 2),
      proposalHash: bytes32Word(`0x${requiredWord(decoded, 0)}`),
      capacityEpochId: bytes32Word(`0x${requiredWord(decoded, 1)}`),
      trader: addressWord(`0x${requiredWord(decoded, 2)}`),
      treasury: addressWord(`0x${requiredWord(decoded, 3)}`),
      traderInputToken: addressWord(`0x${requiredWord(decoded, 4)}`),
      traderOutputToken: addressWord(`0x${requiredWord(decoded, 5)}`),
      traderInputValue: uintWord(requiredWord(decoded, 6)),
      traderOutputValue: uintWord(requiredWord(decoded, 7)),
      treasuryOutputValue: uintWord(requiredWord(decoded, 8)),
      totalFeeAmount: uintWord(requiredWord(decoded, 9)),
      consumedBefore: uintWord(requiredWord(decoded, 10)),
      consumedAfter: uintWord(requiredWord(decoded, 11)),
      expectedPostStateHash: bytes32Word(`0x${requiredWord(decoded, 12)}`),
    });
  }
  throw new TypeError(`Unsupported settlement event ${name}`);
}

/** Parse the canonical payload for events emitted by the settlement router. */
export function parseProtocolEventPayload(
  name: ProtocolEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const schema =
    protocolEventPayloadSchemas[
      name as keyof typeof protocolEventPayloadSchemas
    ];
  return schema ? schema.parse(payload) : payload;
}

export const protocolEventSchema = z
  .object({
    id: identifierSchema,
    name: protocolEventNameSchema,
    chainId: z.number().int().positive().safe(),
    contract: addressSchema,
    transactionHash: transactionHashSchema,
    blockNumber: uint256StringSchema,
    logIndex: z.number().int().nonnegative(),
    blockHash: bytes32Schema,
    observedAt: unixTimestampSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ProtocolEventName = z.infer<typeof protocolEventNameSchema>;
export type ProtocolEvent = z.infer<typeof protocolEventSchema>;
