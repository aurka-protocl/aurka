/* global setTimeout */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PersistentEpochEventStore,
  RpcRequestCoordinator,
  RpcRateLimitedError,
} from "../scripts/sepolia-rpc-recovery.mjs";

const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] },
  json: async () => body,
});

describe("Sepolia RPC recovery", () => {
  it("shares identical reads and invalidates cached heads after writes", async () => {
    let calls = 0;
    const coordinator = new RpcRequestCoordinator({
      url: "https://rpc.invalid",
      fetchImpl: async (_url, request) => {
        calls += 1;
        const body = JSON.parse(request.body);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return response(200, {
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "eth_sendRawTransaction"
              ? `0x${"22".repeat(32)}`
              : "0x2a",
        });
      },
      random: () => 0,
    });

    const values = await Promise.all(
      Array.from({ length: 5 }, () =>
        coordinator.request({
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
      ),
    );
    expect(values).toHaveLength(5);
    expect(calls).toBe(1);
    await coordinator.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    expect(calls).toBe(1);

    await coordinator.request({
      method: "eth_sendRawTransaction",
      params: [`0x${"11".repeat(32)}`],
    });
    await coordinator.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    expect(calls).toBe(3);
  });

  it("opens one process-wide cooldown and honors Retry-After", async () => {
    let now = 1_000;
    let calls = 0;
    const coordinator = new RpcRequestCoordinator({
      url: "https://rpc.invalid",
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(
              429,
              { error: { code: -32005, message: "rate limit" } },
              { "retry-after": "4" },
            )
          : response(200, { result: "0x2a" });
      },
      random: () => 0,
    });

    await expect(
      coordinator.request({ method: "eth_blockNumber", params: [] }),
    ).rejects.toBeInstanceOf(RpcRateLimitedError);
    expect(coordinator.nextRetryAtSeconds).toBe(5);
    await expect(
      coordinator.request({ method: "eth_chainId", params: [] }),
    ).rejects.toMatchObject({ code: "RPC_COOLDOWN", statusCode: 503 });
    expect(calls).toBe(1);

    now = 5_000;
    await coordinator.request({ method: "eth_blockNumber", params: [] });
    expect(calls).toBe(2);
  });

  it("persists BigInt event evidence and resumable search progress", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "aurka-epoch-"));
    const filename = path.join(directory, "events.json");
    const key = "11155111:0xrouter:0xposition:0xepoch";
    const event = {
      address: "0xrouter",
      blockNumber: 42n,
      blockHash: `0x${"aa".repeat(32)}`,
      transactionHash: `0x${"bb".repeat(32)}`,
      transactionIndex: 3n,
      logIndex: 1n,
      args: {
        positionIdHash: "0xposition",
        capacityEpochId: "0xepoch",
        capacityBaselineValue: 50_000n,
        policyNonce: 7n,
        consumedBefore: 0n,
      },
    };
    const store = new PersistentEpochEventStore({
      filename,
      chainId: 11_155_111,
      router: "0xrouter",
    });
    store.set(
      key,
      {
        chainId: 11_155_111,
        router: "0xrouter",
        positionIdHash: "0xposition",
        capacityEpochId: "0xepoch",
      },
      event,
    );
    store.setProgress(key, { phase: "recent", nextTo: "31" });

    const restored = new PersistentEpochEventStore({
      filename,
      chainId: 11_155_111,
      router: "0xrouter",
    });
    expect(restored.get(key)).toMatchObject({
      blockNumber: 42n,
      transactionIndex: 3n,
      args: { capacityBaselineValue: 50_000n, policyNonce: 7n },
    });
    expect(restored.getProgress(key)).toMatchObject({
      phase: "recent",
      nextTo: "31",
    });
    restored.delete(key);
    expect(restored.get(key)).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });
});
