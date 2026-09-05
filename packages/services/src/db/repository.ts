import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";

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
} from "@aurka/shared";

import {
  capacityEpochs,
  chainEvents,
  executions,
  agentIdentities,
  idempotencyKeys,
  indexingCheckpoints,
  intents,
  managedAssets,
  policies,
  positions,
  proposals,
  quotes,
  riskCertificates,
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

export interface StoredIdempotencyResponse {
  readonly statusCode: number;
  readonly body: unknown;
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
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: riskCertificates.hash,
        set: { certificateJson: json(certificate), active, updatedAt: now() },
      })
      .run();
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
    simulationStatus: string,
  ): void {
    const value = atomicSettlementProposalSchema.parse(proposal);
    const timestamp = now();
    this.db
      .insert(proposals)
      .values({
        proposalHash,
        intentHash: value.intentHash,
        solver: value.solver,
        status: simulationStatus === "SUCCEEDED" ? "EXECUTABLE" : "REJECTED",
        simulationStatus,
        proposalJson: json(value),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: proposals.proposalHash,
        set: {
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
        row.simulationStatus === "SUCCEEDED"
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
      throw new Error("Idempotency key was reused for another request");
    return { statusCode: row.statusCode, body: parse(row.responseJson) };
  }

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
          contract: value.contract,
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
            eq(chainEvents.contract, value.contract),
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

  setCheckpoint(
    chainId: number,
    contract: string,
    blockNumber: string,
    blockHash: string,
  ): void {
    this.db
      .insert(indexingCheckpoints)
      .values({ chainId, contract, blockNumber, blockHash, updatedAt: now() })
      .onConflictDoUpdate({
        target: [indexingCheckpoints.chainId, indexingCheckpoints.contract],
        set: { blockNumber, blockHash, updatedAt: now() },
      })
      .run();
  }

  getCheckpoint(chainId: number, contract: string) {
    return this.db
      .select()
      .from(indexingCheckpoints)
      .where(
        and(
          eq(indexingCheckpoints.chainId, chainId),
          eq(indexingCheckpoints.contract, contract),
        ),
      )
      .get();
  }
}
