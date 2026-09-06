import type {
  AtomicSettlementIntent,
  AtomicSettlementProposal,
  BindingConstraint,
  PriceSnapshot,
} from "@aurka/shared";

import { AURKA_ROUTER_EXECUTE_SELECTOR } from "@aurka/shared";

import type { AssetStateForHash } from "./hash.js";
import { encodeDirectProgram } from "./hash.js";
import type { SolverSnapshot } from "./types.js";

export const ROUTER_EXECUTE_SELECTOR = AURKA_ROUTER_EXECUTE_SELECTOR;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const constraintCode: Record<BindingConstraint, number> = {
  NONE: 0,
  TRANSACTION_CAP: 1,
  AVAILABLE_BALANCE: 2,
  CAPACITY_EXHAUSTED: 3,
  MINIMUM_WEIGHT: 4,
  MAXIMUM_WEIGHT: 5,
  RISK_LIMIT: 0,
  FEE_EXCEEDS_OUTPUT: 0,
  PAUSED: 0,
  REQUESTED_AMOUNT: 0,
};

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X")
    ? value.slice(2)
    : value;
}

function addressWord(value: string): string {
  const clean = strip0x(value).toLowerCase();
  if (clean.length > 40) {
    throw new RangeError(`Invalid address length: ${value}`);
  }
  return clean.padStart(64, "0");
}

function uintWord(value: bigint | number | string): string {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) {
    throw new RangeError(`Negative uint: ${value}`);
  }
  return big.toString(16).padStart(64, "0");
}

function boolWord(value: boolean): string {
  return (value ? "1" : "0").padStart(64, "0");
}

function bytes32Word(value: string): string {
  const clean = strip0x(value).toLowerCase();
  if (clean.length > 64) {
    throw new RangeError(`Bytes32 exceeds 32 bytes: ${value}`);
  }
  return clean.padStart(64, "0");
}

function encodeBytesTail(dataHex: string): string {
  const clean = strip0x(dataHex);
  const lengthBytes = clean.length / 2;
  const lengthWord = lengthBytes.toString(16).padStart(64, "0");
  const padLength = Math.ceil(clean.length / 64) * 64;
  const paddedData = clean.padEnd(padLength, "0");
  return lengthWord + paddedData;
}

function encodeSnapshot(snapshot: PriceSnapshot): string {
  return (
    addressWord(snapshot.token) +
    bytes32Word(snapshot.snapshotId) +
    uintWord(snapshot.price) +
    uintWord(snapshot.priceDecimals) +
    uintWord(snapshot.observedAt)
  );
}

export interface RouterExecuteInput {
  readonly intent: AtomicSettlementIntent;
  readonly intentSignature?: string;
  readonly proposal: AtomicSettlementProposal;
  readonly proposalSignature: string;
  readonly assets: readonly AssetStateForHash[];
  readonly snapshot: SolverSnapshot;
  readonly directProgramHex: string;
}

/**
 * Build the exact bytes validated by AurkaSettlementAuthority. Keeping this
 * construction beside the ABI encoder prevents solving and execution from
 * committing different direct-program payloads.
 */
