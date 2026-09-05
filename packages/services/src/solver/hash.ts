import { keccak_256 } from "@noble/hashes/sha3.js";

import type {
  AtomicSettlementIntent,
  AtomicSettlementProposal,
  BindingConstraint,
} from "@aurka/shared";

import type { SolverSnapshot } from "./types.js";

const text = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function hashText(value: string): Uint8Array {
  return keccak_256(text.encode(value));
}

function bytes32(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError("Expected bytes32");
  return parseHex(value);
}

function slot(value: bigint | number | string): Uint8Array {
  const number = typeof value === "bigint" ? value : BigInt(value);
  if (number < 0n || number >= 1n << 256n)
    throw new RangeError("Value does not fit uint256");
  return parseHex(`0x${number.toString(16).padStart(64, "0")}`);
}

function address(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new TypeError("Expected address");
  return parseHex(`0x${value.slice(2).padStart(64, "0")}`);
}

function bool(value: boolean): Uint8Array {
  return slot(value ? 1 : 0);
}

function join(slots: readonly Uint8Array[]): Uint8Array {
  const value = new Uint8Array(slots.length * 32);
  slots.forEach((item, index) => value.set(item, index * 32));
  return value;
}

export interface AssetStateForHash {
  readonly token: string;
  readonly value: bigint | string;
  readonly minimumWeightBps: bigint | number | string;
  readonly maximumWeightBps: bigint | number | string;
}

/** Solidity `keccak256(abi.encode(tokens, balances))`. */
export function hashAquaBalances(
  tokens: readonly string[],
  balances: readonly (bigint | string)[],
): string {
  if (tokens.length !== balances.length)
    throw new RangeError("Balance arrays must have equal length");
  const tokenTail = [slot(tokens.length), ...tokens.map(address)];
  const balanceTail = [
    slot(balances.length),
    ...balances.map((value) => slot(value)),
  ];
  return hex(
    keccak_256(
      join([
        slot(64),
        slot(64 + tokenTail.length * 32),
        ...tokenTail,
        ...balanceTail,
      ]),
    ),
  );
}

/** Solidity `keccak256(abi.encode(AssetState[]))` for AURKA-005 assets. */
export function hashAssetStates(assets: readonly AssetStateForHash[]): string {
  return hex(
    keccak_256(
      join([
        slot(32),
        slot(assets.length),
        ...assets.flatMap((asset) => [
          address(asset.token),
          slot(asset.value),
          slot(asset.minimumWeightBps),
          slot(asset.maximumWeightBps),
        ]),
      ]),
    ),
  );
}

export interface DirectProgramFields {
  readonly policyId: string;
  readonly positionIdHash: string;
  readonly trader: string;
  readonly inputToken: string;
  readonly outputToken: string;
  readonly strategyHash: string;
  readonly inputAmount: bigint | string;
  readonly traderOutputAmount: bigint | string;
  readonly solverFeeAmount: bigint | string;
  readonly protocolFeeAmount: bigint | string;
  readonly inputValue: bigint | string;
  readonly traderOutputValue: bigint | string;
  readonly treasuryOutputValue: bigint | string;
  readonly capacityEpochId: string;
  readonly intentHash: string;
}

/** Solidity `abi.encode` payload accepted by AurkaSwapVMRouter._validateProgram. */
export function hashDirectProgram(fields: DirectProgramFields): string {
  return hex(
    keccak_256(
      join([
        hashText("AURKA_DIRECT_PAIR_V1"),
        bytes32(fields.policyId),
        bytes32(fields.positionIdHash),
        address(fields.trader),
        address(fields.inputToken),
        address(fields.outputToken),
        bytes32(fields.strategyHash),
        slot(fields.inputAmount),
        slot(fields.traderOutputAmount),
        slot(fields.solverFeeAmount),
        slot(fields.protocolFeeAmount),
        slot(fields.inputValue),
        slot(fields.traderOutputValue),
        slot(fields.treasuryOutputValue),
        bytes32(fields.capacityEpochId),
        bytes32(fields.intentHash),
      ]),
    ),
  );
}

function typedData(domain: Uint8Array, structHash: Uint8Array): string {
  return hex(
    keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...structHash])),
  );
}

function domainSeparator(snapshot: SolverSnapshot): Uint8Array {
  const typeHash = hashText(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  );
  return keccak_256(
    join([
      typeHash,
      hashText("AURKA Direct Settlement"),
      hashText("1"),
      slot(snapshot.chainId),
      address(snapshot.verifyingContract),
    ]),
  );
}

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

