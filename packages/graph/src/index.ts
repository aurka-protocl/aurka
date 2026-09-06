import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uintSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const graphConfigSchema = z
  .object({
    endpoint: z.string().url(),
    apiKey: z.string().min(1).optional(),
    chainId: z.number().int().positive().safe(),
    deploymentId: z.string().min(1).max(128),
    schemaVersion: z.string().min(1).max(32),
    queryVersion: z.string().min(1).max(32),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    attempts: z.number().int().positive().max(5).default(3),
    pageSize: z.number().int().positive().max(1_000).default(100),
    maxObservationAgeSeconds: z.number().int().positive().safe(),
    maxIndexedLagBlocks: z.number().int().nonnegative().safe(),
  })
  .strict();

export type GraphConfig = z.infer<typeof graphConfigSchema>;

export const graphMetaSchema = z
  .object({
    deployment: z.string().min(1),
    hasIndexingErrors: z.boolean(),
    block: z
      .object({
        number: z.number().int().nonnegative().safe(),
        hash: bytes32Schema,
        timestamp: z.number().int().nonnegative().safe().optional(),
      })
      .strict(),
  })
  .strict();

export type GraphMeta = z.infer<typeof graphMetaSchema>;

export const graphObservationRowSchema = z
  .object({
    id: z.string().min(1),
    signal: z.enum([
      "DEX_LIQUIDITY",
      "DEX_VOLUME",
      "DIRECTIONAL_FLOW",
      "AURKA_EXECUTIONS",
      "AURKA_REVERTS",
      "BOUNDARY_PRESSURE",
    ]),
    metricValue: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
    sampleSize: uintSchema,
    affectedAssets: z.array(addressSchema),
    observedAt: z.number().int().nonnegative().safe(),
    indexedBlock: uintSchema,
    indexedBlockHash: bytes32Schema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type GraphObservationRow = z.infer<typeof graphObservationRowSchema>;

export interface RiskObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: "AURKA_SUBGRAPH" | "DEX_SUBGRAPH" | "FIXTURE";
  readonly chainId: number;
  readonly deploymentId: string;
  readonly schemaVersion: string;
  readonly queryVersion: string;
  readonly signal: GraphObservationRow["signal"];
  readonly metricValue: string;
  readonly sampleSize: string;
  readonly affectedAssets: readonly string[];
  readonly indexedBlock: string;
  readonly indexedBlockHash: string;
  readonly observedAt: number;
  readonly retrievedAt: number;
  readonly finality: "FINAL" | "SAFE" | "UNFINALIZED";
  readonly payloadHash: string;
  readonly payload: Record<string, unknown>;
}

export interface GraphQueryResponse<T> {
  readonly data: T;
  readonly meta: GraphMeta;
  readonly retrievedAt: number;
}

export interface GraphFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type GraphFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<GraphFetchResponse>;

export interface CanonicalChainReader {
  getLatestBlock(): Promise<bigint>;
  getBlockHash(blockNumber: bigint): Promise<string | undefined>;
}

export interface GraphClientOptions {
  readonly fetch?: GraphFetch;
  readonly now?: () => number;
}

interface GraphEnvelope<T> {
  readonly data?: T;
  readonly errors?: readonly { readonly message?: string }[];
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }
    return item;
  });
}

function payloadHash(value: unknown): string {
  return `0x${Array.from(
    keccak_256(new TextEncoder().encode(canonical(value))),
    (item) => item.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Graph request failed";
}

export class GraphClient {
  private readonly fetcher: GraphFetch;
  private readonly now: () => number;
  private readonly config: GraphConfig;

  constructor(config: GraphConfig, options: GraphClientOptions = {}) {
    this.config = graphConfigSchema.parse(config);
    this.fetcher = options.fetch ?? (fetch as unknown as GraphFetch);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async query<T>(
    query: string,
    variables: Record<string, unknown>,
    dataSchema: z.ZodType<T>,
  ): Promise<GraphQueryResponse<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.config.attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (this.config.apiKey !== undefined)
          headers.authorization = `Bearer ${this.config.apiKey}`;
        const response = await this.fetcher(this.config.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500)
            throw new Error(`Retryable Graph HTTP ${response.status}`);
          throw new Error(`Graph HTTP ${response.status}`);
        }
        const envelope = (await response.json()) as GraphEnvelope<unknown>;
        if (envelope.errors && envelope.errors.length > 0) {
          throw new Error(
            envelope.errors
              .map((error) => error.message ?? "GraphQL error")
              .join("; "),
          );
        }
        if (envelope.data === undefined)
          throw new Error("Malformed GraphQL response: missing data");
        const data = dataSchema.parse(envelope.data);
        const meta = graphMetaSchema.parse(
          (data as Record<string, unknown>)._meta,
        );
        return { data, meta, retrievedAt: this.now() };
      } catch (error) {
        lastError = error;
        if (attempt + 1 < this.config.attempts)
          await sleep(Math.min(250 * 2 ** attempt, 2_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Graph query failed: ${errorText(lastError)}`);
  }

  getConfig(): GraphConfig {
    return this.config;
  }
}

const observationsResponseSchema = z
  .object({
    _meta: graphMetaSchema,
    observations: z.array(graphObservationRowSchema),
  })
  .strict();

const OBSERVATIONS_QUERY = `query AurkaRiskObservations($first: Int!, $lastId: ID!) {
  observations(first: $first, where: { id_gt: $lastId }, orderBy: id, orderDirection: asc) {
    id signal metricValue sampleSize affectedAssets observedAt indexedBlock indexedBlockHash payload
  }
  _meta { deployment hasIndexingErrors block { number hash timestamp } }
}`;

