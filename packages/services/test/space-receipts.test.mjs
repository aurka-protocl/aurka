import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ForkSpaceLifecycle,
  verifySpaceBatchReceipts,
  verifySpaceReceipt,
} from "../scripts/fork-space-lifecycle.mjs";
const owner = `0x${"11".repeat(20)}`;
const target = `0x${"22".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`;
const blockHash = `0x${"44".repeat(32)}`;
const expected = { to: target, data: "0x1234", value: "0x0" };
function rpc(overrides = {}) {
  const receipt = {
    status: "success",
    from: owner,
    to: target,
    blockHash,
    blockNumber: 10n,
    ...overrides.receipt,
  };
  const transaction = {
    from: owner,
    to: target,
    input: expected.data,
    value: 0n,
    chainId: 31337,
    blockHash,
    ...overrides.transaction,
  };
  return {
    getChainId: async () => overrides.chainId ?? 31337,
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: overrides.blockHash ?? blockHash }),
  };
}
describe("fork Space receipt authority", () => {
  it("accepts only the canonical successful owner transaction for the exact plan", async () => {
    await expect(
      verifySpaceReceipt(rpc(), 31337, owner, expected, hash),
    ).resolves.toMatchObject({ status: "success" });
  });
  it.each([
    { receipt: { status: "reverted" } },
    { transaction: { from: target } },
    { receipt: { from: target } },
    { transaction: { to: owner } },
    { transaction: { input: "0xabcd" } },
    { transaction: { value: 1n } },
    { transaction: { chainId: 1 } },
    { chainId: 1 },
    { blockHash: hash },
    { transaction: { blockHash: hash } },
  ])(
    "rejects failed, unrelated, unauthorized and orphaned evidence: %#",
    async (overrides) => {
      await expect(
        verifySpaceReceipt(rpc(overrides), 31337, owner, expected, hash),
      ).rejects.toThrow();
    },
  );
  it("does not treat an unavailable receipt as success", async () => {
    const client = rpc();
    client.getTransactionReceipt = async () => {
      throw new Error("Receipt not found");
    };
    await expect(
      verifySpaceReceipt(client, 31337, owner, expected, hash),
    ).rejects.toThrow("Receipt not found");
  });
});

describe("atomic Space batch receipt authority", () => {
  const second = { to: owner, data: "0xabcd", value: "0x0" };

  it("accepts one canonical receipt only when its owner calls exactly match the plan", async () => {
    const client = rpc();
    client.request = async () => ({
      type: "CALL",
      from: owner,
      to: owner,
      input: "0xwallet",
      value: "0x0",
      calls: [
        {
          type: "CALL",
          from: owner,
          to: target,
          input: expected.data,
          value: "0x0",
        },
        {
          type: "CALL",
          from: owner,
          to: owner,
          input: second.data,
          value: "0x0",
        },
      ],
    });
    await expect(
      verifySpaceBatchReceipts(
        client,
        31337,
        owner,
        [expected, second],
        [hash],
        "0",
      ),
    ).resolves.toHaveLength(1);
  });

  it("rejects altered or additional owner calls inside one atomic receipt", async () => {
    const client = rpc();
    client.request = async () => ({
      type: "CALL",
      from: owner,
      to: owner,
      calls: [
        {
          type: "CALL",
          from: owner,
          to: target,
          input: expected.data,
          value: "0x0",
        },
        {
          type: "CALL",
          from: owner,
          to: owner,
          input: second.data,
          value: "0x0",
        },
        { type: "CALL", from: owner, to: owner, input: "0xdead", value: "0x0" },
      ],
    });
    await expect(
      verifySpaceBatchReceipts(
        client,
        31337,
        owner,
        [expected, second],
        [hash],
        "0",
      ),
    ).rejects.toThrow("exactly the reviewed");
  });

  it("accepts one direct canonical receipt for each reviewed call", async () => {
    const nextHash = `0x${"55".repeat(32)}`;
    const client = rpc();
    const selected = (requested) => (requested === hash ? expected : second);
    client.getTransaction = async ({ hash: requested }) => ({
      from: owner,
      to: selected(requested).to,
      input: selected(requested).data,
      value: 0n,
      chainId: 31337,
      blockHash,
    });
    client.getTransactionReceipt = async ({ hash: requested }) => ({
      status: "success",
      from: owner,
      to: selected(requested).to,
      blockHash,
      blockNumber: 10n,
    });
    await expect(
      verifySpaceBatchReceipts(
        client,
        31337,
        owner,
        [expected, second],
        [hash, nextHash],
        "0",
      ),
    ).resolves.toHaveLength(2);
  });
});

