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
  /** Returns the canonical block hash for the given block number, or undefined if not found. */
  getBlockHash(blockNumber: bigint): Promise<string | undefined>;
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

    // Reorg detection: verify the stored checkpoint block hash against canonical chain.
    if (checkpoint) {
      const canonicalHash = await source.getBlockHash(
        BigInt(checkpoint.blockNumber),
      );
      if (canonicalHash === undefined)
        throw new Error(
          "Unable to verify indexing checkpoint on canonical chain",
        );
      if (canonicalHash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
        // Walk the retained canonical headers until an actual common
        // ancestor is found. Falling back to -1 is safe for databases created
        // before header retention was introduced: replaying from genesis
        // cannot preserve an orphaned branch.
        let ancestorBlock = -1n;
        let ancestorHash: string | undefined;
        for (
          let candidate = BigInt(checkpoint.blockNumber) - 1n;
          candidate >= 0n;
          candidate -= 1n
        ) {
          const stored = this.repository.getIndexedHeader(
            chainId,
            contract,
            candidate,
          );
          if (!stored) continue;
          const candidateHash = await source.getBlockHash(candidate);
          if (
            candidateHash !== undefined &&
            candidateHash.toLowerCase() === stored.blockHash.toLowerCase()
          ) {
            ancestorBlock = candidate;
            ancestorHash = candidateHash;
            break;
          }
        }
        this.repository.rollbackToBlock(
          chainId,
          contract,
          ancestorBlock,
          ancestorHash,
        );
        return this.sync(source, chainId, contract, confirmations);
      }
    }

    const fromBlock = checkpoint ? BigInt(checkpoint.blockNumber) + 1n : 0n;
    if (fromBlock > toBlock) {
      return {
        inserted: 0,
        removed: 0,
        checkpoint: checkpoint
          ? {
              blockNumber: checkpoint.blockNumber,
              blockHash: checkpoint.blockHash,
            }
          : undefined,
      };
    }
    const logs = await retryBounded(() =>
      source.getLogs({ chainId, contract, fromBlock, toBlock }),
    );
    const headers: { blockNumber: string; blockHash: string }[] = [];
    const headerHashes = new Map<string, string>();
    for (let block = fromBlock; block <= toBlock; block += 1n) {
      const blockHash = await source.getBlockHash(block);
      if (blockHash === undefined)
        throw new Error(
          `Unable to verify canonical block ${block.toString()} for indexing`,
        );
      if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash))
        throw new Error(`Invalid canonical block hash at ${block.toString()}`);
      const blockNumber = block.toString();
      const normalizedHash = blockHash.toLowerCase();
      headers.push({ blockNumber, blockHash: normalizedHash });
      headerHashes.set(blockNumber, normalizedHash);
    }

    const normalizedContract = contract.toLowerCase();
    const validatedLogs = logs.map((raw) => chainLogSchema.parse(raw));
    for (const log of validatedLogs) {
      const logBlock = BigInt(log.blockNumber);
      if (log.chainId !== chainId)
        throw new Error(
          `Fetched log chain ${log.chainId} does not match ${chainId}`,
        );
      if (log.contract.toLowerCase() !== normalizedContract)
        throw new Error("Fetched log contract does not match the index target");
      if (logBlock < fromBlock || logBlock > toBlock)
        throw new Error("Fetched log is outside the requested canonical range");
      const canonicalHash = headerHashes.get(log.blockNumber);
      if (
        canonicalHash === undefined ||
        canonicalHash !== log.blockHash.toLowerCase()
      )
        throw new Error(
          `Fetched log block hash does not match canonical block ${log.blockNumber}`,
        );
      // Decode the event before writing headers or projections. This keeps a
      // malformed fetched batch from advancing the checkpoint.
      this.toProtocolEvent(log);
    }
    this.repository.saveIndexedHeaders(chainId, contract, headers);
    const result = this.ingest(
      [...validatedLogs].sort((left, right) =>
        BigInt(left.blockNumber) === BigInt(right.blockNumber)
          ? left.logIndex - right.logIndex
          : BigInt(left.blockNumber) < BigInt(right.blockNumber)
            ? -1
            : 1,
      ),
    );
    // Always advance to a verified block. This prevents both empty ranges and
    // ranges whose last event predates `toBlock` from being rescanned.
    const rangeHash = headers.find(
      (header) => header.blockNumber === toBlock.toString(),
    )?.blockHash;
    if (rangeHash) {
      this.repository.setCheckpoint(
        chainId,
        contract,
        toBlock.toString(),
        rangeHash,
      );
    }
    return {
      ...result,
      checkpoint:
        rangeHash === undefined
          ? result.checkpoint
          : { blockNumber: toBlock.toString(), blockHash: rangeHash },
    };
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