export interface ObservationQueryOptions {
  readonly sourceId: string;
  readonly sourceKind: RiskObservation["sourceKind"];
  readonly nowSeconds: number;
  readonly canonical: CanonicalChainReader;
  readonly finalityBlock?: bigint;
}

export class GraphSignalSource {
  constructor(
    private readonly client: GraphClient,
    private readonly sourceId: string,
  ) {}

  async fetchObservations(
    options: ObservationQueryOptions,
  ): Promise<readonly RiskObservation[]> {
    const config = this.client.getConfig();
    if (options.sourceId !== this.sourceId)
      throw new Error("Graph source identifier mismatch");
    const result: RiskObservation[] = [];
    const seen = new Set<string>();
    let lastId = "";
    for (;;) {
      const page = await this.client.query(
        OBSERVATIONS_QUERY,
        { first: config.pageSize, lastId },
        observationsResponseSchema,
      );
      if (page.meta.deployment !== config.deploymentId)
        throw new Error("Graph deployment mismatch");
      if (page.meta.hasIndexingErrors)
        throw new Error("Graph subgraph reports indexing errors");
      const chainLatest = await options.canonical.getLatestBlock();
      const indexedBlock = BigInt(page.meta.block.number);
      if (indexedBlock > chainLatest)
        throw new Error("Graph index is ahead of the canonical chain");
      if (chainLatest - indexedBlock > BigInt(config.maxIndexedLagBlocks))
        throw new Error("Graph index is outside the configured lag bound");
      if (
        options.finalityBlock !== undefined &&
        indexedBlock > options.finalityBlock
      )
        throw new Error("Graph result is not final");
      const canonicalMetaHash =
        await options.canonical.getBlockHash(indexedBlock);
      if (
        canonicalMetaHash === undefined ||
        canonicalMetaHash.toLowerCase() !== page.meta.block.hash.toLowerCase()
      )
        throw new Error("Graph metadata block is not canonical");

      let added = 0;
      for (const row of page.data.observations) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        added += 1;
        const rowBlock = BigInt(row.indexedBlock);
        if (rowBlock > chainLatest)
          throw new Error("Graph observation is from the future");
        if (chainLatest - rowBlock > BigInt(config.maxIndexedLagBlocks))
          throw new Error("Graph observation is stale");
        const rowHash = await options.canonical.getBlockHash(rowBlock);
        if (
          rowHash === undefined ||
          rowHash.toLowerCase() !== row.indexedBlockHash.toLowerCase()
        )
          throw new Error(`Graph observation ${row.id} is reorged`);
        if (options.nowSeconds < row.observedAt)
          throw new Error(`Graph observation ${row.id} is from the future`);
        if (
          options.nowSeconds - row.observedAt >
          config.maxObservationAgeSeconds
        )
          throw new Error(`Graph observation ${row.id} is stale`);
        result.push({
          ...row,
          sourceId: options.sourceId,
          sourceKind: options.sourceKind,
          chainId: config.chainId,
          deploymentId: config.deploymentId,
          schemaVersion: config.schemaVersion,
          queryVersion: config.queryVersion,
          retrievedAt: options.nowSeconds,
          finality:
            options.finalityBlock !== undefined &&
            rowBlock <= options.finalityBlock
              ? "FINAL"
              : "SAFE",
          payloadHash: payloadHash(row.payload),
        });
      }
      if (added === 0 || added < config.pageSize) break;
      if (page.data.observations.length < config.pageSize) break;
      const nextId = page.data.observations.at(-1)?.id;
      if (nextId === undefined || nextId === lastId) break;
      lastId = nextId;
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }
}

export interface DexSignalAdapter<T> {
  readonly sourceId: string;
  normalize(
    input: T,
    context: { readonly indexedBlock: bigint; readonly retrievedAt: number },
  ): RiskObservation;
}

/** Normalizes one deployment-specific Graph row without erasing its source. */
export class GraphObservationAdapter implements DexSignalAdapter<GraphObservationRow> {
  constructor(
    readonly sourceId: string,
    private readonly sourceKind: RiskObservation["sourceKind"],
    private readonly config: Pick<
      GraphConfig,
      "chainId" | "deploymentId" | "schemaVersion" | "queryVersion"
    >,
  ) {}

  normalize(
    input: GraphObservationRow,
    context: { readonly indexedBlock: bigint; readonly retrievedAt: number },
  ): RiskObservation {
    return {
      ...input,
      sourceId: this.sourceId,
      sourceKind: this.sourceKind,
      chainId: this.config.chainId,
      deploymentId: this.config.deploymentId,
      schemaVersion: this.config.schemaVersion,
      queryVersion: this.config.queryVersion,
      retrievedAt: context.retrievedAt,
      finality: "FINAL",
      payloadHash: payloadHash(input.payload),
    };
  }
}

/** Initial fixture DEX adapter; live DEX schemas remain explicit per deployment. */
export class FixtureDexSignalAdapter extends GraphObservationAdapter {
  constructor(
    sourceId: string,
    config: Pick<
      GraphConfig,
      "chainId" | "deploymentId" | "schemaVersion" | "queryVersion"
    >,
  ) {
    super(sourceId, "FIXTURE", config);
  }
}

/** Protocol events use the same provenance contract but a separate source kind. */
export class AurkaProtocolSignalAdapter extends GraphObservationAdapter {
  constructor(
    sourceId: string,
    config: Pick<
      GraphConfig,
      "chainId" | "deploymentId" | "schemaVersion" | "queryVersion"
    >,
  ) {
    super(sourceId, "AURKA_SUBGRAPH", config);
  }
}

export const graphObservationPayloadHash = payloadHash;
