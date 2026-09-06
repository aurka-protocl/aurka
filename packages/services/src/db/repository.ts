import { and, asc, desc, eq, gt, lte, or, sql } from "drizzle-orm";

import {
  atomicSettlementIntentSchema,
  atomicSettlementProposalSchema,
  executionSchema,
  parseProtocolEventPayload,
  positionSchema,
  protocolEventSchema,
  quoteSchema,
  type AtomicSettlementIntent,
  type AtomicSettlementProposal,
  type Execution,
  type Position,
  type ProtocolEvent,
  type Quote,
  type SimulationStatus,
} from "@aurka/shared";

import {
  capacityEpochs,
  chainEvents,
  executions,
  agentIdentities,
  idempotencyKeys,
  indexingCheckpoints,
  indexingHeaders,
  intents,
  managedAssets,
  policies,
  positions,
  proposals,
  quotes,
  riskCertificates,
  riskObservations,
  riskEvaluations,
  riskJobs,
  riskAuditEvents,
  walletPolicies,
} from "./schema.js";
import type { ServiceDrizzleDatabase } from "./database.js";
import { hashBytes } from "../solver/hash.js";

const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const now = (): number => Math.floor(Date.now() / 1000);

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface EventPage {
  readonly items: readonly ProtocolEvent[];
  readonly nextCursor: string | null;
}

export interface IndexedBlockHeader {
  readonly blockNumber: string;
  readonly blockHash: string;
}

export interface StoredIdempotencyResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

