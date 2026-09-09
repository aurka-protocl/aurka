import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  closeApiServer,
  createApiServer,
  listenApiServer,
} from "../src/api/server.js";
import { LocalDemoProvider, createCanonicalFixture } from "../src/fixture.js";
import { ServiceDatabase } from "../src/db/database.js";
import { AurkaService } from "../src/service.js";
import type { SpaceDraft } from "@aurka/shared";

const OWNER = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);
const ATTACKER = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000002",
);

function draft(ownerAddress: string, id = "space:independent"): SpaceDraft {
  return {
    id,
    name: "Independent allocation",
    ownerAddress,
    chainId: 31337,
    assets: [
      {
        token: "0x1111111111111111111111111111111111111111",
        symbol: "USDC",
        decimals: 0,
        minimumWeightBps: 5_000,
        maximumWeightBps: 10_000,
      },
      {
        token: "0x2222222222222222222222222222222222222222",
        symbol: "WETH",
        decimals: 0,
        minimumWeightBps: 0,
        maximumWeightBps: 5_000,
      },
    ],
    maximumTransactionValue: "5000",
  };
}

function forkDraft(owner: string, id: string): SpaceDraft {
  const value = draft(owner, id);
  return {
    ...value,
    assets: value.assets.map((asset, i) => ({
      ...asset,
      token:
        i === 0
          ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
          : "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      decimals: i === 0 ? 6 : 18,
    })),
  };
}

async function signedMutation(
  service: AurkaService,
  account: typeof OWNER,
  operation: "CREATE" | "ACTIVATE" | "UPDATE" | "PAUSE" | "RESUME",
  spaceId: string,
  value?: ReturnType<typeof draft>,
) {
  const prepared = service.prepareSpaceMutation({
    operation,
    spaceId,
    ownerAddress: account.address,
    ...(value ? { draft: value } : {}),
  });
  const signature = await account.signTypedData({
    domain: {
      ...prepared.typedData.domain,
      verifyingContract: prepared.typedData.domain
        .verifyingContract as `0x${string}`,
    },
    types: { SpaceMutation: prepared.typedData.types.SpaceMutation! },
    primaryType: "SpaceMutation",
    message: prepared.typedData.message,
  });
  return {
    operation,
    spaceId,
    ownerAddress: account.address,
    ...(value ? { draft: value } : {}),
    authorization: { ...prepared.authorization, signature },
  } as const;
}

