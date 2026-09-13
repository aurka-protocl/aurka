import { describe, expect, it, vi } from "vitest";
import { createOrRecoverWallet } from "../src/agent/trading-agents.js";

const conflict = new Error(
  "400 Idempotency key was reused for a request with a new body",
);
const request = { external_id: "account-1", policy_ids: ["policy-2"] };

describe("wallet creation reconciliation", () => {
  it("recovers an existing wallet without creating a replacement", async () => {
    const create = vi.fn().mockRejectedValue(conflict);
    const list = vi.fn().mockResolvedValue({ data: [{ id: "existing" }] });
    expect(
      await createOrRecoverWallet(
        { wallets: () => ({ create, list }) },
        request,
        "old",
      ),
    ).toEqual({ id: "existing" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ external_id: "account-1" });
  });
  it("uses a stable body-specific retry key after confirming no existing wallet", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: "new" })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: "new" });
    const list = vi.fn().mockResolvedValue({ data: [] });
    const client = { wallets: () => ({ create, list }) };
    await createOrRecoverWallet(client, request, "old");
    await createOrRecoverWallet(client, request, "old");
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[3]?.[0]);
    expect(create.mock.calls[1]?.[0]["privy-idempotency-key"]).not.toBe("old");
  });
  it("does not create another wallet after a timeout", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timeout"));
    const list = vi.fn();
    await expect(
      createOrRecoverWallet(
        { wallets: () => ({ create, list }) },
        request,
        "old",
      ),
    ).rejects.toThrow("timeout");
    expect(create).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });
});
