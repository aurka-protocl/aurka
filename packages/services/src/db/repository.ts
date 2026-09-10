import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  activityItemSchema,
  atomicSettlementIntentSchema,
  atomicSettlementProposalSchema,
  executionSchema,
  feeSummarySchema,
  parseProtocolEventPayload,
  positionSchema,
  protocolEventSchema,
  quoteSchema,
  spaceChangeSchema,
  spaceDraftSchema,
  spaceIdentitySchema,
  spaceRecordSchema,
  type AtomicSettlementIntent,
  type AtomicSettlementProposal,
  type ActivityItem,
  type ActivityStatus,
  type ActivityType,
  type FeeSummary,
  type Execution,
  type Position,
  type ProtocolEvent,
  type Quote,
  type SimulationStatus,
  type SpaceChange,
  type SpaceDraft,
  type SpaceIdentity,
  type SpaceRecord,
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
  riskStates,
  riskWorkflows,
  riskAuditEvents,
  settlementRecords,
  spaces,
  spaceChanges,
  walletPolicies,
} from "./schema.js";
import type { ServiceDrizzleDatabase } from "./database.js";
import { hashBytes } from "../solver/hash.js";

const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const now = (): number => Math.floor(Date.now() / 1000);

interface ActivityCursor {
  readonly timestamp: number;
  readonly id: string;
}

function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeActivityCursor(
  value: string | undefined,
): ActivityCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ActivityCursor>;
    if (
      typeof parsed.timestamp !== "number" ||
      !Number.isSafeInteger(parsed.timestamp) ||
      parsed.timestamp < 0 ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    )
      return undefined;
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    return undefined;
  }
}

