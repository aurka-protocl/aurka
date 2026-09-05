import type { AtomicSettlementIntent } from "@aurka/shared";

import type { DirectSolver } from "./direct.js";
import { verifyProposalSignature } from "./signing.js";
import type { SolvedProposal, SolverRankingKey } from "./types.js";

export interface OptimizedRoute {
  readonly id: string;
  readonly allowlisted: true;
  solve(intent: AtomicSettlementIntent): Promise<SolvedProposal>;
}

function rankingKey(value: SolvedProposal): SolverRankingKey {
  return {
    executableValue: value.fill.executedValue,
    traderOutputValue: value.fill.traderOutputValue,
    totalFeeAmount: value.fill.fees.totalFeeAmount,
    gasEstimate: value.simulation.gasEstimate,
    proposalHash: value.proposalHash,
  };
}

/**
 * A deliberately closed strategy registry. Empty by default, it falls back to
 * the direct router and never accepts arbitrary route or calldata input.
 */
export class OptimizedSolver {
  constructor(
    private readonly directSolver: DirectSolver,
    private readonly routes: readonly OptimizedRoute[] = [],
  ) {}

  async solve(intent: AtomicSettlementIntent): Promise<SolvedProposal> {
    const direct = await this.directSolver.solve(intent);
    const routeResults = await Promise.allSettled(
      this.routes
        .filter((route) => route.allowlisted)
        .map((route) => route.solve(intent)),
    );
    const candidates = [
      direct,
      ...routeResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      ),
    ];
    const executable = candidates.filter(
      (candidate) =>
        candidate.simulation.status === "SUCCEEDED" &&
        verifyProposalSignature(candidate.proposal, candidate.proposalHash),
    );
    if (executable.length === 0)
      throw new Error("No executable solver proposal");
    return [...executable].sort((left, right) => {
      const a = rankingKey(left);
      const b = rankingKey(right);
      if (a.executableValue !== b.executableValue)
        return a.executableValue > b.executableValue ? -1 : 1;
      if (a.traderOutputValue !== b.traderOutputValue)
        return a.traderOutputValue > b.traderOutputValue ? -1 : 1;
      if (a.totalFeeAmount !== b.totalFeeAmount)
        return a.totalFeeAmount < b.totalFeeAmount ? -1 : 1;
      if (a.gasEstimate !== b.gasEstimate)
        return a.gasEstimate < b.gasEstimate ? -1 : 1;
      return a.proposalHash.localeCompare(b.proposalHash);
    })[0]!;
  }
}
