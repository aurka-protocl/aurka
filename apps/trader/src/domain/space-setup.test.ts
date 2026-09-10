import { describe, expect, it, vi } from "vitest";
import { activateForkSpace, parseSendCallsResult } from "./space-setup";

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
      activateForkSpace("space:one", owner, provider, () => {}),
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
              error: "The fork RPC cannot verify the partial batch.",
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
      activateForkSpace("space:partial", owner, provider, () => {}),
    ).rejects.toThrow("fork RPC cannot verify");
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
      activateForkSpace("space:retry", owner, provider, () => {}),
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
});
