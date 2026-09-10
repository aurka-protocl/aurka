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

  function atomicClient(trace) {
    const client = rpc();
    client.request = async () => trace;
    return client;
  }

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

  it.each([
    {
      name: "a planned inner call",
      trace: {
        type: "CALL",
        from: owner,
        calls: [
          {
            type: "CALL",
            from: owner,
            to: target,
            input: expected.data,
            value: "0x0",
            error: "execution reverted",
          },
          {
            type: "CALL",
            from: owner,
            to: owner,
            input: second.data,
            value: "0x0",
          },
        ],
      },
    },
    {
      name: "a reverted ancestor",
      trace: {
        type: "CALL",
        from: owner,
        error: "execution reverted",
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
      },
    },
    {
      name: "an outer-success inner failure envelope",
      trace: {
        type: "CALL",
        from: owner,
        calls: [
          {
            type: "CALL",
            from: owner,
            to: target,
            input: expected.data,
            value: "0x0",
            error: "execution reverted",
          },
          {
            type: "CALL",
            from: owner,
            to: owner,
            input: second.data,
            value: "0x0",
          },
        ],
      },
    },
  ])(
    "rejects $name even when the outer receipt succeeds",
    async ({ trace }) => {
      await expect(
        verifySpaceBatchReceipts(
          atomicClient(trace),
          31337,
          owner,
          [expected, second],
          [hash],
          "0",
        ),
      ).rejects.toThrow("reverted call or execution ancestor");
    },
  );

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

  it("keeps an activation batch valid after capacity is appended and a response is retried", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-batch-retry-"));
    const spaceId = "space:batch-retry";
    const nextHash = `0x${"66".repeat(32)}`;
    const steps = Array.from({ length: 10 }, (_, index) => ({
      label: `step-${index}`,
      transaction: {
        to: target,
        data: `0x${String(index + 1).padStart(4, "0")}`,
        value: "0x0",
      },
    }));
    const submittedSteps = steps.map((step) => ({
      ...step,
      transaction: { ...step.transaction },
    }));
    const client = rpc();
    client.request = async () => ({
      type: "CALL",
      from: owner,
      calls: submittedSteps.map(({ transaction }) => ({
        type: "CALL",
        from: owner,
        to: transaction.to,
        input: transaction.data,
        value: transaction.value,
      })),
    });
    client.getTransaction = async ({ hash: requested }) => ({
      from: owner,
      to: requested === nextHash ? second.to : target,
      input: requested === nextHash ? second.data : expected.data,
      value: 0n,
      chainId: 31337,
      blockHash,
    });
    client.getTransactionReceipt = async ({ hash: requested }) => ({
      status: "success",
      from: owner,
      to: requested === nextHash ? second.to : target,
      blockHash,
      blockNumber: requested === nextHash ? 11n : 10n,
    });
    const identity = {
      id: spaceId,
      mode: "fork",
      state: "DRAFT",
      ownerAddress: owner,
    };
    const draft = { ownerAddress: owner };
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      providers: new Map(),
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft }),
        repository: {
          setSpaceReceiptStatus: () => {},
          saveSpaceIdentity: (next) => Object.assign(identity, next),
        },
      },
    });
    lifecycle.plans[spaceId] = {
      definition: { positionId: spaceId },
      draft,
      treasury: target,
      minimumBlock: "0",
      complete: false,
      receipts: [],
      steps,
    };
    lifecycle.prepare = async () => ({ complete: false });
    try {
      await lifecycle.confirmBatch(spaceId, [hash], "ACTIVATE", "wallet-1");
      lifecycle.plans[spaceId].steps.push({
        label: "capacity",
        transaction: second,
      });
      lifecycle.plans[spaceId].receipts.push({
        hash: nextHash,
        blockHash,
        blockNumber: "11",
      });
      lifecycle.usedReceipts[nextHash] = true;
      await lifecycle.confirmBatch(spaceId, [hash], "ACTIVATE", "wallet-1");
      expect(lifecycle.plans[spaceId].batchPlan.coveredCount).toBe(10);
      expect(lifecycle.plans[spaceId].batchPlan.calls).toHaveLength(10);
      expect(lifecycle.plans[spaceId].receipts).toHaveLength(11);
      expect(lifecycle.plans[spaceId].receipts.at(-1).hash).toBe(nextHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an UPDATE batch valid after its separate reauthorization step is appended", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-update-batch-"));
    const spaceId = "space:update-batch";
    const nextHash = `0x${"77".repeat(32)}`;
    const updateSteps = [expected, second].map((transaction, index) => ({
      label: `update-${index}`,
      transaction,
    }));
    const submittedUpdateSteps = updateSteps.map((step) => ({
      ...step,
      transaction: { ...step.transaction },
    }));
    const client = rpc();
    client.request = async () => ({
      type: "CALL",
      from: owner,
      calls: submittedUpdateSteps.map(({ transaction }) => ({
        type: "CALL",
        from: owner,
        to: transaction.to,
        input: transaction.data,
        value: transaction.value,
      })),
    });
    client.getTransaction = async ({ hash: requested }) => ({
      from: owner,
      to: requested === nextHash ? target : target,
      input: requested === nextHash ? expected.data : expected.data,
      value: 0n,
      chainId: 31337,
      blockHash,
    });
    client.getTransactionReceipt = async ({ hash: requested }) => ({
      status: "success",
      from: owner,
      to: target,
      blockHash,
      blockNumber: requested === nextHash ? 11n : 10n,
    });
    const identity = {
      id: spaceId,
      mode: "fork",
      state: "ACTIVE",
      ownerAddress: owner,
      treasuryAddress: target,
    };
    const draft = { ownerAddress: owner };
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      providers: new Map(),
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft, position: {} }),
        repository: {
          setSpaceReceiptStatus: () => {},
          saveSpaceIdentity: (next) => Object.assign(identity, next),
        },
      },
    });
    lifecycle.operations[`${spaceId}:UPDATE`] = {
      definition: { positionId: spaceId },
      draft,
      treasury: target,
      operation: "UPDATE",
      minimumBlock: "0",
      complete: false,
      receipts: [],
      steps: updateSteps,
    };
    lifecycle.prepareOperation = async () => ({ complete: false });
    lifecycle.recordPolicyReceipt = async () => {};
    try {
      await lifecycle.confirmBatch(spaceId, [hash], "UPDATE", "wallet-2");
      lifecycle.operations[`${spaceId}:UPDATE`].steps.push({
        label: "capacity",
        transaction: expected,
      });
      lifecycle.operations[`${spaceId}:UPDATE`].receipts.push({
        hash: nextHash,
        blockHash,
        blockNumber: "11",
      });
      lifecycle.usedReceipts[nextHash] = true;
      await lifecycle.confirmBatch(spaceId, [hash], "UPDATE", "wallet-2");
      expect(
        lifecycle.operations[`${spaceId}:UPDATE`].batchPlan.coveredCount,
      ).toBe(2);
      expect(
        lifecycle.operations[`${spaceId}:UPDATE`].batchPlan.calls,
      ).toHaveLength(2);
      expect(lifecycle.operations[`${spaceId}:UPDATE`].receipts).toHaveLength(
        3,
      );
      expect(
        lifecycle.operations[`${spaceId}:UPDATE`].receipts.at(-1).hash,
      ).toBe(nextHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("verifies a complete atomic revert, records it, and permits a new batch identity", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-batch-revert-"));
    const spaceId = "space:batch-revert";
    const failedHash = `0x${"88".repeat(32)}`;
    const batchSteps = [expected, second].map((transaction, index) => ({
      label: `batch-${index}`,
      transaction,
    }));
    const identity = {
      id: spaceId,
      mode: "fork",
      state: "DRAFT",
      ownerAddress: owner,
    };
    const changes = [];
    const client = rpc({ receipt: { status: "reverted" } });
    client.request = async () => ({
      type: "CALL",
      from: owner,
      error: "execution reverted",
      calls: batchSteps.map(({ transaction }) => ({
        type: "CALL",
        from: owner,
        to: transaction.to,
        input: transaction.data,
        value: transaction.value,
      })),
    });
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft: { ownerAddress: owner } }),
        repository: {
          setSpaceReceiptStatus: () => {},
          saveSpaceIdentity: (next) => Object.assign(identity, next),
          saveSpaceChange: (change) => changes.push(change),
        },
      },
    });
    lifecycle.plans[spaceId] = {
      definition: { positionId: spaceId },
      draft: { ownerAddress: owner },
      complete: false,
      receipts: [],
      steps: batchSteps,
    };
    const offered = await lifecycle.prepare(spaceId);
    lifecycle.prepare = async () => ({ complete: false, step: 0 });
    const recovered = await lifecycle.reconcileBatch(
      spaceId,
      [failedHash],
      "ACTIVATE",
      "wallet-failed",
      offered.batchPlanId,
      offered.batchCommitment,
      true,
      500,
    );
    expect(recovered).toMatchObject({ complete: false });
    expect(lifecycle.plans[spaceId].receipts).toHaveLength(0);
    expect(lifecycle.plans[spaceId].batchPlan).toMatchObject({
      recovery: {
        outcome: "RETRYABLE_FULL_REVERT",
        walletBatchId: "wallet-failed",
      },
    });
    expect(lifecycle.plans[spaceId].batchPlan.walletBatchId).toBeUndefined();
    expect(changes).toContainEqual(
      expect.objectContaining({ status: "FAILED", receiptHash: failedHash }),
    );
    await expect(
      lifecycle.reconcileBatch(
        spaceId,
        [failedHash],
        "ACTIVATE",
        "wallet-failed",
        offered.batchPlanId,
        offered.batchCommitment,
        true,
        500,
      ),
    ).resolves.toMatchObject({ complete: false });
    expect(changes).toHaveLength(1);
    rmSync(directory, { recursive: true, force: true });
  });

  it("continues only from a verified successful direct prefix after a partial result", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-batch-prefix-"));
    const spaceId = "space:batch-prefix";
    const prefixHash = `0x${"99".repeat(32)}`;
    const steps = [
      expected,
      second,
      { to: target, data: "0xbeef", value: "0x0" },
    ].map((transaction, index) => ({ label: `step-${index}`, transaction }));
    const identity = {
      id: spaceId,
      mode: "fork",
      state: "DRAFT",
      ownerAddress: owner,
    };
    const client = rpc();
    client.getTransaction = async () => ({
      from: owner,
      to: expected.to,
      input: expected.data,
      value: 0n,
      chainId: 31337,
      blockHash,
    });
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft: { ownerAddress: owner } }),
        repository: {
          setSpaceReceiptStatus: () => {},
          saveSpaceIdentity: (next) => Object.assign(identity, next),
        },
      },
    });
    lifecycle.plans[spaceId] = {
      definition: { positionId: spaceId },
      draft: { ownerAddress: owner },
      complete: false,
      receipts: [],
      steps,
    };
    const offered = await lifecycle.prepare(spaceId);
    lifecycle.prepare = async () => ({ complete: false, step: 1 });
    await expect(
      lifecycle.reconcileBatch(
        spaceId,
        [prefixHash],
        "ACTIVATE",
        "wallet-partial",
        offered.batchPlanId,
        offered.batchCommitment,
        false,
        600,
      ),
    ).resolves.toMatchObject({ complete: false, step: 1 });
    expect(lifecycle.plans[spaceId].receipts).toHaveLength(1);
    expect(lifecycle.plans[spaceId].receipts[0].hash).toBe(prefixHash);
    expect(lifecycle.plans[spaceId].batchPlan.recovery).toMatchObject({
      outcome: "CONTINUED_SUCCESSFUL_PREFIX",
      recoveredCount: 1,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the failed batch when trace verification is unavailable", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-batch-outage-"));
    const spaceId = "space:batch-outage";
    const failedHash = `0x${"aa".repeat(32)}`;
    const identity = {
      id: spaceId,
      mode: "fork",
      state: "DRAFT",
      ownerAddress: owner,
    };
    const client = rpc({ receipt: { status: "reverted" } });
    client.request = async () => {
      throw new Error("RPC unavailable");
    };
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft: { ownerAddress: owner } }),
        repository: { setSpaceReceiptStatus: () => {} },
      },
    });
    lifecycle.plans[spaceId] = {
      definition: { positionId: spaceId },
      draft: { ownerAddress: owner },
      complete: false,
      receipts: [],
      steps: [
        { label: "one", transaction: expected },
        { label: "two", transaction: second },
      ],
    };
    const offered = await lifecycle.prepare(spaceId);
    lifecycle.plans[spaceId].batchPlan.walletBatchId = "wallet-outage";
    await expect(
      lifecycle.reconcileBatch(
        spaceId,
        [failedHash],
        "ACTIVATE",
        "wallet-outage",
        offered.batchPlanId,
        offered.batchCommitment,
        true,
        500,
      ),
    ).rejects.toThrow("cannot verify");
    expect(lifecycle.plans[spaceId].batchPlan.walletBatchId).toBe(
      "wallet-outage",
    );
    expect(lifecycle.plans[spaceId].batchPlan.recovery).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists an explicit repair state when a partial result includes a reverted call", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aurka-batch-repair-"));
    const spaceId = "space:batch-repair";
    const successHash = `0x${"ab".repeat(32)}`;
    const failedHash = `0x${"ac".repeat(32)}`;
    const steps = [
      expected,
      second,
      { to: target, data: "0xbeef", value: "0x0" },
    ].map((transaction, index) => ({ label: `step-${index}`, transaction }));
    const identity = {
      id: spaceId,
      mode: "fork",
      state: "DRAFT",
      ownerAddress: owner,
    };
    const client = rpc();
    client.getTransaction = async ({ hash: requested }) => ({
      from: owner,
      to: requested === successHash ? expected.to : second.to,
      input: requested === successHash ? expected.data : second.data,
      value: 0n,
      chainId: 31337,
      blockHash,
    });
    client.getTransactionReceipt = async ({ hash: requested }) => ({
      status: requested === successHash ? "success" : "reverted",
      from: owner,
      to: requested === successHash ? expected.to : second.to,
      blockHash,
      blockNumber: requested === successHash ? 10n : 11n,
    });
    const lifecycle = new ForkSpaceLifecycle({
      client,
      manifest: { chainId: 31337 },
      file: path.join(directory, "setup.json"),
      service: {
        getSpace: () => ({ identity, draft: { ownerAddress: owner } }),
        repository: {
          setSpaceReceiptStatus: () => {},
          saveSpaceIdentity: (next) => Object.assign(identity, next),
        },
      },
    });
    lifecycle.plans[spaceId] = {
      definition: { positionId: spaceId },
      draft: { ownerAddress: owner },
      complete: false,
      receipts: [],
      steps,
    };
    const offered = await lifecycle.prepare(spaceId);
    await expect(
      lifecycle.reconcileBatch(
        spaceId,
        [successHash, failedHash],
        "ACTIVATE",
        "wallet-repair",
        offered.batchPlanId,
        offered.batchCommitment,
        false,
        600,
      ),
    ).rejects.toThrow("manual repair");
    expect(lifecycle.plans[spaceId].receipts).toHaveLength(1);
    expect(lifecycle.plans[spaceId].batchPlan.recovery).toMatchObject({
      outcome: "REPAIR_REQUIRED",
      failedIndex: 1,
    });
    await expect(lifecycle.prepare(spaceId)).rejects.toThrow("manual repair");
    rmSync(directory, { recursive: true, force: true });
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
