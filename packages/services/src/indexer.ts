import { z } from "zod";

import {
  decodeProtocolEventLog,
  parseProtocolEventPayload,
  protocolEventNameSchema,
  protocolEventSchema,
} from "@aurka/shared";
import type { ProtocolEvent } from "@aurka/shared";

import type { ServiceRepository } from "./db/repository.js";
import { retryBounded } from "./observability.js";

export const chainLogSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    logIndex: z.number().int().nonnegative(),
    name: protocolEventNameSchema,
    payload: z.record(z.string(), z.unknown()),
    topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).optional(),
    data: z
      .string()
      .regex(/^0x[0-9a-fA-F]*$/)
      .optional(),
    observedAt: z.number().int().nonnegative().safe(),
    removed: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.topics === undefined) !== (value.data === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "topics and data must be supplied together",
        path: ["topics"],
      });
    }
  });

export type ChainLog = z.infer<typeof chainLogSchema>;

export interface ChainLogSource {
  getLogs(input: {
    readonly chainId: number;
    readonly contract: string;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly ChainLog[]>;
  getLatestBlock(): Promise<bigint>;
}

export interface IndexResult {
  readonly inserted: number;
  readonly removed: number;
  readonly checkpoint:
    { readonly blockNumber: string; readonly blockHash: string } | undefined;
}

/**
 * Reorg-safe event projector. Logs are keyed by chain/contract/tx/log index;
 * replaying the same range is therefore idempotent. Removed logs trigger a
 * transactional rebuild of derived capacity state from remaining raw events.
 */
export class ChainEventIndexer {
  constructor(private readonly repository: ServiceRepository) {}

  ingest(logs: readonly ChainLog[]): IndexResult {
    let inserted = 0;
    let removed = 0;
    let checkpoint: { blockNumber: string; blockHash: string } | undefined;
    for (const raw of logs) {
      const log = chainLogSchema.parse(raw);
      const event = this.toProtocolEvent(log);
      if (log.removed) {
        this.repository.projectRemovedLog(event);
        removed += 1;
      } else {
        this.repository.projectEvent(event);
        inserted += 1;
        checkpoint = { blockNumber: log.blockNumber, blockHash: log.blockHash };
        this.repository.setCheckpoint(
          log.chainId,
          log.contract,
          log.blockNumber,
          log.blockHash,
        );
      }
    }
    return { inserted, removed, checkpoint };
  }

  async sync(
    source: ChainLogSource,
    chainId: number,
    contract: string,
    confirmations = 0,
  ): Promise<IndexResult> {
    if (!Number.isInteger(confirmations) || confirmations < 0)
      throw new RangeError("Confirmations must be non-negative");
    const latest = await source.getLatestBlock();
    const toBlock = latest - BigInt(confirmations);
    if (toBlock < 0n) return { inserted: 0, removed: 0, checkpoint: undefined };
    const checkpoint = this.repository.getCheckpoint(chainId, contract);
    const fromBlock = checkpoint ? BigInt(checkpoint.blockNumber) + 1n : 0n;
    if (fromBlock > toBlock)
      return { inserted: 0, removed: 0, checkpoint: undefined };
    const logs = await retryBounded(() =>
      source.getLogs({ chainId, contract, fromBlock, toBlock }),
    );
    return this.ingest(
      [...logs].sort((left, right) =>
        BigInt(left.blockNumber) === BigInt(right.blockNumber)
          ? left.logIndex - right.logIndex
          : BigInt(left.blockNumber) < BigInt(right.blockNumber)
            ? -1
            : 1,
      ),
    );
  }

  replay(events: readonly ProtocolEvent[]): IndexResult {
    return this.ingest(
      events.map((event) => ({
        chainId: event.chainId,
        contract: event.contract,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        name: event.name,
        payload: event.payload,
        observedAt: event.observedAt,
        removed: false,
      })),
    );
  }

  private toProtocolEvent(log: ChainLog): ProtocolEvent {
    return protocolEventSchema.parse({
      id: `${log.chainId}:${log.contract.toLowerCase()}:${log.transactionHash}:${log.logIndex}`,
      name: log.name,
      chainId: log.chainId,
      contract: log.contract,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      blockHash: log.blockHash,
      observedAt: log.observedAt,
      payload:
        log.topics && log.data
          ? decodeProtocolEventLog(log.name, log.topics, log.data)
          : parseProtocolEventPayload(log.name, log.payload),
    });
  }
}
