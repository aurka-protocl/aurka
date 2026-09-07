import { z } from "zod";
import {
  type GraphClient,
  graphMetaSchema,
  graphObservationPayloadHash,
  type ObservationQueryOptions,
  type RiskObservation,
} from "./index.js";
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hour = z.object({
  id: z.string(),
  periodStartUnix: z.number().int().nonnegative().safe(),
  liquidity: uint,
  volumeUSD: z.string().regex(/^\d+(\.\d+)?$/),
  txCount: uint,
  pool: z.object({
    id: z.string(),
    token0: z.object({ id: address }),
    token1: z.object({ id: address }),
  }),
});
const QUERY = `query AurkaUniswapV4Hours($pool: String!, $before: Int!, $block: Int!) {
 poolHourDatas(first: 2, orderBy: periodStartUnix, orderDirection: desc, where: {pool: $pool, periodStartUnix_lt: $before}, block: {number: $block}) {
  id periodStartUnix liquidity volumeUSD txCount pool { id token0 { id } token1 { id } }
 }
 _meta(block: {number: $block}) { deployment hasIndexingErrors block {number hash timestamp} }
}`;
function usdMicros(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1000000n + BigInt((fraction + "000000").slice(0, 6));
}
/** Uniswap v4 PoolHourData schema; deployments and pools are explicit operator configuration. */
export class UniswapV4SignalSource {
  constructor(
    private readonly client: GraphClient,
    private readonly poolId: string,
  ) {
    z.string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .parse(poolId);
  }
  async fetchObservations(
    options: ObservationQueryOptions,
  ): Promise<readonly RiskObservation[]> {
    const config = this.client.getConfig(),
      block = options.finalityBlock;
    if (block === undefined || block < 0n || block > BigInt(2147483647))
      throw new Error("A bounded finalized block is required");
    if ((await options.canonical.getChainId()) !== config.chainId)
      throw new Error("DEX chain mismatch");
    const latest = await options.canonical.getLatestBlock();
    if (latest < block || latest - block > BigInt(config.maxIndexedLagBlocks))
      throw new Error("DEX finality lag exceeds configured bound");
    const canonicalHash = await options.canonical.getBlockHash(block);
    const before = options.nowSeconds - (options.nowSeconds % 3600);
    const page = await this.client.query(
      QUERY,
      { pool: this.poolId.toLowerCase(), before, block: Number(block) },
      z.object({
        _meta: graphMetaSchema,
        poolHourDatas: z.array(hour).length(2),
      }),
    );
    if (
      page.meta.deployment !== config.deploymentId ||
      page.meta.hasIndexingErrors ||
      BigInt(page.meta.block.number) !== block ||
      page.meta.block.hash.toLowerCase() !== canonicalHash?.toLowerCase()
    )
      throw new Error("DEX metadata is not canonical");
    const [current, previous] = page.data.poolHourDatas;
    if (
      !current ||
      !previous ||
      current.periodStartUnix - previous.periodStartUnix !== 3600 ||
      current.periodStartUnix >= before ||
      current.pool.id.toLowerCase() !== this.poolId.toLowerCase() ||
      previous.pool.id.toLowerCase() !== this.poolId.toLowerCase()
    )
      throw new Error(
        "DEX evidence requires consecutive completed hours for the configured pool",
      );
    const observedAt = current.periodStartUnix + 3600;
    if (options.nowSeconds - observedAt > config.maxObservationAgeSeconds)
      throw new Error("DEX evidence is stale");
    if (
      (await options.canonical.getBlockHash(block))?.toLowerCase() !==
      canonicalHash?.toLowerCase()
    )
      throw new Error("DEX block changed during query");
    const oldLiquidity = BigInt(previous.liquidity);
    if (oldLiquidity === 0n)
      throw new Error("DEX liquidity baseline is unavailable");
    const payload = { current, previous };
    const base = {
      sourceId: options.sourceId,
      sourceKind: "DEX_SUBGRAPH" as const,
      chainId: config.chainId,
      deploymentId: config.deploymentId,
      schemaVersion: "uniswap-v4-pool-hour-v1",
      queryVersion: "completed-hours-v1",
      sampleSize: current.txCount,
      affectedAssets: [current.pool.token0.id, current.pool.token1.id],
      indexedBlock: block.toString(),
      indexedBlockHash: canonicalHash!,
      observedAt,
      retrievedAt: options.nowSeconds,
      finality: "FINAL" as const,
      payloadHash: graphObservationPayloadHash(payload),
      payload,
    };
    return [
      {
        ...base,
        id: `${current.id}:liquidity`,
        signal: "DEX_LIQUIDITY",
        metricValue: (
          ((BigInt(current.liquidity) - oldLiquidity) * 10000n) /
          oldLiquidity
        ).toString(),
      },
      {
        ...base,
        id: `${current.id}:volume`,
        signal: "DEX_VOLUME",
        metricValue: usdMicros(current.volumeUSD).toString(),
      },
    ];
  }
}