describe("MVP-002 Space management", () => {
  it("uses the documented demo clock and refreshes source evidence", async () => {
    let now = 1_000;
    const service = new AurkaService({
      provider: new LocalDemoProvider(() => now),
      riskNow: () => now,
      seedFixture: true,
    });
    try {
      const before = service.getPosition("position:canonical");
      expect(before.currentPortfolio?.observedAt).toBe(1_000);
      now = 1_030;
      const refreshed = await service.refreshPosition("position:canonical");
      expect(refreshed.currentPortfolio?.observedAt).toBe(1_030);
      expect(refreshed.currentPortfolio?.blockNumber).toBe(
        before.currentPortfolio?.blockNumber,
      );
      expect(refreshed.currentPortfolio?.snapshotHash).toBe(
        before.currentPortfolio?.snapshotHash,
      );
    } finally {
      service.close();
    }
  });

  it("requires an authoritative provider when fork mode is explicitly configured", () => {
    expect(
      () =>
        new AurkaService({
          spaceMode: "fork",
          rpcTransport: { request: async () => "0x1" },
        }),
    ).toThrow("Fork/RPC mode requires a usable real snapshot provider");
  });

  it("fails refresh clearly when the authoritative source is unavailable", async () => {
    const service = new AurkaService({
      provider: {
        getPositionSnapshot: async () => {
          throw new Error("RPC offline");
        },
        getSnapshot: async () => {
          throw new Error("RPC offline");
        },
      },
      seedFixture: true,
    });
    try {
      await expect(
        service.refreshPosition("position:canonical"),
      ).rejects.toMatchObject({
        code: "SNAPSHOT_UNAVAILABLE",
        statusCode: 503,
      });
    } finally {
      service.close();
    }
  });

  it("never activates a fork Space without verified chain setup", async () => {
    let chainReads = 0;
    const service = new AurkaService({
      spaceMode: "fork",
      provider: {
        getPositionSnapshot: async () => {
          chainReads += 1;
          throw new Error("RPC offline");
        },
        getSnapshot: async () => {
          chainReads += 1;
          throw new Error("RPC offline");
        },
      },
      seedFixture: false,
    });
    const value = forkDraft(OWNER.address, "space:fork-unverified");
    try {
      const created = await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "CREATE", value.id, value),
      );
      expect(created.space.identity).toMatchObject({
        mode: "fork",
        state: "DRAFT",
      });

      expect(() =>
        service.prepareSpaceMutation({
          operation: "ACTIVATE",
          spaceId: value.id,
          ownerAddress: OWNER.address,
          draft: value,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "FORK_SPACE_CHAIN_OPERATION_UNSUPPORTED",
          statusCode: 501,
        }),
      );

      await expect(
        service.confirmSpaceMutation({
          operation: "ACTIVATE",
          spaceId: value.id,
          ownerAddress: OWNER.address,
          draft: value,
          receiptHash: `0x${"22".repeat(32)}`,
          authorization: {
            operation: "ACTIVATE",
            spaceId: value.id,
            ownerAddress: OWNER.address,
            payloadHash: `0x${"33".repeat(32)}`,
            nonce: "1",
            deadline: Math.floor(Date.now() / 1000) + 60,
            signature: `0x${"44".repeat(65)}`,
          },
        }),
      ).rejects.toMatchObject({
        code: "FORK_SPACE_CHAIN_OPERATION_UNSUPPORTED",
        statusCode: 501,
      });

      expect(service.getSpace(value.id).identity.state).toBe("DRAFT");
      expect(service.getSpace(value.id).position).toBeUndefined();
      expect(service.listSpaceChanges(value.id)).toHaveLength(1);
      expect(service.listSpaceChanges(value.id)[0]).toMatchObject({
        eventType: "SPACE_CREATED",
        status: "CONFIRMED",
      });
      expect(chainReads).toBe(0);
    } finally {
      service.close();
    }
  });

  it("keeps receipt-free activation confined to the labelled demo authority", async () => {
    const service = new AurkaService({
      spaceMode: "demo",
      provider: new LocalDemoProvider(),
      seedFixture: false,
    });
    const value = draft(OWNER.address, "space:demo-activation");
    try {
      await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "CREATE", value.id, value),
      );
      const activated = await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "ACTIVATE", value.id, value),
      );
      expect(activated.space.identity).toMatchObject({
        mode: "demo",
        state: "ACTIVE",
      });
      expect(activated.change).toMatchObject({
        eventType: "SPACE_ACTIVATED",
        status: "CONFIRMED",
      });
      expect(activated.change.receiptHash).toBeUndefined();

      const unverified = draft(OWNER.address, "space:demo-fake-receipt");
      await expect(
        service.confirmSpaceMutation({
          ...(await signedMutation(
            service,
            OWNER,
            "CREATE",
            unverified.id,
            unverified,
          )),
          receiptHash: `0x${"88".repeat(32)}`,
        }),
      ).rejects.toMatchObject({
        code: "UNVERIFIED_SPACE_RECEIPT",
        statusCode: 501,
      });
      expect(() => service.getSpace(unverified.id)).toThrowError(
        expect.objectContaining({ code: "SPACE_NOT_FOUND" }),
      );
    } finally {
      service.close();
    }
  });

  it("rejects unverified fork activation through the HTTP API", async () => {
    const service = new AurkaService({
      spaceMode: "fork",
      provider: {
        getPositionSnapshot: async () => {
          throw new Error("RPC offline");
        },
        getSnapshot: async () => {
          throw new Error("RPC offline");
        },
      },
      seedFixture: false,
    });
    const value = forkDraft(OWNER.address, "space:fork-api-unverified");
    await service.confirmSpaceMutation(
      await signedMutation(service, OWNER, "CREATE", value.id, value),
    );
    const handle = createApiServer({ service });
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const prepare = await fetch(`${base}/v1/spaces/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "ACTIVATE",
          spaceId: value.id,
          ownerAddress: OWNER.address,
          draft: value,
        }),
      });
      expect(prepare.status).toBe(501);
      expect(await prepare.json()).toMatchObject({
        ok: false,
        error: { code: "FORK_SPACE_CHAIN_OPERATION_UNSUPPORTED" },
      });

      const confirm = await fetch(`${base}/v1/spaces/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "ACTIVATE",
          spaceId: value.id,
          ownerAddress: OWNER.address,
          draft: value,
          receiptHash: `0x${"55".repeat(32)}`,
          authorization: {
            operation: "ACTIVATE",
            spaceId: value.id,
            ownerAddress: OWNER.address,
            payloadHash: `0x${"66".repeat(32)}`,
            nonce: "1",
            deadline: Math.floor(Date.now() / 1000) + 60,
            signature: `0x${"77".repeat(65)}`,
          },
        }),
      });
      expect(confirm.status).toBe(501);
      expect(await confirm.json()).toMatchObject({
        ok: false,
        error: { code: "FORK_SPACE_CHAIN_OPERATION_UNSUPPORTED" },
      });

      const stored = await fetch(
        `${base}/v1/spaces/${encodeURIComponent(value.id)}`,
      );
      expect(stored.status).toBe(200);
      expect(await stored.json()).toMatchObject({
        ok: true,
        data: { identity: { state: "DRAFT" } },
      });
    } finally {
      await closeApiServer(handle);
    }
  });

  it("blocks capacity when the authoritative snapshot is stale", async () => {
    const source = createCanonicalFixture({ nowSeconds: 1_000 });
    const staleSnapshot = {
      ...source.snapshot,
      priceProtection: {
        ...source.snapshot.priceProtection,
        nowSeconds: 1_200,
      },
    };
    const service = new AurkaService({
      provider: {
        getPositionSnapshot: async () => staleSnapshot,
        getSnapshot: async () => staleSnapshot,
      },
      riskNow: () => 1_200,
      seedFixture: true,
    });
    try {
      await expect(
        service.getCapacity(
          "position:canonical",
          source.snapshot.portfolio.assets[1]!.token,
          source.snapshot.portfolio.assets[0]!.token,
        ),
      ).rejects.toMatchObject({
        code: "SNAPSHOT_STALE",
        statusCode: 409,
      });
    } finally {
      service.close();
    }
  });

  it("persists independent draft, active, and policy states across restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-spaces-"));
    const filename = path.join(directory, "service.sqlite");
    try {
      const service = new AurkaService({
        database: new ServiceDatabase({ filename }),
        provider: new LocalDemoProvider(),
        seedFixture: true,
      });
      const value = draft(OWNER.address);
      const secondValue = draft(OWNER.address, "space:independent-two");
      const secondNamedValue = { ...secondValue, name: "Research allocation" };
      const created = await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "CREATE", value.id, value),
      );
      expect(created.space.identity.state).toBe("DRAFT");
      expect(created.space.position).toBeUndefined();

      const secondCreated = await service.confirmSpaceMutation(
        await signedMutation(
          service,
          OWNER,
          "CREATE",
          secondNamedValue.id,
          secondNamedValue,
        ),
      );
      expect(secondCreated.space.identity.name).toBe("Research allocation");
      expect(secondCreated.space.identity.policyId).not.toBe(
        created.space.identity.policyId,
      );

      const activated = await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "ACTIVATE", value.id, value),
      );
      expect(activated.space.identity.state).toBe("ACTIVE");
      expect(activated.space.position?.policy.id).toMatch(/^0x[0-9a-f]{64}$/);
      const secondActivated = await service.confirmSpaceMutation(
        await signedMutation(
          service,
          OWNER,
          "ACTIVATE",
          secondNamedValue.id,
          secondNamedValue,
        ),
      );
      expect(secondActivated.space.identity.state).toBe("ACTIVE");
      expect(secondActivated.space.position?.id).not.toBe(
        activated.space.position?.id,
      );
      const staleIntent = await service.prepareTokenIntent({
        positionId: secondNamedValue.id,
        trader: OWNER.address,
        traderInputToken: secondNamedValue.assets[1]!.token,
        traderOutputToken: secondNamedValue.assets[0]!.token,
        requestedTraderInputAmount: "1000",
        minimumTraderOutputValue: "0",
        nonce: "0",
        deadline: Math.floor(Date.now() / 1000) + 60,
      });
      const renamed = { ...secondNamedValue, name: "Research allocation v2" };
      const updated = await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "UPDATE", renamed.id, renamed),
      );
      expect(updated.space.identity.name).toBe("Research allocation v2");
      await expect(service.quote(staleIntent)).rejects.toThrow(
        "Local demo snapshot expired",
      );

      const paused = await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "PAUSE", value.id),
      );
      expect(paused.space.identity.state).toBe("PAUSED");
      expect(paused.space.position?.policy.paused).toBe(true);
      expect(service.getSpace(secondNamedValue.id).identity.state).toBe(
        "ACTIVE",
      );
      expect(
        service.listSpaces(20, undefined, OWNER.address).items,
      ).toHaveLength(2);
      expect(service.listSpaceChanges(value.id)).toHaveLength(3);
      service.close();

      const restarted = new AurkaService({
        database: new ServiceDatabase({ filename }),
        provider: new LocalDemoProvider(),
        seedFixture: false,
      });
      const restored = restarted.getSpace(value.id);
      expect(restored.identity.state).toBe("PAUSED");
      expect(restored.position?.policy.paused).toBe(true);
      expect(restored.identity.ownerAddress.toLowerCase()).toBe(
        OWNER.address.toLowerCase(),
      );
      expect(restarted.getSpace(secondNamedValue.id).identity.state).toBe(
        "ACTIVE",
      );
      const restoredRulesFirst = restarted.listActivity({
        spaceId: value.id,
        type: "RULE_CHANGE",
        limit: 1,
      });
      expect(restoredRulesFirst.items).toHaveLength(1);
      expect(restoredRulesFirst.nextCursor).not.toBeNull();
      const restoredRulesSecond = restarted.listActivity({
        spaceId: value.id,
        type: "RULE_CHANGE",
        limit: 1,
        cursor: restoredRulesFirst.nextCursor ?? undefined,
      });
      expect(restoredRulesSecond.items).toHaveLength(1);
      expect(restoredRulesSecond.items[0]?.id).not.toBe(
        restoredRulesFirst.items[0]?.id,
      );
      const restoredIntent = await restarted.provider.prepareTokenIntent!({
        positionId: secondNamedValue.id,
        trader: OWNER.address,
        traderInputToken: secondNamedValue.assets[1]!.token,
        traderOutputToken: secondNamedValue.assets[0]!.token,
        requestedTraderInputAmount: "1000",
        minimumTraderOutputValue: "0",
        nonce: "0",
        deadline: Math.floor(Date.now() / 1000) + 60,
      });
      expect(restoredIntent.positionIdHash).toMatch(/^0x[0-9a-f]{64}$/);
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects signatures from another wallet, altered drafts, and replays", async () => {
    const service = new AurkaService({ seedFixture: true });
    try {
      const value = draft(OWNER.address, "space:auth-bound");
      expect(() =>
        service.prepareSpaceMutation({
          operation: "CREATE",
          spaceId: value.id,
          ownerAddress: OWNER.address,
          draft: {
            ...value,
            assets: [{ ...value.assets[0]!, decimals: 18 }, value.assets[1]!],
          },
        }),
      ).toThrow("decimal places");
      const prepared = service.prepareSpaceMutation({
        operation: "CREATE",
        spaceId: value.id,
        ownerAddress: OWNER.address,
        draft: value,
      });
      const attackerSignature = await ATTACKER.signTypedData({
        domain: {
          ...prepared.typedData.domain,
          verifyingContract: prepared.typedData.domain
            .verifyingContract as `0x${string}`,
        },
        types: { SpaceMutation: prepared.typedData.types.SpaceMutation! },
        primaryType: "SpaceMutation",
        message: prepared.typedData.message,
      });
      await expect(
        service.confirmSpaceMutation({
          operation: "CREATE",
          spaceId: value.id,
          ownerAddress: OWNER.address,
          draft: value,
          authorization: {
            ...prepared.authorization,
            signature: attackerSignature,
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_AUTHORIZATION" });

      const signed = await signedMutation(
        service,
        OWNER,
        "CREATE",
        value.id,
        value,
      );
      await expect(
        service.confirmSpaceMutation({
          ...signed,
          draft: { ...value, name: "Altered" },
        }),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_MISMATCH" });
      await service.confirmSpaceMutation(signed);
      await expect(service.confirmSpaceMutation(signed)).rejects.toMatchObject({
        code: "SPACE_ALREADY_EXISTS",
      });
    } finally {
      service.close();
    }
  });

  it("serves the signed lifecycle through the API after the prepare clock advances", async () => {
    let now = 10_000;
    const service = new AurkaService({ seedFixture: true, riskNow: () => now });
    const handle = createApiServer({ service });
    await listenApiServer(handle, 0);
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("API did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const value = draft(OWNER.address, "space:api-lifecycle");
      const signed = await signedMutation(
        service,
        OWNER,
        "CREATE",
        value.id,
        value,
      );
      now += 2;
      const response = await fetch(`${base}/v1/spaces/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "space-api-create-1",
        },
        body: JSON.stringify(signed),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          space: { identity: { state: string } };
          change: { eventType: string };
        };
      };
      expect(body.data.space.identity.state).toBe("DRAFT");
      expect(body.data.change.eventType).toBe("SPACE_CREATED");

      const replay = await fetch(`${base}/v1/spaces/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "space-api-create-1",
        },
        body: JSON.stringify(signed),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(body);

      const listed = await fetch(
        `${base}/v1/spaces?ownerAddress=${encodeURIComponent(OWNER.address)}`,
      );
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as {
        data: { items: Array<{ identity: { id: string } }> };
      };
      expect(
        listedBody.data.items.some((item) => item.identity.id === value.id),
      ).toBe(true);

      const activity = await fetch(
        `${base}/v1/activity?spaceId=${encodeURIComponent(value.id)}&type=RULE_CHANGE`,
      );
      expect(activity.status).toBe(200);
      const activityBody = (await activity.json()) as {
        data: {
          items: Array<{
            type: string;
            eventType: string;
            spaceId: string;
            traderInputToken?: string;
          }>;
        };
      };
      expect(activityBody.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "RULE_CHANGE",
            eventType: "SPACE_CREATED",
            spaceId: value.id,
          }),
        ]),
      );
      expect(activityBody.data.items[0]).not.toHaveProperty("traderInputToken");
    } finally {
      await closeApiServer(handle);
    }
  });

  it("projects durable Space changes into typed global activity", async () => {
    const service = new AurkaService({ seedFixture: true });
    const value = draft(OWNER.address, "space:activity");
    try {
      await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "CREATE", value.id, value),
      );
      const created = service.listActivity({
        spaceId: value.id,
        type: "RULE_CHANGE",
        limit: 20,
      });
      expect(created.items[0]).toMatchObject({
        type: "RULE_CHANGE",
        eventType: "SPACE_CREATED",
        spaceId: value.id,
        spaceName: value.name,
        status: "CONFIRMED",
        source: "SPACE_CHANGE",
        state: "DRAFT",
        actor: OWNER.address,
      });
      expect(created.items[0]).not.toHaveProperty("traderInputToken");
      expect(created.items[0]).not.toHaveProperty("transactionHash");

      await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "ACTIVATE", value.id, value),
      );
      await service.confirmSpaceMutation(
        await signedMutation(service, OWNER, "PAUSE", value.id),
      );
      const status = service.listActivity({
        spaceId: value.id,
        type: "TRADING_STATUS",
        status: "CONFIRMED",
        limit: 20,
      });
      expect(status.items[0]).toMatchObject({
        type: "TRADING_STATUS",
        eventType: "SPACE_PAUSED",
        state: "PAUSED",
        spaceName: value.name,
      });
      expect(
        service.listActivity({
          spaceId: value.id,
          type: "RULE_CHANGE",
          from: 0,
          to: Math.floor(Date.now() / 1000),
          limit: 20,
        }).items,
      ).toHaveLength(2);
      expect(
        service.listActivity({
          spaceId: "space:missing",
          limit: 20,
        }).items,
      ).toHaveLength(0);
    } finally {
      service.close();
    }
  });
});
