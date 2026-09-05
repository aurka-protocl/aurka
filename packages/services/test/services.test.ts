import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIXTURE_ADDRESSES,
  FIXTURE_BALANCE_SNAPSHOT,
  FIXTURE_POSITION_ID,
  FIXTURE_POSITION_ID_HASH,
  FIXTURE_PRICE_SNAPSHOT,
  FIXTURE_AQUA_STRATEGY_HASH,
  createCanonicalFixture,
} from "../src/fixture.js";
import { protocolEventTopic } from "@aurka/shared";
import { ServiceDatabase } from "../src/db/database.js";
import { ChainEventIndexer, type ChainLog } from "../src/indexer.js";
import {
  createApiServer,
  closeApiServer,
  listenApiServer,
} from "../src/api/server.js";
import { AurkaService } from "../src/service.js";
import {
  DeterministicRouterSimulator,
  FixtureProvider,
} from "../src/fixture.js";
import { DirectSolver } from "../src/solver/direct.js";
import { OptimizedSolver } from "../src/solver/optimized.js";
import { ProposalCollector } from "../src/solver/proposals.js";
import {
  FixtureProposalSigner,
  verifyProposalSignature,
} from "../src/solver/signing.js";
import { retryBounded } from "../src/observability.js";

function eventLog(overrides: Partial<ChainLog> = {}): ChainLog {
  return {
    chainId: 31337,
    contract: FIXTURE_ADDRESSES.router,
    blockNumber: "1",
    blockHash: `0x${"10".repeat(32)}`,
    transactionHash: `0x${"20".repeat(32)}`,
    logIndex: 0,
    name: "CapacityEpochActivated",
    payload: {
      policyId: `0x${"01".repeat(32)}`,
      positionIdHash: FIXTURE_POSITION_ID_HASH,
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      capacityEpochId: `0x${"30".repeat(32)}`,
      capacityBaselineValue: "50000",
      policyNonce: "1",
      riskCertificateHash: `0x${"00".repeat(32)}`,
      balanceSnapshot: FIXTURE_BALANCE_SNAPSHOT,
      priceSnapshot: FIXTURE_PRICE_SNAPSHOT,
      portfolioPriceSnapshot: `0x${"40".repeat(32)}`,
      aquaStrategyHash: FIXTURE_AQUA_STRATEGY_HASH,
      consumedBefore: "0",
    },
    observedAt: 200,
    removed: false,
    ...overrides,
  };
}

function tradePayload(consumedAfter: string): Record<string, unknown> {
  return {
    policyId: `0x${"01".repeat(32)}`,
    positionIdHash: FIXTURE_POSITION_ID_HASH,
    intentHash: `0x${"41".repeat(32)}`,
    proposalHash: `0x${"42".repeat(32)}`,
    capacityEpochId: `0x${"30".repeat(32)}`,
    trader: FIXTURE_ADDRESSES.trader,
    treasury: FIXTURE_ADDRESSES.treasury,
    traderInputToken: FIXTURE_ADDRESSES.weth,
    traderOutputToken: FIXTURE_ADDRESSES.usdc,
    traderInputValue: "50000",
    traderOutputValue: "49766",
    treasuryOutputValue: "49816",
    totalFeeAmount: "234",
    consumedBefore: "0",
    consumedAfter,
    expectedPostStateHash: `0x${"43".repeat(32)}`,
  };
}

