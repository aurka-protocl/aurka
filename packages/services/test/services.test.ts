import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import routerCalldataFixture from "../test-vectors/router-execute-partial.json" with { type: "json" };

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
  SECP256K1_HALF_ORDER,
  signDigest,
  verifyProposalSignature,
  verifySignature,
} from "../src/solver/signing.js";
import {
  JsonRpcHttpTransport,
  Eip1193RouterSimulator,
  ROUTER_EXECUTE_SELECTOR,
} from "../src/solver/index.js";
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

function calldataWord(data: string, index: number): bigint {
  const start = 2 + 8 + index * 64;
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

function highSTwin(signature: string): string {
  const order =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130, 132) === "1b" ? "1c" : "1b";
  const highS = (order - s).toString(16).padStart(64, "0");
  return `0x${r}${highS}${v}`;
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
        result.transactionRequest.data.startsWith(ROUTER_EXECUTE_SELECTOR),
      ).toBe(true);
      expect(
        result.transactionRequest.data.includes("AURKA_DIRECT_PAIR_V1"),
      ).toBe(false);
      expect(
        service.getExecution(result.execution.transactionHash).status,
      ).toBe("PENDING");
    } finally {
      service.close();
    }
  });

  it("retains authorization-pending proposals for service and HTTP discovery", async () => {
    const service = new AurkaService({
      rpcTransport: {
        request: async () => "0x",
      },
    });
    const handle = createApiServer({ service });
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("API did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const fixture = createCanonicalFixture();
    try {
      const solveResponse = await fetch(`${base}/v1/solve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: fixture.intent }),
      });
      expect(solveResponse.status).toBe(200);
      const solved = await json(solveResponse);
      expect((solved.data?.simulation as { status: string }).status).toBe(
        "AUTHORIZATION_PENDING",
      );

      const proposalHash = solved.data?.proposalHash as string;
      const stored = service.database.sqlite
        .prepare(
          "SELECT status, simulation_status AS simulationStatus FROM proposals WHERE proposal_hash = ?",
        )
        .get(proposalHash) as
        { status: string; simulationStatus: string } | undefined;
      expect(stored).toEqual({
        status: "AUTHORIZATION_PENDING",
        simulationStatus: "AUTHORIZATION_PENDING",
      });

      const proposals = await fetch(
        `${base}/v1/intents/${fixture.intent.intentId}/proposals`,
      );
      expect(proposals.status).toBe(200);
      expect((await json(proposals)).data).toHaveLength(1);
    } finally {
      await closeApiServer(handle);
    }
  });

  it("uses the same ABI calldata for an exact EIP-1193 router simulation", async () => {
    const fixture = createCanonicalFixture();
    const calls: Array<{ method: string; params?: readonly unknown[] }> = [];
    const simulator = new Eip1193RouterSimulator({
      request: async (input) => {
        calls.push(input);
        return "0x";
      },
    });
    const direct = new DirectSolver(
      new FixtureProvider(fixture),
      new DeterministicRouterSimulator(),
      new FixtureProposalSigner(),
    );
    const solved = await direct.solve(fixture.intent);
    const result = await simulator.simulateExact(
      { ...fixture.intent, signature: `0x${"11".repeat(65)}` },
      solved.proposal,
      fixture.snapshot,
    );
    expect(result).toEqual({ status: "SUCCEEDED", gasEstimate: 0n });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("eth_call");
    const transaction = calls[0]?.params?.[0] as {
      to: string;
      data: string;
      value: string;
    };
    expect(transaction.to).toBe(FIXTURE_ADDRESSES.router);
    expect(transaction.data.startsWith(ROUTER_EXECUTE_SELECTOR)).toBe(true);
    expect(transaction.value).toBe("0x0");
    expect(calls[0]?.params?.[1]).toBe("0x64");
  });

  it("rejects null and non-hex eth_call results", async () => {
    const fixture = createCanonicalFixture();
    const direct = new DirectSolver(
      new FixtureProvider(fixture),
      new DeterministicRouterSimulator(),
      new FixtureProposalSigner(),
    );
    const solved = await direct.solve(fixture.intent);
    for (const result of [null, "not-hex"]) {
      const simulator = new Eip1193RouterSimulator({
        request: async () => result,
      });
      await expect(
        simulator.simulateExact(
          { ...fixture.intent, signature: `0x${"11".repeat(65)}` },
          solved.proposal,
          fixture.snapshot,
        ),
      ).resolves.toEqual({
        status: "REVERTED",
        gasEstimate: 0n,
        reason: "Malformed eth_call result",
      });
    }
  });

  it("binds price-input amounts to the executable partial fill", async () => {
    const fixture = createCanonicalFixture();
    const intent = {
      ...fixture.intent,
      intentId: `0x${"07".repeat(32)}`,
      requestedValue: "25000",
    };
    const service = new AurkaService();
    try {
      const submitted = await service.submitIntent(intent);
      const solved = await service.solve(intent);
      const result = await service.execute(
        submitted.intentHash,
        solved.proposalHash,
      );
      expect(calldataWord(result.transactionRequest.data, 94)).toBe(25000n);
      expect(calldataWord(result.transactionRequest.data, 95)).toBe(
        BigInt(solved.proposal.traderOutputAmount) +
          BigInt(solved.proposal.solverFeeAmount) +
          BigInt(solved.proposal.protocolFeeAmount),
      );
      expect(calldataWord(result.transactionRequest.data, 24)).toBe(25000n);
      expect(result.transactionRequest.data).toBe(
        routerCalldataFixture.calldata,
      );
    } finally {
      service.close();
    }
  });

  it("rejects high-s signature malleability accepted by the old boundary", () => {
    const signer = new FixtureProposalSigner();
    const digest = `0x${"09".repeat(32)}`;
    const signature = signDigest(
      digest,
      Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    );
    expect(BigInt(`0x${signature.slice(66, 130)}`)).toBeLessThanOrEqual(
      SECP256K1_HALF_ORDER,
    );
    expect(verifySignature(signer.address, digest, signature)).toBe(true);
    expect(verifySignature(signer.address, digest, highSTwin(signature))).toBe(
      false,
    );
  });

  it("does not call an exact router before trader authorization", async () => {
    const fixture = createCanonicalFixture();
    const direct = new DirectSolver(
      new FixtureProvider(fixture),
      new Eip1193RouterSimulator({ request: async () => "0x" }),
      new FixtureProposalSigner(),
    );
    const solved = await direct.solve(fixture.intent);
    expect(solved.simulation.status).toBe("AUTHORIZATION_PENDING");
  });

  it("rejects malformed JSON-RPC envelopes and preserves revert data", async () => {
    const transport = new JsonRpcHttpTransport("http://rpc.invalid");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0" }),
    }));
    await expect(transport.request({ method: "eth_call" })).rejects.toThrow(
      "missing result",
    );
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        error: { message: "execution reverted: 0x1234" },
      }),
    }));
    await expect(transport.request({ method: "eth_call" })).rejects.toThrow(
      "execution reverted: 0x1234",
    );
    vi.unstubAllGlobals();
  });

  it("exactly simulates an authorized execute request without claiming submission", async () => {
    const fixture = createCanonicalFixture();
    const solverAddress = new FixtureProposalSigner().address;
    const intent = { ...fixture.intent, trader: solverAddress };
    const calls: Array<{ method: string; params?: readonly unknown[] }> = [];
    const service = new AurkaService({
      rpcTransport: {
        request: async (input) => {
          calls.push(input);
          return "0x";
        },
      },
    });
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    try {
      const submitted = await service.submitIntent(intent);
      const solved = await service.solve(intent);
      const result = await service.execute(
        submitted.intentHash,
        solved.proposalHash,
        signDigest(submitted.intentHash, privateKey),
      );
      expect(result.execution.status).toBe("PENDING");
      expect(
        result.transactionRequest.data.startsWith(ROUTER_EXECUTE_SELECTOR),
      ).toBe(true);
      expect(calls.map((call) => call.method)).toEqual(["eth_call"]);
      const stored = service.database.sqlite
        .prepare(
          "SELECT status, simulation_status AS simulationStatus FROM proposals WHERE proposal_hash = ?",
        )
        .get(solved.proposalHash) as {
        status: string;
        simulationStatus: string;
      };
      expect(stored).toEqual({
        status: "EXECUTABLE",
        simulationStatus: "SUCCEEDED",
      });
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

  it("uses only the deterministic direct pairwise solver", async () => {
    const fixture = createCanonicalFixture();
    const direct = new DirectSolver(
      new FixtureProvider(fixture),
      new DeterministicRouterSimulator(),
      new FixtureProposalSigner(),
    );
    const solver = new OptimizedSolver(direct);
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
          getBlockHash: async (blockNumber) =>
            blockNumber === 0n
              ? `0x${"00".repeat(32)}`
              : blockNumber === 1n
                ? `0x${"10".repeat(32)}`
                : `0x${"11".repeat(32)}`,
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

  it("rejects fetched logs that do not bind to the requested canonical range", async () => {
    const canonicalHash = (blockNumber: bigint): string =>
      `0x${blockNumber.toString(16).padStart(2, "0").repeat(32)}`;
    const cases: readonly {
      readonly name: string;
      readonly log: ChainLog;
      readonly confirmations?: number;
      readonly checkpoint?: string;
    }[] = [
      {
        name: "wrong chain",
        log: eventLog({ chainId: 1 }),
      },
      {
        name: "wrong contract",
        log: eventLog({ contract: `0x${"de".repeat(20)}` }),
      },
      {
        name: "wrong block hash",
        log: eventLog({ blockHash: `0x${"aa".repeat(32)}` }),
      },
      {
        name: "reorg between log and header reads",
        log: eventLog({ blockHash: `0x${"aa".repeat(32)}` }),
      },
      {
        name: "below requested range",
        log: eventLog(),
        checkpoint: "1",
      },
      {
        name: "above sufficiently confirmed range",
        log: eventLog({
          blockNumber: "3",
          blockHash: canonicalHash(3n),
        }),
        confirmations: 1,
      },
    ];

    for (const testCase of cases) {
      const database = new ServiceDatabase();
      const service = new AurkaService({ database, seedFixture: true });
      const indexer = new ChainEventIndexer(service.repository);
      if (testCase.checkpoint !== undefined) {
        service.repository.setCheckpoint(
          31337,
          FIXTURE_ADDRESSES.router,
          testCase.checkpoint,
          canonicalHash(BigInt(testCase.checkpoint)),
        );
      }
      try {
        const source = {
          getLatestBlock: async () => 3n,
          getBlockHash: async (blockNumber: bigint) =>
            canonicalHash(blockNumber),
          getLogs: async () => [testCase.log],
        };
        await expect(
          indexer.sync(
            source,
            31337,
            FIXTURE_ADDRESSES.router,
            testCase.confirmations ?? 0,
          ),
        ).rejects.toThrow();
        expect(
          service.repository.listEvents(31337, 20).items,
          testCase.name,
        ).toHaveLength(0);
        const checkpoint = service.repository.getCheckpoint(
          31337,
          FIXTURE_ADDRESSES.router,
        );
        if (testCase.checkpoint === undefined) {
          expect(checkpoint, testCase.name).toBeUndefined();
        } else {
          expect(checkpoint, testCase.name).toMatchObject({
            blockNumber: testCase.checkpoint,
            blockHash: canonicalHash(BigInt(testCase.checkpoint)),
          });
        }
      } finally {
        service.close();
      }
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

      const conflict = await fetch(`${base}/v1/intents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "intent-create-1",
        },
        body: JSON.stringify({
          intent: { ...fixture.intent, nonce: "2" },
        }),
      });
      expect(conflict.status).toBe(409);

      const concurrentHash = "0x" + "33".repeat(32);
      expect(
        handle.service.repository.claimIdempotencyKey(
          "intent-concurrent-1",
          "POST",
          "/v1/intents",
          concurrentHash,
        ),
      ).toBeUndefined();
      expect(() =>
        handle.service.repository.claimIdempotencyKey(
          "intent-concurrent-1",
          "POST",
          "/v1/intents",
          concurrentHash,
        ),
      ).toThrow("still in progress");
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

  it("rewinds and replays a replacement checkpointed block after restart", async () => {
    const database = new ServiceDatabase();
    const service = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(service.repository);
    let forked = false;
    const originalTrade = rawRouterEvent(
      eventLog({
        blockNumber: "2",
        blockHash: `0x${"11".repeat(32)}`,
        transactionHash: `0x${"21".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("50000"),
      }),
    );
    const replacementTrade = rawRouterEvent(
      eventLog({
        blockNumber: "2",
        blockHash: `0x${"12".repeat(32)}`,
        transactionHash: `0x${"22".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("30000"),
      }),
    );
    try {
      const source = {
        getLatestBlock: async () => 2n,
        getBlockHash: async (blockNumber: bigint) => {
          if (blockNumber === 1n) return `0x${"10".repeat(32)}`;
          if (blockNumber === 2n)
            return `0x${(forked ? "12" : "11").repeat(32)}`;
          return `0x${"00".repeat(32)}`;
        },
        getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
          fromBlock <= 1n ? [eventLog(), originalTrade] : [replacementTrade],
      };
      await indexer.sync(source, 31337, FIXTURE_ADDRESSES.router);
      expect(
        service.repository.getCheckpoint(31337, FIXTURE_ADDRESSES.router)
          ?.blockHash,
      ).toBe(`0x${"11".repeat(32)}`);

      forked = true;
      const result = await indexer.sync(
        source,
        31337,
        FIXTURE_ADDRESSES.router,
      );
      expect(result.inserted).toBe(1);
      expect(
        service.repository.getCapacityEpoch(
          FIXTURE_POSITION_ID,
          FIXTURE_ADDRESSES.weth,
          FIXTURE_ADDRESSES.usdc,
        )?.consumedValue,
      ).toBe("30000");
      const events = service.repository.listEvents(31337, 20).items;
      expect(events).toHaveLength(2);
      expect(
        events.some(
          (event) => event.transactionHash === `0x${"21".repeat(32)}`,
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) => event.transactionHash === `0x${"22".repeat(32)}`,
        ),
      ).toBe(true);
    } finally {
      service.close();
    }
  });

  it("rewinds a multi-block fork to the retained common ancestor", async () => {
    const database = new ServiceDatabase();
    const service = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(service.repository);
    let forked = false;
    const oldTrade2 = rawRouterEvent(
      eventLog({
        blockNumber: "2",
        blockHash: `0x${"11".repeat(32)}`,
        transactionHash: `0x${"23".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("20000"),
      }),
    );
    const oldTrade3 = rawRouterEvent(
      eventLog({
        blockNumber: "3",
        blockHash: `0x${"13".repeat(32)}`,
        transactionHash: `0x${"24".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("50000"),
      }),
    );
    const replacementTrade2 = rawRouterEvent(
      eventLog({
        blockNumber: "2",
        blockHash: `0x${"12".repeat(32)}`,
        transactionHash: `0x${"25".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("15000"),
      }),
    );
    const replacementTrade3 = rawRouterEvent(
      eventLog({
        blockNumber: "3",
        blockHash: `0x${"14".repeat(32)}`,
        transactionHash: `0x${"26".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("45000"),
      }),
    );
    try {
      const source = {
        getLatestBlock: async () => 3n,
        getBlockHash: async (blockNumber: bigint) => {
          if (blockNumber === 0n) return `0x${"00".repeat(32)}`;
          if (blockNumber === 1n) return `0x${"10".repeat(32)}`;
          if (blockNumber === 2n)
            return `0x${(forked ? "12" : "11").repeat(32)}`;
          if (blockNumber === 3n)
            return `0x${(forked ? "14" : "13").repeat(32)}`;
          return undefined;
        },
        getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
          fromBlock <= 1n
            ? [eventLog(), oldTrade2, oldTrade3]
            : [replacementTrade2, replacementTrade3],
      };
      await indexer.sync(source, 31337, FIXTURE_ADDRESSES.router);
      forked = true;
      const result = await indexer.sync(
        source,
        31337,
        FIXTURE_ADDRESSES.router,
      );
      expect(result.inserted).toBe(2);
      expect(
        service.repository.getCapacityEpoch(
          FIXTURE_POSITION_ID,
          FIXTURE_ADDRESSES.weth,
          FIXTURE_ADDRESSES.usdc,
        )?.consumedValue,
      ).toBe("45000");
      const events = service.repository.listEvents(31337, 20).items;
      expect(events).toHaveLength(3);
      expect(
        events.some((event) => event.blockHash === `0x${"11".repeat(32)}`),
      ).toBe(false);
      expect(
        events.some((event) => event.blockHash === `0x${"13".repeat(32)}`),
      ).toBe(false);
      expect(
        service.repository.getCheckpoint(31337, FIXTURE_ADDRESSES.router)
          ?.blockHash,
      ).toBe(`0x${"14".repeat(32)}`);
    } finally {
      service.close();
    }
  });

  it("advances empty ranges only to a verified canonical block", async () => {
    const database = new ServiceDatabase();
    const service = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(service.repository);
    let reads = 0;
    try {
      const source = {
        getLatestBlock: async () => 3n,
        getBlockHash: async (blockNumber: bigint) =>
          `0x${blockNumber.toString(16).padStart(2, "0").repeat(32)}`,
        getLogs: async () => {
          reads += 1;
          return [];
        },
      };
      const first = await indexer.sync(source, 31337, FIXTURE_ADDRESSES.router);
      expect(reads).toBe(1);
      expect(first.checkpoint?.blockNumber).toBe("3");
      expect(
        service.repository.getCheckpoint(31337, FIXTURE_ADDRESSES.router)
          ?.blockNumber,
      ).toBe("3");
      const second = await indexer.sync(
        source,
        31337,
        FIXTURE_ADDRESSES.router,
      );
      expect(reads).toBe(1);
      expect(second.checkpoint?.blockNumber).toBe("3");
    } finally {
      service.close();
    }
  });

  it("uses retained empty-block headers during a deeper restart reorg", async () => {
    const database = new ServiceDatabase();
    const service = new AurkaService({ database, seedFixture: true });
    const indexer = new ChainEventIndexer(service.repository);
    let forked = false;
    const oldTrade = rawRouterEvent(
      eventLog({
        blockNumber: "4",
        blockHash: `0x${"15".repeat(32)}`,
        transactionHash: `0x${"27".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("50000"),
      }),
    );
    const replacementTrade = rawRouterEvent(
      eventLog({
        blockNumber: "4",
        blockHash: `0x${"16".repeat(32)}`,
        transactionHash: `0x${"28".repeat(32)}`,
        name: "TradeExecuted",
        payload: tradePayload("42000"),
      }),
    );
    try {
      const source = {
        getLatestBlock: async () => 4n,
        getBlockHash: async (blockNumber: bigint) => {
          if (blockNumber === 0n) return `0x${"00".repeat(32)}`;
          if (blockNumber === 1n) return `0x${"10".repeat(32)}`;
          if (blockNumber === 2n)
            return `0x${(forked ? "12" : "11").repeat(32)}`;
          if (blockNumber === 3n)
            return `0x${(forked ? "14" : "13").repeat(32)}`;
          if (blockNumber === 4n)
            return `0x${(forked ? "16" : "15").repeat(32)}`;
          return undefined;
        },
        getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
          fromBlock <= 1n ? [eventLog(), oldTrade] : [replacementTrade],
      };
      await indexer.sync(source, 31337, FIXTURE_ADDRESSES.router);
      forked = true;
      await indexer.sync(source, 31337, FIXTURE_ADDRESSES.router);
      expect(
        service.repository.getCapacityEpoch(
          FIXTURE_POSITION_ID,
          FIXTURE_ADDRESSES.weth,
          FIXTURE_ADDRESSES.usdc,
        )?.consumedValue,
      ).toBe("42000");
      const events = service.repository.listEvents(31337, 20).items;
      expect(events).toHaveLength(2);
      expect(
        events.some(
          (event) => event.transactionHash === oldTrade.transactionHash,
        ),
      ).toBe(false);
      expect(
        service.repository.getIndexedHeader(31337, FIXTURE_ADDRESSES.router, 2n)
          ?.blockHash,
      ).toBe(`0x${"12".repeat(32)}`);
    } finally {
      service.close();
    }
  });
});
