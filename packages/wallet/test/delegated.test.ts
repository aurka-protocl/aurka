import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
  options: {
    readonly broadcastMode?: "privy" | "sign-and-broadcast";
    readonly walletAddress?: string;
    readonly signAccount?: ReturnType<typeof privateKeyToAccount>;
    readonly restoreRemote?: () => Promise<void>;
  } = {},
) {
  const walletAddress = options.walletAddress ?? AGENT;
  return new PrivyDelegatedExecutionAdapter({
    client: {
      wallets: () => ({
        ethereum: () => ({
          signTypedData: async () => ({
            encoding: "hex",
            signature: `0x${"00".repeat(65)}`,
          }),
          signTransaction: async (_walletId, input) => {
            const transaction = input.params as {
              transaction: Record<string, string>;
            };
            return {
              encoding: "rlp",
              signed_transaction: options.signAccount
                ? await options.signAccount.signTransaction({
                    to: transaction.transaction.to! as `0x${string}`,
                    value: BigInt(transaction.transaction.value!),
                    data: transaction.transaction.data! as `0x${string}`,
                    nonce: Number(BigInt(transaction.transaction.nonce!)),
                    gas: BigInt(transaction.transaction.gas_limit!),
                    gasPrice: BigInt(transaction.transaction.gas_price!),
                    chainId: Number(BigInt(transaction.transaction.chain_id!)),
                  })
                : `0x02${"00".repeat(65)}`,
            };
          },
          sendTransaction: async () => ({
            caip2: "eip155:31337",
            hash: `0x${"88".repeat(32)}`,
          }),
        }),
      }),
    },
    policy: async () => ({
      walletId: "delegated-wallet",
      walletAddress,
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
        ...(options.broadcastMode === "sign-and-broadcast"
          ? ["eth_signTransaction" as const]
          : ["eth_sendTransaction" as const]),
        "eth_signTypedData_v4",
      ],
    }),
    rpc: { request: async (method) => rpcValue(method) },
    authorization: async () => ({}) as never,
    revokeRemote: async () => undefined,
    ...(options.restoreRemote ? { restoreRemote: options.restoreRemote } : {}),
    ...(options.broadcastMode ? { broadcastMode: options.broadcastMode } : {}),
    now: () => 100,
  });
}

describe("delegated Privy execution boundary", () => {
  it("exposes restore only through the explicit remote signer callback", async () => {
    let restores = 0;
    const value = adapter(undefined, {
      restoreRemote: async () => {
        restores += 1;
      },
    });
    await value.restore!();
    expect(restores).toBe(1);
  });

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

  it("signs and broadcasts the exact agent-token approval through the local RPC route", async () => {
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const value = adapter(
      (method) => {
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_getBalance") return "0x1";
        if (method === "eth_getTransactionCount") return "0x0";
        if (method === "eth_estimateGas") return "0x5208";
        if (method === "eth_gasPrice") return "0x1";
        if (method === "eth_sendRawTransaction") return `0x${"88".repeat(32)}`;
        return "0x0";
      },
      {
        broadcastMode: "sign-and-broadcast",
        walletAddress: account.address,
        signAccount: account,
      },
    );
    await expect(
      value.approveToken!(
        {
          chainId: 31_337,
          token: INPUT,
          spender: ROUTER,
          amount: "10",
          expiresAt: 200,
          policyFingerprint: FINGERPRINT,
        },
        {} as never,
      ),
    ).resolves.toEqual({ transactionHash: `0x${"88".repeat(32)}` });
  });

  it("does not confirm a receipt unless its transaction, block, and settlement boundary are canonical", async () => {
    const account = privateKeyToAccount(`0x${"03".repeat(32)}`);
    const signed = await account.signTransaction({
      to: INPUT as `0x${string}`,
      data: "0x",
      value: 0n,
      nonce: 0,
      gas: 21_000n,
      gasPrice: 1n,
      chainId: 31_337,
    });
    const transactionHash = keccak256(signed);
    const blockHash = `0x${"99".repeat(32)}`;
    const value = adapter((method) => {
      if (method === "eth_getTransactionReceipt")
        return {
          transactionHash,
          blockNumber: "0x2",
          blockHash,
          status: "0x1",
          logs: [],
        };
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getTransactionByHash")
        return {
          hash: transactionHash,
          blockHash,
          blockNumber: "0x2",
          from: account.address,
          to: INPUT,
          input: "0x",
          value: "0x0",
          chainId: "0x7a69",
        };
      if (method === "eth_getBlockByHash")
        return { hash: blockHash, number: "0x2" };
      throw new Error(`unexpected RPC method ${method}`);
    });
    await expect(
      value.getReceipt(transactionHash, {
        chainId: 31_337,
        from: account.address,
        to: INPUT,
        data: "0x",
        value: "0",
      }),
    ).resolves.toMatchObject({ transactionHash, blockHash });

    const replacement = adapter((method) => {
      if (method === "eth_getTransactionReceipt")
        return {
          transactionHash,
          blockNumber: "0x2",
          blockHash,
          status: "0x1",
          logs: [],
        };
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getTransactionByHash")
        return {
          hash: transactionHash,
          blockHash: `0x${"aa".repeat(32)}`,
          blockNumber: "0x2",
          from: account.address,
          to: INPUT,
          input: "0x",
          value: "0x0",
          chainId: "0x7a69",
        };
      if (method === "eth_getBlockByHash")
        return { hash: blockHash, number: "0x2" };
      throw new Error(`unexpected RPC method ${method}`);
    });
    await expect(
      replacement.getReceipt(transactionHash, {
        chainId: 31_337,
        from: account.address,
        to: INPUT,
        data: "0x",
        value: "0",
      }),
    ).rejects.toThrow("Canonical transaction");
  });
});
