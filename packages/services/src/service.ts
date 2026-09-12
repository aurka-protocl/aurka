import type {
  PrepareIntentRequest,
  PrepareTokenIntentRequest,
} from "@aurka/shared";
import {
  calculateDirectionalCapacity,
  executionSchema,
  positionSchema,
  quoteSchema,
  type ActivityItem,
  type FeeSummary,
  type AtomicSettlementIntent,
  type AtomicSettlementProposal,
  type DirectionalCapacity,
  type Execution,
  type Position,
  type ProtocolEvent,
  type Quote,
  spaceMutationAuthorizationSchema,
  spaceMutationConfirmRequestSchema,
  spaceMutationPrepareRequestSchema,
  spaceMutationTypedDataSchema,
  SPACE_MANAGEMENT_AUTHORITY,
  SPACE_MUTATION_TYPES,
  type SpaceChange,
  type SpaceDraft,
  type SpaceMutationAuthorization,
  type SpaceMutationConfirmRequest,
  type SpaceMutationPrepareRequest,
  type SpaceRecord,
  type SpaceMutationTypedData,
  snapshotFreshness,
  parseTokenAmount,
} from "@aurka/shared";

import { ServiceDatabase } from "./db/database.js";
import {
  ServiceRepository,
  type ActivityQuery,
  type FeeSummaryQuery,
  type Page,
} from "./db/repository.js";
import {
  FIXTURE_ADDRESSES,
  FIXTURE_POLICY_ID,
  FIXTURE_AQUA_STRATEGY_HASH,
  FixtureProvider,
  LocalDemoProvider,
  createCanonicalFixture,
} from "./fixture.js";
import {
  hashBytes,
  hashCanonical,
  hashIntent,
  hashProposal,
} from "./solver/hash.js";
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
import { buildUpstreamSwapVMStrategy } from "./solver/upstream.js";
import { hashTypedData } from "viem";
import { RiskService } from "./risk-service.js";
import {
  ReadinessMonitor,
  type ReadinessConfiguration,
  type RpcReadiness,
  type IndexerReadiness,
} from "./readiness.js";

export type UnsignedTransactionRequest = RouterTransactionRequest;

const serviceNow = (): number => Math.floor(Date.now() / 1000);

export interface ServiceOptions {
  readonly riskNow?: () => number;
  readonly database?: ServiceDatabase;
  readonly provider?: SolverSnapshotProvider;
  readonly signer?: ProposalSigner;
  readonly seedFixture?: boolean;
  readonly chainId?: number;
  readonly settlementContract?: string;
  readonly indexConfirmations?: number;
  readonly maxIndexerLagBlocks?: number;
  readonly rpcFinalityMaxAgeSeconds?: number;
  readonly readiness?: ReadinessConfiguration;
  readonly routerSimulator?: RouterSimulator;
  readonly rpcTransport?: Eip1193Transport;
  readonly spaceMode?: "demo" | "testnet" | "fork";
  readonly spaceAssets?: readonly { token: string; decimals: number }[];
}

