import { describe, expect, it } from "vitest";

import {
  FakeWalletAdapter,
  createWalletPolicy,
  type WalletPolicy,
} from "../src/index.js";

const ADDRESS = `0x${"11".repeat(20)}`;
const ROUTER = `0x${"22".repeat(20)}`;
const REGISTRY = `0x${"33".repeat(20)}`;
const ASSET = `0x${"44".repeat(20)}`;
const AUTH = { signatures: [`0x${"55".repeat(65)}`] };

function policy(role: "EXECUTION" | "RISK"): WalletPolicy {
  return createWalletPolicy({
    policyId: "fixture",
    role,
    chainId: 31_337,
    router: ROUTER,
    riskRegistry: REGISTRY,
    allowedMethods: ["eth_call", "eth_sendTransaction", "eth_sign"],
    allowedSelectors: ["0x12345678", "0x00000000"],
    calldataRules: [
      { selector: "0x12345678", wordCount: 0 },
      { selector: "0x00000000", wordCount: 0 },
    ],
    approvedAssets: [ASSET],
    maximumNativeValue: "10",
    maximumTokenAmount: "100",
    validUntil: 2_000,
    paused: false,
    revoked: false,
    signerAddress: ADDRESS,
  });
}

describe("scoped wallet boundary", () => {
  it("accepts only role-specific approved actions", async () => {
    const adapter = new FakeWalletAdapter(
      "execution",
      policy("EXECUTION"),
      () => 1_000,
    );
    const result = await adapter.simulateAndSend(
      {
        operation: "ROUTER_EXECUTE",
        chainId: 31_337,
        to: ROUTER,
        data: "0x12345678",
        value: "1",
        asset: ASSET,
        amount: "50",
        expiresAt: 1_500,
        policyFingerprint: (await adapter.getPolicy()).fingerprint,
      },
      AUTH,
    );
    expect(result.status).toBe("SUBMITTED");
    await expect(
      adapter.simulateAndSend(
        {
          operation: "RISK_CERTIFICATE",
          chainId: 31_337,
          to: REGISTRY,
          data: "0x00000000",
          value: "0",
          expiresAt: 1_500,
          policyFingerprint: result.policyFingerprint,
        },
        AUTH,
      ),
    ).rejects.toThrow("Execution signer");
  });

  it("fails closed on wrong chain, selector, cap, expiry, and missing authorization", async () => {
    const adapter = new FakeWalletAdapter(
      "execution",
      policy("EXECUTION"),
      () => 1_000,
    );
    const fingerprint = (await adapter.getPolicy()).fingerprint;
    const base = {
      operation: "ROUTER_EXECUTE" as const,
      chainId: 31_337,
      to: ROUTER,
      data: "0x12345678",
      value: "1",
      expiresAt: 1_500,
      policyFingerprint: fingerprint,
    };
    await expect(
      adapter.simulateAndSend({ ...base, chainId: 1 }, AUTH),
    ).rejects.toThrow("chain");
    await expect(
      adapter.simulateAndSend({ ...base, data: "0xdeadbeef" }, AUTH),
    ).rejects.toThrow("selector");
    await expect(
      adapter.simulateAndSend({ ...base, value: "11" }, AUTH),
    ).rejects.toThrow("cap");
    await expect(
      adapter.simulateAndSend({ ...base, expiresAt: 900 }, AUTH),
    ).rejects.toThrow("expired");
    await expect(
      adapter.simulateAndSend(base, { signatures: [] }),
    ).rejects.toThrow("authorization");
  });
});