type ProposalStatus = "EXECUTABLE" | "AUTHORIZATION_PENDING" | "REJECTED";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class ServiceRepository {
  constructor(private readonly db: ServiceDrizzleDatabase) {}

  savePosition(position: Position): Position {
    const value = positionSchema.parse(position);
    this.db
      .insert(policies)
      .values({
        id: value.policy.id,
        chainId: value.policy.chainId,
        registry: value.policy.registry,
        treasury: value.policy.treasury,
        governance: value.policy.governance,
        maximumTransactionValue: value.policy.maximumTransactionValue,
        quoteTtlSeconds: value.policy.quoteTtlSeconds,
        priceMaxAgeSeconds: value.policy.priceMaxAgeSeconds,
        maximumPriceDeviationBps: value.policy.maximumPriceDeviationBps,
        feeJson: json(value.policy.fee),
        paused: value.policy.paused,
        nonce: value.policy.nonce,
        policyJson: json(value.policy),
        updatedAt: value.updatedAt,
      })
      .onConflictDoUpdate({
        target: policies.id,
        set: {
          policyJson: json(value.policy),
          nonce: value.policy.nonce,
          paused: value.policy.paused,
          updatedAt: value.updatedAt,
        },
      })
      .run();
    this.db
      .insert(managedAssets)
      .values(
        value.policy.assets.map((asset) => ({
          policyId: value.policy.id,
          token: asset.token.toLowerCase(),
          symbol: asset.symbol,
          decimals: asset.decimals,
          minimumWeightBps: asset.minimumWeightBps,
          maximumWeightBps: asset.maximumWeightBps,
        })),
      )
      .onConflictDoUpdate({
        target: [managedAssets.policyId, managedAssets.token],
        set: {
          symbol: sql.raw("excluded.symbol"),
          decimals: sql.raw("excluded.decimals"),
          minimumWeightBps: sql.raw("excluded.minimum_weight_bps"),
          maximumWeightBps: sql.raw("excluded.maximum_weight_bps"),
        },
      })
      .run();
    this.db
      .insert(positions)
      .values({
        id: value.id,
        name: value.name,
        chainId: value.chainId,
        owner: value.owner,
        treasury: value.treasury,
        policyId: value.policy.id,
        riskMode: value.riskMode,
        portfolioJson: json(value.currentPortfolio ?? null),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      })
      .onConflictDoUpdate({
        target: positions.id,
        set: {
          name: value.name,
          owner: value.owner,
          treasury: value.treasury,
          policyId: value.policy.id,
          riskMode: value.riskMode,
          portfolioJson: json(value.currentPortfolio ?? null),
          updatedAt: value.updatedAt,
        },
      })
      .run();
    return value;
  }

  getPosition(id: string): Position | undefined {
    const row = this.db
      .select()
      .from(positions)
      .where(eq(positions.id, id))
      .get();
    if (!row) return undefined;
    const policyRow = this.db
      .select()
      .from(policies)
      .where(eq(policies.id, row.policyId))
      .get();
    if (!policyRow) return undefined;
    return positionSchema.parse({
      id: row.id,
      name: row.name,
      chainId: row.chainId,
      owner: row.owner,
      treasury: row.treasury,
      policy: parse(policyRow.policyJson),
      riskMode: row.riskMode,
      ...(parse<unknown>(row.portfolioJson) === null
        ? {}
        : { currentPortfolio: parse(row.portfolioJson) }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  listPositions(limit: number, cursor: string | undefined): Page<Position> {
    const rows = this.db
      .select({ id: positions.id })
      .from(positions)
      .where(cursor ? gt(positions.id, cursor) : undefined)
      .orderBy(asc(positions.id))
      .limit(limit + 1)
      .all();
    const items = rows.slice(0, limit).flatMap((row) => {
      const position = this.getPosition(row.id);
      return position ? [position] : [];
    });
    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  saveRiskCertificate(
    hash: string,
    certificate: Record<string, unknown>,
    active: boolean,
  ): void {
    const policyId = String(certificate.policyId);
    this.db
      .insert(riskCertificates)
      .values({
        hash,
        policyId,
        chainId: Number(certificate.chainId),
        verifyingContract: String(certificate.verifyingContract),
        nonce: String(certificate.nonce),
        riskMode: String(certificate.riskMode),
        expiresAt: Number(certificate.expiresAt),
        certificateJson: json(certificate),
        active,
        status: String(certificate.status ?? (active ? "ACTIVE" : "EXPIRED")),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: riskCertificates.hash,
        set: {
          certificateJson: json(certificate),
          active,
          status: String(certificate.status ?? (active ? "ACTIVE" : "EXPIRED")),
          updatedAt: now(),
        },
      })
      .run();
  }

  saveRiskObservation(observation: Record<string, unknown>): void {
    this.db
      .insert(riskObservations)
      .values({
        id: String(observation.id),
        sourceId: String(observation.sourceId),
        chainId: Number(observation.chainId),
        deploymentId: String(observation.deploymentId),
        indexedBlock: String(observation.indexedBlock),
        indexedBlockHash: String(observation.indexedBlockHash),
        finality: String(observation.finality),
        payloadHash: String(observation.payloadHash),
        observationJson: json(observation),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: riskObservations.id,
        set: {
          sourceId: String(observation.sourceId),
          indexedBlock: String(observation.indexedBlock),
          indexedBlockHash: String(observation.indexedBlockHash),
          finality: String(observation.finality),
          payloadHash: String(observation.payloadHash),
          observationJson: json(observation),
          updatedAt: now(),
        },
      })
      .run();
  }

  saveRiskEvaluation(
    hash: string,
    positionId: string,
    evaluation: Record<string, unknown>,
    configuration: Record<string, unknown>,
    configurationHash: string,
  ): void {
    this.db
      .insert(riskEvaluations)
      .values({
        evaluationHash: hash,
        positionId,
        configurationVersion: String(evaluation.version),
        configurationHash,
        configurationJson: json(configuration),
        sourceDigest: String(evaluation.sourceDigest),
        mode: String(evaluation.mode),
        activeBoundsHash: String(evaluation.activeBoundsHash),
        evaluatedAt: Number(evaluation.evaluatedAt),
        evaluationJson: json(evaluation),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: riskEvaluations.evaluationHash,
        set: {
          evaluationJson: json(evaluation),
          configurationHash,
          configurationJson: json(configuration),
          mode: String(evaluation.mode),
          updatedAt: now(),
        },
      })
      .run();
  }

  getLatestRiskEvaluation(
    positionId: string,
  ): Record<string, unknown> | undefined {
    const row = this.db
      .select()
      .from(riskEvaluations)
      .where(eq(riskEvaluations.positionId, positionId))
      .orderBy(
        desc(riskEvaluations.evaluatedAt),
        asc(riskEvaluations.evaluationHash),
      )
      .limit(1)
      .get();
    return row ? parse<Record<string, unknown>>(row.evaluationJson) : undefined;
  }

  saveRiskJob(input: {
    readonly id: string;
    readonly positionId: string;
    readonly kind: string;
    readonly status: string;
    readonly attempt: number;
    readonly lastError?: string;
    readonly nextRunAt: number;
  }): void {
    this.db
      .insert(riskJobs)
      .values({ ...input, updatedAt: now() })
      .onConflictDoUpdate({
        target: riskJobs.id,
        set: { ...input, updatedAt: now() },
      })
      .run();
  }

  /** Claim one due job transactionally; repeated workers cannot double-run it. */
  claimRiskJob(
    id: string,
    nowSeconds = now(),
  ):
    | {
        readonly id: string;
        readonly positionId: string;
        readonly kind: string;
        readonly attempt: number;
      }
    | undefined {
    return this.db.transaction((transaction) => {
      const row = transaction
        .select()
        .from(riskJobs)
        .where(
          and(
            eq(riskJobs.id, id),
            eq(riskJobs.status, "QUEUED"),
            lte(riskJobs.nextRunAt, nowSeconds),
          ),
        )
        .get();
      if (!row) return undefined;
      transaction
        .update(riskJobs)
        .set({ status: "RUNNING", attempt: row.attempt + 1, updatedAt: now() })
        .where(and(eq(riskJobs.id, id), eq(riskJobs.status, "QUEUED")))
        .run();
      return {
        id: row.id,
        positionId: row.positionId,
        kind: row.kind,
        attempt: row.attempt + 1,
      };
    });
  }

  completeRiskJob(id: string, nextRunAt = now()): void {
    this.db
      .update(riskJobs)
      .set({
        status: "COMPLETED",
        lastError: null,
        nextRunAt,
        updatedAt: now(),
      })
      .where(eq(riskJobs.id, id))
      .run();
  }

  failRiskJob(id: string, error: string, nextRunAt: number): void {
    this.db
      .update(riskJobs)
      .set({
        status: "QUEUED",
        lastError: error.slice(0, 500),
        nextRunAt,
        updatedAt: now(),
      })
      .where(eq(riskJobs.id, id))
      .run();
  }

  saveRiskAuditEvent(input: {
    readonly id: string;
    readonly positionId: string;
    readonly eventType: string;
    readonly actor: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt?: number;
  }): void {
    this.db
      .insert(riskAuditEvents)
      .values({
        id: input.id,
        positionId: input.positionId,
        eventType: input.eventType,
        actor: input.actor,
        payloadJson: json(input.payload),
        createdAt: input.createdAt ?? now(),
      })
      .onConflictDoNothing()
      .run();
  }

  saveWalletPolicy(policy: {
    readonly fingerprint: string;
    readonly walletId: string;
    readonly role: string;
    readonly signerAddress: string;
    readonly expiresAt: number;
    readonly revoked: boolean;
    readonly policy: Record<string, unknown>;
  }): void {
    this.db
      .insert(walletPolicies)
      .values({
        fingerprint: policy.fingerprint,
        walletId: policy.walletId,
        role: policy.role,
        signerAddress: policy.signerAddress,
        expiresAt: policy.expiresAt,
        revoked: policy.revoked,
        policyJson: json(policy.policy),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: walletPolicies.fingerprint,
        set: {
          revoked: policy.revoked,
          expiresAt: policy.expiresAt,
          policyJson: json(policy.policy),
          updatedAt: now(),
        },
      })
      .run();
  }

  getRiskPosition(positionId: string): {
    readonly evaluation: Record<string, unknown> | undefined;
    readonly certificate: Record<string, unknown> | undefined;
    readonly certificateStatus: string | undefined;
  } {
    const position = this.db
      .select()
      .from(positions)
      .where(eq(positions.id, positionId))
      .get();
    const evaluation = this.getLatestRiskEvaluation(positionId);
    const certificateRow = position
      ? this.db
          .select()
          .from(riskCertificates)
          .where(eq(riskCertificates.policyId, position.policyId))
          .orderBy(desc(riskCertificates.updatedAt))
          .limit(1)
          .get()
      : undefined;
    return {
      evaluation,
      certificate: certificateRow
        ? parse<Record<string, unknown>>(certificateRow.certificateJson)
        : undefined,
      certificateStatus: certificateRow?.status,
    };
  }

  saveAgentIdentity(input: {
    readonly id: string;
    readonly address: string;
    readonly role: string;
    readonly enabled: boolean;
    readonly metadata?: Record<string, unknown>;
  }): void {
    this.db
      .insert(agentIdentities)
      .values({
        id: input.id,
        address: input.address,
        role: input.role,
        enabled: input.enabled,
        metadataJson: json(input.metadata ?? {}),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: agentIdentities.id,
        set: {
          address: input.address,
          role: input.role,
          enabled: input.enabled,
          metadataJson: json(input.metadata ?? {}),
          updatedAt: now(),
        },
      })
      .run();
  }

  listAgentIdentities() {
    return this.db
      .select()
      .from(agentIdentities)
      .orderBy(asc(agentIdentities.id))
      .all()
      .map((row) => ({
        id: row.id,
        address: row.address,
        role: row.role,
        enabled: row.enabled,
        metadata: parse<Record<string, unknown>>(row.metadataJson),
        updatedAt: row.updatedAt,
      }));
  }

  saveIntent(
    intent: AtomicSettlementIntent,
    intentHash: string,
  ): AtomicSettlementIntent {
    const value = atomicSettlementIntentSchema.parse(intent);
    const timestamp = now();
    this.db
      .insert(intents)
      .values({
        id: value.intentId,
        intentHash,
        trader: value.trader,
        policyId: value.policyId,
        status: "OPEN",
        intentJson: json(value),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();
    return value;
  }

  getIntent(idOrHash: string): AtomicSettlementIntent | undefined {
    const row = this.db
      .select()
      .from(intents)
      .where(or(eq(intents.id, idOrHash), eq(intents.intentHash, idOrHash)))
      .get();
    return row
      ? atomicSettlementIntentSchema.parse(parse(row.intentJson))
      : undefined;
  }

  saveProposal(
    proposal: AtomicSettlementProposal,
    proposalHash: string,
    simulationStatus: SimulationStatus,
  ): void {
    const value = atomicSettlementProposalSchema.parse(proposal);
    const status: ProposalStatus =
      simulationStatus === "SUCCEEDED"
        ? "EXECUTABLE"
        : simulationStatus === "AUTHORIZATION_PENDING"
          ? "AUTHORIZATION_PENDING"
          : "REJECTED";
    const timestamp = now();
    this.db
      .insert(proposals)
      .values({
        proposalHash,
        intentHash: value.intentHash,
        solver: value.solver,
        status,
        simulationStatus,
        proposalJson: json(value),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: proposals.proposalHash,
        set: {
          status,
          simulationStatus,
          proposalJson: json(value),
          updatedAt: timestamp,
        },
      })
      .run();
  }

  listProposals(intentHash: string, limit: number): AtomicSettlementProposal[] {
    return this.db
      .select()
      .from(proposals)
      .where(eq(proposals.intentHash, intentHash))
      .orderBy(desc(proposals.simulationStatus), asc(proposals.proposalHash))
      .limit(limit)
      .all()
      .flatMap((row) =>
        row.simulationStatus === "SUCCEEDED" ||
        row.simulationStatus === "AUTHORIZATION_PENDING"
          ? [atomicSettlementProposalSchema.parse(parse(row.proposalJson))]
          : [],
      );
  }

  getProposal(proposalHash: string): AtomicSettlementProposal | undefined {
    const row = this.db
      .select()
      .from(proposals)
      .where(eq(proposals.proposalHash, proposalHash))
      .get();
    return row
      ? atomicSettlementProposalSchema.parse(parse(row.proposalJson))
      : undefined;
  }

  saveQuote(quote: Quote): void {
    const value = quoteSchema.parse(quote);
    this.db
      .insert(quotes)
      .values({
        id: value.id,
        intentHash: value.intentHash,
        quoteJson: json(value),
        expiresAt: value.expiresAt,
        simulationStatus: value.simulationStatus,
        createdAt: now(),
      })
      .onConflictDoUpdate({
        target: quotes.id,
        set: {
          quoteJson: json(value),
          expiresAt: value.expiresAt,
          simulationStatus: value.simulationStatus,
        },
      })
      .run();
  }

  getQuote(id: string): Quote | undefined {
    const row = this.db.select().from(quotes).where(eq(quotes.id, id)).get();
    return row ? quoteSchema.parse(parse(row.quoteJson)) : undefined;
  }

  saveExecution(execution: Execution): void {
    const value = executionSchema.parse(execution);
    this.db
      .insert(executions)
      .values({
        transactionHash: value.transactionHash,
        intentHash: value.intentHash,
        proposalHash: value.proposalHash,
        status: value.status,
        executionJson: json(value),
        submittedAt: value.submittedAt,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: executions.transactionHash,
        set: {
          status: value.status,
          executionJson: json(value),
          updatedAt: now(),
        },
      })
      .run();
  }

  getExecution(hash: string): Execution | undefined {
    const row = this.db
      .select()
      .from(executions)
      .where(eq(executions.transactionHash, hash))
      .get();
    return row ? executionSchema.parse(parse(row.executionJson)) : undefined;
  }

  upsertCapacityEpoch(input: {
    readonly positionId: string;
    readonly traderInputToken: string;
    readonly traderOutputToken: string;
    readonly capacityEpochId: string;
    readonly capacityBaselineValue: string;
    readonly consumedValue: string;
    readonly policyNonce: string;
    readonly riskCertificateHash: string;
    readonly balanceSnapshot: string;
    readonly priceSnapshot: string;
    readonly portfolioPriceSnapshot: string;
    readonly aquaStrategyHash: string;
    readonly chainId: number;
    readonly verifyingContract: string;
    readonly active: boolean;
  }): void {
    this.db
      .insert(capacityEpochs)
      .values({ ...input, updatedAt: now() })
      .onConflictDoUpdate({
        target: [
          capacityEpochs.positionId,
          capacityEpochs.traderInputToken,
          capacityEpochs.traderOutputToken,
        ],
        set: { ...input, updatedAt: now() },
      })
      .run();
  }

  getCapacityEpoch(
    positionId: string,
    traderInputToken: string,
    traderOutputToken: string,
  ) {
    return this.db
      .select()
      .from(capacityEpochs)
      .where(
        and(
          eq(capacityEpochs.positionId, positionId),
          eq(capacityEpochs.traderInputToken, traderInputToken),
          eq(capacityEpochs.traderOutputToken, traderOutputToken),
        ),
      )
      .get();
  }

  /**
   * Atomically claim an idempotency key slot.
   * - Returns undefined if the key is new (slot was claimed for us).
   * - Returns the stored response if the key was already COMPLETED with matching body.
   * - Throws IdempotencyConflictError (HTTP 409) if:
   *   a) the key was used with a different method/path, or
   *   b) the key was used with a different request body (hash mismatch).
   */
  claimIdempotencyKey(
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): StoredIdempotencyResponse | undefined {
    return this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key))
        .get();
      if (!row) {
        // New key: insert a PENDING claim
        tx.insert(idempotencyKeys)
          .values({
            key,
            method,
            path,
            requestHash,
            status: "PENDING",
            createdAt: now(),
          })
          .run();
        return undefined;
      }
      if (row.method !== method || row.path !== path) {
        throw new IdempotencyConflictError(
          "Idempotency key was reused for a different endpoint",
        );
      }
      if (row.requestHash !== requestHash) {
        throw new IdempotencyConflictError(
          "Idempotency key was reused with a different request body",
        );
      }
      if (row.status === "PENDING") {
        // Concurrent request still in-flight; let caller handle as 409
        throw new IdempotencyConflictError(
          "Idempotency key request is still in progress",
        );
      }
      if (row.statusCode !== null && row.responseJson !== null) {
        return { statusCode: row.statusCode, body: parse(row.responseJson) };
      }
      return undefined;
    });
  }

  /** Record the completed response for an idempotency key. */
  completeIdempotencyResponse(
    key: string,
    response: StoredIdempotencyResponse,
  ): void {
    this.db
      .update(idempotencyKeys)
      .set({
        status: "COMPLETED",
        statusCode: response.statusCode,
        responseJson: json(response.body),
      })
      .where(eq(idempotencyKeys.key, key))
      .run();
  }

  /** Release a claim when its callback failed before a response was stored. */
  releaseIdempotencyKey(key: string, requestHash: string): void {
    this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.requestHash, requestHash),
          eq(idempotencyKeys.status, "PENDING"),
        ),
      )
      .run();
  }

  /** @deprecated Use claimIdempotencyKey + completeIdempotencyResponse instead */
  getIdempotentResponse(
    key: string,
    method: string,
    path: string,
  ): StoredIdempotencyResponse | undefined {
    const row = this.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .get();
    if (!row) return undefined;
    if (row.method !== method || row.path !== path)
      throw new IdempotencyConflictError(
        "Idempotency key was reused for another request",
      );
    if (row.statusCode !== null && row.responseJson !== null)
      return { statusCode: row.statusCode, body: parse(row.responseJson) };
    return undefined;
  }

  /** @deprecated Use claimIdempotencyKey + completeIdempotencyResponse instead */
  saveIdempotentResponse(
    key: string,
    method: string,
    path: string,
    response: StoredIdempotencyResponse,
  ): void {
    this.db
      .insert(idempotencyKeys)
      .values({
        key,
        method,
        path,
        requestHash: "",
        status: "COMPLETED",
        statusCode: response.statusCode,
        responseJson: json(response.body),
        createdAt: now(),
      })
      .onConflictDoNothing()
      .run();
  }

  projectEvent(event: ProtocolEvent): void {
    const parsed = protocolEventSchema.parse(event);
    const value = {
      ...parsed,
      payload: parseProtocolEventPayload(parsed.name, parsed.payload),
    } as ProtocolEvent;
    const id = `${value.chainId}:${value.contract.toLowerCase()}:${value.transactionHash}:${value.logIndex}`;
    this.db.transaction((transaction) => {
      transaction
        .insert(chainEvents)
        .values({
          id,
          chainId: value.chainId,
          blockNumber: value.blockNumber,
          blockHash: value.blockHash,
          transactionHash: value.transactionHash,
          logIndex: value.logIndex,
          contract: value.contract.toLowerCase(),
          eventVersion: 1,
          name: value.name,
          payloadJson: json(value.payload),
          removed: false,
          observedAt: value.observedAt,
        })
        .onConflictDoUpdate({
          target: [
            chainEvents.chainId,
            chainEvents.contract,
            chainEvents.transactionHash,
            chainEvents.logIndex,
          ],
          set: {
            blockNumber: value.blockNumber,
            blockHash: value.blockHash,
            contract: value.contract.toLowerCase(),
            name: value.name,
            payloadJson: json(value.payload),
            removed: false,
            observedAt: value.observedAt,
          },
        })
        .run();
      this.applyProjectedEvent(transaction, value);
    });
  }

  projectRemovedLog(event: ProtocolEvent): void {
    const parsed = protocolEventSchema.parse(event);
    const value = {
      ...parsed,
      payload: parseProtocolEventPayload(parsed.name, parsed.payload),
    } as ProtocolEvent;
    this.db.transaction((transaction) => {
      transaction
        .update(chainEvents)
        .set({ removed: true })
        .where(
          and(
            eq(chainEvents.chainId, value.chainId),
            eq(chainEvents.contract, value.contract.toLowerCase()),
            eq(chainEvents.transactionHash, value.transactionHash),
            eq(chainEvents.logIndex, value.logIndex),
          ),
        )
        .run();
      this.rebuildProjectedState(transaction);
    });
  }

  private applyProjectedEvent(
    database: ServiceDrizzleDatabase,
    event: ProtocolEvent,
  ): void {
    if (event.name === "CapacityEpochActivated") {
      const payload = event.payload;
      const positionId = this.resolvePositionId(
        database,
        String(payload.positionIdHash),
      );
      database
        .insert(capacityEpochs)
        .values({
          positionId,
          traderInputToken: String(payload.traderInputToken).toLowerCase(),
          traderOutputToken: String(payload.traderOutputToken).toLowerCase(),
          capacityEpochId: String(payload.capacityEpochId),
          capacityBaselineValue: String(payload.capacityBaselineValue),
          consumedValue: String(payload.consumedBefore),
          policyNonce: String(payload.policyNonce),
          riskCertificateHash: String(payload.riskCertificateHash),
          balanceSnapshot: String(payload.balanceSnapshot),
          priceSnapshot: String(payload.priceSnapshot),
          portfolioPriceSnapshot: String(payload.portfolioPriceSnapshot),
          aquaStrategyHash: String(payload.aquaStrategyHash),
          chainId: event.chainId,
          verifyingContract: event.contract,
          active: true,
          updatedAt: event.observedAt,
        })
        .onConflictDoUpdate({
          target: [
            capacityEpochs.positionId,
            capacityEpochs.traderInputToken,
            capacityEpochs.traderOutputToken,
          ],
          set: {
            capacityEpochId: String(payload.capacityEpochId),
            capacityBaselineValue: String(payload.capacityBaselineValue),
            consumedValue: String(payload.consumedBefore),
            policyNonce: String(payload.policyNonce),
            riskCertificateHash: String(payload.riskCertificateHash),
            balanceSnapshot: String(payload.balanceSnapshot),
            priceSnapshot: String(payload.priceSnapshot),
            portfolioPriceSnapshot: String(payload.portfolioPriceSnapshot),
            aquaStrategyHash: String(payload.aquaStrategyHash),
            active: true,
            updatedAt: event.observedAt,
          },
        })
        .run();
    }
    if (event.name === "TradeExecuted") {
      const payload = event.payload;
      const positionId = this.resolvePositionId(
        database,
        String(payload.positionIdHash),
      );
      const traderInputToken = String(payload.traderInputToken).toLowerCase();
      const traderOutputToken = String(payload.traderOutputToken).toLowerCase();
      const epoch = database
        .select()
        .from(capacityEpochs)
        .where(
          and(
            eq(capacityEpochs.positionId, positionId),
            eq(capacityEpochs.traderInputToken, traderInputToken),
            eq(capacityEpochs.traderOutputToken, traderOutputToken),
          ),
        )
        .get();
      if (epoch) {
        database
          .update(capacityEpochs)
          .set({
            consumedValue: String(payload.consumedAfter),
            updatedAt: event.observedAt,
          })
          .where(
            and(
              eq(capacityEpochs.positionId, positionId),
              eq(capacityEpochs.traderInputToken, traderInputToken),
              eq(capacityEpochs.traderOutputToken, traderOutputToken),
            ),
          )
          .run();
      }
    }
  }

  private resolvePositionId(
    database: ServiceDrizzleDatabase,
    positionIdHash: string,
  ): string {
    const position = database
      .select({ id: positions.id })
      .from(positions)
      .all()
      .find(
        (candidate) =>
          hashBytes(candidate.id).toLowerCase() ===
          positionIdHash.toLowerCase(),
      );
    return position?.id ?? positionIdHash;
  }

  private rebuildProjectedState(database: ServiceDrizzleDatabase): void {
    database.delete(capacityEpochs).run();
    const events = database
      .select()
      .from(chainEvents)
      .where(eq(chainEvents.removed, false))
      .all()
      .sort((left, right) => {
        const blockDifference =
          BigInt(left.blockNumber) - BigInt(right.blockNumber);
        return blockDifference === 0n
          ? left.logIndex - right.logIndex
          : blockDifference < 0n
            ? -1
            : 1;
      });
    for (const row of events) {
      this.applyProjectedEvent(
        database,
        protocolEventSchema.parse({
          id: row.id,
          name: row.name,
          chainId: row.chainId,
          contract: row.contract,
          transactionHash: row.transactionHash,
          blockNumber: row.blockNumber,
          logIndex: row.logIndex,
          blockHash: row.blockHash,
          observedAt: row.observedAt,
          payload: parse(row.payloadJson),
        }),
      );
    }
  }

  listEvents(chainId: number, limit: number, cursor?: string): EventPage {
    const rows = this.db
      .select()
      .from(chainEvents)
      .where(
        and(
          eq(chainEvents.chainId, chainId),
          eq(chainEvents.removed, false),
          cursor ? gt(chainEvents.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(chainEvents.id))
      .limit(limit + 1)
      .all();
    const items = rows.slice(0, limit).map((row) =>
      protocolEventSchema.parse({
        id: row.id,
        name: row.name,
        chainId: row.chainId,
        contract: row.contract,
        transactionHash: row.transactionHash,
        blockNumber: row.blockNumber,
        logIndex: row.logIndex,
        blockHash: row.blockHash,
        observedAt: row.observedAt,
        payload: parse(row.payloadJson),
      }),
    );
    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Retain every verified header in an indexed range. Events alone are not
   * sufficient for fork recovery because a replaced block may have emitted no
   * event.
   */
  saveIndexedHeaders(
    chainId: number,
    contract: string,
    headers: readonly IndexedBlockHeader[],
  ): void {
    if (headers.length === 0) return;
    this.db.transaction((tx) => {
      for (const header of headers) {
        tx.insert(indexingHeaders)
          .values({
            chainId,
            contract: contract.toLowerCase(),
            blockNumber: header.blockNumber,
            blockHash: header.blockHash,
            updatedAt: now(),
          })
          .onConflictDoUpdate({
            target: [
              indexingHeaders.chainId,
              indexingHeaders.contract,
              indexingHeaders.blockNumber,
            ],
            set: { blockHash: header.blockHash, updatedAt: now() },
          })
          .run();
      }
    });
  }

  getIndexedHeader(
    chainId: number,
    contract: string,
    blockNumber: bigint,
  ): IndexedBlockHeader | undefined {
    const row = this.db
      .select({
        blockNumber: indexingHeaders.blockNumber,
        blockHash: indexingHeaders.blockHash,
      })
      .from(indexingHeaders)
      .where(
        and(
          eq(indexingHeaders.chainId, chainId),
          eq(indexingHeaders.contract, contract.toLowerCase()),
          eq(indexingHeaders.blockNumber, blockNumber.toString()),
        ),
      )
      .get();
    return row;
  }

  /**
   * Remove the orphaned branch after a verified common ancestor and rebuild
   * all derived projections in the same SQLite transaction.
   */
  rollbackToBlock(
    chainId: number,
    contract: string,
    ancestorBlock: bigint,
    ancestorHash?: string,
  ): void {
    const normalizedContract = contract.toLowerCase();
    this.db.transaction((tx) => {
      const eventCondition = and(
        eq(chainEvents.chainId, chainId),
        eq(chainEvents.contract, normalizedContract),
        ancestorBlock < 0n
          ? undefined
          : sql`CAST(${chainEvents.blockNumber} AS INTEGER) > ${Number(ancestorBlock)}`,
      );
      tx.delete(chainEvents).where(eventCondition).run();
      tx.delete(indexingHeaders)
        .where(
          and(
            eq(indexingHeaders.chainId, chainId),
            eq(indexingHeaders.contract, normalizedContract),
            ancestorBlock < 0n
              ? undefined
              : sql`CAST(${indexingHeaders.blockNumber} AS INTEGER) > ${Number(ancestorBlock)}`,
          ),
        )
        .run();
      this.rebuildProjectedState(tx);
      if (ancestorHash === undefined || ancestorBlock < 0n) {
        tx.delete(indexingCheckpoints)
          .where(
            and(
              eq(indexingCheckpoints.chainId, chainId),
              eq(indexingCheckpoints.contract, normalizedContract),
            ),
          )
          .run();
      } else {
        tx.insert(indexingCheckpoints)
          .values({
            chainId,
            contract: normalizedContract,
            blockNumber: ancestorBlock.toString(),
            blockHash: ancestorHash,
            updatedAt: now(),
          })
          .onConflictDoUpdate({
            target: [indexingCheckpoints.chainId, indexingCheckpoints.contract],
            set: {
              blockNumber: ancestorBlock.toString(),
              blockHash: ancestorHash,
              updatedAt: now(),
            },
          })
          .run();
      }
    });
  }

  /** Remove all chain events at or after blockNumber for reorg rollback. */
  removeEventsAfterBlock(
    chainId: number,
    contract: string,
    blockNumber: bigint,
  ): void {
    this.rollbackToBlock(chainId, contract, blockNumber - 1n);
  }

  /** Public alias for external reorg recovery. */
  rebuildProjections(): void {
    this.db.transaction((tx) => this.rebuildProjectedState(tx));
  }

  setCheckpoint(
    chainId: number,
    contract: string,
    blockNumber: string,
    blockHash: string,
  ): void {
    const normalizedContract = contract.toLowerCase();
    this.db
      .insert(indexingCheckpoints)
      .values({
        chainId,
        contract: normalizedContract,
        blockNumber,
        blockHash,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [indexingCheckpoints.chainId, indexingCheckpoints.contract],
        set: { blockNumber, blockHash, updatedAt: now() },
      })
      .run();
  }

  clearCheckpoint(chainId: number, contract: string): void {
    this.db
      .delete(indexingCheckpoints)
      .where(
        and(
          eq(indexingCheckpoints.chainId, chainId),
          eq(indexingCheckpoints.contract, contract.toLowerCase()),
        ),
      )
      .run();
  }

  getCheckpoint(chainId: number, contract: string) {
    return this.db
      .select()
      .from(indexingCheckpoints)
      .where(
        and(
          eq(indexingCheckpoints.chainId, chainId),
          eq(indexingCheckpoints.contract, contract.toLowerCase()),
        ),
      )
      .get();
  }
}
