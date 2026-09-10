import { describe, expect, it } from "vitest";

import {
  PrivyDelegatedExecutionAdapter,
  type DelegatedExecutionAction,
} from "../src/index.js";

const AGENT = `0x${"11".repeat(20)}`;
const ROUTER = `0x${"22".repeat(20)}`;
const INPUT = `0x${"33".repeat(20)}`;
const OUTPUT = `0x${"44".repeat(20)}`;
const FINGERPRINT = `0x${"55".repeat(32)}`;

function action(overrides: Partial<DelegatedExecutionAction> = {}) {
  return {
    chainId: 31_337,
    to: ROUTER,
    data: "0xdeadbeef",
    value: "0",
    trader: AGENT,
    inputToken: INPUT,
    outputToken: OUTPUT,
    inputAmount: "10",
    intentHash: `0x${"66".repeat(32)}`,
    proposalHash: `0x${"77".repeat(32)}`,
    expiresAt: 200,
    policyFingerprint: FINGERPRINT,
    ...overrides,
  } satisfies DelegatedExecutionAction;
}

function adapter(
  rpcValue: (method: string) => unknown = (method) =>
    method === "eth_chainId" ? "0x7a69" : "0x0",
) {
  return new PrivyDelegatedExecutionAdapter({
    client: {
      wallets: () => ({
        ethereum: () => ({
          signTypedData: async () => ({
            encoding: "hex",
            signature: `0x${"00".repeat(65)}`,
          }),
          sendTransaction: async () => ({
            caip2: "eip155:31337",
            hash: `0x${"88".repeat(32)}`,
          }),
        }),
      }),
    },
    policy: async () => ({
      walletId: "delegated-wallet",
      walletAddress: AGENT,
      signerAddress: AGENT,
      policyId: "delegated-policy",
      chainId: 31_337,
      router: ROUTER,
      inputToken: INPUT,
      outputToken: OUTPUT,
      maximumInputAmount: "100",
      validUntil: 500,
      paused: false,
      revoked: false,
      fingerprint: FINGERPRINT,
      allowedMethods: [
        "eth_call",
        "eth_sendTransaction",
        "eth_signTypedData_v4",
      ],
    }),
    rpc: { request: async (method) => rpcValue(method) },
    authorization: async () => ({}) as never,
    revokeRemote: async () => undefined,
    now: () => 100,
  });
}

describe("delegated Privy execution boundary", () => {
  it("reports the dedicated identity and fails closed on chain, target, and calldata mismatch", async () => {
    const value = adapter();
    await expect(value.getStatus()).resolves.toMatchObject({
      configured: true,
      address: AGENT,
      chainId: 31_337,
      policyFingerprint: FINGERPRINT,
    });
    await expect(
      value.simulateAndSend(action({ chainId: 1 }), {} as never),
    ).rejects.toThrow("chain mismatch");
    await expect(
      value.simulateAndSend(
        action({ to: `0x${"99".repeat(20)}` }),
        {} as never,
      ),
    ).rejects.toThrow("approved router");
    await expect(value.simulateAndSend(action(), {} as never)).rejects.toThrow(
      "Encoded function signature",
    );
  });

  it("does not call Privy when the canonical RPC chain is wrong", async () => {
    let calls = 0;
    const value = adapter((method) => {
      calls += 1;
      return method === "eth_chainId" ? "0x1" : "0x0";
    });
    await expect(
      value.signIntent(
        {
          domain: {
            name: "AURKA Direct Settlement",
            version: "1",
            chainId: 31_337,
            verifyingContract: ROUTER,
          },
          types: { Intent: [] },
          primaryType: "Intent",
          message: {},
        } as never,
        {} as never,
      ),
    ).rejects.toThrow("RPC chain mismatch");
    expect(calls).toBe(1);
  });
});
