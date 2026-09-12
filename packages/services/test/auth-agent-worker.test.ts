import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { tradingAgentSchema } from "@aurka/shared";

import { AuthService } from "../src/api/auth.js";
import { ServiceDatabase } from "../src/db/database.js";
import { ServiceRepository } from "../src/db/repository.js";

const chainId = 11_155_111;
const origin = "http://127.0.0.1:3002";
const owner = privateKeyToAccount(`0x${"91".repeat(32)}`);

function request(cookie?: string) {
  return {
    headers: cookie ? { cookie } : {},
  } as never;
}

function agent(ownerAddress: string, id: string) {
  return tradingAgentSchema.parse({
    id,
    ownerAddress,
    chainId,
    walletId: `wallet-${id}`,
    walletAddress: `0x${"ab".repeat(20)}`,
    signerId: "signer-test",
    policyId: "policy-test",
    recoveryPolicyId: "recovery-test",
    state: "READY",
    fundingJson: { eth: "0", usdc: "0", weth: "0", transactions: [] },
    mandateJson: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("per-user agent foundations", () => {
  it("authenticates a Sepolia wallet once and rejects replay and origin changes", async () => {
    const database = new ServiceDatabase();
    const repository = new ServiceRepository(database.db);
    const auth = new AuthService(repository, 3_600, chainId);
    const challenge = auth.challenge({
      address: owner.address,
      chainId,
      origin,
    });
    expect(
      (challenge.typedData.message as Record<string, unknown>).expiresAt,
    ).toBeTypeOf("number");
    expect(
      (challenge.typedData as { types: Record<string, unknown> }).types
        .EIP712Domain,
    ).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
    const signature = await owner.signTypedData(challenge.typedData as never);
    const input = {
      challengeId: challenge.challengeId,
      address: owner.address,
      chainId,
      signature,
    };

    await expect(
      auth.verify(input, "http://localhost:3002"),
    ).rejects.toMatchObject({
      code: "AUTH_ORIGIN_MISMATCH",
    });
    await expect(auth.verify(input, origin)).rejects.toMatchObject({
      code: "AUTH_CHALLENGE_INVALID",
    });

    const second = auth.challenge({ address: owner.address, chainId, origin });
    const secondSignature = await owner.signTypedData(
      second.typedData as never,
    );
    const result = await auth.verify(
      {
        challengeId: second.challengeId,
        address: owner.address,
        chainId,
        signature: secondSignature,
      },
      origin,
    );
    const firstCookie = auth.cookie(result.token);
    expect(auth.authenticate(request(firstCookie))).toEqual({
      ownerAddress: owner.address.toLowerCase(),
      chainId,
      expiresAt: result.session.expiresAt,
    });
    expect(auth.clearCookie(request(firstCookie))).toContain("Max-Age=0");
    expect(() => auth.authenticate(request(firstCookie))).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
    await expect(
      auth.verify(
        {
          challengeId: second.challengeId,
          address: owner.address,
          chainId,
          signature: secondSignature,
        },
        origin,
      ),
    ).rejects.toMatchObject({ code: "AUTH_CHALLENGE_INVALID" });

    expect(() =>
      auth.challenge({ address: owner.address, chainId: 31_337, origin }),
    ).toThrow(expect.objectContaining({ code: "CHAIN_MISMATCH" }));
    database.close();
  });

  it("normalizes owner and agent-wallet addresses for durable lookups", () => {
    const database = new ServiceDatabase();
    const repository = new ServiceRepository(database.db);
    const value = agent(
      `0x${owner.address.slice(2).toUpperCase()}`,
      "agent-case",
    );
    repository.saveTradingAgent(value);
    expect(repository.getTradingAgent(owner.address, chainId)?.id).toBe(
      "agent-case",
    );
    expect(
      repository.getTradingAgentByWalletAddress(
        `0x${value.walletAddress.slice(2).toUpperCase()}`,
      )?.id,
    ).toBe("agent-case");
    expect(
      repository.getTradingAgent(`0x${"92".repeat(20)}`, chainId),
    ).toBeUndefined();
    database.close();
  });

  it("keeps one durable provisioning checkpoint across retries and records provider IDs", () => {
    const database = new ServiceDatabase();
    const repository = new ServiceRepository(database.db);
    const first = repository.reserveAgentProvisioning({
      id: "provisioning-1",
      ownerAddress: owner.address,
      chainId,
      idempotencyKey: `agent-${owner.address.toLowerCase()}-${chainId}`,
    });
    expect(first.state).toBe("PROVISIONING");
    expect(
      repository.claimAgentProvisioning("provisioning-1", "worker-a", 100, 10),
    ).toBe(true);
    expect(
      repository.claimAgentProvisioning("provisioning-1", "worker-b", 200, 99),
    ).toBe(false);
    expect(
      repository.claimAgentProvisioning("provisioning-1", "worker-b", 300, 100),
    ).toBe(true);
    expect(
      repository.reserveAgentProvisioning({
        id: "provisioning-2",
        ownerAddress: owner.address.toUpperCase() as `0x${string}`,
        chainId,
        idempotencyKey: "a-different-retry-key",
      }).id,
    ).toBe("provisioning-1");
    repository.updateAgentProvisioning("provisioning-1", {
      recoveryPolicyId: "policy-user-1",
      walletId: "wallet-user-1",
      walletAddress: "0x1234567890123456789012345678901234567890",
      state: "READY",
    });
    expect(
      repository.getAgentProvisioning(owner.address, chainId),
    ).toMatchObject({
      id: "provisioning-1",
      recoveryPolicyId: "policy-user-1",
      walletId: "wallet-user-1",
      state: "READY",
    });
    database.close();
  });

  it("serializes delegated worker leases and releases only its own lease", () => {
    const database = new ServiceDatabase();
    const repository = new ServiceRepository(database.db);
    expect(
      repository.claimDelegatedWorkerLease("session-1", "worker-a", 20, 10),
    ).toBe(true);
    expect(
      repository.claimDelegatedWorkerLease("session-1", "worker-b", 20, 11),
    ).toBe(false);
    repository.releaseDelegatedWorkerLease("session-1", "worker-b");
    expect(
      repository.claimDelegatedWorkerLease("session-1", "worker-a", 30, 12),
    ).toBe(true);
    expect(
      repository.claimDelegatedWorkerLease("session-1", "worker-b", 40, 31),
    ).toBe(true);
    database.close();
  });

  it("keeps faucet reservations idempotent and enforces a durable global budget", () => {
    const database = new ServiceDatabase();
    const repository = new ServiceRepository(database.db);
    const maximum = { ethAmount: "100", usdcAmount: "1000", wethAmount: "50" };
    const first = {
      id: "funding-1",
      agentId: "agent-1",
      ownerAddress: owner.address,
      chainId,
      ethAmount: "10",
      usdcAmount: "500",
      wethAmount: "25",
      maximum,
    };
    expect(repository.reserveAgentFunding(first)).toBe(true);
    expect(repository.getPendingAgentFunding("agent-1")?.id).toBe("funding-1");
    expect(
      repository.reserveAgentFunding({ ...first, id: "funding-retry" }),
    ).toBe(true);
    expect(
      repository.reserveAgentFunding({
        ...first,
        id: "funding-2",
        agentId: "agent-2",
        ethAmount: "1",
        usdcAmount: "501",
        wethAmount: "25",
      }),
    ).toBe(false);
    repository.completeAgentFunding("funding-1");
    expect(repository.getPendingAgentFunding("agent-1")).toBeUndefined();
    database.close();
  });
});