export interface ServiceRuntimeDiagnostics {
  readonly chainId: number;
  readonly settlementContract: string | undefined;
  readonly indexConfirmations: number;
  readonly maxIndexerLagBlocks: number;
  readonly rpcFinalityMaxAgeSeconds: number;
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

function positionForFixture(nowSeconds = 200): Position {
  const fixture = createCanonicalFixture({ nowSeconds });
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
  readonly rpcTransport: Eip1193Transport | undefined;
  readonly readiness: ReadinessMonitor;
  readonly spaceMode: "demo" | "testnet" | "fork";
  private readonly spaceAssets: readonly { token: string; decimals: number }[];
  private readonly localProvider: LocalDemoProvider | undefined;
  private readonly now: () => number;
  private readonly positionRefreshes = new Map<string, Promise<Position>>();

  constructor(options: ServiceOptions = {}) {
    this.now = options.riskNow ?? serviceNow;
    this.rpcTransport = options.rpcTransport;
    this.spaceMode =
      options.spaceMode ?? (options.rpcTransport ? "fork" : "demo");
    this.spaceAssets =
      options.spaceAssets ??
      (this.spaceMode !== "demo"
        ? [
            {
              token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              decimals: 6,
            },
            {
              token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              decimals: 18,
            },
          ]
        : [
            { token: FIXTURE_ADDRESSES.usdc, decimals: 0 },
            { token: FIXTURE_ADDRESSES.weth, decimals: 0 },
            { token: FIXTURE_ADDRESSES.link, decimals: 0 },
          ]);
    this.database = options.database ?? new ServiceDatabase();
    this.repository = new ServiceRepository(this.database.db);
    this.riskService = new RiskService(this.repository, options.riskNow);
    this.runtime = {
      chainId: options.chainId ?? 31_337,
      settlementContract: options.settlementContract,
      indexConfirmations: options.indexConfirmations ?? 2,
      maxIndexerLagBlocks: options.maxIndexerLagBlocks ?? 20,
      rpcFinalityMaxAgeSeconds: options.rpcFinalityMaxAgeSeconds ?? 120,
      rpc: options.rpcTransport ? "configured" : "fixture-only",
    };
    this.readiness = new ReadinessMonitor(
      {
        mode: options.rpcTransport ? "live" : "fixture",
        expectedChainId: this.runtime.chainId,
        maxIndexerLagBlocks: this.runtime.maxIndexerLagBlocks,
        ...(options.readiness ?? {}),
        probes: {
          ...(options.rpcTransport ? { rpc: () => this.probeRpc() } : {}),
          ...(options.rpcTransport
            ? { indexer: () => this.probeIndexer() }
            : {}),
          ...options.readiness?.probes,
        },
        database: () => this.probeDatabase(),
      },
      this.now,
    );
    const sourceProvider: SolverSnapshotProvider =
      options.provider ??
      (options.spaceMode === "demo"
        ? new LocalDemoProvider(this.now)
        : new FixtureProvider());
    if (
      options.spaceMode !== undefined &&
      options.spaceMode !== "demo" &&
      !sourceProvider.getPositionSnapshot
    ) {
      throw new ServiceError(
        "SNAPSHOT_PROVIDER_REQUIRED",
        `${options.spaceMode === "testnet" ? "Testnet" : "Fork"}/RPC mode requires a usable real snapshot provider; FixtureProvider is not valid for configured RPC data`,
        503,
      );
    }
    this.localProvider =
      sourceProvider instanceof LocalDemoProvider ? sourceProvider : undefined;
    const validateSnapshot = (snapshot: SolverSnapshot): SolverSnapshot => {
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
    };
    const validateUpstreamPricing = (
      snapshot: SolverSnapshot,
      intent: AtomicSettlementIntent,
    ): void => {
      if (!snapshot.swapVMGuard) return;
      const expected = buildUpstreamSwapVMStrategy(
        snapshot,
        intent.traderInputToken,
        intent.traderOutputToken,
      ).strategyHash;
      if (expected.toLowerCase() !== snapshot.aquaStrategyHash.toLowerCase()) {
        throw new ServiceError(
          "PRICING_RENEWAL_REQUIRED",
          "Pricing needs renewal: this fixed-price Space no longer matches its shipped SwapVM strategy",
          409,
          {
            positionId: snapshot.positionId,
            state: "PRICING_NEEDS_RENEWAL",
            shippedStrategyHash: snapshot.aquaStrategyHash,
            currentStrategyHash: expected,
            executable: false,
            recovery:
              "Pause the old Space, dock its Aqua strategy, withdraw the exact vault balances, and create a new owner-controlled Space with a new identity.",
          },
        );
      }
    };
    this.provider = {
      ...(sourceProvider.getPositionSnapshot
        ? {
            getPositionSnapshot: async (positionId: string) =>
              validateSnapshot(
                await sourceProvider.getPositionSnapshot!(positionId),
              ),
          }
        : {}),
      ...(sourceProvider.prepareIntent
        ? {
            prepareIntent: async (input: PrepareIntentRequest) => {
              const intent = await sourceProvider.prepareIntent!(input);
              await this.provider.getSnapshot(intent);
              return intent;
            },
          }
        : {}),
      ...(sourceProvider.prepareTokenIntent
        ? {
            prepareTokenIntent: async (input: PrepareTokenIntentRequest) => {
              const intent = await sourceProvider.prepareTokenIntent!(input);
              await this.provider.getSnapshot(intent);
              return intent;
            },
          }
        : {}),
      getSnapshot: async (intent) => {
        // Check the authoritative current snapshot before asking a chain
        // adapter to validate the intent's old balance/price commitment. A
        // fixed-price SwapVM Space must report typed renewal before a generic
        // stale-snapshot error can hide the recovery instruction.
        if (sourceProvider.getPositionSnapshot) {
          const knownSpace = this.repository
            .listSpaces(1_000)
            .items.find(
              (space) =>
                hashBytes(space.identity.id).toLowerCase() ===
                intent.positionIdHash.toLowerCase(),
            );
          const current = await sourceProvider.getPositionSnapshot(
            knownSpace?.identity.id ?? intent.positionIdHash,
          );
          const validatedCurrent = validateSnapshot(current);
          this.assertTradingSnapshotFresh(validatedCurrent);
          validateUpstreamPricing(validatedCurrent, intent);
        }
        const snapshot = await sourceProvider.getSnapshot(intent);
        const space = this.repository.getSpace(snapshot.positionId);
        if (space?.identity.state === "PAUSED")
          throw new ServiceError(
            "SPACE_PAUSED",
            "Trading is paused for this Space",
            409,
          );
        const validated = validateSnapshot(snapshot);
        if (sourceProvider.getPositionSnapshot)
          this.assertTradingSnapshotFresh(validated);
        validateUpstreamPricing(validated, intent);
        return validated;
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
    if (options.seedFixture !== false) {
      const seeded = positionForFixture(
        this.localProvider ? this.now() : undefined,
      );
      this.repository.savePosition(seeded);
      this.repository.saveSpaceIdentity({
        id: seeded.id,
        name: seeded.name,
        ownerAddress: seeded.owner,
        controllerAddress: seeded.policy.governance,
        treasuryAddress: seeded.treasury,
        chainId: seeded.chainId,
        policyId: seeded.policy.id,
        strategyId: FIXTURE_AQUA_STRATEGY_HASH,
        policyRegistryAddress: seeded.policy.registry,
        mode: this.spaceMode,
        state: seeded.policy.paused ? "PAUSED" : "ACTIVE",
      });
    }
    this.hydrateLocalSpaces();
  }

  close(): void {
    this.database.close();
  }

  /** Rebuild demo provider bundles from durable Space records after a restart. */
  private hydrateLocalSpaces(): void {
    if (!this.localProvider) return;
    for (const record of this.repository.listSpaces(1_000).items) {
      const position = record.position;
      if (!position) continue;
      this.localProvider.registerSpace(
        createCanonicalFixture({
          nowSeconds: this.now(),
          positionId: position.id,
          policyId: position.policy.id,
          strategyHash: record.identity.strategyId,
          treasuryAddress: position.treasury,
          assetTokens: position.policy.assets.map((asset) => asset.token),
          assetBounds: position.policy.assets.map((asset) => ({
            token: asset.token,
            minimumWeightBps: asset.minimumWeightBps,
            maximumWeightBps: asset.maximumWeightBps,
          })),
          maximumTransactionValue: BigInt(
            position.policy.maximumTransactionValue,
          ),
          policyNonce: BigInt(position.policy.nonce),
        }),
      );
    }
  }

  configureReadiness(configuration: ReadinessConfiguration): void {
    this.readiness.configure(configuration);
  }

  getReadiness() {
    return this.readiness.snapshot();
  }

  private probeDatabase() {
    const started = performance.now();
    const result = this.database.sqlite.prepare("SELECT 1 AS ready").get() as
      { ready?: number } | undefined;
    if (result?.ready !== 1) throw new Error("database_probe_failed");
    return {
      state: "healthy" as const,
      observedAt: this.now(),
      reason: null,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }

  private async probeRpc(): Promise<RpcReadiness> {
    if (!this.rpcTransport)
      return {
        state: "disabled",
        observedAt: null,
        reason: "disabled",
        chainId: null,
        expectedChainId: this.runtime.chainId,
        latestBlock: null,
        canonicalBlock: null,
        canonicalBlockHash: null,
        finalizedBlock: null,
        finalizedBlockHash: null,
        finalizedAt: null,
      };
    const parseHex = (value: unknown, label: string): bigint => {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
        throw new Error(`Malformed ${label}`);
      return BigInt(value);
    };
    const chain = Number(
      parseHex(
        await this.rpcTransport.request({
          method: "eth_chainId",
          params: [],
        }),
        "chain ID",
      ),
    );
    if (!Number.isSafeInteger(chain) || chain !== this.runtime.chainId)
      throw new Error("rpc_chain_mismatch");
    const latestBlock = parseHex(
      await this.rpcTransport.request({
        method: "eth_blockNumber",
        params: [],
      }),
      "latest block",
    );
    const latest = await this.rpcTransport.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    const finalized = await this.rpcTransport.request({
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
    });
    if (!latest || typeof latest !== "object")
      throw new Error("latest_head_unavailable");
    if (!finalized || typeof finalized !== "object")
      throw new Error("finalized_head_unavailable");
    const latestValue = latest as {
      number?: unknown;
      hash?: unknown;
    };
    const finalizedValue = finalized as {
      number?: unknown;
      hash?: unknown;
      timestamp?: unknown;
    };
    const latestNumber = parseHex(latestValue.number, "latest block number");
    const finalizedNumber = parseHex(
      finalizedValue.number,
      "finalized block number",
    );
    const latestHash = latestValue.hash;
    const finalizedHash = finalizedValue.hash;
    const timestamp = parseHex(finalizedValue.timestamp, "finalized timestamp");
    if (
      typeof latestHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(latestHash) ||
      typeof finalizedHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(finalizedHash) ||
      finalizedNumber > latestNumber ||
      latestNumber !== latestBlock
    )
      throw new Error("invalid_canonical_head");
    if (timestamp > BigInt(this.now()))
      throw new Error("finalized_head_from_future");
    if (
      BigInt(this.now()) - timestamp >
      BigInt(this.runtime.rpcFinalityMaxAgeSeconds)
    )
      throw new Error("finalized_head_stale");
    return {
      state: "healthy",
      observedAt: this.now(),
      reason: null,
      chainId: chain,
      expectedChainId: this.runtime.chainId,
      latestBlock: latestBlock.toString(),
      canonicalBlock: latestNumber.toString(),
      canonicalBlockHash: latestHash,
      finalizedBlock: finalizedNumber.toString(),
      finalizedBlockHash: finalizedHash,
      finalizedAt: Number(timestamp),
    };
  }

  private async probeIndexer(): Promise<IndexerReadiness> {
    if (!this.rpcTransport || !this.runtime.settlementContract)
      return {
        state: "unknown",
        observedAt: null,
        reason: "indexer_not_configured",
        checkpointBlock: null,
        checkpointHash: null,
        latestBlock: null,
        lagBlocks: null,
      };
    const latestValue = await this.rpcTransport.request({
      method: "eth_blockNumber",
      params: [],
    });
    if (
      typeof latestValue !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(latestValue)
    )
      throw new Error("latest_block_unavailable");
    const latest = BigInt(latestValue);
    const checkpoint = this.repository.getCheckpoint(
      this.runtime.chainId,
      this.runtime.settlementContract,
    );
    if (!checkpoint)
      return {
        state: "unknown",
        observedAt: this.now(),
        reason: "indexer_checkpoint_unavailable",
        checkpointBlock: null,
        checkpointHash: null,
        latestBlock: latest.toString(),
        lagBlocks: null,
      };
    const checkpointBlock = BigInt(checkpoint.blockNumber);
    if (checkpointBlock > latest)
      return {
        state: "unhealthy",
        observedAt: this.now(),
        reason: "indexer_checkpoint_ahead",
        checkpointBlock: checkpoint.blockNumber,
        checkpointHash: checkpoint.blockHash,
        latestBlock: latest.toString(),
        lagBlocks: null,
      };
    const canonical = await this.rpcTransport.request({
      method: "eth_getBlockByNumber",
      params: [`0x${checkpointBlock.toString(16)}`, false],
    });
    const canonicalHash =
      canonical && typeof canonical === "object"
        ? (canonical as { hash?: unknown }).hash
        : undefined;
    if (
      typeof canonicalHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(canonicalHash) ||
      canonicalHash.toLowerCase() !== checkpoint.blockHash.toLowerCase()
    )
      return {
        state: "unhealthy",
        observedAt: this.now(),
        reason: "indexer_checkpoint_reorged",
        checkpointBlock: checkpoint.blockNumber,
        checkpointHash: checkpoint.blockHash,
        latestBlock: latest.toString(),
        lagBlocks: Number(latest - checkpointBlock),
      };
    const lag = latest - checkpointBlock;
    return {
      state:
        lag <= BigInt(this.runtime.maxIndexerLagBlocks)
          ? "healthy"
          : "unhealthy",
      observedAt: this.now(),
      reason:
        lag <= BigInt(this.runtime.maxIndexerLagBlocks)
          ? null
          : "indexer_lag_exceeded",
      checkpointBlock: checkpoint.blockNumber,
      checkpointHash: checkpoint.blockHash,
      latestBlock: latest.toString(),
      lagBlocks: Number(lag),
    };
  }

  listPositions(limit: number, cursor?: string): Page<Position> {
    return this.repository.listPositions(limit, cursor);
  }

  private async readAuthoritativePositionSnapshot(
    positionId: string,
  ): Promise<SolverSnapshot | undefined> {
    if (!this.provider.getPositionSnapshot) return undefined;
    try {
      const snapshot = await this.provider.getPositionSnapshot(positionId);
      if (snapshot.positionId !== positionId)
        throw new ServiceError(
          "INVALID_SNAPSHOT",
          "The snapshot provider returned data for a different Space",
          503,
        );
      return snapshot;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "SNAPSHOT_UNAVAILABLE",
        "The authoritative Space snapshot is unavailable; dependent trading is blocked",
        503,
        { positionId },
      );
    }
  }

  private assertTradingSnapshotFresh(snapshot: SolverSnapshot): void {
    const freshness = snapshotFreshness(
      snapshot.portfolioSnapshot.observedAt,
      snapshot.priceProtection.nowSeconds,
      snapshot.priceProtection.maximumPriceAgeSeconds,
    );
    if (freshness !== "fresh")
      throw new ServiceError(
        "SNAPSHOT_STALE",
        "Trading is unavailable because the authoritative Space snapshot is stale",
        409,
        { positionId: snapshot.positionId },
      );
  }

  private persistAuthoritativeSnapshot(
    position: Position,
    snapshot: SolverSnapshot,
  ): Position {
    const sourceAssets = new Map(
      snapshot.portfolioSnapshot.assets.map((asset) => [
        asset.token.toLowerCase(),
        asset,
      ]),
    );
    const existingAssets = new Map(
      position.policy.assets.map((asset) => [asset.token.toLowerCase(), asset]),
    );
    const next = positionSchema.parse({
      ...position,
      chainId: snapshot.chainId,
      policy: {
        ...position.policy,
        id: snapshot.policyId,
        chainId: snapshot.chainId,
        maximumTransactionValue:
          snapshot.policy.maximumTransactionValue.toString(),
        priceMaxAgeSeconds: snapshot.priceProtection.maximumPriceAgeSeconds,
        maximumPriceDeviationBps: Number(
          snapshot.priceProtection.maximumPriceDeviationBps,
        ),
        nonce: snapshot.policyNonce,
        paused: snapshot.paused ?? position.policy.paused,
        fee: {
          ...position.policy.fee,
          baseFeeBps: Number(snapshot.fee.baseFeeBps),
          slopeBps: Number(snapshot.fee.slopeBps),
          maximumFeeBps: Number(snapshot.fee.maximumFeeBps),
          treasuryBaseFeeBps: Number(snapshot.fee.treasuryBaseFeeBps),
          solverFeeBps: Number(snapshot.fee.solverFeeBps),
          protocolFeeBps: Number(snapshot.fee.protocolFeeBps),
          treasuryFeeRecipient: snapshot.feeAccounting.treasuryRecipient,
          protocolFeeRecipient: snapshot.feeAccounting.protocolRecipient,
        },
        assets: snapshot.policy.assets.map((asset) => {
          const sourceAsset = sourceAssets.get(asset.token.toLowerCase());
          const existingAsset = existingAssets.get(asset.token.toLowerCase());
          return {
            token: asset.token,
            symbol: sourceAsset?.symbol ?? existingAsset?.symbol ?? "ASSET",
            decimals: sourceAsset?.decimals ?? existingAsset?.decimals ?? 0,
            minimumWeightBps: Number(asset.minimumWeightBps),
            maximumWeightBps: Number(asset.maximumWeightBps),
          };
        }),
      },
      riskMode: snapshot.riskMode,
      currentPortfolio: snapshot.portfolioSnapshot,
      updatedAt: Math.max(
        position.updatedAt,
        this.now(),
        snapshot.portfolioSnapshot.observedAt,
      ),
    });
    this.repository.savePosition(next);
    return this.getPosition(position.id);
  }

  /** Read source evidence and publish the matching durable snapshot. */
  async refreshPosition(positionId: string): Promise<Position> {
    const inFlight = this.positionRefreshes.get(positionId);
    if (inFlight) return inFlight;

    const refresh = (async (): Promise<Position> => {
      const position = this.getPosition(positionId);
      const snapshot = await this.readAuthoritativePositionSnapshot(positionId);
      return snapshot
        ? this.persistAuthoritativeSnapshot(position, snapshot)
        : position;
    })();
    this.positionRefreshes.set(positionId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.positionRefreshes.get(positionId) === refresh)
        this.positionRefreshes.delete(positionId);
    }
  }

  async refreshSpace(spaceId: string): Promise<SpaceRecord> {
    const space = this.getSpace(spaceId);
    if (space.position) await this.refreshPosition(space.position.id);
    return this.getSpace(spaceId);
  }

  async refreshSpaces(ownerAddress?: string): Promise<void> {
    const spaces = this.repository.listSpaces(1_000, undefined, ownerAddress);
    for (const space of spaces.items)
      if (space.position) await this.refreshPosition(space.position.id);
  }

  async refreshPositions(): Promise<void> {
    const positions = this.repository.listPositions(1_000, undefined);
    for (const position of positions.items)
      await this.refreshPosition(position.id);
  }

  listSpaces(
    limit: number,
    cursor?: string,
    ownerAddress?: string,
  ): Page<SpaceRecord> {
    return this.repository.listSpaces(limit, cursor, ownerAddress);
  }

  getSpace(spaceId: string): SpaceRecord {
    const value = this.repository.getSpace(spaceId);
    if (!value)
      throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
    return value;
  }

  listSpaceChanges(spaceId: string): SpaceChange[] {
    this.getSpace(spaceId);
    return this.repository.listSpaceChanges(spaceId);
  }

  prepareSpaceMutation(input: SpaceMutationPrepareRequest): {
    readonly authorization: Omit<SpaceMutationAuthorization, "signature">;
    readonly typedData: SpaceMutationTypedData;
  } {
    const value = spaceMutationPrepareRequestSchema.parse(input);
    const existing = this.repository.getSpace(value.spaceId);
    if (value.operation === "CREATE") {
      if (existing)
        throw new ServiceError(
          "SPACE_ALREADY_EXISTS",
          "A Space with this identity already exists",
          409,
        );
    } else {
      if (!existing)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      this.assertSpaceOwner(existing, value.ownerAddress);
    }
    this.assertSpaceMutationSupported(value.operation, existing);
    if (value.draft) this.validateSpaceDraft(value.draft, value.ownerAddress);
    const chainId =
      value.draft?.chainId ??
      existing?.identity.chainId ??
      this.runtime.chainId;
    if (chainId !== this.runtime.chainId)
      throw new ServiceError(
        "CHAIN_MISMATCH",
        "Space chain does not match the configured settlement chain",
        409,
      );
    const nonce = existing
      ? this.repository.getSpaceAuthNonce(value.spaceId)
      : "0";
    const payloadHash = hashCanonical(this.spaceMutationPayload(value));
    const deadline = this.now() + 300;
    const authorization = {
      operation: value.operation,
      spaceId: value.spaceId,
      ownerAddress: value.ownerAddress,
      payloadHash,
      nonce,
      deadline,
    } satisfies Omit<SpaceMutationAuthorization, "signature">;
    const typedData = spaceMutationTypedDataSchema.parse({
      domain: {
        name: "AURKA Space Management",
        version: "1",
        chainId,
        verifyingContract: SPACE_MANAGEMENT_AUTHORITY,
      },
      primaryType: "SpaceMutation",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SpaceMutation: SPACE_MUTATION_TYPES.map(({ name, type }) => ({
          name,
          type,
        })),
      },
      message: {
        operation: value.operation,
        spaceId: value.spaceId,
        owner: value.ownerAddress,
        payloadHash,
        nonce,
        deadline,
      },
    });
    return { authorization, typedData };
  }

  async confirmSpaceMutation(
    input: SpaceMutationConfirmRequest,
  ): Promise<{ readonly space: SpaceRecord; readonly change: SpaceChange }> {
    const value = spaceMutationConfirmRequestSchema.parse(input);
    const authorization = spaceMutationAuthorizationSchema.parse(
      value.authorization,
    );
    const existing = this.repository.getSpace(value.spaceId);
    if (value.operation === "CREATE") {
      if (existing)
        throw new ServiceError(
          "SPACE_ALREADY_EXISTS",
          "A Space with this identity already exists",
          409,
        );
    } else {
      if (!existing)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      this.assertSpaceOwner(existing, value.ownerAddress);
    }
    this.assertSpaceMutationSupported(value.operation, existing);
    if (value.receiptHash)
      throw new ServiceError(
        "UNVERIFIED_SPACE_RECEIPT",
        "Client-supplied Space receipt hashes are not accepted until the service can verify the receipt, intended operation, caller, contract, and resulting chain state",
        501,
        { operation: value.operation, spaceId: value.spaceId },
      );
    if (value.draft) this.validateSpaceDraft(value.draft, value.ownerAddress);
    const chainId =
      value.draft?.chainId ??
      existing?.identity.chainId ??
      this.runtime.chainId;
    if (chainId !== this.runtime.chainId)
      throw new ServiceError(
        "CHAIN_MISMATCH",
        "Space chain does not match the configured settlement chain",
        409,
      );
    const nonce = existing
      ? this.repository.getSpaceAuthNonce(value.spaceId)
      : "0";
    const payloadHash = hashCanonical(this.spaceMutationPayload(value));
    if (
      authorization.operation !== value.operation ||
      authorization.spaceId !== value.spaceId ||
      authorization.ownerAddress.toLowerCase() !==
        value.ownerAddress.toLowerCase() ||
      authorization.payloadHash.toLowerCase() !== payloadHash.toLowerCase() ||
      authorization.nonce !== nonce
    )
      throw new ServiceError(
        "AUTHORIZATION_MISMATCH",
        "Authorization is stale or does not match the reviewed Space change",
        409,
      );
    if (authorization.deadline <= this.now())
      throw new ServiceError(
        "AUTHORIZATION_EXPIRED",
        "Space authorization has expired",
        409,
      );
    const digest = hashTypedData({
      domain: {
        name: "AURKA Space Management",
        version: "1",
        chainId,
        verifyingContract: SPACE_MANAGEMENT_AUTHORITY,
      },
      types: {
        SpaceMutation: SPACE_MUTATION_TYPES.map(({ name, type }) => ({
          name,
          type,
        })),
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
      primaryType: "SpaceMutation",
      message: {
        operation: value.operation,
        spaceId: value.spaceId,
        owner: value.ownerAddress,
        payloadHash,
        nonce: BigInt(nonce),
        deadline: BigInt(authorization.deadline),
      },
    } as never);
    if (!verifySignature(value.ownerAddress, digest, authorization.signature))
      throw new ServiceError(
        "INVALID_AUTHORIZATION",
        "Space change signature is not from the connected owner",
        403,
      );

    if (
      existing &&
      !this.repository.consumeSpaceAuthNonce(value.spaceId, authorization.nonce)
    )
      throw new ServiceError(
        "AUTHORIZATION_REPLAYED",
        "Space authorization has already been used",
        409,
      );
    const result = this.applySpaceMutation(value, existing);
    if (
      !existing &&
      !this.repository.consumeSpaceAuthNonce(value.spaceId, authorization.nonce)
    )
      throw new ServiceError(
        "AUTHORIZATION_REPLAYED",
        "Space authorization has already been used",
        409,
      );
    return result;
  }

  private spaceMutationPayload(
    input:
      | Pick<SpaceMutationConfirmRequest, "operation" | "draft">
      | Pick<SpaceMutationPrepareRequest, "operation" | "draft">,
  ): Record<string, unknown> {
    return {
      operation: input.operation,
      ...(input.draft ? { draft: input.draft } : {}),
    };
  }

  /**
   * The generic Space API can persist authenticated testnet drafts, but it
   * does not yet prepare or verify the policy/strategy transactions required
   * to make those drafts active. An owner signature authorizes an intent; it
   * is never evidence that the corresponding chain operation succeeded.
   */
  private assertSpaceMutationSupported(
    operation: SpaceMutationPrepareRequest["operation"],
    existing: SpaceRecord | undefined,
  ): void {
    if (this.spaceMode === "demo" || operation === "CREATE") return;
    if (
      operation === "UPDATE" &&
      existing?.identity.state !== "PENDING" &&
      existing?.identity.state !== "FAILED"
    )
      return;
    const legacyFork = this.spaceMode === "fork";
    throw new ServiceError(
      legacyFork
        ? "FORK_SPACE_CHAIN_OPERATION_UNSUPPORTED"
        : "TESTNET_SPACE_CHAIN_OPERATION_UNSUPPORTED",
      `${legacyFork ? "Fork" : "Testnet"} Space ${operation.toLowerCase()} requires a receipt-verified owner-wallet chain transaction; this API currently supports authenticated draft persistence only`,
      501,
      { operation, spaceId: existing?.identity.id ?? null },
    );
  }

  private assertSpaceOwner(space: SpaceRecord, ownerAddress: string): void {
    if (
      space.identity.ownerAddress.toLowerCase() !==
        ownerAddress.toLowerCase() ||
      space.identity.controllerAddress.toLowerCase() !==
        ownerAddress.toLowerCase()
    )
      throw new ServiceError(
        "SPACE_OWNER_REQUIRED",
        "Only the recorded Space owner can authorize this change",
        403,
      );
  }

  private validateSpaceDraft(draft: SpaceDraft, ownerAddress: string): void {
    if (draft.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase())
      throw new ServiceError(
        "SPACE_OWNER_MISMATCH",
        "Draft owner does not match the signing wallet",
        403,
      );
    if (draft.chainId !== this.runtime.chainId)
      throw new ServiceError(
        "CHAIN_MISMATCH",
        "This Space must use the configured settlement chain",
        409,
      );
    const [usdc, weth] = this.spaceAssets;
    if (!usdc || !weth)
      throw new ServiceError(
        "FUNDING_CONFIGURATION_UNAVAILABLE",
        "The environment has no two-asset funding configuration",
        503,
      );
    for (const [symbol, amount, decimals] of [
      ["USDC", draft.funding.usdc, usdc.decimals],
      ["WETH", draft.funding.weth, weth.decimals],
    ] as const) {
      let raw: bigint;
      try {
        raw = parseTokenAmount(amount, decimals);
      } catch (error) {
        throw new ServiceError(
          "INVALID_FUNDING_AMOUNT",
          `${symbol} funding is invalid: ${error instanceof Error ? error.message : String(error)}`,
          400,
        );
      }
      if (raw === 0n)
        throw new ServiceError(
          "INVALID_FUNDING_AMOUNT",
          `${symbol} funding must be greater than zero; both USDC and WETH are required for this MVP`,
          400,
        );
    }
    const maximum = BigInt(draft.maximumTransactionValue);
    const minimum = this.spaceMode !== "demo" ? 1n : 1_000n;
    if (maximum < minimum || maximum > 1_000_000_000n)
      throw new ServiceError(
        "INVALID_TRANSACTION_LIMIT",
        `Transaction limit must be between ${minimum} and 1000000000 value units`,
      );
    const tokens = draft.assets.map((asset) => asset.token.toLowerCase());
    if (new Set(tokens).size !== tokens.length)
      throw new ServiceError(
        "DUPLICATE_ASSET",
        "A Space cannot manage the same asset twice",
      );
    const minimumTotal = draft.assets.reduce(
      (total, asset) => total + asset.minimumWeightBps,
      0,
    );
    const maximumTotal = draft.assets.reduce(
      (total, asset) => total + asset.maximumWeightBps,
      0,
    );
    if (minimumTotal > 10_000 || maximumTotal < 10_000)
      throw new ServiceError(
        "INFEASIBLE_BOUNDS",
        "Allocation ranges must permit a complete portfolio",
      );
    const supportedDecimals = new Map(
      this.spaceAssets.map((asset) => [
        asset.token.toLowerCase(),
        asset.decimals,
      ]),
    );
    for (const asset of draft.assets) {
      const expectedDecimals = supportedDecimals.get(asset.token.toLowerCase());
      if (expectedDecimals === undefined)
        throw new ServiceError(
          "UNSUPPORTED_ASSET",
          "This environment only supports its configured assets",
        );
      if (asset.decimals !== expectedDecimals)
        throw new ServiceError(
          "ASSET_DECIMALS_MISMATCH",
          `${asset.symbol} must use ${expectedDecimals} decimal places in this environment`,
        );
    }
    if (!tokens.includes(this.spaceAssets[0]!.token.toLowerCase()))
      throw new ServiceError(
        "UNSUPPORTED_ASSET_SET",
        "A Space must include the configured USDC fee asset",
      );
    if (!tokens.includes(this.spaceAssets[1]!.token.toLowerCase()))
      throw new ServiceError(
        "UNSUPPORTED_ASSET_SET",
        "A Space must include WETH for the supported local trading pair",
      );
  }

  private positionForSpaceDraft(
    draft: SpaceDraft,
    policyNonce = "1",
  ): {
    readonly position: Position;
    readonly strategyId: string;
    readonly bundle: ReturnType<typeof createCanonicalFixture>;
  } {
    const policyId = hashBytes(`policy:${draft.id}`);
    const strategyId = hashBytes(`strategy:${draft.id}`);
    const bundle = createCanonicalFixture({
      nowSeconds: this.now(),
      positionId: draft.id,
      policyId,
      strategyHash: strategyId,
      treasuryAddress: draft.ownerAddress,
      assetTokens: draft.assets.map((asset) => asset.token),
      assetBounds: draft.assets.map((asset) => ({
        token: asset.token,
        minimumWeightBps: asset.minimumWeightBps,
        maximumWeightBps: asset.maximumWeightBps,
      })),
      maximumTransactionValue: BigInt(draft.maximumTransactionValue),
      policyNonce: BigInt(policyNonce),
      protocolAddress: FIXTURE_ADDRESSES.protocol,
    });
    const base = positionForFixture(this.now());
    const position = positionSchema.parse({
      ...base,
      id: draft.id,
      name: draft.name,
      owner: draft.ownerAddress,
      treasury: draft.ownerAddress,
      chainId: draft.chainId,
      policy: {
        ...base.policy,
        id: policyId,
        chainId: draft.chainId,
        treasury: draft.ownerAddress,
        governance: draft.ownerAddress,
        assets: draft.assets,
        maximumTransactionValue: draft.maximumTransactionValue,
        nonce: policyNonce,
        paused: false,
        fee: {
          ...base.policy.fee,
          treasuryFeeRecipient: draft.ownerAddress,
        },
      },
      riskMode: "NORMAL",
      currentPortfolio: bundle.snapshot.portfolioSnapshot,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    return { position, strategyId, bundle };
  }

  private applySpaceMutation(
    input: SpaceMutationConfirmRequest,
    existing: SpaceRecord | undefined,
  ): { readonly space: SpaceRecord; readonly change: SpaceChange } {
    const timestamp = this.now();
    let identity: SpaceRecord["identity"];
    let draft = input.draft;
    let position: Position | undefined;
    if (input.operation === "CREATE") {
      if (existing || !draft)
        throw new ServiceError(
          "SPACE_ALREADY_EXISTS",
          "Space already exists",
          409,
        );
      const generated =
        this.spaceMode === "demo"
          ? this.positionForSpaceDraft(draft)
          : undefined;
      identity = {
        id: draft.id,
        name: draft.name,
        ownerAddress: draft.ownerAddress,
        controllerAddress: draft.ownerAddress,
        treasuryAddress: draft.ownerAddress,
        chainId: draft.chainId,
        policyId:
          generated?.position.policy.id ?? hashBytes(`policy:${draft.id}`),
        strategyId: generated?.strategyId ?? hashBytes(`strategy:${draft.id}`),
        policyRegistryAddress:
          generated?.position.policy.registry ?? SPACE_MANAGEMENT_AUTHORITY,
        mode: this.spaceMode,
        state: "DRAFT",
      };
    } else {
      if (!existing)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      identity = existing.identity;
      draft = input.draft ?? existing.draft;
      if (this.spaceMode !== "demo" && input.operation === "UPDATE") {
        identity = { ...identity, name: draft!.name };
        if (existing.position)
          position = { ...existing.position, name: draft!.name };
      } else if (
        input.operation === "UPDATE" ||
        input.operation === "ACTIVATE"
      ) {
        if (!draft)
          throw new ServiceError(
            "DRAFT_REQUIRED",
            "A policy draft is required",
          );
        const nextPolicyNonce =
          existing.identity.state === "DRAFT" || !existing.position
            ? "1"
            : (BigInt(existing.position.policy.nonce) + 1n).toString();
        const generated = this.positionForSpaceDraft(draft, nextPolicyNonce);
        position =
          existing.identity.state === "PAUSED"
            ? positionSchema.parse({
                ...generated.position,
                policy: {
                  ...generated.position.policy,
                  paused: true,
                  nonce: (
                    BigInt(existing.position?.policy.nonce ?? "1") + 1n
                  ).toString(),
                },
              })
            : generated.position;
        identity = {
          ...identity,
          name: draft.name,
          chainId: draft.chainId,
          policyId: generated.position.policy.id,
          strategyId: generated.strategyId,
          treasuryAddress: generated.position.treasury,
          state: input.operation === "ACTIVATE" ? "ACTIVE" : identity.state,
        };
        if (input.operation === "UPDATE" && identity.state === "DRAFT")
          position = undefined;
      } else {
        if (!existing.position)
          throw new ServiceError(
            "SPACE_NOT_ACTIVE",
            "Only an active Space can change pause state",
            409,
          );
        const paused = input.operation === "PAUSE";
        position = positionSchema.parse({
          ...existing.position,
          policy: {
            ...existing.position.policy,
            paused,
            nonce: (BigInt(existing.position.policy.nonce) + 1n).toString(),
          },
          updatedAt: timestamp,
        });
        identity = { ...identity, state: paused ? "PAUSED" : "ACTIVE" };
      }
    }
    if (position) {
      this.repository.savePosition(position);
      if (this.localProvider) {
        const generated = this.positionForSpaceDraft(
          draft ?? {
            id: position.id,
            name: position.name,
            ownerAddress: position.owner,
            chainId: position.chainId,
            assets: position.policy.assets,
            maximumTransactionValue: position.policy.maximumTransactionValue,
            draftVersion: 2,
            funding: { usdc: "1", weth: "1" },
          },
          position.policy.nonce,
        );
        this.localProvider.registerSpace(generated.bundle);
      }
    }
    const savedIdentity = this.repository.saveSpaceIdentity(identity, draft);
    const eventType =
      input.operation === "CREATE"
        ? "SPACE_CREATED"
        : input.operation === "ACTIVATE"
          ? "SPACE_ACTIVATED"
          : input.operation === "PAUSE"
            ? "SPACE_PAUSED"
            : input.operation === "RESUME"
              ? "SPACE_RESUMED"
              : "SPACE_UPDATED";
    const change = this.repository.saveSpaceChange({
      id: hashBytes(
        `space-change:${input.spaceId}:${input.operation}:${input.authorization.nonce}`,
      ).slice(0, 128),
      spaceId: input.spaceId,
      eventType,
      actor: input.ownerAddress,
      status: "CONFIRMED",
      ...(input.receiptHash ? { receiptHash: input.receiptHash } : {}),
      payload: {
        operation: input.operation,
        authority: this.spaceMode !== "demo" ? "signed-metadata-only" : "demo",
        state: savedIdentity.state,
        ...(draft ? { draft } : {}),
      },
      createdAt: timestamp,
    });
    const space = this.getSpace(input.spaceId);
    return { space, change };
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
    await this.refreshPosition(positionId);
    const fixture = createCanonicalFixture({ positionId });
    const snapshot = this.provider.getPositionSnapshot
      ? (await this.readAuthoritativePositionSnapshot(positionId))!
      : await this.provider.getSnapshot(fixture.intent);
    if (this.provider.getPositionSnapshot)
      this.assertTradingSnapshotFresh(snapshot);
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

  async prepareTokenIntent(
    input: PrepareTokenIntentRequest,
  ): Promise<AtomicSettlementIntent> {
    this.getPosition(input.positionId);
    if (!this.provider.prepareTokenIntent)
      throw new ServiceError(
        "PREPARATION_UNAVAILABLE",
        "The configured provider does not support token-amount preparation",
        503,
      );
    return this.provider.prepareTokenIntent(input);
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

  listActivity(query: ActivityQuery): Page<ActivityItem> {
    return this.repository.listActivity(query);
  }

  getFeeSummary(
    positionId: string,
    query: Omit<FeeSummaryQuery, "chainId"> = {},
  ): FeeSummary {
    const position = this.getPosition(positionId);
    return this.repository.getFeeSummary(position.id, {
      chainId: position.chainId,
      ...query,
    });
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
      submissionState: "PREPARED",
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
