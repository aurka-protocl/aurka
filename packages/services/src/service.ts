import {
  calculateDirectionalCapacity,
  executionSchema,
  positionSchema,
  quoteSchema,
  type AtomicSettlementIntent,
  type AtomicSettlementProposal,
  type DirectionalCapacity,
  type Execution,
  type Position,
  type ProtocolEvent,
  type Quote,
} from "@aurka/shared";

import { ServiceDatabase } from "./db/database.js";
import { ServiceRepository, type Page } from "./db/repository.js";
import {
  FIXTURE_ADDRESSES,
  FIXTURE_POLICY_ID,
  FixtureProvider,
  createCanonicalFixture,
} from "./fixture.js";
import { hashBytes, hashIntent, hashProposal } from "./solver/hash.js";
import { DirectSolver } from "./solver/direct.js";
import { OptimizedSolver } from "./solver/optimized.js";
import {
  FixtureProposalSigner,
  verifySignature,
  verifyProposalSignature,
} from "./solver/signing.js";
import {
  buildRouterTransactionRequest,
  type RouterTransactionRequest,
} from "./solver/calldata.js";
import { DeterministicRouterSimulator } from "./fixture.js";
import type {
  ProposalSigner,
  RouterSimulator,
  SolverSnapshot,
  SolverSnapshotProvider,
} from "./solver/types.js";
import { Eip1193RouterSimulator, type Eip1193Transport } from "./solver/rpc.js";
import { RiskService } from "./risk-service.js";

export type UnsignedTransactionRequest = RouterTransactionRequest;

export interface ServiceOptions {
  readonly database?: ServiceDatabase;
  readonly provider?: SolverSnapshotProvider;
  readonly signer?: ProposalSigner;
  readonly seedFixture?: boolean;
  readonly chainId?: number;
  readonly settlementContract?: string;
  readonly indexConfirmations?: number;
  readonly routerSimulator?: RouterSimulator;
  readonly rpcTransport?: Eip1193Transport;
}

export interface ServiceRuntimeDiagnostics {
  readonly chainId: number;
  readonly settlementContract: string | undefined;
  readonly indexConfirmations: number;
  readonly rpc: "fixture-only" | "configured";
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

function positionForFixture(): Position {
  const fixture = createCanonicalFixture();
  const snapshot = fixture.snapshot;
  return positionSchema.parse({
    id: snapshot.positionId,
    name: "Canonical local treasury",
    chainId: snapshot.chainId,
    owner: FIXTURE_ADDRESSES.treasury,
    treasury: FIXTURE_ADDRESSES.treasury,
    policy: {
      id: FIXTURE_POLICY_ID,
      chainId: snapshot.chainId,
      registry: FIXTURE_ADDRESSES.registry,
      treasury: FIXTURE_ADDRESSES.treasury,
      governance: FIXTURE_ADDRESSES.treasury,
      assets: snapshot.portfolio.assets.map((asset) => ({
        token: asset.token,
        symbol: asset.symbol ?? "ASSET",
        decimals: asset.decimals,
        minimumWeightBps: Number(asset.minimumWeightBps),
        maximumWeightBps: Number(asset.maximumWeightBps),
      })),
      maximumTransactionValue:
        snapshot.policy.maximumTransactionValue.toString(),
      quoteTtlSeconds: 60,
      priceMaxAgeSeconds: snapshot.priceProtection.maximumPriceAgeSeconds,
      maximumPriceDeviationBps: Number(
        snapshot.priceProtection.maximumPriceDeviationBps,
      ),
      fee: {
        baseFeeBps: Number(snapshot.fee.baseFeeBps),
        slopeBps: Number(snapshot.fee.slopeBps),
        maximumFeeBps: Number(snapshot.fee.maximumFeeBps),
        treasuryBaseFeeBps: Number(snapshot.fee.treasuryBaseFeeBps),
        solverFeeBps: Number(snapshot.fee.solverFeeBps),
        protocolFeeBps: Number(snapshot.fee.protocolFeeBps),
        treasuryFeeRecipient: FIXTURE_ADDRESSES.treasury,
        protocolFeeRecipient: FIXTURE_ADDRESSES.protocol,
      },
      nonce: snapshot.policyNonce,
      paused: false,
    },
    riskMode: snapshot.riskMode,
    currentPortfolio: snapshot.portfolioSnapshot,
    createdAt: 100,
    updatedAt: 100,
  });
}

export class AurkaService {
  readonly database: ServiceDatabase;
  readonly repository: ServiceRepository;
  readonly provider: SolverSnapshotProvider;
  readonly directSolver: DirectSolver;
  readonly optimizedSolver: OptimizedSolver;
  readonly routerSimulator: RouterSimulator;
  readonly riskService: RiskService;
  readonly runtime: ServiceRuntimeDiagnostics;

