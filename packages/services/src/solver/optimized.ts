import type { AtomicSettlementIntent } from "@aurka/shared";

import type { DirectSolver } from "./direct.js";
import type { SolvedProposal } from "./types.js";

/**
 * Phase 5 intentionally exposes one closed settlement strategy: direct
 * pairwise execution. Keeping this wrapper preserves the service boundary
 * while making it impossible for callers to inject arbitrary routes or
 * calldata. Multi-route optimization belongs to a separately reviewed
 * milestone.
 */
export class OptimizedSolver {
  constructor(private readonly directSolver: DirectSolver) {}

  solve(intent: AtomicSettlementIntent): Promise<SolvedProposal> {
    return this.directSolver.solve(intent);
  }
}
