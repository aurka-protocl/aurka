/* global fetch */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFilteredRpcServer } from "../scripts/filtered-rpc-proxy.mjs";

const servers = [];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(url, payload, init = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...init,
  });
  return { status: response.status, body: await response.json() };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("filtered hosted RPC", () => {
  it("forwards reads and raw signed transactions only", async () => {
    const upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(body).id,
          result: "0x1",
        }),
      );
    });
    const upstreamUrl = await listen(upstream);
    const proxy = createFilteredRpcServer({
      upstreamUrl,
      rateLimitPerMinute: 20,
      sendRateLimitPerMinute: 2,
    });
    const proxyUrl = await listen(proxy);

    await expect(
      request(proxyUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
    ).resolves.toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: "0x1" },
    });

    await expect(
      request(proxyUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendTransaction",
        params: [],
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: { code: -32601 } },
    });

    await expect(
      request(proxyUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "anvil_reset",
        params: [],
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: { code: -32601 } },
    });
  });

  it("rejects JSON-RPC batches before they reach the upstream", async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.end("{}");
    });
    const upstreamUrl = await listen(upstream);
    const proxy = createFilteredRpcServer({ upstreamUrl });
    const proxyUrl = await listen(proxy);

    const result = await request(proxyUrl, [
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    ]);
    expect(result.status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });
});
