import { describe, expect, it } from "vitest";

import {
  GraphClient,
  GraphSignalSource,
  graphMetaSchema,
  graphObservationPayloadHash,
  type GraphFetch,
} from "../src/index.js";
import { z } from "zod";

const HASH_1 = `0x${"01".repeat(32)}`;
const ADDRESS = `0x${"11".repeat(20)}`;

function response(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body };
}

function config() {
  return {
    endpoint: "https://gateway.example/graphql",
    apiKey: "server-only",
    chainId: 31337,
    deploymentId: "QmDeployment",
    schemaVersion: "aurka-v1",
    queryVersion: "observations-v1",
    timeoutMs: 1_000,
    attempts: 1,
    pageSize: 2,
    maxObservationAgeSeconds: 120,
    maxIndexedLagBlocks: 2,
  } as const;
}

function row(id: string) {
  return {
    id,
    signal: "DEX_LIQUIDITY" as const,
    metricValue: "10",
    sampleSize: "3",
    affectedAssets: [ADDRESS],
    observedAt: 100,
    indexedBlock: "1",
    indexedBlockHash: HASH_1,
    payload: { id, liquidity: "10" },
  };
}

describe("Graph signal source", () => {
  it("uses bearer auth, paginates by id, deduplicates, and preserves provenance", async () => {
    const requests: string[] = [];
    let page = 0;
    const fetcher: GraphFetch = async (_url, init) => {
      requests.push(init.headers.authorization ?? "");
      page += 1;
      return response({
        data: {
          observations:
            page === 1
              ? [row("a"), row("b")]
              : page === 2
                ? [row("b"), row("c")]
                : [],
          _meta: {
            deployment: "QmDeployment",
            hasIndexingErrors: false,
            block: { number: 1, hash: HASH_1 },
          },
        },
      });
    };
    const source = new GraphSignalSource(
      new GraphClient(config(), { fetch: fetcher, now: () => 110 }),
      "fixture-dex",
    );
    const observations = await source.fetchObservations({
      sourceId: "fixture-dex",
      sourceKind: "DEX_SUBGRAPH",
      nowSeconds: 110,
      canonical: {
        getChainId: async () => 31337,
        getLatestBlock: async () => 1n,
        getBlockHash: async () => HASH_1,
      },
      finalityBlock: 1n,
    });
    expect(observations.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(observations[0]).toMatchObject({
      sourceId: "fixture-dex",
      indexedBlockHash: HASH_1,
      finality: "FINAL",
      payloadHash: graphObservationPayloadHash(row("a").payload),
    });
    expect(requests).toEqual([
      "Bearer server-only",
      "Bearer server-only",
      "Bearer server-only",
    ]);
  });

  it("rejects GraphQL partial errors and noncanonical metadata", async () => {
    const partial: GraphFetch = async () =>
      response({
        data: { observations: [], _meta: {} },
        errors: [{ message: "partial" }],
      });
    const client = new GraphClient(config(), { fetch: partial });
    await expect(
      client.query("query", {}, (await import("zod")).z.unknown()),
    ).rejects.toThrow("partial");

    const source = new GraphSignalSource(
      new GraphClient(config(), {
        fetch: async () =>
          response({
            data: {
              observations: [row("a")],
              _meta: {
                deployment: "wrong",
                hasIndexingErrors: false,
                block: { number: 1, hash: HASH_1 },
              },
            },
          }),
      }),
      "fixture-dex",
    );
    await expect(
      source.fetchObservations({
        sourceId: "fixture-dex",
        sourceKind: "FIXTURE",
        finalityBlock: 1n,
        nowSeconds: 110,
        canonical: {
          getChainId: async () => 31337,
          getLatestBlock: async () => 1n,
          getBlockHash: async () => HASH_1,
        },
      }),
    ).rejects.toThrow("deployment mismatch");
  });

  it("bounds retries for rate limits, transport failures, and malformed data", async () => {
    let attempts = 0;
    const client = new GraphClient(
      { ...config(), attempts: 2 },
      {
        fetch: async () => {
          attempts += 1;
          if (attempts === 1) return response({}, 429);
          return response({
            data: {
              _meta: {
                deployment: "QmDeployment",
                hasIndexingErrors: false,
                block: { number: 1, hash: HASH_1 },
              },
            },
          });
        },
      },
    );
    await expect(
      client.query("query", {}, z.object({ _meta: graphMetaSchema }).strict()),
    ).resolves.toMatchObject({ meta: { deployment: "QmDeployment" } });
    expect(attempts).toBe(2);

    const malformed = new GraphClient(config(), {
      fetch: async () =>
        response({
          data: {
            observations: [{ id: "missing-fields" }],
            _meta: {
              deployment: "QmDeployment",
              hasIndexingErrors: false,
              block: { number: 1, hash: HASH_1 },
            },
          },
        }),
    });
    await expect(
      new GraphSignalSource(malformed, "fixture-dex").fetchObservations({
        sourceId: "fixture-dex",
        sourceKind: "FIXTURE",
        finalityBlock: 1n,
        nowSeconds: 110,
        canonical: {
          getChainId: async () => 31337,
          getLatestBlock: async () => 1n,
          getBlockHash: async () => HASH_1,
        },
      }),
    ).rejects.toThrow("Graph query failed");
  });
});

it("requires finality proof and rejects rows newer than metadata", async () => {
  const source = new GraphSignalSource(
    new GraphClient(config(), {
      fetch: async () =>
        response({
          data: {
            observations: [{ ...row("a"), indexedBlock: "2" }],
            _meta: {
              deployment: "QmDeployment",
              hasIndexingErrors: false,
              block: { number: 1, hash: HASH_1 },
            },
          },
        }),
    }),
    "test",
  );
  const options = {
    sourceId: "test",
    sourceKind: "AURKA_SUBGRAPH" as const,
    nowSeconds: 110,
    canonical: {
      getChainId: async () => 31337,
      getLatestBlock: async () => 2n,
      getBlockHash: async () => HASH_1,
    },
  };
  await expect(source.fetchObservations(options)).rejects.toThrow(
    "finality block",
  );
  await expect(
    source.fetchObservations({ ...options, finalityBlock: 1n }),
  ).rejects.toThrow("exceeds metadata");
});

it("normalizes real Uniswap v4 hourly fields using integer units", async () => {
  const poolId = `0x${"22".repeat(32)}`,
    pool = {
      id: poolId,
      token0: { id: ADDRESS },
      token1: { id: `0x${"33".repeat(20)}` },
    };
  const client = new GraphClient(
    { ...config(), maxObservationAgeSeconds: 3600 },
    {
      fetch: async (_url, init) => {
        expect(init.body).toContain("poolHourDatas");
        return response({
          data: {
            _meta: {
              deployment: "QmDeployment",
              hasIndexingErrors: false,
              block: { number: 1, hash: HASH_1 },
            },
            poolHourDatas: [
              {
                id: "current",
                periodStartUnix: 3600,
                liquidity: "80",
                volumeUSD: "12.3456789",
                txCount: "10",
                pool,
              },
              {
                id: "previous",
                periodStartUnix: 0,
                liquidity: "100",
                volumeUSD: "10",
                txCount: "10",
                pool,
              },
            ],
          },
        });
      },
    },
  );
  const { UniswapV4SignalSource } = await import("../src/uniswap-v4.js");
  const observations = await new UniswapV4SignalSource(
    client,
    poolId,
  ).fetchObservations({
    sourceId: "uniswap-v4",
    sourceKind: "DEX_SUBGRAPH",
    nowSeconds: 7300,
    finalityBlock: 1n,
    canonical: {
      getChainId: async () => 31337,
      getLatestBlock: async () => 1n,
      getBlockHash: async () => HASH_1,
    },
  });
  expect(observations.map((o) => o.metricValue)).toEqual(["-2000", "12345678"]);
});
