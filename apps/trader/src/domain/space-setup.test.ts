import { describe, expect, it, vi } from "vitest";
import { activateTestnetSpace, parseSendCallsResult } from "./space-setup";

describe("wallet call result parsing", () => {
  it("accepts the standard SendCallsResult object", () => {
    expect(parseSendCallsResult({ id: "wallet-batch-1" })).toBe(
      "wallet-batch-1",
    );
  });

  it.each(["wallet-batch-1", {}, { id: "" }, { id: 12 }, null])(
    "rejects malformed result %#",
    (result) => {
      expect(() => parseSendCallsResult(result)).toThrow("malformed");
    },
  );
});

describe("atomic Space setup recovery", () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const calls = [
    {
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: "0x0",
    },
    {
      to: "0x3333333333333333333333333333333333333333",
      data: "0xabcd",
      value: "0x0",
    },
  ];
  const prepare = {
    complete: false,
    ownerAddress: owner,
    treasury: calls[0].to,
    step: 0,
    total: 11,
    label: "Create isolated treasury",
    transaction: calls[0],
    batch: calls,
    batchPlanId: "plan-1",
    batchCommitment: "commitment-1",
  };

  function storage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  }

  it("uses the standard object result and confirms one atomic receipt", async () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    const requests: { method: string; params?: unknown[] }[] = [];
    const provider = {
      request: vi.fn(async (input: { method: string; params?: unknown[] }) => {
        requests.push(input);
        if (input.method === "eth_chainId") return "0x7a69";
        if (input.method === "eth_accounts") return [owner];
        if (input.method === "wallet_getCapabilities")
          return { "0x7a69": { atomic: { status: "ready" } } };
        if (input.method === "wallet_sendCalls")
          return { id: "wallet-batch-1" };
        if (input.method === "wallet_getCallsStatus")
          return {
            id: "wallet-batch-1",
            chainId: "0x7a69",
            status: 200,
            atomic: true,
            receipts: [
              { transactionHash: `0x${"44".repeat(32)}`, status: "0x1" },
            ],
          };
        throw new Error(`Unexpected provider method ${input.method}`);
      }),
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () =>
            body.batch ? { complete: true, space: { identity: {} } } : prepare,
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      activateTestnetSpace("space:one", owner, provider, () => {}),
    ).resolves.toMatchObject({ identity: {} });
    expect(
      requests.some(
        ({ method, params }) =>
          method === "wallet_sendCalls" &&
          (params?.[0] as { atomicRequired?: boolean }).atomicRequired === true,
      ),
    ).toBe(true);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      atomic: true,
      batchId: "wallet-batch-1",
      batchPlanId: "plan-1",
      batchCommitment: "commitment-1",
    });
    expect(
      local.getItem(
        "aurka:space-setup:31337:0x1111111111111111111111111111111111111111:space:one:ACTIVATE:batch",
      ),
    ).toBeNull();
  });

  it("keeps a possibly partially executed terminal batch for reconciliation", async () => {
    const local = storage();
    const key =
      "aurka:space-setup:31337:0x1111111111111111111111111111111111111111:space:partial:ACTIVATE";
    local.setItem(
      `${key}:batch`,
      JSON.stringify({
        id: "wallet-batch-2",
        planId: "plan-1",
        commitment: "commitment-1",
        spaceId: "space:partial",
        operation: "ACTIVATE",
        owner,
        chainId: 31337,
      }),
    );
    vi.stubGlobal("localStorage", local);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_accounts") return [owner];
        if (method === "wallet_getCallsStatus")
          return {
            id: "wallet-batch-2",
            chainId: "0x7a69",
            status: 600,
            atomic: true,
            receipts: [
              {
                transactionHash: `0x${"55".repeat(32)}`,
                status: "0x0",
              },
            ],
          };
        throw new Error(`Unexpected provider method ${method}`);
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.status === 600)
          return {
            ok: false,
            json: async () => ({
              error: "The testnet RPC cannot verify the partial batch.",
            }),
          };
        return {
          ok: true,
          json: async () => ({
            ...prepare,
            batch: undefined,
            batchPlanId: "plan-1",
            batchCommitment: "commitment-1",
          }),
        };
      }),
    );

    await expect(
      activateTestnetSpace("space:partial", owner, provider, () => {}),
    ).rejects.toThrow("testnet RPC cannot verify");
    expect(local.getItem(`${key}:batch`)).not.toBeNull();
  });

  it("clears a batch only after the server verifies a full revert and retries with a new id", async () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    let batchSubmission = 1;
    const requests: string[] = [];
    const provider = {
      request: vi.fn(async (input: { method: string; params?: unknown[] }) => {
        requests.push(input.method);
        if (input.method === "eth_chainId") return "0x7a69";
        if (input.method === "eth_accounts") return [owner];
        if (input.method === "wallet_getCallsStatus")
          return {
            id:
              String(input.params?.[0]) === "wallet-batch-3"
                ? "wallet-batch-3"
                : "wallet-batch-2",
            chainId: "0x7a69",
            status: String(input.params?.[0]) === "wallet-batch-3" ? 200 : 500,
            atomic: true,
            receipts: [
              {
                transactionHash: `0x${"55".repeat(32)}`,
                status:
                  String(input.params?.[0]) === "wallet-batch-3"
                    ? "0x1"
                    : "0x0",
              },
            ],
          };
        if (input.method === "wallet_getCapabilities")
          return { "0x7a69": { atomic: { status: "ready" } } };
        if (input.method === "wallet_sendCalls") {
          batchSubmission += 1;
          return {
            id: batchSubmission === 1 ? "wallet-batch-2" : "wallet-batch-3",
          };
        }
        throw new Error(`Unexpected provider method ${input.method}`);
      }),
    };
    local.setItem(
      "aurka:space-setup:31337:0x1111111111111111111111111111111111111111:space:retry:ACTIVATE:batch",
      JSON.stringify({
        id: "wallet-batch-2",
        planId: "plan-1",
        commitment: "commitment-1",
        spaceId: "space:retry",
        operation: "ACTIVATE",
        owner,
        chainId: 31337,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(
          body.status
            ? `reconcile:${body.status}`
            : body.batch
              ? "confirm"
              : "prepare",
        );
        if (body.status === 500)
          return {
            ok: true,
            json: async () => ({ ...prepare, batch: calls }),
          };
        if (body.batch)
          return {
            ok: true,
            json: async () => ({ complete: true, space: { identity: {} } }),
          };
        return { ok: true, json: async () => ({ ...prepare, batch: calls }) };
      }),
    );

    await expect(
      activateTestnetSpace("space:retry", owner, provider, () => {}),
    ).resolves.toMatchObject({ identity: {} });
    expect(requests).toContain("reconcile:500");
    expect(
      requests.filter((value) => value === "wallet_sendCalls"),
    ).toHaveLength(1);
    expect(
      local.getItem(
        "aurka:space-setup:31337:0x1111111111111111111111111111111111111111:space:retry:ACTIVATE:batch",
      ),
    ).toBeNull();
  });

  it("rejects a prepared step with no transaction before asking the wallet to send", async () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x7a69";
        throw new Error(`Unexpected provider method ${method}`);
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...prepare, transaction: undefined }),
      })),
    );

    await expect(
      activateTestnetSpace(
        "space:missing-transaction",
        owner,
        provider,
        () => {},
      ),
    ).rejects.toThrow("did not return the transaction");
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_sendTransaction" }),
    );
  });

  it("reconciles a saved single transaction after reload without sending again", async () => {
    const local = storage();
    const key =
      "aurka:space-setup:31337:0x1111111111111111111111111111111111111111:space:reload:ACTIVATE";
    const hash = `0x${"66".repeat(32)}`;
    local.setItem(
      key,
      JSON.stringify({
        step: 0,
        hash,
        spaceId: "space:reload",
        operation: "ACTIVATE",
        owner,
        chainId: 31337,
      }),
    );
    vi.stubGlobal("localStorage", local);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_accounts") return [owner];
        throw new Error(`Unexpected provider method ${method}`);
      }),
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.hash === hash)
          return {
            ok: true,
            json: async () => ({ complete: true, space: { identity: {} } }),
          };
        return { ok: true, json: async () => prepare };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      activateTestnetSpace("space:reload", owner, provider, () => {}),
    ).resolves.toMatchObject({ identity: {} });
    expect(
      provider.request.mock.calls.some(
        ([input]) => input.method === "eth_sendTransaction",
      ),
    ).toBe(false);
    expect(local.getItem(key)).toBeNull();
  });

  it("blocks a saved transaction when the wallet is on a different testnet instance", async () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    const testnetSetup = {
      ...prepare,
      forkGeneration: "fork-new",
      forkAnchor: {
        blockNumber: "10",
        blockHash: `0x${"77".repeat(32)}`,
      },
    };
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_accounts") return [owner];
        if (method === "eth_getBlockByNumber")
          return { hash: `0x${"88".repeat(32)}` };
        throw new Error(`Unexpected provider method ${method}`);
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => testnetSetup })),
    );

    await expect(
      activateTestnetSpace("space:testnet-mismatch", owner, provider, () => {}),
    ).rejects.toMatchObject({ state: "testnet-mismatch" });
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_sendTransaction" }),
    );
  });

  it("requires an explicit safe recovery action before retrying a missing first step", async () => {
    const local = storage();
    const key =
      "aurka:space-setup:31337:0x1111111111111111111111111111111111111111:space:safe-retry:ACTIVATE";
    const oldHash = `0x${"99".repeat(32)}`;
    const newHash = `0x${"aa".repeat(32)}`;
    local.setItem(
      key,
      JSON.stringify({
        step: 0,
        hash: oldHash,
        spaceId: "space:safe-retry",
        operation: "ACTIVATE",
        owner,
        chainId: 31337,
      }),
    );
    vi.stubGlobal("localStorage", local);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_accounts") return [owner];
        if (method === "eth_sendTransaction") return newHash;
        if (method === "eth_getTransactionReceipt") return { status: "0x1" };
        throw new Error(`Unexpected provider method ${method}`);
      }),
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.hash === oldHash && body.step === 0 && body.operation)
          return { ok: true, json: async () => prepare };
        if (body.hash === newHash)
          return {
            ok: true,
            json: async () => ({ complete: true, space: { identity: {} } }),
          };
        return { ok: true, json: async () => prepare };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      activateTestnetSpace(
        "space:safe-retry",
        owner,
        provider,
        () => {},
        "ACTIVATE",
        "retry",
      ),
    ).resolves.toMatchObject({ identity: {} });
    expect(
      provider.request.mock.calls.filter(
        ([input]) => input.method === "eth_sendTransaction",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/testnet/spaces/recover"),
      ),
    ).toBe(true);
  });

  it("uses explicit token approvals followed by exactly one ordinary setup transaction", async () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    const setupTransaction = {
      to: "0x2222222222222222222222222222222222222222",
      data: "0xdeadbeef",
      value: "0x0",
    };
    const prerequisites = [
      {
        token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        symbol: "USDC",
        amount: "35000000000",
        spender: setupTransaction.to,
        transaction: {
          to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          data: "0xapproveusdc",
          value: "0x0",
        },
      },
      {
        token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        symbol: "WETH",
        amount: "5000000000000000000",
        spender: setupTransaction.to,
        transaction: {
          to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          data: "0xapproveweth",
          value: "0x0",
        },
      },
    ];
    const setup = {
      complete: false,
      mode: "single-transaction" as const,
      ownerAddress: owner,
      treasury: "0xcccccccccccccccccccccccccccccccccccccccc",
      step: 0,
      total: 1,
      label: "Create, fund, configure and activate Space",
      transaction: setupTransaction,
      prerequisites,
    };
    const requests: { method: string; params?: unknown[] }[] = [];
    const hashes = [
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      `0x${"33".repeat(32)}`,
    ];
    const provider = {
      request: vi.fn(async (input: { method: string; params?: unknown[] }) => {
        requests.push(input);
        if (input.method === "eth_chainId") return "0x7a69";
        if (input.method === "eth_accounts") return [owner];
        if (input.method === "eth_sendTransaction")
          return hashes[
            requests.filter(({ method }) => method === "eth_sendTransaction")
              .length - 1
          ];
        if (input.method === "eth_getTransactionReceipt")
          return { status: "0x1" };
        throw new Error(`Unexpected provider method ${input.method}`);
      }),
    };
    let prepares = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.hash === hashes[2])
          return {
            ok: true,
            json: async () => ({ complete: true, space: { identity: {} } }),
          };
        if (body.hash) return { ok: true, json: async () => setup };
        prepares += 1;
        return {
          ok: true,
          json: async () =>
            prepares === 1 ? setup : { ...setup, prerequisites: [] },
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      activateTestnetSpace("space:single", owner, provider, () => {}),
    ).resolves.toMatchObject({ identity: {} });
    expect(
      requests.filter(({ method }) => method === "eth_sendTransaction"),
    ).toHaveLength(3);
    expect(
      requests.some(({ method }) => method === "wallet_getCapabilities"),
    ).toBe(false);
    expect(requests.some(({ method }) => method === "wallet_sendCalls")).toBe(
      false,
    );
    expect(
      (
        requests.find(
          ({ method, params }) =>
            method === "eth_sendTransaction" &&
            (params?.[0] as { data?: string }).data === "0xdeadbeef",
        )?.params?.[0] as { to: string }
      ).to,
    ).toBe(setupTransaction.to);
  });
});