export function hashIntent(
  intent: AtomicSettlementIntent,
  snapshot: SolverSnapshot,
): string {
  const typeHash = hashText(
    "Intent(bytes32 intentId,bytes32 policyId,bytes32 positionIdHash,address trader,address traderInputToken,address traderOutputToken,uint256 requestedValue,uint256 minimumTraderOutputValue,bool exactInput,bool allowPartialFill,uint256 deadline,uint256 nonce,bytes32 balanceSnapshot,bytes32 priceSnapshot,bytes32 aquaStrategyHash)",
  );
  const structHash = keccak_256(
    join([
      typeHash,
      bytes32(intent.intentId),
      bytes32(intent.policyId),
      bytes32(intent.positionIdHash),
      address(intent.trader),
      address(intent.traderInputToken),
      address(intent.traderOutputToken),
      slot(intent.requestedValue),
      slot(intent.minimumTraderOutputValue),
      bool(intent.exactInput),
      bool(intent.allowPartialFill),
      slot(intent.deadline),
      slot(intent.nonce),
      bytes32(intent.balanceSnapshot),
      bytes32(intent.priceSnapshot),
      bytes32(intent.aquaStrategyHash),
    ]),
  );
  return typedData(domainSeparator(snapshot), structHash);
}

export function hashProposal(
  proposal: AtomicSettlementProposal,
  snapshot: SolverSnapshot,
): string {
  const typeHash = hashText(
    "Proposal(bytes32 intentHash,address solver,bytes32 balancesHash,bytes32 priceSnapshotHash,uint256 policyNonce,bytes32 riskCertificateHash,address traderInputToken,address traderOutputToken,uint256 traderInputAmount,uint256 traderOutputAmount,uint256 solverFeeAmount,uint256 protocolFeeAmount,uint256 traderInputValue,uint256 traderOutputValue,uint256 treasuryOutputValue,uint256 feeBpsScaled,uint256 baseFeeAmount,uint256 treasuryBaseFeeAmount,uint256 optionSpacePremiumAmount,uint256 totalFeeAmount,uint256 treasuryAmount,uint256 solverAmount,uint256 protocolAmount,address feeToken,uint8 feePaymentMode,bytes32 initialPortfolioHash,uint256 capacityBaselineValue,uint256 consumedBefore,uint256 consumedAfter,bytes32 capacityEpochId,uint256 utilizationBefore,uint256 utilizationAfter,uint8 bindingConstraint,address bindingAsset,bytes32 expectedPostStateHash,bytes32 aquaStrategyHash,bytes32 swapVMCalldataHash,uint256 deadline)",
  );
  const structHash = keccak_256(
    join([
      typeHash,
      bytes32(proposal.intentHash),
      address(proposal.solver),
      bytes32(proposal.balancesHash),
      bytes32(proposal.priceSnapshotHash),
      slot(proposal.policyNonce),
      bytes32(proposal.riskCertificateHash),
      address(proposal.traderInputToken),
      address(proposal.traderOutputToken),
      slot(proposal.traderInputAmount),
      slot(proposal.traderOutputAmount),
      slot(proposal.solverFeeAmount),
      slot(proposal.protocolFeeAmount),
      slot(proposal.traderInputValue),
      slot(proposal.traderOutputValue),
      slot(proposal.treasuryOutputValue),
      slot(proposal.feeBpsScaled),
      slot(proposal.baseFeeAmount),
      slot(proposal.treasuryBaseFeeAmount),
      slot(proposal.optionSpacePremiumAmount),
      slot(proposal.totalFeeAmount),
      slot(proposal.treasuryAmount),
      slot(proposal.solverAmount),
      slot(proposal.protocolAmount),
      address(proposal.feeToken),
      slot(0),
      bytes32(proposal.initialPortfolioHash),
      slot(proposal.capacityBaselineValue),
      slot(proposal.consumedBefore),
      slot(proposal.consumedAfter),
      bytes32(proposal.capacityEpochId),
      slot(proposal.utilizationBefore),
      slot(proposal.utilizationAfter),
      slot(constraintCode[proposal.bindingConstraint]),
      address(
        proposal.bindingAsset ?? "0x0000000000000000000000000000000000000000",
      ),
      bytes32(proposal.expectedPostStateHash),
      bytes32(proposal.aquaStrategyHash),
      bytes32(proposal.swapVMCalldataHash),
      slot(proposal.deadline),
    ]),
  );
  return typedData(domainSeparator(snapshot), structHash);
}

export function hashCanonical(value: unknown): string {
  const canonical = JSON.stringify(value, (_, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return item;
  });
  return hex(hashText(canonical));
}

export function hashBytes(value: Uint8Array | string): string {
  return hex(
    keccak_256(typeof value === "string" ? text.encode(value) : value),
  );
}