describe("Space setup recovery", () => {
  it("downgrades orphaned activation, preserves replay protection and resumes the missing step", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-receipt-"));
    const identity = { id: "space:reorg", state: "ACTIVE" };
    const statuses = [];
    const client = rpc({ blockHash: hash });
    client.getBlockNumber = async () => 10n;
    const providers = new Map([[identity.id, {}]]);
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      providers,
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft: { ownerAddress: owner } }),
        repository: {
          saveSpaceIdentity: (next) => Object.assign(identity, next),
          setSpaceReceiptStatus: (_id, hashes, status) =>
            statuses.push({ hashes, status }),
        },
      },
    });
    const plan = {
      definition: { positionId: identity.id },
      draft: { ownerAddress: owner },
      complete: true,
      receipts: [{ hash, blockHash, blockNumber: "10" }],
      steps: [{ label: "Create treasury", transaction: expected }],
    };
    lifecycle.plans[identity.id] = plan;
    lifecycle.usedReceipts[hash] = true;
    try {
      await expect(lifecycle.reconcile(plan)).rejects.toThrow("canonical");
      expect(identity.state).toBe("FAILED");
      expect(providers.has(identity.id)).toBe(false);
      expect(plan.receipts).toHaveLength(0);
      expect(plan.complete).toBe(false);
      expect(lifecycle.usedReceipts[hash]).toBe(true);
      expect(statuses).toContainEqual({ hashes: [hash], status: "FAILED" });
      const next = await lifecycle.prepare(identity.id);
      expect(next).toMatchObject({ complete: false, step: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects replay before mutation and records an intended reverted transaction without advancing setup", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-replay-"));
    const identity = { id: "space:retry", state: "DRAFT" };
    const draft = { ownerAddress: owner };
    const changes = [];
    const lifecycle = new ForkSpaceLifecycle({
      client: rpc({ receipt: { status: "reverted" } }),
      manifest: { chainId: 31337 },
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft }),
        repository: {
          saveSpaceIdentity: (next) => Object.assign(identity, next),
          setSpaceReceiptStatus: () => {},
          saveSpaceChange: (change) => changes.push(change),
        },
      },
    });
    const plan = {
      definition: { positionId: identity.id },
      draft,
      complete: false,
      receipts: [],
      minimumBlock: "0",
      steps: [{ label: "Create treasury", transaction: expected }],
    };
    lifecycle.plans[identity.id] = plan;
    try {
      lifecycle.usedReceipts[hash] = true;
      await expect(lifecycle.confirm(identity.id, 0, hash)).rejects.toThrow(
        "already been used",
      );
      expect(identity.state).toBe("DRAFT");
      expect(changes).toHaveLength(0);
      delete lifecycle.usedReceipts[hash];
      await expect(lifecycle.confirm(identity.id, 0, hash)).rejects.toThrow(
        "reverted",
      );
      expect(identity.state).toBe("FAILED");
      expect(plan.receipts).toHaveLength(0);
      expect(changes).toContainEqual(
        expect.objectContaining({ status: "FAILED", receiptHash: hash }),
      );
      expect(await lifecycle.prepare(identity.id)).toMatchObject({
        complete: false,
        step: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a successful transaction mined before preparation", async () => {
    await expect(
      verifySpaceReceipt(rpc(), 31337, owner, expected, hash, "10"),
    ).rejects.toThrow("predates");
  });
});