  constructor(options: ServiceOptions = {}) {
    this.database = options.database ?? new ServiceDatabase();
    this.repository = new ServiceRepository(this.database.db);
    this.riskService = new RiskService(this.repository);
    this.runtime = {
      chainId: options.chainId ?? 31_337,
      settlementContract: options.settlementContract,
      indexConfirmations: options.indexConfirmations ?? 2,
      rpc: options.rpcTransport ? "configured" : "fixture-only",
    };
    const sourceProvider = options.provider ?? new FixtureProvider();
    this.provider = {
      getSnapshot: async (intent) => {
        const snapshot = await sourceProvider.getSnapshot(intent);
        if (snapshot.chainId !== this.runtime.chainId) {
          throw new ServiceError(
            "CHAIN_MISMATCH",
            "Settlement snapshot chain does not match service configuration",
            409,
          );
        }
        if (
          this.runtime.settlementContract !== undefined &&
          snapshot.verifyingContract.toLowerCase() !==
            this.runtime.settlementContract.toLowerCase()
        ) {
          throw new ServiceError(
            "CONTRACT_MISMATCH",
            "Settlement snapshot router does not match service configuration",
            409,
          );
        }
        return snapshot;
      },
    };
    this.routerSimulator =
      options.routerSimulator ??
      (options.rpcTransport
        ? new Eip1193RouterSimulator(options.rpcTransport)
        : new DeterministicRouterSimulator());
    this.directSolver = new DirectSolver(
      this.provider,
      this.routerSimulator,
      options.signer ?? new FixtureProposalSigner(),
    );
    this.optimizedSolver = new OptimizedSolver(this.directSolver);
    if (options.seedFixture !== false)
      this.repository.savePosition(positionForFixture());
  }

  close(): void {
    this.database.close();
  }

  listPositions(limit: number, cursor?: string): Page<Position> {
    return this.repository.listPositions(limit, cursor);
  }

  getPosition(id: string): Position {
    const value = this.repository.getPosition(id);
    if (!value)
      throw new ServiceError(
        "POSITION_NOT_FOUND",
        "Position was not found",
        404,
      );
    return value;
  }

  async getCapacity(
    positionId: string,
    traderInputToken: string,
    traderOutputToken: string,
  ): Promise<DirectionalCapacity> {
    this.getPosition(positionId);
    const fixture = createCanonicalFixture({ positionId });
    const snapshot = await this.provider.getSnapshot(fixture.intent);
    const state = this.repository.getCapacityEpoch(
      positionId,
      traderInputToken.toLowerCase(),
      traderOutputToken.toLowerCase(),
    );
    const capacity = calculateDirectionalCapacity(
      snapshot.portfolio,
      snapshot.policy,
      traderInputToken,
      traderOutputToken,
      state
        ? {
            capacityBaselineValue: state.capacityBaselineValue,
            consumedValue: state.consumedValue,
            capacityEpochId: state.capacityEpochId,
          }
        : undefined,
    );
    return {
      positionId,
      traderInputToken,
      traderOutputToken,
      maximumTraderInput: capacity.maximumValue.toString(),
      maximumTraderOutput: capacity.maximumValue.toString(),
      maximumValue: capacity.maximumValue.toString(),
      capacityBaselineValue: capacity.capacityBaselineValue.toString(),
      consumedBefore: capacity.consumedValue.toString(),
      capacityEpochId: state?.capacityEpochId ?? snapshot.capacityEpochId,
      remainingValue: capacity.remainingValue.toString(),
      utilization: capacity.utilization.toString(),
      bindingConstraint: capacity.bindingConstraint,
      calculatedAtBlock: snapshot.snapshotBlock.toString(),
      expiresAt: snapshot.priceProtection.nowSeconds + 60,
    };
  }