export function encodeSettlementDirectProgram(
  intent: AtomicSettlementIntent,
  proposal: AtomicSettlementProposal,
  intentHash: string,
): string {
  const bytes = encodeDirectProgram({
    policyId: intent.policyId,
    positionIdHash: intent.positionIdHash,
    trader: intent.trader,
    inputToken: intent.traderInputToken,
    outputToken: intent.traderOutputToken,
    strategyHash: proposal.aquaStrategyHash,
    inputAmount: BigInt(proposal.traderInputAmount),
    traderOutputAmount: BigInt(proposal.traderOutputAmount),
    solverFeeAmount: BigInt(proposal.solverFeeAmount),
    protocolFeeAmount: BigInt(proposal.protocolFeeAmount),
    inputValue: BigInt(proposal.traderInputValue),
    traderOutputValue: BigInt(proposal.traderOutputValue),
    treasuryOutputValue: BigInt(proposal.treasuryOutputValue),
    capacityEpochId: proposal.capacityEpochId,
    intentHash,
  });
  return `0x${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function encodeRouterExecuteCall(input: RouterExecuteInput): string {
  // Head words:
  // 0: Intent (15 words)
  // 1: intentSignature offset (1 word)
  // 2: Proposal (38 words)
  // 3: proposalSignature offset (1 word)
  // 4: assets offset (1 word)
  // 5: CapacityEpoch (14 words)
  // 6: SettlementInput (32 words)
  // 7: directProgram offset (1 word)
  // Total head words = 15 + 1 + 38 + 1 + 1 + 14 + 32 + 1 = 103 words = 3296 bytes.

  const intentWords = [
    bytes32Word(input.intent.intentId),
    bytes32Word(input.intent.policyId),
    bytes32Word(input.intent.positionIdHash),
    addressWord(input.intent.trader),
    addressWord(input.intent.traderInputToken),
    addressWord(input.intent.traderOutputToken),
    uintWord(input.intent.requestedValue),
    uintWord(input.intent.minimumTraderOutputValue),
    boolWord(input.intent.exactInput),
    boolWord(input.intent.allowPartialFill),
    uintWord(input.intent.deadline),
    uintWord(input.intent.nonce),
    bytes32Word(input.intent.balanceSnapshot),
    bytes32Word(input.intent.priceSnapshot),
    bytes32Word(input.intent.aquaStrategyHash),
  ].join("");

  const proposalWords = [
    bytes32Word(input.proposal.intentHash),
    addressWord(input.proposal.solver),
    bytes32Word(input.proposal.balancesHash),
    bytes32Word(input.proposal.priceSnapshotHash),
    uintWord(input.proposal.policyNonce),
    bytes32Word(input.proposal.riskCertificateHash),
    addressWord(input.proposal.traderInputToken),
    addressWord(input.proposal.traderOutputToken),
    uintWord(input.proposal.traderInputAmount),
    uintWord(input.proposal.traderOutputAmount),
    uintWord(input.proposal.solverFeeAmount),
    uintWord(input.proposal.protocolFeeAmount),
    uintWord(input.proposal.traderInputValue),
    uintWord(input.proposal.traderOutputValue),
    uintWord(input.proposal.treasuryOutputValue),
    uintWord(input.proposal.feeBpsScaled),
    uintWord(input.proposal.baseFeeAmount),
    uintWord(input.proposal.treasuryBaseFeeAmount),
    uintWord(input.proposal.optionSpacePremiumAmount),
    uintWord(input.proposal.totalFeeAmount),
    uintWord(input.proposal.treasuryAmount),
    uintWord(input.proposal.solverAmount),
    uintWord(input.proposal.protocolAmount),
    addressWord(input.proposal.feeToken),
    uintWord(0), // feePaymentMode = OUTPUT_TOKEN
    bytes32Word(input.proposal.initialPortfolioHash),
    uintWord(input.proposal.capacityBaselineValue),
    uintWord(input.proposal.consumedBefore),
    uintWord(input.proposal.consumedAfter),
    bytes32Word(input.proposal.capacityEpochId),
    uintWord(input.proposal.utilizationBefore),
    uintWord(input.proposal.utilizationAfter),
    uintWord(constraintCode[input.proposal.bindingConstraint]),
    addressWord(input.proposal.bindingAsset ?? ZERO_ADDRESS),
    bytes32Word(input.proposal.expectedPostStateHash),
    bytes32Word(input.proposal.aquaStrategyHash),
    bytes32Word(input.proposal.swapVMCalldataHash),
    uintWord(input.proposal.deadline),
  ].join("");

  const epoch = input.snapshot.capacityEpoch;
  const epochWords = [
    bytes32Word(input.intent.positionIdHash),
    addressWord(input.intent.traderInputToken),
    addressWord(input.intent.traderOutputToken),
    bytes32Word(epoch.balanceSnapshot),
    bytes32Word(epoch.priceSnapshot),
    bytes32Word(epoch.portfolioPriceSnapshot),
    uintWord(epoch.policyNonce),
    bytes32Word(epoch.riskCertificateHash),
    bytes32Word(epoch.aquaStrategyHash),
    uintWord(epoch.capacityBaselineValue),
    uintWord(epoch.consumedBefore),
    uintWord(epoch.chainId),
    addressWord(epoch.verifyingContract),
    bytes32Word(input.snapshot.capacityEpochId),
  ].join("");

  // The approved oracle/policy commitment is stable across a capacity epoch,
  // but the raw token amounts are fill-specific.  Encoding the snapshot's
  // provisional amounts here makes capped and split fills fail the router's
  // ProposalMismatch check.  The router expects the gross treasury output,
  // while Proposal.traderOutputAmount is net of the two external fee legs.
  const p = {
    ...input.snapshot.priceProtection,
    traderInputAmount: input.proposal.traderInputAmount,
    traderOutputAmount: (
      BigInt(input.proposal.traderOutputAmount) +
      BigInt(input.proposal.solverFeeAmount) +
      BigInt(input.proposal.protocolFeeAmount)
    ).toString(),
  };
  const priceInputWords = [
    addressWord(input.intent.traderInputToken),
    addressWord(input.intent.traderOutputToken),
    encodeSnapshot(p.traderInputReferencePrice),
    encodeSnapshot(p.traderInputExecutionPrice),
    encodeSnapshot(p.traderOutputReferencePrice),
    encodeSnapshot(p.traderOutputExecutionPrice),
    bytes32Word(p.approvedTraderInputSnapshotId),
    bytes32Word(p.approvedTraderOutputSnapshotId),
    uintWord(p.traderInputAmount),
    uintWord(p.traderOutputAmount),
    uintWord(p.traderInputDecimals),
    uintWord(p.traderOutputDecimals),
    uintWord(p.valueDecimals),
    uintWord(p.nowSeconds),
    uintWord(p.maximumPriceAgeSeconds),
    uintWord(p.maximumPriceDeviationBps),
  ].join("");

  const HEAD_BYTES = 103 * 32;

  const intentSignatureTail = encodeBytesTail(input.intentSignature ?? "");
  const offset1 = HEAD_BYTES;

  const proposalSignatureTail = encodeBytesTail(input.proposalSignature);
  const offset3 = offset1 + intentSignatureTail.length / 2;

  const assetsCountWord = uintWord(input.assets.length);
  const assetsElements = input.assets
    .map(
      (a) =>
        addressWord(a.token) +
        uintWord(a.value) +
        uintWord(a.minimumWeightBps) +
        uintWord(a.maximumWeightBps),
    )
    .join("");
  const assetsTail = assetsCountWord + assetsElements;
  const offset4 = offset3 + proposalSignatureTail.length / 2;

  const directProgramTail = encodeBytesTail(input.directProgramHex);
  const offset7 = offset4 + assetsTail.length / 2;

  const head =
    intentWords +
    uintWord(offset1) +
    proposalWords +
    uintWord(offset3) +
    uintWord(offset4) +
    epochWords +
    priceInputWords +
    uintWord(offset7);

  const calldataHex =
    ROUTER_EXECUTE_SELECTOR +
    head +
    intentSignatureTail +
    proposalSignatureTail +
    assetsTail +
    directProgramTail;

  return calldataHex;
}

export interface RouterTransactionRequest {
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly value: string;
}

/** Construct the single transaction shape shared by eth_call and /execute. */
export function buildRouterTransactionRequest(
  intent: AtomicSettlementIntent,
  proposal: AtomicSettlementProposal,
  snapshot: SolverSnapshot,
  intentHash: string,
  intentSignature?: string,
): RouterTransactionRequest {
  return {
    chainId: snapshot.chainId,
    to: snapshot.verifyingContract,
    data: encodeRouterExecuteCall({
      intent,
      ...(intentSignature === undefined ? {} : { intentSignature }),
      proposal,
      proposalSignature: proposal.signature ?? "",
      assets: snapshot.portfolio.assets,
      snapshot,
      directProgramHex: encodeSettlementDirectProgram(
        intent,
        proposal,
        intentHash,
      ),
    }),
    value: "0",
  };
}
