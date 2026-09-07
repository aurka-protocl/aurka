import { expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashRiskCertificate } from "@aurka/shared";
import { type AurkaWalletAdapter, createWalletPolicy } from "@aurka/wallet";
import { AurkaService } from "../src/service.js";
import {
  RiskCertificateWorker,
  type RiskWorkerSources,
} from "../src/risk-worker.js";
import { FIXTURE_ADDRESSES, FIXTURE_POSITION_ID } from "../src/fixture.js";
import { body } from "./risk-fixture.js";

it("recovers a lost acknowledgement without a second broadcast, tracks reorgs and renews", async () => {
  let now = 200;
  const service = new AurkaService({ riskNow: () => now });
  const account = privateKeyToAccount(`0x${"00".repeat(31)}01`);
  const input = body(),
    position = service.getPosition(FIXTURE_POSITION_ID);
  const policy = createWalletPolicy({
    policyId: position.policy.id,
    role: "RISK",
    chainId: 31337,
    router: FIXTURE_ADDRESSES.registry,
    riskRegistry: `0x${"ab".repeat(20)}`,
    allowedMethods: ["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"],
    allowedSelectors: [],
    calldataRules: [],
    approvedAssets: input.hardBounds.map((b) => b.token),
    maximumNativeValue: "0",
    maximumTokenAmount: "50000",
    validUntil: 1000,
    paused: false,
    revoked: false,
    signerAddress: account.address,
  });
  const hashes = new Map<string, string>();
  let lostResponse = true,
    signed = 0;
  const wallet: AurkaWalletAdapter = {
    getPolicy: async () => policy,
    getSignerStatus: async () => ({
      walletId: "fixture",
      role: "RISK",
      address: account.address,
      enabled: true,
      revoked: false,
      expiresAt: 1000,
      policyFingerprint: policy.fingerprint,
    }),
    signTypedData: async (c) => {
      signed++;
      return account.sign({ hash: hashRiskCertificate(c) as `0x${string}` });
    },
    simulateAndSend: async (action) => {
      if (!hashes.has(action.data))
        hashes.set(
          action.data,
          `0x${hashes.size.toString(16).padStart(64, "0")}`,
        );
      if (lostResponse) {
        lostResponse = false;
        throw new Error("Lost response after broadcast");
      }
      return {
        walletId: "fixture",
        status: "SUBMITTED",
        transactionHash: hashes.get(action.data)!,
        policyFingerprint: policy.fingerprint,
      };
    },
  };
  let nonce = "1",
    authorized = true,
    hasReceipt = false,
    canonical = true;
  const blockHash = `0x${"11".repeat(32)}`;
  const sources: RiskWorkerSources = {
    context: async () => ({
      policyId: position.policy.id,
      chainId: 31337,
      registry: `0x${"ab".repeat(20)}`,
      watchtower: account.address,
      policyNonce: position.policy.nonce,
      authorizationEpoch: "1",
      nextNonce: nonce,
      authorized,
    }),
    evaluation: async () => ({
      ...input,
      nowSeconds: now,
      observations: input.observations.map((o) => ({
        ...o,
        observedAt: now,
        retrievedAt: now,
      })),
    }),
    receipt: async () =>
      hasReceipt ? { blockNumber: "100", blockHash, success: true } : null,
    canonicalHash: async () => (canonical ? blockHash : null),
    finalizedBlock: async () => 100n,
  };
  const options = {
    repository: service.repository,
    risk: service.riskService,
    wallet,
    sources,
    authorize: async () => ({ signatures: ["0x11"] }),
    now: () => now,
  };
  try {
    await expect(
      new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID),
    ).rejects.toThrow("Lost response");
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SIGNED",
    );
    now = 210;
    await new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID);
    expect(hashes.size).toBe(1);
    expect(signed).toBe(1);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SUBMITTED",
    );
    now = 220;
    hasReceipt = true;
    nonce = "2";
    await new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "ACTIVE",
    );
    now = 230;
    canonical = false;
    await new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SUBMITTED",
    );
    expect(hashes.size).toBe(1);
    now = 240;
    canonical = true;
    await new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID);
    now = 450;
    await new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID);
    expect(signed).toBe(2);
    expect(hashes.size).toBe(2);
    now = 460;
    authorized = false;
    await new RiskCertificateWorker(options).tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "REVOKED",
    );
  } finally {
    service.close();
  }
});
