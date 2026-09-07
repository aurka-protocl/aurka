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
    allowedMethods: ["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"],
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

import { privateKeyToAccount } from "viem/accounts";
import {
  hashActiveBounds,
  hashRiskCertificate,
  type RiskCertificate,
} from "@aurka/shared";
import {
  PrivyWalletAdapter,
  encodeRiskSubmission,
  type PrivyNodeClient,
} from "../src/index.js";
const testAccount = privateKeyToAccount(`0x${"00".repeat(31)}01`);
function certificate(): RiskCertificate {
  const bounds = [
    {
      token: ASSET,
      minimumWeightBps: 0,
      maximumWeightBps: 10000,
      paused: false,
    },
  ];
  return {
    policyId: `0x${"aa".repeat(32)}`,
    chainId: 31337,
    verifyingContract: REGISTRY,
    signatureVersion: 2,
    riskMode: "CAUTIOUS",
    activeBounds: bounds,
    activeBoundsHash: hashActiveBounds(bounds),
    maximumTradeValue: "75",
    sourceDigest: `0x${"bb".repeat(32)}`,
    reasonCode: `0x${"cc".repeat(32)}`,
    issuedAt: 1000,
    expiresAt: 1500,
    nonce: "1",
    watchtower: testAccount.address,
    watchtowerAuthorizationEpoch: "1",
    policyNonce: "1",
  };
}
it("uses typed Privy signing and chain-bound sending with decoded certificate policy", async () => {
  const c = certificate();
  const { fingerprint: oldFingerprint, ...basePolicy } = policy("RISK");
  expect(oldFingerprint).toMatch(/^0x/);
  const p = createWalletPolicy({
    ...basePolicy,
    policyId: c.policyId,
    signerAddress: testAccount.address,
    approvedRiskBoundsHashes: [c.activeBoundsHash],
    allowedSelectors: [
      encodeRiskSubmission({ ...c, signature: `0x${"11".repeat(65)}` }).slice(
        0,
        10,
      ),
    ],
  });
  let signed = 0,
    sent = 0;
  const client: PrivyNodeClient = {
    wallets: () => ({
      ethereum: () => ({
        signTypedData: async (_id, input) => {
          signed++;
          expect(input.params.typed_data.domain).toMatchObject({
            name: "AURKA RiskModeRegistry",
            version: "2",
            chain_id: 31337,
            verifying_contract: REGISTRY,
          });
          expect(input.params.typed_data.primary_type).toBe("RiskCertificate");
          return {
            encoding: "hex",
            signature: await testAccount.sign({
              hash: hashRiskCertificate(c) as `0x${string}`,
            }),
          };
        },
        sendTransaction: async (_id, input) => {
          sent++;
          expect(input.caip2).toBe("eip155:31337");
          expect(input.params.transaction).toMatchObject({ to: REGISTRY });
          expect(input.idempotency_key).toBeTruthy();
          return { caip2: "eip155:31337", hash: `0x${"dd".repeat(32)}` };
        },
      }),
    }),
  };
  let epoch = "1";
  const adapter = new PrivyWalletAdapter(client, {
    walletId: "test",
    refreshPolicy: async () => p,
    readRiskAuthority: async () => ({
      authorized: true,
      policyNonce: "1",
      watchtowerAuthorizationEpoch: epoch,
      nextNonce: "1",
    }),
    rpc: {
      request: async (method) =>
        method === "eth_chainId" ? "0x7a69" : `0x${"00".repeat(32)}`,
    },
    now: () => 1000,
  });
  const signature = await adapter.signTypedData(c, AUTH);
  expect(signed).toBe(1);
  const result = await adapter.simulateAndSend(
    {
      operation: "RISK_CERTIFICATE",
      chainId: c.chainId,
      to: REGISTRY,
      data: encodeRiskSubmission({ ...c, signature }),
      value: "0",
      expiresAt: c.expiresAt,
      policyFingerprint: p.fingerprint,
    },
    AUTH,
  );
  expect(result.status).toBe("SUBMITTED");
  expect(sent).toBe(1);
  await expect(
    adapter.signTypedData({ ...c, chainId: 1 }, AUTH),
  ).rejects.toThrow("domain");
  epoch = "2";
  await expect(adapter.signTypedData(c, AUTH)).rejects.toThrow(
    "authority changed",
  );
  expect(signed).toBe(1);
});