function activityTimestamp(item: ActivityItem): number {
  return item.occurredAt ?? item.submittedAt ?? 0;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface EventPage {
  readonly items: readonly ProtocolEvent[];
  readonly nextCursor: string | null;
}

export interface ActivityQuery {
  readonly spaceId?: string | undefined;
  readonly chainId?: number | undefined;
  readonly positionId?: string | undefined;
  readonly type?: ActivityType | undefined;
  readonly status?: ActivityStatus | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface FeeSummaryQuery {
  readonly chainId?: number | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
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

    const existingSpace = this.db
      .select({ state: spaces.state })
      .from(spaces)
      .where(eq(spaces.id, value.id))
      .get();
    const syncedState =
      existingSpace &&
      (existingSpace.state === "DRAFT" ||
        existingSpace.state === "PENDING" ||
        existingSpace.state === "FAILED")
        ? existingSpace.state
        : value.policy.paused
          ? "PAUSED"
          : "ACTIVE";
    this.db
      .insert(spaces)
      .values({
        id: value.id,
        name: value.name,
        owner: value.owner,
        controller: value.policy.governance,
        treasury: value.treasury,
        chainId: value.chainId,
        policyId: value.policy.id,
        strategyId: `0x${"00".repeat(32)}`,
        policyRegistry: value.policy.registry,
        mode: "demo",
        state: syncedState,
        positionId: value.id,
        draftJson: null,
        failureReason: null,
        updatedAt: value.updatedAt,
        createdAt: value.createdAt,
      })
      .onConflictDoUpdate({
        target: spaces.id,
        set: {
          name: value.name,
          owner: value.owner,
          controller: value.policy.governance,
          treasury: value.treasury,
          chainId: value.chainId,
          policyId: value.policy.id,
          policyRegistry: value.policy.registry,
          state: syncedState,
          positionId: value.id,
          failureReason: null,
          updatedAt: value.updatedAt,
        },
      })
      .run();
    return value;
  }

  saveSpaceIdentity(
    identity: SpaceIdentity,
    draft?: SpaceDraft,
    failureReason?: string,
  ): SpaceIdentity {
    const value = spaceIdentitySchema.parse(identity);
    const parsedDraft =
      draft === undefined ? undefined : spaceDraftSchema.parse(draft);
    this.db
      .insert(spaces)
      .values({
        id: value.id,
        name: value.name,
        owner: value.ownerAddress,
        controller: value.controllerAddress,
        treasury: value.treasuryAddress,
        chainId: value.chainId,
        policyId: value.policyId,
        strategyId: value.strategyId,
        policyRegistry: value.policyRegistryAddress,
        mode: value.mode,
        state: value.state,
        positionId: value.id,
        draftJson: parsedDraft === undefined ? null : json(parsedDraft),
        failureReason: failureReason ?? null,
        updatedAt: now(),
        createdAt: now(),
      })
      .onConflictDoUpdate({
        target: spaces.id,
        set: {
          name: value.name,
          owner: value.ownerAddress,
          controller: value.controllerAddress,
          treasury: value.treasuryAddress,
          chainId: value.chainId,
          policyId: value.policyId,
          strategyId: value.strategyId,
          policyRegistry: value.policyRegistryAddress,
          mode: value.mode,
          state: value.state,
          positionId: value.id,
          ...(parsedDraft === undefined
            ? {}
            : { draftJson: json(parsedDraft) }),
          failureReason: failureReason ?? null,
          updatedAt: now(),
        },
      })
      .run();
    return value;
  }

  getSpace(id: string): SpaceRecord | undefined {
    const row = this.db.select().from(spaces).where(eq(spaces.id, id)).get();
    if (!row) return undefined;
    const position = this.getPosition(row.positionId ?? row.id);
    const identity = spaceIdentitySchema.parse({
      id: row.id,
      name: row.name,
      ownerAddress: row.owner,
      controllerAddress: row.controller,
      treasuryAddress: row.treasury,
      chainId: row.chainId,
      policyId: row.policyId,
      strategyId: row.strategyId,
      policyRegistryAddress: row.policyRegistry,
      mode: row.mode,
      state: row.state,
    });
    return spaceRecordSchema.parse({
      identity,
      ...(position ? { position } : {}),
      ...(row.draftJson ? { draft: parse<SpaceDraft>(row.draftJson) } : {}),
      ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    }) as SpaceRecord;
  }

  listSpaces(
    limit: number,
    cursor?: string,
    ownerAddress?: string,
  ): Page<SpaceRecord> {
    const rows = this.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          cursor ? gt(spaces.id, cursor) : undefined,
          ownerAddress
            ? sql`lower(${spaces.owner}) = lower(${ownerAddress})`
            : undefined,
        ),
      )
      .orderBy(asc(spaces.id))
      .limit(limit + 1)
      .all();
    const items = rows.flatMap((row) => {
      const space = this.getSpace(row.id);
      return space ? [space] : [];
    });
    return {
      items: items.slice(0, limit),
      nextCursor:
        rows.length > limit ? (items.at(limit - 1)?.identity.id ?? null) : null,
    };
  }

  getSpaceAuthNonce(spaceId: string): string {
    const row = this.db
      .select({ authNonce: spaces.authNonce })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .get();
    return row?.authNonce ?? "0";
  }

  consumeSpaceAuthNonce(spaceId: string, expectedNonce: string): boolean {
    const next = (BigInt(expectedNonce) + 1n).toString();
    const result = this.db
      .update(spaces)
      .set({ authNonce: next, updatedAt: now() })
      .where(and(eq(spaces.id, spaceId), eq(spaces.authNonce, expectedNonce)))
      .run();
    return result.changes === 1;
  }

  saveSpaceChange(input: SpaceChange): SpaceChange {
    const value = spaceChangeSchema.parse(input);
    this.db
      .insert(spaceChanges)
      .values({
        id: value.id,
        spaceId: value.spaceId,
        eventType: value.eventType,
        actor: value.actor,
        status: value.status,
        receiptHash: value.receiptHash ?? null,
        payloadJson: json(value.payload),
        createdAt: value.createdAt,
      })
      .onConflictDoNothing()
      .run();
    return value;
  }

  /**
   * Complete the pending projection for a chain operation without allowing a
   * late retry to downgrade an already terminal change.
   */
  updateSpaceChange(input: SpaceChange): SpaceChange {
    const value = spaceChangeSchema.parse(input);
    const result = this.db
      .update(spaceChanges)
      .set({
        eventType: value.eventType,
        actor: value.actor,
        status: value.status,
        receiptHash: value.receiptHash ?? null,
        payloadJson: json(value.payload),
        createdAt: value.createdAt,
      })
      .where(
        and(eq(spaceChanges.id, value.id), eq(spaceChanges.status, "PENDING")),
      )
      .run();
    if (result.changes === 0) {
      const existing = this.db
        .select({ id: spaceChanges.id })
        .from(spaceChanges)
        .where(eq(spaceChanges.id, value.id))
        .get();
      if (!existing) this.saveSpaceChange(value);
    }
    return value;
  }

  setSpaceReceiptStatus(
    spaceId: string,
    hashes: string[],
    status: "CONFIRMED" | "FAILED",
  ): void {
    for (const hash of hashes) {
      this.db
        .update(spaceChanges)
        .set({ status })
        .where(
          and(
            eq(spaceChanges.spaceId, spaceId),
            eq(spaceChanges.receiptHash, hash),
          ),
        )
        .run();
    }
  }

  listSpaceChanges(spaceId: string, limit = 100): SpaceChange[] {
    return this.db
      .select()
      .from(spaceChanges)
      .where(eq(spaceChanges.spaceId, spaceId))
      .orderBy(desc(spaceChanges.createdAt), desc(spaceChanges.id))
      .limit(limit)
      .all()
      .map((row) =>
        spaceChangeSchema.parse({
          id: row.id,
          spaceId: row.spaceId,
          eventType: row.eventType,
          actor: row.actor,
          status: row.status,
          ...(row.receiptHash ? { receiptHash: row.receiptHash } : {}),
          payload: parse<Record<string, unknown>>(row.payloadJson),
          createdAt: row.createdAt,
        }),
      );
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

  transaction<T>(action: () => T): T {
    return this.db.transaction(action, { behavior: "immediate" });
  }
  getRiskState(positionId: string): Record<string, unknown> | undefined {
    const row = this.db
      .select()
      .from(riskStates)
      .where(eq(riskStates.positionId, positionId))
      .get();
    return row ? parse<Record<string, unknown>>(row.stateJson) : undefined;
  }
  saveRiskState(positionId: string, state: Record<string, unknown>): void {
    this.db
      .insert(riskStates)
      .values({ positionId, stateJson: json(state) })
      .onConflictDoUpdate({
        target: riskStates.positionId,
        set: { stateJson: json(state) },
      })
      .run();
  }

  getRiskWorkflow(positionId: string): Record<string, unknown> | undefined {
    const row = this.db
      .select()
      .from(riskWorkflows)
      .where(eq(riskWorkflows.positionId, positionId))
      .get();
    return row ? parse<Record<string, unknown>>(row.payloadJson) : undefined;
  }
  saveRiskWorkflow(positionId: string, payload: Record<string, unknown>): void {
    this.db
      .insert(riskWorkflows)
      .values({ positionId, payloadJson: json(payload) })
      .onConflictDoUpdate({
        target: riskWorkflows.positionId,
        set: { payloadJson: json(payload) },
      })
      .run();
  }
  ownsRiskJob(id: string, attempt: number): boolean {
    const row = this.db
      .select()
      .from(riskJobs)
      .where(eq(riskJobs.id, id))
      .get();
    return row?.status === "RUNNING" && row.attempt === attempt;
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
      .orderBy(desc(riskEvaluations.evaluatedAt), sql`rowid DESC`)
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
            or(eq(riskJobs.status, "QUEUED"), eq(riskJobs.status, "RUNNING")),
            lte(riskJobs.nextRunAt, nowSeconds),
          ),
        )
        .get();
      if (!row) return undefined;
      transaction
        .update(riskJobs)
        .set({
          status: "RUNNING",
          attempt: row.attempt + 1,
          nextRunAt: nowSeconds + 120,
          updatedAt: now(),
        })
        .where(and(eq(riskJobs.id, id), eq(riskJobs.attempt, row.attempt)))
        .run();
      return {
        id: row.id,
        positionId: row.positionId,
        kind: row.kind,
        attempt: row.attempt + 1,
      };
    });
  }

  releaseRiskJob(id: string, attempt: number, nextRunAt: number): void {
    this.db
      .update(riskJobs)
      .set({ status: "QUEUED", nextRunAt, updatedAt: now() })
      .where(
        and(
          eq(riskJobs.id, id),
          eq(riskJobs.attempt, attempt),
          eq(riskJobs.status, "RUNNING"),
        ),
      )
      .run();
  }
  ensureRiskJob(id: string, positionId: string, nextRunAt: number): void {
    this.db
      .insert(riskJobs)
      .values({
        id,
        positionId,
        kind: "CERTIFICATE_RENEWAL",
        status: "QUEUED",
        attempt: 0,
        nextRunAt,
        updatedAt: now(),
      })
      .onConflictDoNothing()
      .run();
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
    readonly configuration: Record<string, unknown> | undefined;
    readonly certificate: Record<string, unknown> | undefined;
    readonly certificateStatus: string | undefined;
  } {
    const position = this.db
      .select()
      .from(positions)
      .where(eq(positions.id, positionId))
      .get();
    const evaluation = this.getLatestRiskEvaluation(positionId);
    const evaluationRow = this.db
      .select({ configurationJson: riskEvaluations.configurationJson })
      .from(riskEvaluations)
      .where(eq(riskEvaluations.positionId, positionId))
      .orderBy(desc(riskEvaluations.evaluatedAt), sql`rowid DESC`)
      .limit(1)
      .get();
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
      configuration: evaluationRow
        ? parse<Record<string, unknown>>(evaluationRow.configurationJson)
        : undefined,
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
      .where(
        and(
          eq(proposals.intentHash, intentHash),
          or(
            eq(proposals.simulationStatus, "SUCCEEDED"),
            eq(proposals.simulationStatus, "AUTHORIZATION_PENDING"),
          ),
        ),
      )
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
        positionId: value.initialPortfolio.positionId,
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

  listActivity(query: ActivityQuery): Page<ActivityItem> {
    const cursor = decodeActivityCursor(query.cursor);
    const requestedSpaceId = query.spaceId ?? query.positionId;
    const includeSwaps = query.type === undefined || query.type === "SWAP";
    const includeChanges = query.type === undefined || query.type !== "SWAP";
    const sourceLimit = Math.min(201, query.limit * 2 + 1);
    const executionRows = includeSwaps
      ? this.db
          .select()
          .from(executions)
          .where(
            and(
              query.chainId === undefined
                ? undefined
                : sql`json_extract(${executions.executionJson}, '$.chainId') = ${query.chainId}`,
              requestedSpaceId === undefined || requestedSpaceId === ""
                ? undefined
                : eq(executions.positionId, requestedSpaceId),
              query.status === "CONFIRMED" || query.status === "ORPHANED"
                ? sql`0 = 1`
                : query.status === "FAILED"
                  ? or(
                      eq(executions.status, "REVERTED"),
                      eq(executions.status, "DROPPED"),
                    )
                  : query.status === "PREPARED"
                    ? and(
                        eq(executions.status, "PENDING"),
                        or(
                          sql`json_extract(${executions.executionJson}, '$.submissionState') IS NULL`,
                          sql`json_extract(${executions.executionJson}, '$.submissionState') = 'PREPARED'`,
                        ),
                      )
                    : query.status === "PENDING"
                      ? and(
                          eq(executions.status, "PENDING"),
                          sql`json_extract(${executions.executionJson}, '$.submissionState') = 'SUBMITTED'`,
                        )
                      : or(
                          eq(executions.status, "PENDING"),
                          eq(executions.status, "REVERTED"),
                          eq(executions.status, "DROPPED"),
                        ),
              query.from === undefined
                ? undefined
                : gte(executions.submittedAt, query.from),
              query.to === undefined
                ? undefined
                : lte(executions.submittedAt, query.to),
              cursor === undefined
                ? undefined
                : or(
                    sql`${executions.submittedAt} < ${cursor.timestamp}`,
                    and(
                      eq(executions.submittedAt, cursor.timestamp),
                      sql`(${executions.transactionHash} || ':' || ${executions.proposalHash}) < ${cursor.id}`,
                    ),
                  ),
            ),
          )
          .orderBy(
            desc(executions.submittedAt),
            desc(
              sql`${executions.transactionHash} || ':' || ${executions.proposalHash}`,
            ),
          )
          .limit(sourceLimit)
          .all()
      : [];

    const settlementRows = includeSwaps
      ? this.db
          .select()
          .from(settlementRecords)
          .where(
            and(
              query.chainId === undefined
                ? undefined
                : eq(settlementRecords.chainId, query.chainId),
              requestedSpaceId === undefined || requestedSpaceId === ""
                ? undefined
                : eq(settlementRecords.positionId, requestedSpaceId),
              query.status === "PREPARED" ||
                query.status === "PENDING" ||
                query.status === "FAILED"
                ? sql`0 = 1`
                : query.status === "ORPHANED"
                  ? eq(settlementRecords.orphaned, true)
                  : query.status === "CONFIRMED"
                    ? eq(settlementRecords.orphaned, false)
                    : undefined,
              isNotNull(settlementRecords.tradeJson),
              isNotNull(settlementRecords.feeJson),
              query.from === undefined
                ? undefined
                : gte(settlementRecords.observedAt, query.from),
              query.to === undefined
                ? undefined
                : lte(settlementRecords.observedAt, query.to),
              cursor === undefined
                ? undefined
                : or(
                    sql`${settlementRecords.observedAt} < ${cursor.timestamp}`,
                    and(
                      eq(settlementRecords.observedAt, cursor.timestamp),
                      sql`(${settlementRecords.transactionHash} || ':' || ${settlementRecords.proposalHash}) < ${cursor.id}`,
                    ),
                  ),
            ),
          )
          .orderBy(
            desc(settlementRecords.observedAt),
            desc(
              sql`${settlementRecords.transactionHash} || ':' || ${settlementRecords.proposalHash}`,
            ),
          )
          .limit(sourceLimit)
          .all()
      : [];

    const changeRows = includeChanges
      ? this.db
          .select()
          .from(spaceChanges)
          .where(
            and(
              requestedSpaceId === undefined || requestedSpaceId === ""
                ? undefined
                : eq(spaceChanges.spaceId, requestedSpaceId),
              query.chainId === undefined
                ? undefined
                : sql`EXISTS (SELECT 1 FROM spaces WHERE spaces.id = ${spaceChanges.spaceId} AND spaces.chain_id = ${query.chainId})`,
              query.type === "RULE_CHANGE"
                ? or(
                    eq(spaceChanges.eventType, "SPACE_CREATED"),
                    eq(spaceChanges.eventType, "SPACE_UPDATED"),
                    eq(spaceChanges.eventType, "SPACE_ACTIVATED"),
                  )
                : query.type === "TRADING_STATUS"
                  ? or(
                      eq(spaceChanges.eventType, "SPACE_PAUSED"),
                      eq(spaceChanges.eventType, "SPACE_RESUMED"),
                      eq(spaceChanges.eventType, "SPACE_DEPLOYMENT_FAILED"),
                    )
                  : undefined,
              query.status === "PREPARED" || query.status === "ORPHANED"
                ? sql`0 = 1`
                : query.status === "PENDING" || query.status === "CONFIRMED"
                  ? eq(spaceChanges.status, query.status)
                  : query.status === "FAILED"
                    ? eq(spaceChanges.status, "FAILED")
                    : undefined,
              query.from === undefined
                ? undefined
                : gte(spaceChanges.createdAt, query.from),
              query.to === undefined
                ? undefined
                : lte(spaceChanges.createdAt, query.to),
              cursor === undefined
                ? undefined
                : or(
                    sql`${spaceChanges.createdAt} < ${cursor.timestamp}`,
                    and(
                      eq(spaceChanges.createdAt, cursor.timestamp),
                      sql`${spaceChanges.id} < ${cursor.id}`,
                    ),
                  ),
            ),
          )
          .orderBy(desc(spaceChanges.createdAt), desc(spaceChanges.id))
          .limit(sourceLimit)
          .all()
      : [];

    type ActivityEntry = {
      readonly item: ActivityItem;
      readonly timestamp: number;
      readonly key: string;
    };
    const settlementEntries = settlementRows.flatMap((row): ActivityEntry[] => {
      const item = this.activityFromSettlement(row);
      return item
        ? [
            {
              item,
              timestamp: activityTimestamp(item),
              key: `${row.transactionHash}:${row.proposalHash}`,
            },
          ]
        : [];
    });
    const settledKeys = new Set(
      settlementRows.map((row) => {
        const trade = row.tradeJson
          ? parse<Record<string, unknown>>(row.tradeJson)
          : {};
        return `${String(trade.intentHash ?? row.intentHash)}:${row.proposalHash}`;
      }),
    );
    const executionEntries = executionRows.flatMap((row): ActivityEntry[] => {
      const execution = executionSchema.parse(parse(row.executionJson));
      if (settledKeys.has(`${execution.intentHash}:${execution.proposalHash}`))
        return [];
      const item = this.activityFromExecution(row.positionId, execution);
      return item
        ? [
            {
              item,
              timestamp: activityTimestamp(item),
              key: `${execution.transactionHash}:${execution.proposalHash}`,
            },
          ]
        : [];
    });
    const changeEntries = changeRows.flatMap((row): ActivityEntry[] => {
      const item = this.activityFromSpaceChange(row);
      return item
        ? [
            {
              item,
              timestamp: activityTimestamp(item),
              key: row.id,
            },
          ]
        : [];
    });

    const mergedEntries = [
      ...settlementEntries,
      ...executionEntries,
      ...changeEntries,
    ].sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.key.localeCompare(left.key),
    );
    const mergedItems = mergedEntries.map((entry) => entry.item);
    const items = mergedItems.slice(0, query.limit);
    const hasMore =
      mergedItems.length > query.limit ||
      settlementRows.length === sourceLimit ||
      executionRows.length === sourceLimit ||
      changeRows.length === sourceLimit;
    const lastEntry = mergedEntries[query.limit - 1];
    return {
      items,
      nextCursor:
        hasMore && lastEntry
          ? encodeActivityCursor({
              timestamp: lastEntry.timestamp,
              id: lastEntry.key,
            })
          : null,
    };
  }

  getFeeSummary(positionId: string, query: FeeSummaryQuery = {}): FeeSummary {
    const position = this.getPosition(positionId);
    if (!position) throw new Error("Position was not found");
    const rows = this.db
      .select()
      .from(settlementRecords)
      .where(
        and(
          query.chainId === undefined
            ? undefined
            : eq(settlementRecords.chainId, query.chainId),
          eq(settlementRecords.positionId, positionId),
          eq(settlementRecords.orphaned, false),
          isNotNull(settlementRecords.tradeJson),
          isNotNull(settlementRecords.feeJson),
          query.from === undefined
            ? undefined
            : gte(settlementRecords.observedAt, query.from),
          query.to === undefined
            ? undefined
            : lte(settlementRecords.observedAt, query.to),
        ),
      )
      .orderBy(asc(settlementRecords.observedAt), asc(settlementRecords.id))
      .limit(100_000)
      .all();
    const grouped = new Map<
      string,
      {
        treasury: bigint;
        total: bigint;
        solver: bigint;
        protocol: bigint;
        count: number;
        first: number;
        last: number;
      }
    >();
    for (const row of rows) {
      const trade = parse<Record<string, string>>(row.tradeJson!);
      const fee = parse<Record<string, string>>(row.feeJson!);
      const total =
        BigInt(fee.solverAmount!) +
        BigInt(fee.protocolAmount!) +
        BigInt(fee.treasuryAmount!);
      if (total !== BigInt(trade.totalFeeAmount!)) continue;
      const token = fee.feeToken!.toLowerCase();
      const current = grouped.get(token);
      if (current) {
        current.treasury += BigInt(fee.treasuryAmount!);
        current.total += total;
        current.solver += BigInt(fee.solverAmount!);
        current.protocol += BigInt(fee.protocolAmount!);
        current.count += 1;
        current.last = Math.max(current.last, row.observedAt);
      } else {
        grouped.set(token, {
          treasury: BigInt(fee.treasuryAmount!),
          total,
          solver: BigInt(fee.solverAmount!),
          protocol: BigInt(fee.protocolAmount!),
          count: 1,
          first: row.observedAt,
          last: row.observedAt,
        });
      }
    }
    const assets = position.currentPortfolio?.assets ?? [];
    const items = [...grouped.entries()].map(([feeToken, value]) => ({
      feeToken,
      ...(assets.find((asset) => asset.token.toLowerCase() === feeToken)
        ?.symbol === undefined
        ? {}
        : {
            feeTokenSymbol: assets.find(
              (asset) => asset.token.toLowerCase() === feeToken,
            )!.symbol,
          }),
      treasuryAmount: value.treasury.toString(),
      totalFeeAmount: value.total.toString(),
      solverAmount: value.solver.toString(),
      protocolAmount: value.protocol.toString(),
      settlementCount: value.count,
      unit: "NORMALIZED_SETTLEMENT_VALUE" as const,
      firstConfirmedAt: value.first,
      lastConfirmedAt: value.last,
    }));
    const coveredFrom = rows.length > 0 ? rows[0]!.observedAt : null;
    const coveredTo = rows.length > 0 ? rows.at(-1)!.observedAt : null;
    return feeSummarySchema.parse({
      positionId,
      chainId: query.chainId ?? position.chainId,
      treasury: position.treasury,
      periodFrom: query.from ?? null,
      periodTo: query.to ?? null,
      coveredFrom,
      coveredTo,
      coverage:
        rows.length > 0
          ? "CONFIRMED_SETTLEMENT_EVENTS"
          : "NO_CONFIRMED_SETTLEMENTS",
      items,
      confirmedSettlementCount: rows.length,
    });
  }

  private activityFromExecution(
    positionId: string,
    execution: Execution,
  ): ActivityItem | undefined {
    const intent = this.getIntent(execution.intentHash);
    const position = this.getPosition(
      positionId || execution.initialPortfolio.positionId,
    );
    if (!intent || !position) return undefined;
    const space = this.getSpace(position.id);
    const status: ActivityStatus =
      execution.status === "PENDING"
        ? execution.submissionState === "SUBMITTED"
          ? "PENDING"
          : "PREPARED"
        : execution.status === "CONFIRMED"
          ? "CONFIRMED"
          : "FAILED";
    const inputAsset = execution.initialPortfolio.assets.find(
      (asset) =>
        asset.token.toLowerCase() === execution.traderInputToken.toLowerCase(),
    );
    const outputAsset = execution.initialPortfolio.assets.find(
      (asset) =>
        asset.token.toLowerCase() === execution.traderOutputToken.toLowerCase(),
    );
    return activityItemSchema.parse({
      id: hashBytes(`activity:execution:${execution.transactionHash}`),
      type: "SWAP",
      spaceId: position.id,
      ...(space ? { spaceName: space.identity.name } : {}),
      positionId: position.id,
      chainId: execution.chainId,
      status,
      source: "SERVICE_PREPARATION",
      transactionHash: execution.transactionHash,
      intentHash: execution.intentHash,
      proposalHash: execution.proposalHash,
      trader: intent.trader,
      actor: intent.trader,
      treasury: position.treasury,
      traderInputToken: execution.traderInputToken,
      traderOutputToken: execution.traderOutputToken,
      ...(inputAsset?.symbol === undefined
        ? {}
        : { traderInputSymbol: inputAsset.symbol }),
      ...(outputAsset?.symbol === undefined
        ? {}
        : { traderOutputSymbol: outputAsset.symbol }),
      requestedTraderInputValue: execution.requestedTraderInputAmount,
      executedTraderInputValue: execution.executedTraderInputAmount,
      submittedAt: execution.submittedAt,
      ...(execution.confirmedAt === undefined
        ? {}
        : { confirmedAt: execution.confirmedAt }),
      ...(execution.blockNumber === undefined
        ? {}
        : { blockNumber: execution.blockNumber }),
      bindingConstraint: execution.bindingConstraint,
      estimatedFees: execution.fees,
      feeState: status === "PREPARED" ? "ESTIMATE" : "NONE",
      initialPortfolio: execution.initialPortfolio,
      ...(execution.finalPortfolio === undefined
        ? {}
        : { finalPortfolio: execution.finalPortfolio }),
      ...(execution.revertReason === undefined
        ? {}
        : { revertReason: execution.revertReason }),
      evidence: {},
    });
  }

  private activityFromSettlement(
    row: typeof settlementRecords.$inferSelect,
  ): ActivityItem | undefined {
    if (!row.tradeJson || !row.feeJson || !row.positionId) return undefined;
    const trade = parse<Record<string, string>>(row.tradeJson);
    const fee = parse<Record<string, string>>(row.feeJson);
    const position = this.getPosition(row.positionId);
    if (!position) return undefined;
    const space = this.getSpace(position.id);
    const assets = position.currentPortfolio?.assets ?? [];
    const inputAsset = assets.find(
      (asset) =>
        asset.token.toLowerCase() === trade.traderInputToken!.toLowerCase(),
    );
    const outputAsset = assets.find(
      (asset) =>
        asset.token.toLowerCase() === trade.traderOutputToken!.toLowerCase(),
    );
    const status: ActivityStatus = row.orphaned ? "ORPHANED" : "CONFIRMED";
    const totalFee =
      BigInt(fee.solverAmount!) +
      BigInt(fee.protocolAmount!) +
      BigInt(fee.treasuryAmount!);
    const feeMatchesTrade = totalFee === BigInt(trade.totalFeeAmount!);
    return activityItemSchema.parse({
      id: hashBytes(`activity:settlement:${row.id}`),
      type: "SWAP",
      spaceId: position.id,
      ...(space ? { spaceName: space.identity.name } : {}),
      positionId: row.positionId,
      chainId: row.chainId,
      status,
      source: "CHAIN_EVENT",
      transactionHash: row.transactionHash,
      intentHash: trade.intentHash,
      proposalHash: trade.proposalHash,
      trader: trade.trader,
      actor: trade.trader,
      treasury: trade.treasury,
      traderInputToken: trade.traderInputToken,
      traderOutputToken: trade.traderOutputToken,
      ...(inputAsset?.symbol === undefined
        ? {}
        : { traderInputSymbol: inputAsset.symbol }),
      ...(outputAsset?.symbol === undefined
        ? {}
        : { traderOutputSymbol: outputAsset.symbol }),
      requestedTraderInputValue: trade.traderInputValue,
      executedTraderInputValue: trade.traderInputValue,
      traderOutputValue: trade.traderOutputValue,
      submittedAt: row.observedAt,
      occurredAt: row.observedAt,
      ...(row.orphaned ? {} : { confirmedAt: row.observedAt }),
      blockNumber: row.blockNumber,
      bindingConstraint: "NONE",
      feeState: row.orphaned || !feeMatchesTrade ? "NONE" : "EARNED",
      ...(row.orphaned || !feeMatchesTrade
        ? {}
        : {
            earnedFee: {
              feeToken: fee.feeToken,
              treasuryAmount: fee.treasuryAmount,
              solverAmount: fee.solverAmount,
              protocolAmount: fee.protocolAmount,
              totalAmount: totalFee.toString(),
              unit: "NORMALIZED_SETTLEMENT_VALUE" as const,
              eventId: row.feeEventId!,
            },
          }),
      expectedPostStateHash: trade.expectedPostStateHash,
      evidence: {
        tradeEventId: row.tradeEventId!,
        feeEventId: row.feeEventId!,
        blockHash: row.blockHash,
      },
    });
  }

  private activityFromSpaceChange(
    row: typeof spaceChanges.$inferSelect,
  ): ActivityItem | undefined {
    const change = spaceChangeSchema.parse({
      id: row.id,
      spaceId: row.spaceId,
      eventType: row.eventType,
      actor: row.actor,
      status: row.status,
      ...(row.receiptHash ? { receiptHash: row.receiptHash } : {}),
      payload: parse<Record<string, unknown>>(row.payloadJson),
      createdAt: row.createdAt,
    });
    const space = this.getSpace(change.spaceId);
    if (!space) return undefined;
    const operation =
      typeof change.payload.operation === "string" &&
      ["CREATE", "UPDATE", "ACTIVATE", "PAUSE", "RESUME"].includes(
        change.payload.operation,
      )
        ? (change.payload.operation as
            "CREATE" | "UPDATE" | "ACTIVATE" | "PAUSE" | "RESUME")
        : undefined;
    const state =
      typeof change.payload.state === "string" &&
      ["DRAFT", "PENDING", "ACTIVE", "PAUSED", "FAILED"].includes(
        change.payload.state,
      )
        ? (change.payload.state as
            "DRAFT" | "PENDING" | "ACTIVE" | "PAUSED" | "FAILED")
        : undefined;
    const type =
      change.eventType === "SPACE_PAUSED" ||
      change.eventType === "SPACE_RESUMED" ||
      change.eventType === "SPACE_DEPLOYMENT_FAILED"
        ? "TRADING_STATUS"
        : "RULE_CHANGE";
    const position = space.position;
    const status: ActivityStatus = change.status;
    return activityItemSchema.parse({
      id: hashBytes(`activity:space-change:${change.id}`),
      type,
      spaceId: change.spaceId,
      spaceName: space.identity.name,
      ...(position ? { positionId: position.id } : {}),
      chainId: space.identity.chainId,
      status,
      source: "SPACE_CHANGE",
      actor: change.actor,
      submittedAt: change.createdAt,
      occurredAt: change.createdAt,
      ...(status === "CONFIRMED" ? { confirmedAt: change.createdAt } : {}),
      ...(operation ? { operation } : {}),
      ...(state ? { state } : {}),
      eventType: change.eventType,
      ...(change.receiptHash
        ? { evidence: { receiptHash: change.receiptHash } }
        : { evidence: {} }),
      payload: change.payload,
    });
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
      this.applySettlementEvent(transaction, value, false);
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
      this.applySettlementEvent(transaction, value, true);
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
      // Older projections may have used the hash before the Space draft existed.
      // Remove that alias before inserting the canonical Space-scoped epoch.
      database
        .delete(capacityEpochs)
        .where(
          and(
            eq(capacityEpochs.capacityEpochId, String(payload.capacityEpochId)),
            eq(capacityEpochs.positionId, String(payload.positionIdHash)),
            ne(capacityEpochs.positionId, positionId),
          ),
        )
        .run();
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

  private applySettlementEvent(
    database: ServiceDrizzleDatabase,
    event: ProtocolEvent,
    orphaned: boolean,
  ): void {
    if (event.name !== "TradeExecuted" && event.name !== "FeesRouted") return;
    const payload = event.payload;
    const proposalHash = String(payload.proposalHash);
    const id = `${event.chainId}:${event.contract.toLowerCase()}:${event.transactionHash}:${proposalHash}`;
    const isTrade = event.name === "TradeExecuted";
    const positionId = isTrade
      ? this.resolvePositionId(database, String(payload.positionIdHash))
      : undefined;
    const values = {
      id,
      chainId: event.chainId,
      contract: event.contract.toLowerCase(),
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      proposalHash,
      positionIdHash: isTrade ? String(payload.positionIdHash) : null,
      positionId: positionId ?? null,
      intentHash: isTrade ? String(payload.intentHash) : null,
      tradeEventId: isTrade ? event.id : null,
      feeEventId: isTrade ? null : event.id,
      tradeJson: isTrade ? json(payload) : null,
      feeJson: isTrade ? null : json(payload),
      orphaned:
        orphaned ||
        (!orphaned &&
          this.hasRemovedSettlementLog(database, event, proposalHash)),
      observedAt: event.observedAt,
      updatedAt: now(),
    };
    database
      .insert(settlementRecords)
      .values(values)
      .onConflictDoUpdate({
        target: settlementRecords.id,
        set: isTrade
          ? {
              blockNumber: values.blockNumber,
              blockHash: values.blockHash,
              positionIdHash: values.positionIdHash,
              positionId: values.positionId,
              intentHash: values.intentHash,
              tradeEventId: values.tradeEventId,
              tradeJson: values.tradeJson,
              orphaned: values.orphaned,
              observedAt: values.observedAt,
              updatedAt: values.updatedAt,
            }
          : {
              blockNumber: values.blockNumber,
              blockHash: values.blockHash,
              feeEventId: values.feeEventId,
              feeJson: values.feeJson,
              orphaned: values.orphaned,
              observedAt: values.observedAt,
              updatedAt: values.updatedAt,
            },
      })
      .run();
  }

  private hasRemovedSettlementLog(
    database: ServiceDrizzleDatabase,
    event: ProtocolEvent,
    proposalHash: string,
  ): boolean {
    return database
      .select({
        removed: chainEvents.removed,
        payloadJson: chainEvents.payloadJson,
      })
      .from(chainEvents)
      .where(
        and(
          eq(chainEvents.chainId, event.chainId),
          eq(chainEvents.contract, event.contract.toLowerCase()),
          eq(chainEvents.transactionHash, event.transactionHash),
        ),
      )
      .all()
      .some(
        (row) =>
          row.removed &&
          String(
            parse<Record<string, unknown>>(row.payloadJson).proposalHash,
          ) === proposalHash,
      );
  }

  private resolvePositionId(
    database: ServiceDrizzleDatabase,
    positionIdHash: string,
  ): string {
    const position = database
      .select({ id: spaces.id })
      .from(spaces)
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
      const event = protocolEventSchema.parse({
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
      });
      this.applySettlementEvent(database, event, false);
      this.applyProjectedEvent(database, event);
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
      const orphanedRows = tx
        .select()
        .from(chainEvents)
        .where(eventCondition)
        .all();
      for (const row of orphanedRows) {
        if (row.name !== "TradeExecuted" && row.name !== "FeesRouted") continue;
        const event = protocolEventSchema.parse({
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
        });
        this.applySettlementEvent(tx, event, true);
      }
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