  async submitIntent(
    intent: AtomicSettlementIntent,
  ): Promise<{ intent: AtomicSettlementIntent; intentHash: string }> {
    const snapshot = await this.provider.getSnapshot(intent);
    const intentHash = hashIntent(intent, snapshot);
    this.repository.saveIntent(intent, intentHash);
    return { intent, intentHash };
  }

  async quote(intent: AtomicSettlementIntent): Promise<Quote> {
    const quote = quoteSchema.parse(await this.directSolver.quote(intent));
    this.repository.saveQuote(quote);
    return quote;
  }

  async solve(intent: AtomicSettlementIntent): Promise<{
    proposal: AtomicSettlementProposal;
    proposalHash: string;
    simulation: unknown;
  }> {
    const solved = await this.optimizedSolver.solve(intent);
    this.repository.saveProposal(
      solved.proposal,
      solved.proposalHash,
      solved.simulation.status,
    );
    return {
      proposal: solved.proposal,
      proposalHash: solved.proposalHash,
      simulation: {
        status: solved.simulation.status,
        gasEstimate: solved.simulation.gasEstimate.toString(),
        ...(solved.simulation.reason === undefined
          ? {}
          : { reason: solved.simulation.reason }),
      },
    };
  }

  async listProposals(
    intentIdOrHash: string,
    limit = 20,
  ): Promise<AtomicSettlementProposal[]> {
    const intent = this.repository.getIntent(intentIdOrHash);
    if (!intent)
      throw new ServiceError("INTENT_NOT_FOUND", "Intent was not found", 404);
    const snapshot = await this.provider.getSnapshot(intent);
    const intentHashValue = hashIntent(intent, snapshot);
    return this.repository.listProposals(intentHashValue, limit);
  }

  async execute(
    intentHashValue: string,
    proposalHashValue: string,
    externalSignature?: string,
  ): Promise<{
    execution: Execution;
    transactionRequest: UnsignedTransactionRequest;
  }> {
    const intent = this.repository.getIntent(intentHashValue);
    const proposal = this.repository.getProposal(proposalHashValue);
    if (!intent || !proposal)
      throw new ServiceError(
        "OBJECT_NOT_FOUND",
        "Intent or proposal was not found",
        404,
      );
    const snapshot = await this.provider.getSnapshot(intent);
    const expectedIntentHash = hashIntent(intent, snapshot);
    const expectedProposalHash = hashProposal(proposal, snapshot);
    if (
      expectedIntentHash !== proposal.intentHash ||
      expectedProposalHash !== proposalHashValue
    ) {
      throw new ServiceError(
        "COMMITMENT_MISMATCH",
        "Stored commitment does not match the current settlement snapshot",
      );
    }
    if (!verifyProposalSignature(proposal, expectedProposalHash)) {
      throw new ServiceError(
        "PROPOSAL_SIGNATURE_INVALID",
        "Solver proposal signature is invalid",
      );
    }
    const authorization = externalSignature ?? intent.signature;
    if (authorization !== undefined) {
      if (!verifySignature(intent.trader, expectedIntentHash, authorization)) {
        throw new ServiceError(
          "INVALID_SIGNATURE",
          "External trader signature is invalid",
          400,
        );
      }
    }
    const simulationIntent =
      authorization === undefined
        ? intent
        : { ...intent, signature: authorization };
    const simulation =
      authorization !== undefined &&
      this.routerSimulator.simulateExact !== undefined
        ? await this.routerSimulator.simulateExact(
            simulationIntent,
            proposal,
            snapshot,
          )
        : await this.routerSimulator.simulate(
            simulationIntent,
            proposal,
            snapshot,
          );
    if (
      simulation.status !== "SUCCEEDED" &&
      !(
        authorization === undefined &&
        simulation.status === "AUTHORIZATION_PENDING"
      )
    ) {
      throw new ServiceError(
        "SIMULATION_FAILED",
        simulation.reason ?? "Router simulation failed",
      );
    }
    if (authorization !== undefined && simulation.status === "SUCCEEDED") {
      // A preflight-only proposal remains pending until the caller supplies a
      // verified trader authorization and the exact router boundary passes.
      this.repository.saveProposal(proposal, proposalHashValue, "SUCCEEDED");
    }
    const transactionRequest = this.buildTransactionRequest(
      intent,
      proposal,
      snapshot,
      expectedIntentHash,
      authorization,
    );
    // Phase 5 has no broadcaster. Keep this a durable pending request, never
    // a synthetic onchain transaction hash or a claimed submission.
    const executionId = hashBytes(
      `pending:${expectedIntentHash}:${expectedProposalHash}`,
    );
    const execution = this.pendingExecution(
      intent,
      proposal,
      snapshot,
      executionId,
    );
    this.repository.saveExecution(execution);
    return { execution, transactionRequest };
  }

