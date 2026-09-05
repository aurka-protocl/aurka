import {
  atomicSettlementProposalSchema,
  type AtomicSettlementIntent,
  type AtomicSettlementProposal,
} from "@aurka/shared";

import { hashIntent, hashProposal } from "./hash.js";
import { calculateSolverFill } from "./direct.js";
import { verifyProposalSignature } from "./signing.js";
import type {
  ProposalSimulation,
  RouterSimulator,
  SolvedProposal,
  SolverSnapshot,
} from "./types.js";

export interface CollectedProposal {
  readonly proposal: AtomicSettlementProposal;
  readonly proposalHash: string;
  readonly simulation: ProposalSimulation;
}

/** Validates solver submissions before they enter deterministic ranking. */
export class ProposalCollector {
  constructor(private readonly simulator: RouterSimulator) {}

  async collect(
    intent: AtomicSettlementIntent,
    proposals: readonly AtomicSettlementProposal[],
    snapshot: SolverSnapshot,
  ): Promise<CollectedProposal[]> {
    const intentHash = hashIntent(intent, snapshot);
    const collected: CollectedProposal[] = [];
    for (const candidate of proposals) {
      const proposal = atomicSettlementProposalSchema.parse(candidate);
      if (proposal.intentHash !== intentHash) continue;
      const proposalHash = hashProposal(proposal, snapshot);
      if (!verifyProposalSignature(proposal, proposalHash)) continue;
      const simulation = await this.simulator.simulate(
        intent,
        proposal,
        snapshot,
      );
      if (simulation.status !== "SUCCEEDED") continue;
      collected.push({ proposal, proposalHash, simulation });
    }
    return collected.sort((left, right) => {
      const leftValue = BigInt(left.proposal.traderInputValue);
      const rightValue = BigInt(right.proposal.traderInputValue);
      if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1;
      const leftOutput = BigInt(left.proposal.traderOutputValue);
      const rightOutput = BigInt(right.proposal.traderOutputValue);
      if (leftOutput !== rightOutput) return leftOutput > rightOutput ? -1 : 1;
      const leftFee = BigInt(left.proposal.totalFeeAmount);
      const rightFee = BigInt(right.proposal.totalFeeAmount);
      if (leftFee !== rightFee) return leftFee < rightFee ? -1 : 1;
      return left.proposalHash.localeCompare(right.proposalHash);
    });
  }

  async select(
    intent: AtomicSettlementIntent,
    proposals: readonly AtomicSettlementProposal[],
    snapshot: SolverSnapshot,
  ): Promise<SolvedProposal | undefined> {
    const collected = await this.collect(intent, proposals, snapshot);
    const selected = collected[0];
    if (!selected) return undefined;
    return {
      proposal: selected.proposal,
      proposalHash: selected.proposalHash,
      simulation: selected.simulation,
      // Collection is for externally submitted proposals. The fill is only
      // needed by ranking callers and is recomputed by the direct solver.
      fill: calculateSolverFill(snapshot, intent),
    };
  }
}
