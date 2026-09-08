import { describe, expect, it } from "vitest";

import {
  ReadinessMonitor,
  type ReadinessConfiguration,
} from "../src/readiness.js";
import { AurkaService } from "../src/service.js";

const hash = (value: string): string => `0x${value.repeat(64 / value.length)}`;

function healthyConfiguration(): ReadinessConfiguration {
  return {
    mode: "live",
    expectedChainId: 31_337,
    requirements: {
      rpc: true,
      indexer: true,
      sources: true,
      worker: true,
      signer: true,
      registry: true,
    },
    database: () => ({
      state: "healthy",
      observedAt: 100,
      reason: null,
      latencyMs: 1,
    }),
    probes: {
      rpc: async () => ({
        state: "healthy",
        observedAt: 100,
        reason: null,
        chainId: 31_337,
        expectedChainId: 31_337,
        latestBlock: "12",
        canonicalBlock: "12",
        canonicalBlockHash: hash("a"),
        finalizedBlock: "10",
        finalizedBlockHash: hash("b"),
        finalizedAt: 99,
      }),
      indexer: async () => ({
        state: "healthy",
        observedAt: 100,
        reason: null,
        checkpointBlock: "11",
        checkpointHash: hash("c"),
        latestBlock: "12",
        lagBlocks: 1,
      }),
      sources: async () => ({
        state: "healthy",
        observedAt: 100,
        reason: null,
        sources: [
          {
            sourceId: "source-a",
            state: "healthy",
            observedAt: 100,
            reason: null,
            lastObservedAt: 99,
            indexedBlock: "11",
            lagBlocks: 1,
          },
        ],
      }),
      worker: async () => ({
        state: "healthy",
        observedAt: 100,
        reason: null,
        lastAttemptAt: 100,
        lastCompletedAt: 100,
        leaseExpiresAt: null,
        inFlight: false,
      }),
      signer: async () => ({
        state: "healthy",
        observedAt: 100,
        reason: null,
        address: `0x${"11".repeat(20)}`,
        enabled: true,
        revoked: false,
        expiresAt: 200,
        policyFingerprint: hash("d"),
      }),
      registry: async () => ({
        state: "healthy",
        observedAt: 100,
        reason: null,
        source: "REGISTRY",
        mode: "PAUSED",
        effectiveObservedAt: 99,
      }),
    },
  };
}