function abiWord(value: string | bigint): string {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return "0x" + "0".repeat(24) + value.slice(2).toLowerCase();
  }
  if (typeof value === "string") return value.toLowerCase();
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function rawRouterEvent(log: ChainLog): ChainLog {
  if (log.name === "CapacityEpochActivated") {
    const payload = log.payload;
    return {
      ...log,
      payload: {},
      topics: [
        protocolEventTopic(log.name),
        String(payload.policyId),
        String(payload.positionIdHash),
        abiWord(String(payload.traderInputToken)),
      ],
      data:
        "0x" +
        [
          payload.traderOutputToken,
          payload.capacityEpochId,
          BigInt(String(payload.capacityBaselineValue)),
          BigInt(String(payload.policyNonce)),
          payload.riskCertificateHash,
          payload.balanceSnapshot,
          payload.priceSnapshot,
          payload.portfolioPriceSnapshot,
          payload.aquaStrategyHash,
          BigInt(String(payload.consumedBefore)),
        ]
          .map((value) => abiWord(value as string | bigint))
          .map((word) => word.slice(2))
          .join(""),
    };
  }
  if (log.name === "TradeExecuted") {
    const payload = log.payload;
    return {
      ...log,
      payload: {},
      topics: [
        protocolEventTopic(log.name),
        String(payload.policyId),
        String(payload.positionIdHash),
        String(payload.intentHash),
      ],
      data:
        "0x" +
        [
          payload.proposalHash,
          payload.capacityEpochId,
          payload.trader,
          payload.treasury,
          payload.traderInputToken,
          payload.traderOutputToken,
          BigInt(String(payload.traderInputValue)),
          BigInt(String(payload.traderOutputValue)),
          BigInt(String(payload.treasuryOutputValue)),
          BigInt(String(payload.totalFeeAmount)),
          BigInt(String(payload.consumedBefore)),
          BigInt(String(payload.consumedAfter)),
          payload.expectedPostStateHash,
        ]
          .map((value) => abiWord(value as string | bigint))
          .map((word) => word.slice(2))
          .join(""),
    };
  }
  throw new Error(`Unsupported raw test event ${log.name}`);
}

interface ApiBody {
  readonly error?: { readonly code?: string };
  readonly data?: Record<string, unknown>;
}

async function json(response: Response): Promise<ApiBody> {
  return (await response.json()) as ApiBody;
}