  getExecution(hash: string): Execution {
    const execution = this.repository.getExecution(hash);
    if (!execution)
      throw new ServiceError(
        "EXECUTION_NOT_FOUND",
        "Execution was not found",
        404,
      );
    return execution;
  }

  projectEvent(event: ProtocolEvent): void {
    this.repository.projectEvent(event);
  }

  projectRemovedLog(event: ProtocolEvent): void {
    this.repository.projectRemovedLog(event);
  }

  private pendingExecution(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
    transactionHash: string,
  ): Execution {
    const result = executionSchema.parse({
      transactionHash,
      chainId: snapshot.chainId,
      intentHash: proposal.intentHash,
      proposalHash: hashProposal(proposal, snapshot),
      selectedSolver: proposal.solver,
      traderInputToken: intent.traderInputToken,
      traderOutputToken: intent.traderOutputToken,
      requestedTraderInputAmount: intent.requestedValue,
      executedTraderInputAmount: proposal.traderInputValue,
      fees: {
        baseFeeBps: Number(snapshot.fee.baseFeeBps),
        optionSpacePremiumBpsScaled: (
          BigInt(proposal.feeBpsScaled) -
          BigInt(snapshot.fee.baseFeeBps) * 1_000_000_000_000_000_000n
        ).toString(),
        totalFeeBpsScaled: proposal.feeBpsScaled,
        baseFeeAmount: proposal.baseFeeAmount,
        treasuryBaseFeeAmount: proposal.treasuryBaseFeeAmount,
        optionSpacePremiumAmount: proposal.optionSpacePremiumAmount,
        totalFeeAmount: proposal.totalFeeAmount,
        treasuryAmount: proposal.treasuryAmount,
        solverAmount: proposal.solverAmount,
        protocolAmount: proposal.protocolAmount,
        feeToken: proposal.feeToken,
        feePaymentMode: "OUTPUT_TOKEN",
        treasuryRecipient: snapshot.feeAccounting.treasuryRecipient,
        solverRecipient: snapshot.feeAccounting.solverRecipient,
        protocolRecipient: snapshot.feeAccounting.protocolRecipient,
      },
      bindingConstraint: proposal.bindingConstraint,
      ...(proposal.bindingAsset === undefined
        ? {}
        : { bindingAsset: proposal.bindingAsset }),
      initialPortfolio: snapshot.portfolioSnapshot,
      remainingCapacity: (
        BigInt(proposal.capacityBaselineValue) - BigInt(proposal.consumedAfter)
      ).toString(),
      status: "PENDING",
      submittedAt: snapshot.priceProtection.nowSeconds,
    });
    return result;
  }

  private buildTransactionRequest(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
    intentHash: string,
    intentSignature?: string,
  ): UnsignedTransactionRequest {
    return buildRouterTransactionRequest(
      intent,
      proposal,
      snapshot,
      intentHash,
      intentSignature,
    );
  }
}