describe("ReadinessMonitor", () => {
  it("keeps fixture, disabled and unknown capabilities distinct", async () => {
    const monitor = new ReadinessMonitor(
      {
        mode: "fixture",
        database: () => ({
          state: "healthy",
          observedAt: 100,
          reason: null,
          latencyMs: 0,
        }),
      },
      () => 100,
    );
    const snapshot = await monitor.snapshot();
    expect(snapshot).toMatchObject({
      status: "ready",
      mode: "fixture",
      checks: {
        database: { state: "healthy" },
        rpc: { state: "disabled" },
        worker: { state: "disabled" },
      },
    });

    monitor.configure({ mode: "live", requirements: { rpc: true } });
    const live = await monitor.snapshot();
    expect(live.status).toBe("not_ready");
    expect(live.checks.rpc).toMatchObject({
      state: "unknown",
      reason: "not_configured",
    });
  });

  it("requires measured checks but treats a legitimate PAUSED mode as healthy", async () => {
    const monitor = new ReadinessMonitor(healthyConfiguration(), () => 100);
    const snapshot = await monitor.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.checks.registry).toMatchObject({
      state: "healthy",
      mode: "PAUSED",
    });
    expect(snapshot.reasons).toEqual([]);
  });

  it("bounds stalled probes and coalesces concurrent work", async () => {
    let calls = 0;
    const monitor = new ReadinessMonitor(
      {
        mode: "live",
        probeTimeoutMs: 20,
        cacheTtlSeconds: 2,
        probes: {
          rpc: () => {
            calls += 1;
            return new Promise(() => undefined);
          },
        },
      },
      () => 100,
    );
    const started = performance.now();
    const [first, second] = await Promise.all([
      monitor.snapshot(),
      monitor.snapshot(),
    ]);
    expect(performance.now() - started).toBeLessThan(250);
    expect(calls).toBe(1);
    expect(first).toMatchObject({
      status: "not_ready",
      checks: { rpc: { state: "unhealthy", reason: "probe_timeout" } },
    });
    expect(second.status).toBe("not_ready");
  });

  it("reports database outage without exposing provider error text", async () => {
    const monitor = new ReadinessMonitor(
      {
        mode: "fixture",
        database: () => {
          throw new Error("password=should-never-be-public");
        },
      },
      () => 100,
    );
    const snapshot = await monitor.snapshot();
    expect(snapshot).toMatchObject({
      status: "not_ready",
      database: "error",
      checks: {
        database: { state: "unhealthy", reason: "probe_failed" },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("should-never-be-public");
  });

  it("reports revoked signers, stale workers and source failures independently", async () => {
    const healthy = healthyConfiguration();
    const monitor = new ReadinessMonitor(
      {
        ...healthy,
        probes: {
          ...healthy.probes,
          sources: async () => ({
            state: "unhealthy",
            observedAt: 100,
            reason: "source_not_fresh",
            sources: [
              {
                sourceId: "source-a",
                state: "unhealthy",
                observedAt: 100,
                reason: "source_probe_failed",
                lastObservedAt: null,
                indexedBlock: null,
                lagBlocks: null,
              },
            ],
          }),
          worker: async () => ({
            state: "unhealthy",
            observedAt: 100,
            reason: "worker_stale",
            lastAttemptAt: 50,
            lastCompletedAt: 50,
            leaseExpiresAt: null,
            inFlight: false,
          }),
          signer: async () => ({
            state: "unhealthy",
            observedAt: 100,
            reason: "signer_revoked",
            address: `0x${"11".repeat(20)}`,
            enabled: true,
            revoked: true,
            expiresAt: 200,
            policyFingerprint: hash("d"),
          }),
        },
      },
      () => 100,
    );
    const snapshot = await monitor.snapshot();
    expect(snapshot.status).toBe("not_ready");
    expect(snapshot.reasons).toEqual([
      "sources:source_not_fresh",
      "worker:worker_stale",
      "signer:signer_revoked",
    ]);
  });

  it("recovers a failed dependency after its cached observation expires", async () => {
    let now = 100;
    let healthy = false;
    let calls = 0;
    const monitor = new ReadinessMonitor(
      {
        mode: "live",
        cacheTtlSeconds: 1,
        requirements: { rpc: true },
        probes: {
          rpc: async () => {
            calls += 1;
            return {
              state: healthy ? "healthy" : "unhealthy",
              observedAt: now,
              reason: healthy ? null : "rpc_unavailable",
              chainId: healthy ? 31_337 : null,
              expectedChainId: 31_337,
              latestBlock: healthy ? "1" : null,
              canonicalBlock: healthy ? "1" : null,
              canonicalBlockHash: healthy ? hash("a") : null,
              finalizedBlock: healthy ? "1" : null,
              finalizedBlockHash: healthy ? hash("b") : null,
              finalizedAt: healthy ? now : null,
            };
          },
        },
      },
      () => now,
    );
    expect((await monitor.snapshot()).checks.rpc.state).toBe("unhealthy");
    healthy = true;
    now = 102;
    expect((await monitor.snapshot()).checks.rpc.state).toBe("healthy");
    expect(calls).toBe(2);
  });

  it("rejects wrong-chain and lagging/reorged indexer evidence", async () => {
    const wrongChain = new AurkaService({
      chainId: 31_337,
      rpcTransport: { request: async () => "0x1" },
    });
    try {
      const snapshot = await wrongChain.getReadiness();
      expect(snapshot.checks.rpc).toMatchObject({
        state: "unhealthy",
        reason: "chain_mismatch",
      });
      expect(snapshot.status).toBe("not_ready");
    } finally {
      wrongChain.close();
    }

    const latestHash = hash("a");
    const checkpointHash = hash("c");
    const service = new AurkaService({
      chainId: 31_337,
      settlementContract: `0x${"44".repeat(20)}`,
      maxIndexerLagBlocks: 2,
      riskNow: () => 100,
      rpcFinalityMaxAgeSeconds: 30,
      rpcTransport: {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_blockNumber") return "0x64";
          if (method === "eth_getBlockByNumber") {
            if (params?.[0] === "latest")
              return { number: "0x64", hash: latestHash };
            if (params?.[0] === "finalized")
              return {
                number: "0x63",
                hash: hash("b"),
                timestamp: "0x64",
              };
            return { hash: latestHash };
          }
          throw new Error("unexpected_rpc_call");
        },
      },
    });
    try {
      service.repository.setCheckpoint(
        31_337,
        service.runtime.settlementContract!,
        "1",
        checkpointHash,
      );
      const snapshot = await service.getReadiness();
      expect(snapshot.checks.rpc.state).toBe("healthy");
      expect(snapshot.checks.indexer).toMatchObject({
        state: "unhealthy",
        reason: "indexer_checkpoint_reorged",
      });
      expect(snapshot.checks.indexer.lagBlocks).toBe(99);
    } finally {
      service.close();
    }
  });

  it("rejects stale finalized heads and expired signer authority", async () => {
    const staleRpc = new AurkaService({
      chainId: 31_337,
      riskNow: () => 100,
      rpcFinalityMaxAgeSeconds: 10,
      rpcTransport: {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_blockNumber") return "0x64";
          if (method === "eth_getBlockByNumber")
            return params?.[0] === "latest"
              ? { number: "0x64", hash: hash("a") }
              : {
                  number: "0x63",
                  hash: hash("b"),
                  timestamp: "0x1",
                };
          throw new Error("unexpected_rpc_call");
        },
      },
    });
    try {
      expect((await staleRpc.getReadiness()).checks.rpc).toMatchObject({
        state: "unhealthy",
        reason: "finalized_head_stale",
      });
    } finally {
      staleRpc.close();
    }

    const healthy = healthyConfiguration();
    const monitor = new ReadinessMonitor(
      {
        ...healthy,
        probes: {
          ...healthy.probes,
          signer: async () => ({
            state: "healthy",
            observedAt: 100,
            reason: null,
            address: `0x${"11".repeat(20)}`,
            enabled: true,
            revoked: false,
            expiresAt: 99,
            policyFingerprint: hash("d"),
          }),
        },
      },
      () => 100,
    );
    expect((await monitor.snapshot()).checks.signer).toMatchObject({
      state: "unhealthy",
      reason: "signer_unavailable",
    });
  });
});