describe("AURKA service solver", () => {
  it("matches the shared canonical vector and rejects an unauthorised partial fill", async () => {
    const service = new AurkaService();
    const fixture = createCanonicalFixture();
    try {
      const quote = await service.quote(fixture.intent);
      expect(quote.executableTraderInputAmount).toBe("50000");
      expect(quote.maximumSafeTraderInputAmount).toBe("50000");
      expect(quote.fees.totalFeeAmount).toBe("234");
      expect(quote.expectedPostTradePortfolio.assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            token: FIXTURE_ADDRESSES.usdc,
            value: "550184",
          }),
          expect.objectContaining({
            token: FIXTURE_ADDRESSES.weth,
            value: "350000",
          }),
        ]),
      );

      const solve = await service.solve(fixture.intent);
      expect(solve.simulation).toMatchObject({ status: "SUCCEEDED" });
      expect(solve.proposal.traderInputValue).toBe("50000");
      expect(solve.proposal.traderOutputAmount).toBe("49766");
      expect(solve.proposal.solverFeeAmount).toBe("25");
      expect(solve.proposal.protocolFeeAmount).toBe("25");
      expect(verifyProposalSignature(solve.proposal, solve.proposalHash)).toBe(
        true,
      );

      await expect(
        service.solve({
          ...fixture.intent,
          intentId: `0x${"06".repeat(32)}`,
          requestedValue: "62000",
          allowPartialFill: false,
        }),
      ).rejects.toThrow("does not allow a partial fill");
    } finally {
      service.close();
    }
  });

  it("stores a quote, proposal, and unsigned execution request atomically at the service boundary", async () => {
    const service = new AurkaService();
    const fixture = createCanonicalFixture();
    try {
      const submitted = await service.submitIntent(fixture.intent);
      const solved = await service.solve(fixture.intent);
      expect(
        await service.listProposals(submitted.intent.intentId),
      ).toHaveLength(1);
      const result = await service.execute(
        submitted.intentHash,
        solved.proposalHash,
      );
      expect(result.execution.status).toBe("PENDING");
      expect(result.transactionRequest.chainId).toBe(31337);
      expect(
        service.getExecution(result.execution.transactionHash).status,
      ).toBe("PENDING");
    } finally {
      service.close();
    }
  });

  it("persists signed settlement objects across a database restart", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "aurka-services-"));
    const filename = path.join(directory, "service.sqlite");
    const fixture = createCanonicalFixture();
    let intentHash: string | undefined;
    let proposalHash: string | undefined;
    try {
      const first = new AurkaService({
        database: new ServiceDatabase({ filename }),
      });
      try {
        intentHash = (await first.submitIntent(fixture.intent)).intentHash;
        proposalHash = (await first.solve(fixture.intent)).proposalHash;
      } finally {
        first.close();
      }

      const second = new AurkaService({
        database: new ServiceDatabase({ filename }),
        seedFixture: false,
      });
      try {
        expect(second.repository.getIntent(intentHash!)).toBeDefined();
        expect(second.repository.getProposal(proposalHash!)).toBeDefined();
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps direct fallback when an allowlisted optimized route fails", async () => {
    const fixture = createCanonicalFixture();
    const direct = new DirectSolver(
      new FixtureProvider(fixture),
      new DeterministicRouterSimulator(),
      new FixtureProposalSigner(),
    );
    const solver = new OptimizedSolver(direct, [
      {
        id: "failing-local-route",
        allowlisted: true,
        solve: async () => {
          throw new Error("route unavailable");
        },
      },
    ]);
    const solved = await solver.solve(fixture.intent);
    expect(solved.simulation.status).toBe("SUCCEEDED");
    expect(solved.fill.executedValue).toBe(50_000n);
  });

  it("collects only signed, simulated proposals and rejects stale proposals", async () => {
    const fixture = createCanonicalFixture();
    const signer = new FixtureProposalSigner();
    const direct = new DirectSolver(
      new FixtureProvider(fixture),
      new DeterministicRouterSimulator(),
      signer,
    );
    const solved = await direct.solve(fixture.intent);
    const collector = new ProposalCollector(new DeterministicRouterSimulator());
    const collected = await collector.collect(
      fixture.intent,
      [
        solved.proposal,
        { ...solved.proposal, signature: `0x${"00".repeat(65)}` },
      ],
      fixture.snapshot,
    );
    expect(collected).toHaveLength(1);

    const staleIntent = { ...fixture.intent, deadline: 199 };
    const stale = await direct.solve(staleIntent);
    expect(stale.simulation.status).toBe("STALE");
    await expect(
      collector.collect(staleIntent, [stale.proposal], fixture.snapshot),
    ).resolves.toEqual([]);
  });

  it("bounds retries and rejects malformed chain logs", async () => {
    const database = new ServiceDatabase();
    const service = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(service.repository);
    let attempts = 0;
    try {
      const result = await indexer.sync(
        {
          getLatestBlock: async () => 2n,
          getLogs: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("temporary RPC failure");
            return [
              eventLog(),
              eventLog({
                blockNumber: "2",
                blockHash: `0x${"11".repeat(32)}`,
                transactionHash: `0x${"21".repeat(32)}`,
                name: "TradeExecuted",
                payload: tradePayload("50000"),
              }),
            ];
          },
        },
        31337,
        FIXTURE_ADDRESSES.router,
        0,
      );
      expect(attempts).toBe(3);
      expect(result.inserted).toBe(2);
      expect(result.checkpoint?.blockNumber).toBe("2");
      expect(() =>
        indexer.ingest([{ ...eventLog(), blockNumber: "not-a-block" }]),
      ).toThrow();
    } finally {
      service.close();
    }
  });

  it("uses bounded exponential retries without exceeding the configured attempts", async () => {
    let attempts = 0;
    await expect(
      retryBounded(
        async () => {
          attempts += 1;
          throw new Error("always unavailable");
        },
        { attempts: 3, delayMs: 0, maxDelayMs: 0 },
      ),
    ).rejects.toThrow("always unavailable");
    expect(attempts).toBe(3);
  });
});

