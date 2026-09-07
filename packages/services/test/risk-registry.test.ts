import { expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { createRegistryRiskReader } from "../src/risk-registry.js";
const registry = `0x${"11".repeat(20)}` as const;
const policyRegistry = `0x${"22".repeat(20)}` as const;
const token = `0x${"33".repeat(20)}` as const;
const hash = `0x${"aa".repeat(32)}`;
const abi = parseAbi([
  "function assets(bytes32 policyId) view returns (address[])",
  "function currentRiskMode(bytes32 policyId) view returns (uint8)",
  "function effectiveMaximumTradeValue(bytes32 policyId) view returns (uint256)",
  "function effectiveAssetBound(bytes32 policyId,address token) view returns ((address token,uint16 minimumWeightBps,uint16 maximumWeightBps,bool paused))",
]);
it("reads registry limits at one canonical finalized block and fails closed on stale or wrong-chain RPC", async () => {
  let chain = "0x7a69",
    timestamp = "0xc8";
  const reader = createRegistryRiskReader({
    registry,
    policyRegistry,
    chainId: 31337,
    maximumAgeSeconds: 30,
    now: () => 200,
    rpc: {
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return chain;
        if (method === "eth_getBlockByNumber") {
          expect(params).toEqual(["finalized", false]);
          return { number: "0x64", hash, timestamp };
        }
        expect(params?.[1]).toEqual({
          blockHash: hash,
          requireCanonical: true,
        });
        const call = params?.[0] as { to: string; data: `0x${string}` };
        const decoded = decodeFunctionData({ abi, data: call.data });
        if (decoded.functionName === "assets") {
          expect(call.to).toBe(policyRegistry);
          return encodeFunctionResult({
            abi,
            functionName: "assets",
            result: [token],
          });
        }
        expect(call.to).toBe(registry);
        if (decoded.functionName === "currentRiskMode")
          return encodeFunctionResult({
            abi,
            functionName: "currentRiskMode",
            result: 1,
          });
        if (decoded.functionName === "effectiveMaximumTradeValue")
          return encodeFunctionResult({
            abi,
            functionName: "effectiveMaximumTradeValue",
            result: 75n,
          });
        return encodeFunctionResult({
          abi,
          functionName: "effectiveAssetBound",
          result: {
            token,
            minimumWeightBps: 0,
            maximumWeightBps: 10000,
            paused: false,
          },
        });
      },
    },
  });
  const policyId = `0x${"bb".repeat(32)}`;
  expect(await reader("position", policyId)).toMatchObject({
    source: "REGISTRY",
    mode: "CAUTIOUS",
    maximumTradeValue: "75",
    observedAt: 200,
  });
  timestamp = "0x1";
  expect((await reader("position", policyId)).source).toBe("UNAVAILABLE");
  timestamp = "0xc8";
  chain = "0x1";
  expect((await reader("position", policyId)).source).toBe("UNAVAILABLE");
});

it("reports failed RPC readiness and publishes concrete OpenAPI contracts", async () => {
  const { AurkaService } = await import("../src/service.js");
  const { createApiServer, listenApiServer, closeApiServer } =
    await import("../src/api/server.js");
  const service = new AurkaService({
    rpcTransport: { request: async () => "0x1" },
  });
  const handle = createApiServer({ service });
  await listenApiServer(handle, 0);
  const address = handle.server.address();
  if (!address || typeof address === "string")
    throw new Error("No listening port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/ready`);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { status: "not_ready", rpc: "error", indexerLagBlocks: null },
    });
    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<
        string,
        {
          post?: { requestBody: unknown; responses: Record<string, unknown> };
          get?: { parameters: unknown[] };
        }
      >;
    };
    expect(spec.paths["/v1/execute"]?.post).toMatchObject({
      requestBody: { required: true },
      responses: {
        "202": {
          content: {
            "application/json": {
              schema: {
                oneOf: expect.arrayContaining([
                  expect.objectContaining({
                    type: "object",
                    properties: expect.objectContaining({
                      ok: expect.any(Object),
                      data: expect.any(Object),
                    }),
                  }),
                ]),
              },
            },
          },
        },
      },
    });
    expect(spec.paths["/v1/positions/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  } finally {
    await closeApiServer(handle);
  }
});

it("uses a renewable current-time snapshot for the local demo and expires prepared intents", async () => {
  const { LocalDemoProvider, createCanonicalFixture } =
    await import("../src/fixture.js");
  let now = 1000;
  const provider = new LocalDemoProvider(() => now);
  const { AurkaService } = await import("../src/service.js");
  const service = new AurkaService({ provider });
  const fixture = createCanonicalFixture();
  const input = {
    positionId: fixture.snapshot.positionId,
    trader: fixture.intent.trader,
    traderInputToken: fixture.intent.traderInputToken,
    traderOutputToken: fixture.intent.traderOutputToken,
    requestedValue: "10000",
    minimumTraderOutputValue: "0",
    nonce: "4",
    deadline: 2000,
  };
  const intent = await provider.prepareIntent(input);
  expect(intent.deadline).toBe(1060);
  expect((await provider.getSnapshot(intent)).priceProtection.nowSeconds).toBe(
    1000,
  );
  now = 1061;
  await expect(provider.getSnapshot(intent)).rejects.toThrow("expired");
  const next = await provider.prepareIntent({ ...input, nonce: "5" });
  expect(next.deadline).toBe(1121);
  try {
    expect(
      (
        await service.getCapacity(
          input.positionId,
          input.traderInputToken,
          input.traderOutputToken,
        )
      ).expiresAt,
    ).toBe(1121);
  } finally {
    service.close();
  }
  expect((await provider.getSnapshot(next)).priceProtection.nowSeconds).toBe(
    1061,
  );
});
