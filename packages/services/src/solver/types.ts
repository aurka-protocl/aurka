import type {
  AtomicSettlementIntent,
  AtomicSettlementProposal,
  FeeAccounting,
  FinancialFeeConfig,
  FinancialPolicy,
  PortfolioSnapshot,
  PortfolioValuation,
  RiskMode,
  SettlementPriceProtection,
} from "@aurka/shared";
import type {
  CapacityEpoch,
  DirectSettlementInput,
  DirectSettlementResult,
} from "@aurka/shared";

export interface SolverSnapshot {
  readonly positionId: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly policyId: string;
  readonly policy: FinancialPolicy;
  readonly fee: FinancialFeeConfig;
  readonly feeAccounting: FeeAccounting;
  readonly riskMode: RiskMode;
  readonly riskCertificateHash: string;
  readonly policyNonce: string;
  readonly portfolio: PortfolioValuation;
  readonly portfolioSnapshot: PortfolioSnapshot;
  readonly capacityEpoch: CapacityEpoch;
  readonly capacityEpochId: string;
  readonly priceProtection: SettlementPriceProtection;
  readonly snapshotBlock: bigint;
  readonly aquaStrategyHash: string;
  readonly balancesHash: string;
  /** Converts value units into committed raw token amounts for the quote. */
  readonly rawAmountsForValue?: (
    traderInputValue: bigint,
    treasuryOutputValue: bigint,
  ) => {
    readonly traderInputAmount: bigint;
    readonly traderOutputAmount: bigint;
  };
  /** Converts one output-token value leg into output-token raw units. */
  readonly outputAmountForValue?: (value: bigint) => bigint;
}

export interface ProposalSimulation {
  readonly status: "SUCCEEDED" | "REVERTED" | "STALE" | "AUTHORIZATION_PENDING";
  readonly gasEstimate: bigint;
  readonly reason?: string;
}

export interface RouterSimulator {
  simulate(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
  ): Promise<ProposalSimulation>;
  /** Optional authoritative check used at the custody/execution boundary. */
  simulateExact?(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
  ): Promise<ProposalSimulation>;
}

export interface ProposalSigner {
  readonly address: string;
  signProposal(
    proposal: AtomicSettlementProposal,
    proposalHash: string,
    snapshot: SolverSnapshot,
  ): Promise<string>;
}

export interface SolvedProposal {
  readonly proposal: AtomicSettlementProposal;
  readonly proposalHash: string;
  readonly fill: DirectSettlementResult;
  readonly simulation: ProposalSimulation;
}

export interface SolverSnapshotProvider {
  getSnapshot(intent: AtomicSettlementIntent): Promise<SolverSnapshot>;
}

export function asDirectSettlementInput(
  snapshot: SolverSnapshot,
  intent: AtomicSettlementIntent,
): DirectSettlementInput {
  return {
    portfolio: snapshot.portfolio,
    policy: snapshot.policy,
    fee: snapshot.fee,
    feeAccounting: snapshot.feeAccounting,
    traderInputToken: intent.traderInputToken,
    traderOutputToken: intent.traderOutputToken,
    requestedValue: intent.requestedValue,
    capacityBaselineValue: snapshot.capacityEpoch.capacityBaselineValue,
    consumedBefore: snapshot.capacityEpoch.consumedBefore,
    capacityEpochId: snapshot.capacityEpochId,
    capacityEpoch: snapshot.capacityEpoch,
    priceProtection: snapshot.priceProtection,
  };
}

export type SolverDirection = Pick<
  DirectSettlementInput,
  "traderInputToken" | "traderOutputToken"
>;

export interface SolverRankingKey {
  readonly executableValue: bigint;
  readonly traderOutputValue: bigint;
  readonly totalFeeAmount: bigint;
  readonly gasEstimate: bigint;
  readonly proposalHash: string;
}
