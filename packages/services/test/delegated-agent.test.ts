import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import {
  delegatedAuthorizationTypedData,
  delegatedControlRequestHash,
  delegatedControlTypedData,
  delegatedRecoveryTypedData,
  type AgentProposalResponse,
  type DelegatedSessionPlan,
} from "@aurka/shared";
import type {
  DelegatedExecutionAction,
  DelegatedIntentTypedData,
  DelegatedWalletAdapter,
} from "@aurka/wallet";

import { OpenRouterAgent } from "../src/agent/openrouter.js";
import { DelegatedSessionService } from "../src/agent/delegated.js";
import {
  closeApiServer,
  createApiServer,
  listenApiServer,
} from "../src/api/server.js";
import { FIXTURE_ADDRESSES, FIXTURE_POSITION_ID } from "../src/fixture.js";
import { AurkaService } from "../src/service.js";

const bob = privateKeyToAccount(`0x${"12".repeat(32)}`);
const agentAccount = privateKeyToAccount(`0x${"34".repeat(32)}`);
const alice = privateKeyToAccount(`0x${"56".repeat(32)}`);

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function completion(toolCalls: readonly unknown[]) {
  return new Response(
    JSON.stringify({
      model: "delegated-test-model",
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", content: null, tool_calls: toolCalls },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function agentResponses() {
  return [
    [toolCall("1", "discover_spaces", {})],
    [
      toolCall("2", "read_space_conditions", {
        spaceId: FIXTURE_POSITION_ID,
      }),
    ],
    [
      toolCall("3", "request_deterministic_quote", {
        spaceId: FIXTURE_POSITION_ID,
        traderInputToken: FIXTURE_ADDRESSES.weth,
        traderOutputToken: FIXTURE_ADDRESSES.usdc,
        amount: "100",
      }),
    ],
    [
      toolCall("4", "simulate_proposal", {
        spaceId: FIXTURE_POSITION_ID,
        traderInputToken: FIXTURE_ADDRESSES.weth,
        traderOutputToken: FIXTURE_ADDRESSES.usdc,
        amount: "100",
      }),
    ],
  ];
}

class FakeDelegatedWallet implements DelegatedWalletAdapter {
  readonly actions: DelegatedExecutionAction[] = [];
  signCalls = 0;
  revoked = false;
  receiptsAvailable = false;
  readonly recoveries: string[] = [];
  recoverGate: Promise<void> | undefined;
  recoverEntered: Promise<void>;
  signGate: Promise<void> | undefined;
  signEntered: Promise<void> | undefined;
  private resolveSignEntered: (() => void) | undefined;
  private resolveRecoverEntered: (() => void) | undefined;
  private readonly txHash = `0x${"ab".repeat(32)}`;

  constructor() {
    this.signEntered = new Promise((resolve) => {
      this.resolveSignEntered = resolve;
    });
    this.recoverEntered = new Promise((resolve) => {
      this.resolveRecoverEntered = resolve;
    });
  }

  async getStatus() {
    return {
      configured: true as const,
      walletId: "wallet-delegated-test",
      address: agentAccount.address,
      chainId: 31_337,
      signerAddress: agentAccount.address,
      policyId: "policy-delegated-test",
      policyFingerprint: `0x${"ef".repeat(32)}`,
      enabled: !this.revoked,
      revoked: this.revoked,
      validUntil: Math.floor(Date.now() / 1000) + 3_600,
      reason: null,
    };
  }

  async signIntent(typedData: DelegatedIntentTypedData): Promise<string> {
    this.signCalls += 1;
    this.resolveSignEntered?.();
    if (this.signGate) await this.signGate;
    return agentAccount.signTypedData(typedData as never);
  }

  async simulateAndSend(action: DelegatedExecutionAction) {
    this.actions.push(action);
    return {
      transactionHash: this.txHash,
      policyFingerprint: action.policyFingerprint,
    };
  }

  async getReceipt(transactionHash: string) {
    return this.receiptsAvailable
      ? { transactionHash, blockNumber: "0x1", status: "0x1" as const }
      : null;
  }

  async revoke() {
    this.revoked = true;
  }

  async recover(input: { readonly destination: string }) {
    this.resolveRecoverEntered?.();
    if (this.recoverGate) await this.recoverGate;
    this.recoveries.push(input.destination);
    return { transactionHash: `0x${"cd".repeat(32)}` };
  }
}

async function authorize(
  delegated: DelegatedSessionService,
  plan: DelegatedSessionPlan,
) {
  const typedData = delegatedAuthorizationTypedData(plan, agentAccount.address);
  const signature = await bob.signTypedData(typedData as never);
  return delegated.authorize({
    plan,
    agentWallet: agentAccount.address,
    signature,
  });
}

async function control(
  session: Awaited<ReturnType<DelegatedSessionService["authorize"]>>,
  action: "APPROVE" | "START" | "STOP" | "RECONCILE",
  message = "",
  expiresAt = 300,
  signer = bob,
) {
  const nonce = `0x${Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64)}`;
  const requestHash = delegatedControlRequestHash(message);
  const typedData = delegatedControlTypedData(
    session.plan,
    session.id,
    agentAccount.address,
    action,
    requestHash,
    nonce,
    expiresAt,
  );
  return {
    sessionId: session.id,
    ownerAddress: bob.address,
    agentWallet: agentAccount.address,
    chainId: session.plan.chainId,
    action,
    requestHash,
    nonce,
    expiresAt,
    signature: await signer.signTypedData(typedData as never),
  };
}

describe("bounded delegated agent execution", () => {
  const nonReadyResults: Array<[string, AgentProposalResponse]> = [
    [
      "clarification",
      {
        status: "CLARIFICATION",
        provider: "openrouter",
        model: "test",
        reason: "Choose a trade or a rules explanation.",
        nextAction: "Add a little more detail.",
        suggestions: [],
        toolTrace: [],
      },
    ],
    [
      "read-only rules answer",
      {
        status: "READ_ONLY_ANSWER",
        provider: "openrouter",
        model: "test",
        selectedSpace: {
          id: FIXTURE_POSITION_ID,
          name: "Canonical local treasury",
          owner: bob.address,
        },
        rules: {
          chainId: 31_337,
          state: "ACTIVE",
          riskMode: "NORMAL",
          policyNonce: "1",
          maximumTransactionValue: "50000",
          valueDecimals: 0,
          assets: [
            {
              token: FIXTURE_ADDRESSES.weth,
              symbol: "WETH",
              decimals: 0,
              minimumWeightBps: 0,
              maximumWeightBps: 10_000,
            },
          ],
        },
        answer: "Current rules are available for review.",
        toolTrace: [{ tool: "read_space_conditions", status: "SUCCEEDED" }],
      },
    ],
  ];

  it.each(nonReadyResults)(
    "does not reserve or sign a %s result",
    async (_label, result) => {
      const service = new AurkaService();
      const wallet = new FakeDelegatedWallet();
      const agent = {
        propose: async (): Promise<AgentProposalResponse> => result,
      };
      const now = Math.floor(Date.now() / 1000);
      const delegated = new DelegatedSessionService(service, agent, wallet, {
        now: () => now,
        trustedOwnerAddress: bob.address,
      });
      const plan: DelegatedSessionPlan = {
        ownerAddress: bob.address,
        chainId: 31_337,
        allowedSpaceIds: [FIXTURE_POSITION_ID],
        traderInputToken: FIXTURE_ADDRESSES.weth,
        traderOutputToken: FIXTURE_ADDRESSES.usdc,
        perTradeInputAmount: "100",
        cumulativeInputBudget: "100",
        maxTradeCount: 1,
        slippageBps: 1_000,
        expiresAt: now + 600,
        sessionNonce: `0x${"a1".repeat(32)}`,
      };
      try {
        const session = await authorize(delegated, plan);
        const afterStart = await delegated.start(
          session.id,
          "Explain the reviewed Space's rules.",
          await control(
            session,
            "START",
            "Explain the reviewed Space's rules.",
            now + 120,
          ),
        );
        expect(afterStart.state).toBe("ACTIVE");
        expect(afterStart.trades).toHaveLength(0);
        expect(afterStart.tradeCount).toBe(0);
        expect(wallet.signCalls).toBe(0);
        expect(wallet.actions).toHaveLength(0);
        expect(afterStart.lastResult).toBeTruthy();
      } finally {
        service.close();
      }
    },
  );

  it("authenticates Bob, persists a reservation, executes one 007 proposal, and does not duplicate", async () => {
    vi.useFakeTimers({ now: 200_000 });
    const service = new AurkaService();
    const responses = agentResponses();
    const fetchImpl = vi.fn(async () => completion(responses.shift() ?? []));
    const agent = new OpenRouterAgent(service, {
      apiKey: "delegated-test-key",
      model: "delegated-test-model",
      fetchImpl,
    });
    const wallet = new FakeDelegatedWallet();
    const now = 200;
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      now: () => now,
      trustedOwnerAddress: bob.address,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "100",
      cumulativeInputBudget: "100",
      maxTradeCount: 1,
      slippageBps: 1_000,
      expiresAt: now + 600,
      sessionNonce: `0x${"56".repeat(32)}`,
    };
    try {
      const session = await authorize(delegated, plan);
      expect(session.state).toBe("AUTHORIZED");
      const result = await delegated.start(
        session.id,
        "Make the reviewed one WETH to USDC trade.",
        await control(
          session,
          "START",
          "Make the reviewed one WETH to USDC trade.",
        ),
      );
      expect(result.state).toBe("ACTIVE");
      expect(result.trades).toHaveLength(1);
      expect(result.trades[0]?.status).toBe("SUBMITTED");
      expect(result.lastTransactionHash).toBe(
        wallet.actions[0] ? `0x${"ab".repeat(32)}` : undefined,
      );
      expect(
        service
          .listActivity({ limit: 20 })
          .items.find((item) => item.type === "SWAP"),
      ).toMatchObject({
        actor: agentAccount.address,
        trader: agentAccount.address,
        transactionHash: `0x${"ab".repeat(32)}`,
        status: "PENDING",
      });
      expect(wallet.actions).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(4);

      await expect(
        delegated.start(
          session.id,
          "Repeat the same trade.",
          await control(session, "START", "Repeat the same trade."),
        ),
      ).rejects.toThrow("pending; reconcile");
      expect(wallet.actions).toHaveLength(1);

      await delegated.stop(session.id, await control(session, "STOP"));
      wallet.receiptsAvailable = true;
      const recoveryNonce = `0x${"89".repeat(32)}`;
      const recoveryTypedData = delegatedRecoveryTypedData(
        plan,
        session.id,
        agentAccount.address,
        bob.address,
        [{ token: FIXTURE_ADDRESSES.weth, amount: "100" }],
        recoveryNonce,
      );
      const recoverySignature = await bob.signTypedData(
        recoveryTypedData as never,
      );
      const recovered = await delegated.recover(session.id, {
        destination: bob.address,
        assets: [{ token: FIXTURE_ADDRESSES.weth, amount: "100" }],
        recoveryNonce,
        signature: recoverySignature,
      });
      expect(recovered.lastRecoveryTransactionHash).toBe(
        `0x${"cd".repeat(32)}`,
      );
      expect(wallet.recoveries).toEqual([bob.address]);
      await expect(
        delegated.recover(session.id, {
          destination: bob.address,
          assets: [{ token: FIXTURE_ADDRESSES.weth, amount: "100" }],
          recoveryNonce,
          signature: recoverySignature,
        }),
      ).rejects.toThrow("already been consumed");
      await expect(
        delegated.start(
          session.id,
          "Trade after stop.",
          await control(session, "START", "Trade after stop."),
        ),
      ).rejects.toThrow("STOPPED");
      expect(wallet.actions).toHaveLength(1);
    } finally {
      service.close();
      vi.useRealTimers();
    }
  });

  it("rejects consent signed by the wrong owner and a Space outside the review", async () => {
    const service = new AurkaService();
    const wallet = new FakeDelegatedWallet();
    const unavailable: AgentProposalResponse = {
      status: "UNAVAILABLE",
      provider: "openrouter",
      model: "test",
      code: "MISSING_CONFIGURATION",
      reason: "Assistant setup is incomplete.",
      retryable: false,
      toolTrace: [],
    };
    const agent = {
      propose: async (): Promise<AgentProposalResponse> => unavailable,
    };
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      trustedOwnerAddress: bob.address,
    });
    const now = Math.floor(Date.now() / 1000);
    const base = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "1",
      cumulativeInputBudget: "1",
      maxTradeCount: 1,
      slippageBps: 50,
      expiresAt: now + 600,
      sessionNonce: `0x${"78".repeat(32)}`,
    } satisfies DelegatedSessionPlan;
    try {
      const wrongOwner = { ...base, ownerAddress: alice.address };
      const wrongSignature = await alice.signTypedData(
        delegatedAuthorizationTypedData(
          wrongOwner,
          agentAccount.address,
        ) as never,
      );
      await expect(
        delegated.authorize({
          plan: wrongOwner,
          agentWallet: agentAccount.address,
          signature: wrongSignature,
        }),
      ).rejects.toThrow("different authorized owner");

      const wrongSignerSignature = await alice.signTypedData(
        delegatedAuthorizationTypedData(base, agentAccount.address) as never,
      );
      await expect(
        delegated.authorize({
          plan: base,
          agentWallet: agentAccount.address,
          signature: wrongSignerSignature,
        }),
      ).rejects.toThrow("not signed by the owner");

      const outside = { ...base, allowedSpaceIds: ["space-not-reviewed"] };
      const outsideSignature = await bob.signTypedData(
        delegatedAuthorizationTypedData(outside, agentAccount.address) as never,
      );
      await expect(
        delegated.authorize({
          plan: outside,
          agentWallet: agentAccount.address,
          signature: outsideSignature,
        }),
      ).rejects.toThrow("Space was not found");

      const activeSession = await authorize(delegated, base);
      const activeRecoveryNonce = `0x${"90".repeat(32)}`;
      const activeRecoveryTypedData = delegatedRecoveryTypedData(
        base,
        activeSession.id,
        agentAccount.address,
        bob.address,
        [{ token: FIXTURE_ADDRESSES.weth, amount: "1" }],
        activeRecoveryNonce,
      );
      const activeRecoverySignature = await bob.signTypedData(
        activeRecoveryTypedData as never,
      );
      await expect(
        delegated.recover(activeSession.id, {
          destination: bob.address,
          assets: [{ token: FIXTURE_ADDRESSES.weth, amount: "1" }],
          recoveryNonce: activeRecoveryNonce,
          signature: activeRecoverySignature,
        }),
      ).rejects.toThrow("Stop and revoke");
      await delegated.stop(
        activeSession.id,
        await control(activeSession, "STOP", "", now + 120),
      );
      const wrongDestination = agentAccount.address;
      const wrongDestinationNonce = `0x${"91".repeat(32)}`;
      const wrongDestinationTypedData = delegatedRecoveryTypedData(
        base,
        activeSession.id,
        agentAccount.address,
        wrongDestination,
        [{ token: FIXTURE_ADDRESSES.weth, amount: "1" }],
        wrongDestinationNonce,
      );
      const wrongDestinationSignature = await bob.signTypedData(
        wrongDestinationTypedData as never,
      );
      await expect(
        delegated.recover(activeSession.id, {
          destination: wrongDestination,
          assets: [{ token: FIXTURE_ADDRESSES.weth, amount: "1" }],
          recoveryNonce: wrongDestinationNonce,
          signature: wrongDestinationSignature,
        }),
      ).rejects.toThrow("Bob's authorized owner address");
    } finally {
      service.close();
    }
  });

  it("rejects a 007 proposal that exceeds the delegated per-trade cap", async () => {
    vi.useFakeTimers({ now: 200_000 });
    const service = new AurkaService();
    const responses = agentResponses();
    const agent = new OpenRouterAgent(service, {
      apiKey: "delegated-cap-test-key",
      model: "delegated-cap-test-model",
      fetchImpl: vi.fn(async () => completion(responses.shift() ?? [])),
    });
    const wallet = new FakeDelegatedWallet();
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      now: () => 200,
      trustedOwnerAddress: bob.address,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "50",
      cumulativeInputBudget: "100",
      maxTradeCount: 1,
      slippageBps: 1_000,
      expiresAt: 800,
      sessionNonce: `0x${"92".repeat(32)}`,
    };
    try {
      const session = await authorize(delegated, plan);
      await expect(
        delegated.start(
          session.id,
          "Try an oversized trade.",
          await control(session, "START", "Try an oversized trade."),
        ),
      ).rejects.toThrow("per-trade input cap");
      expect(wallet.actions).toHaveLength(0);
    } finally {
      service.close();
      vi.useRealTimers();
    }
  });

  it("rejects a 007 proposal outside the reviewed slippage limit", async () => {
    vi.useFakeTimers({ now: 200_000 });
    const service = new AurkaService();
    const responses = agentResponses();
    const agent = new OpenRouterAgent(service, {
      apiKey: "delegated-slippage-test-key",
      model: "delegated-slippage-test-model",
      fetchImpl: vi.fn(async () => completion(responses.shift() ?? [])),
    });
    const wallet = new FakeDelegatedWallet();
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      now: () => 200,
      trustedOwnerAddress: bob.address,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "100",
      cumulativeInputBudget: "100",
      maxTradeCount: 1,
      slippageBps: 1,
      expiresAt: 800,
      sessionNonce: `0x${"93".repeat(32)}`,
    };
    try {
      const session = await authorize(delegated, plan);
      await expect(
        delegated.start(
          session.id,
          "Try a trade outside slippage.",
          await control(session, "START", "Try a trade outside slippage."),
        ),
      ).rejects.toThrow("slippage limit");
      expect(wallet.actions).toHaveLength(0);
    } finally {
      service.close();
      vi.useRealTimers();
    }
  });

  it("expires before signing and stops when the delegated signer is revoked", async () => {
    const service = new AurkaService();
    const wallet = new FakeDelegatedWallet();
    const agent = {
      propose: async (): Promise<AgentProposalResponse> => ({
        status: "UNAVAILABLE",
        provider: "openrouter",
        model: "test",
        code: "MISSING_CONFIGURATION",
        reason: "Assistant setup is incomplete.",
        retryable: false,
        toolTrace: [],
      }),
    };
    let now = 200;
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      now: () => now,
      trustedOwnerAddress: bob.address,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "1",
      cumulativeInputBudget: "1",
      maxTradeCount: 1,
      slippageBps: 50,
      expiresAt: 400,
      sessionNonce: `0x${"94".repeat(32)}`,
    };
    try {
      const session = await authorize(delegated, plan);
      now = 401;
      await expect(
        delegated.start(
          session.id,
          "Expired trade.",
          await control(session, "START", "Expired trade.", 500),
        ),
      ).rejects.toThrow("expired");
      expect(delegated.get(session.id).state).toBe("EXPIRED");

      now = 200;
      const second = await authorize(delegated, {
        ...plan,
        sessionNonce: `0x${"95".repeat(32)}`,
        expiresAt: 800,
      });
      wallet.revoked = true;
      await expect(
        delegated.start(
          second.id,
          "Revoked trade.",
          await control(second, "START", "Revoked trade."),
        ),
      ).rejects.toThrow("revoked or unavailable");
      expect(delegated.get(second.id).state).toBe("STOPPED");
    } finally {
      service.close();
    }
  });

  it("rejects unauthorized HTTP start and stop controls without changing session state", async () => {
    const service = new AurkaService();
    const wallet = new FakeDelegatedWallet();
    const agent = {
      propose: async (): Promise<AgentProposalResponse> => ({
        status: "UNAVAILABLE",
        provider: "openrouter",
        model: "test",
        code: "MISSING_CONFIGURATION",
        reason: "Assistant setup is incomplete.",
        retryable: false,
        toolTrace: [],
      }),
    };
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      trustedOwnerAddress: bob.address,
      now: () => 200,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "1",
      cumulativeInputBudget: "1",
      maxTradeCount: 1,
      slippageBps: 50,
      expiresAt: 800,
      sessionNonce: `0x${"96".repeat(32)}`,
    };
    const session = await authorize(delegated, plan);
    const handle = createApiServer({ service, delegated });
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("API did not bind");
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
      const start = await fetch(
        `${endpoint}/v1/delegated/sessions/${session.id}/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "attacker start",
            authorization: await control(
              session,
              "START",
              "attacker start",
              300,
              alice,
            ),
          }),
        },
      );
      expect(start.status).toBe(403);
      expect(await start.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_SIGNATURE" },
      });

      const stop = await fetch(
        `${endpoint}/v1/delegated/sessions/${session.id}/stop`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            authorization: await control(session, "STOP", "", 300, alice),
          }),
        },
      );
      expect(stop.status).toBe(403);
      expect(await stop.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_SIGNATURE" },
      });
      expect(delegated.get(session.id).state).toBe("AUTHORIZED");
    } finally {
      await closeApiServer(handle);
    }
  });

  it("commits Stop before an in-flight signing operation can publish a result", async () => {
    vi.useFakeTimers({ now: 200_000 });
    const service = new AurkaService();
    const responses = agentResponses();
    const agent = new OpenRouterAgent(service, {
      apiKey: "delegated-race-test-key",
      model: "delegated-race-test-model",
      fetchImpl: vi.fn(async () => completion(responses.shift() ?? [])),
    });
    const wallet = new FakeDelegatedWallet();
    let markStopCommitted!: () => void;
    const stopCommitted = new Promise<void>((resolve) => {
      markStopCommitted = resolve;
    });
    const stopSession = service.repository.stopDelegatedSession.bind(
      service.repository,
    );
    vi.spyOn(service.repository, "stopDelegatedSession").mockImplementation(
      (id, lastResult) => {
        const result = stopSession(id, lastResult);
        markStopCommitted();
        return result;
      },
    );
    let releaseSign!: () => void;
    wallet.signGate = new Promise((resolve) => {
      releaseSign = resolve;
    });
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      now: () => 200,
      trustedOwnerAddress: bob.address,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "100",
      cumulativeInputBudget: "100",
      maxTradeCount: 1,
      slippageBps: 1_000,
      expiresAt: 800,
      sessionNonce: `0x${"97".repeat(32)}`,
    };
    try {
      const session = await authorize(delegated, plan);
      const startPromise = delegated.start(
        session.id,
        "Race Stop against signing.",
        await control(session, "START", "Race Stop against signing."),
      );
      await wallet.signEntered;
      const stopPromise = delegated.stop(
        session.id,
        await control(session, "STOP"),
      );
      await stopCommitted;
      expect(delegated.get(session.id).state).toBe("STOPPED");
      releaseSign();
      await expect(startPromise).rejects.toThrow(/stopped/i);
      await stopPromise;
      expect(wallet.actions).toHaveLength(0);
      expect(delegated.get(session.id).state).toBe("STOPPED");
    } finally {
      service.close();
      vi.useRealTimers();
    }
  });

  it("claims a recovery authorization before invoking the owner transfer", async () => {
    const service = new AurkaService();
    const wallet = new FakeDelegatedWallet();
    const agent = {
      propose: async (): Promise<AgentProposalResponse> => ({
        status: "UNAVAILABLE",
        provider: "openrouter",
        model: "test",
        code: "MISSING_CONFIGURATION",
        reason: "Assistant setup is incomplete.",
        retryable: false,
        toolTrace: [],
      }),
    };
    const delegated = new DelegatedSessionService(service, agent, wallet, {
      now: () => 200,
      trustedOwnerAddress: bob.address,
    });
    const plan: DelegatedSessionPlan = {
      ownerAddress: bob.address,
      chainId: 31_337,
      allowedSpaceIds: [FIXTURE_POSITION_ID],
      traderInputToken: FIXTURE_ADDRESSES.weth,
      traderOutputToken: FIXTURE_ADDRESSES.usdc,
      perTradeInputAmount: "1",
      cumulativeInputBudget: "1",
      maxTradeCount: 1,
      slippageBps: 50,
      expiresAt: 800,
      sessionNonce: `0x${"98".repeat(32)}`,
    };
    let releaseRecovery!: () => void;
    wallet.recoverGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    try {
      const session = await authorize(delegated, plan);
      await delegated.stop(session.id, await control(session, "STOP"));
      const recoveryNonce = `0x${"99".repeat(32)}`;
      const assets = [{ token: FIXTURE_ADDRESSES.weth, amount: "1" }];
      const typedData = delegatedRecoveryTypedData(
        plan,
        session.id,
        agentAccount.address,
        bob.address,
        assets,
        recoveryNonce,
      );
      const signature = await bob.signTypedData(typedData as never);
      const request = {
        destination: bob.address,
        assets,
        recoveryNonce,
        signature,
      };
      const first = delegated.recover(session.id, request);
      await wallet.recoverEntered;
      await expect(delegated.recover(session.id, request)).rejects.toThrow(
        "already in flight",
      );
      releaseRecovery();
      await first;
      expect(wallet.recoveries).toHaveLength(1);
    } finally {
      service.close();
    }
  });
});