describe("AURKA HTTP API", () => {
  it("validates requests and makes mutating retries idempotent", async () => {
    const handle = createApiServer();
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("API did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const fixture = createCanonicalFixture();
    try {
      const invalid = await fetch(`${base}/v1/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(invalid.status).toBe(400);
      expect((await json(invalid)).error?.code).toBe("INVALID_REQUEST");

      const request = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "intent-create-1",
        },
        body: JSON.stringify({ intent: fixture.intent }),
      };
      const first = await fetch(`${base}/v1/intents`, request);
      const second = await fetch(`${base}/v1/intents`, request);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((await json(first)).data?.intentHash).toBe(
        (await json(second)).data?.intentHash,
      );

      const quote = await fetch(`${base}/v1/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: fixture.intent }),
      });
      expect(quote.status).toBe(200);
      expect((await json(quote)).data?.executableTraderInputAmount).toBe(
        "50000",
      );
      const solve = await fetch(`${base}/v1/solve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: fixture.intent }),
      });
      expect(solve.status).toBe(200);
      const solveBody = await json(solve);
      expect((solveBody.data?.simulation as { status: string }).status).toBe(
        "SUCCEEDED",
      );
      const proposal = solveBody.data?.proposal as { intentHash: string };
      const execute = await fetch(`${base}/v1/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "execute-1",
        },
        body: JSON.stringify({
          intentHash: proposal.intentHash,
          proposalHash: solveBody.data?.proposalHash,
        }),
      });
      expect(execute.status).toBe(202);
      const executeBody = await json(execute);
      expect((executeBody.data?.execution as { status: string }).status).toBe(
        "PENDING",
      );
      const executeRetry = await fetch(`${base}/v1/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "execute-1",
        },
        body: JSON.stringify({
          intentHash: proposal.intentHash,
          proposalHash: solveBody.data?.proposalHash,
        }),
      });
      expect(executeRetry.status).toBe(202);
      expect((await json(executeRetry)).data?.execution).toEqual(
        executeBody.data?.execution,
      );
    } finally {
      await closeApiServer(handle);
    }
  });
});

describe("AURKA event projection", () => {
  it("is idempotent and rebuilds derived capacity after a removed log", () => {
    const database = new ServiceDatabase();
    const repositoryService = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(repositoryService.repository);
    const activation = rawRouterEvent(eventLog());
    const trade = rawRouterEvent(
      eventLog({
        blockNumber: "2",
        blockHash: `0x${"11".repeat(32)}`,
        transactionHash: `0x${"21".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("50000"),
      }),
    );
    try {
      expect(indexer.ingest([activation, activation]).inserted).toBe(2);
      expect(
        repositoryService.repository.listEvents(31337, 20).items,
      ).toHaveLength(1);
      indexer.ingest([trade]);
      expect(
        repositoryService.repository.getCapacityEpoch(
          FIXTURE_POSITION_ID,
          FIXTURE_ADDRESSES.weth,
          FIXTURE_ADDRESSES.usdc,
        )?.consumedValue,
      ).toBe("50000");

      indexer.ingest([{ ...trade, removed: true }]);
      expect(
        repositoryService.repository.getCapacityEpoch(
          FIXTURE_POSITION_ID,
          FIXTURE_ADDRESSES.weth,
          FIXTURE_ADDRESSES.usdc,
        )?.consumedValue,
      ).toBe("0");
      indexer.ingest([{ ...activation, removed: true }]);
      expect(
        repositoryService.repository.getCapacityEpoch(
          FIXTURE_POSITION_ID,
          FIXTURE_ADDRESSES.weth,
          FIXTURE_ADDRESSES.usdc,
        ),
      ).toBeUndefined();
    } finally {
      repositoryService.close();
    }
  });

  it("replays a range into the same projection deterministically", () => {
    const database = new ServiceDatabase();
    const service = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(service.repository);
    try {
      const result = indexer.replay([
        {
          id: `31337:${FIXTURE_ADDRESSES.router}:${eventLog().transactionHash}:0`,
          ...eventLog(),
        },
      ]);
      expect(result.inserted).toBe(1);
      expect(service.repository.listEvents(31337, 20).items[0]?.name).toBe(
        "CapacityEpochActivated",
      );
    } finally {
      service.close();
    }
  });
});
