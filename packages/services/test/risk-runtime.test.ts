import { expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { GraphFetch } from "@aurka/graph";
import { hashActiveBounds, hashRiskCertificate } from "@aurka/shared";
import {
  createWalletPolicy,
  type AurkaWalletAdapter,
  type WalletPolicy,
} from "@aurka/wallet";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURE_ADDRESSES, FIXTURE_POSITION_ID } from "../src/fixture.js";
import { AurkaService } from "../src/service.js";
import {
  createRiskRuntime,
  hashRiskConfiguration,
  parseRiskRuntimeConfig,
  type RiskRuntimeConfig,
} from "../src/risk-runtime.js";
import { body } from "./risk-fixture.js";

const BLOCK_HASH = `0x${"10".repeat(32)}`;
const REORGED_BLOCK_HASH = `0x${"20".repeat(32)}`;
const policyId = `0x${"01".repeat(32)}`;
const rpcAbi = parseAbi([
  "function policyRegistry() view returns (address)",
  "function policyNonce(bytes32) view returns (uint256)",
  "function maximumTransactionValue(bytes32) view returns (uint256)",
  "function isPaused(bytes32) view returns (bool)",
  "function assets(bytes32) view returns (address[])",
  "function assetBounds(bytes32,address) view returns (uint8,uint16,uint16,bool)",
  "function isWatchtower(bytes32,address) view returns (bool)",
  "function watchtowerAuthorizationEpoch(bytes32,address) view returns (uint256)",
  "function lastNonce(bytes32) view returns (uint256)",
  "function currentRiskMode(bytes32) view returns (uint8)",
  "function effectiveMaximumTradeValue(bytes32) view returns (uint256)",
  "function effectiveAssetBound(bytes32,address) view returns (address,uint16,uint16,bool)",
]);

function configFor(
  configuration: ReturnType<typeof body>["configuration"],
  hardBounds: ReturnType<typeof body>["hardBounds"],
  watchtower = `0x${"01".repeat(20)}`,
): RiskRuntimeConfig {
  const source = {
    sourceId: "dex-a",
    sourceKind: "FIXTURE" as const,
    endpoint: "http://fixture.invalid/graphql",
    deploymentId: "fixture-deployment",
    schemaVersion: "risk-v1",
    queryVersion: "observations-v1",
    attempts: 1,
    maxObservationAgeSeconds: configuration.maxObservationAgeSeconds,
    maxIndexedLagBlocks: configuration.maxIndexedLagBlocks,
  };
  const position = {
    positionId: FIXTURE_POSITION_ID,
    policyId,
    watchtower,
    deploymentId: "fixture-deployment",
    configuration,
    approvedConfigurationHash: hashRiskConfiguration(configuration),
    approvedHardBoundsHash: hashActiveBounds(hardBounds),
    sources: [source, { ...source, sourceId: "dex-b" }],
  };
  return parseRiskRuntimeConfig({
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    policyRegistry: `0x${"aa".repeat(20)}`,
    riskRegistry: `0x${"bb".repeat(20)}`,
    router: `0x${"cc".repeat(20)}`,
    walletId: "risk-wallet",
    walletPolicyReference: "fixture-risk-policy-v1",
    finalityMaxAgeSeconds: 1_000,
    positions: [position],
  });
}

function graphResponse(now: number, sourceId: string): unknown {
  return {
    data: {
      observations: [
        {
          id: `${sourceId}:100`,
          signal: "DEX_LIQUIDITY",
          metricValue: "0",
          sampleSize: "10",
          affectedAssets: [FIXTURE_ADDRESSES.usdc],
          observedAt: now,
          indexedBlock: "100",
          indexedBlockHash: BLOCK_HASH,
          payload: { sourceId },
        },
      ],
      _meta: {
        deployment: "fixture-deployment",
        hasIndexingErrors: false,
        block: { number: 100, hash: BLOCK_HASH, timestamp: 200 },
      },
    },
  };
}

function makeRpc(now: () => number, watchtower: string) {
  let lastNonce = 0n;
  let receiptAvailable = false;
  let authorized = true;
  let canonical = true;
  let transactionHash = `0x${"55".repeat(32)}`;
  const assets = [
    FIXTURE_ADDRESSES.usdc,
    FIXTURE_ADDRESSES.weth,
    FIXTURE_ADDRESSES.link,
  ];
  const bounds = [
    [0, 5_500, 10_000, true],
    [0, 0, 3_500, true],
    [0, 0, 1_500, true],
  ] as const;
  const rpc = {
    async request(input: {
      readonly method: string;
      readonly params?: readonly unknown[];
    }): Promise<unknown> {
      if (input.method === "eth_chainId") return "0x7a69";
      if (input.method === "eth_blockNumber") return "0x64";
      if (input.method === "eth_getBlockByNumber")
        return {
          number: "0x64",
          hash: canonical ? BLOCK_HASH : REORGED_BLOCK_HASH,
          timestamp: `0x${now().toString(16)}`,
        };
      if (input.method === "eth_getTransactionReceipt")
        return receiptAvailable
          ? {
              blockNumber: "0x64",
              blockHash: BLOCK_HASH,
              status: "0x1",
            }
          : null;
      if (input.method !== "eth_call")
        throw new Error(`Unexpected RPC ${input.method}`);
      const call = input.params?.[0] as { data?: string } | undefined;
      const decoded = decodeFunctionData({
        abi: rpcAbi,
        data: call?.data as Hex,
      });
      switch (decoded.functionName) {
        case "policyRegistry":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "policyRegistry",
            result: `0x${"aa".repeat(20)}`,
          });
        case "policyNonce":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "policyNonce",
            result: 1n,
          });
        case "maximumTransactionValue":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "maximumTransactionValue",
            result: 50_000n,
          });
        case "isPaused":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "isPaused",
            result: false,
          });
        case "assets":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "assets",
            result: assets,
          });
        case "assetBounds": {
          const token = String(decoded.args[1]).toLowerCase();
          const index = assets.findIndex(
            (item) => item.toLowerCase() === token,
          );
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "assetBounds",
            result: bounds[index]!,
          });
        }
        case "isWatchtower":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "isWatchtower",
            result:
              authorized &&
              String(decoded.args[1]).toLowerCase() ===
                watchtower.toLowerCase(),
          });
        case "watchtowerAuthorizationEpoch":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "watchtowerAuthorizationEpoch",
            result: 1n,
          });
        case "lastNonce":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "lastNonce",
            result: lastNonce,
          });
        case "currentRiskMode":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "currentRiskMode",
            result: 1,
          });
        case "effectiveMaximumTradeValue":
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "effectiveMaximumTradeValue",
            result: 37_500n,
          });
        case "effectiveAssetBound": {
          const token = String(decoded.args[1]);
          const index = assets.findIndex(
            (item) => item.toLowerCase() === token.toLowerCase(),
          );
          const bound = bounds[index]!;
          return encodeFunctionResult({
            abi: rpcAbi,
            functionName: "effectiveAssetBound",
            result: [assets[index]!, bound[1], bound[2], false],
          });
        }
      }
    },
  };
  return {
    rpc,
    submit() {
      receiptAvailable = false;
      transactionHash = `0x${(lastNonce + 1n).toString(16).padStart(64, "0")}`;
      return transactionHash;
    },
    mine() {
      if (!receiptAvailable) {
        receiptAvailable = true;
        lastNonce += 1n;
      }
    },
    revoke() {
      authorized = false;
    },
    reorg() {
      canonical = false;
    },
    restoreCanonical() {
      canonical = true;
    },
    get transactionHash() {
      return transactionHash;
    },
  };
}

it("composes canonical RPC, Graph and signed wallet callbacks through the worker", async () => {
  let now = 200;
  const input = body();
  const account = privateKeyToAccount(`0x${"00".repeat(31)}01`);
  const config = configFor(
    input.configuration,
    input.hardBounds,
    account.address,
  );
  const policy: WalletPolicy = createWalletPolicy({
    policyId,
    role: "RISK",
    chainId: 31337,
    router: config.router,
    riskRegistry: config.riskRegistry,
    allowedMethods: ["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"],
    allowedSelectors: [],
    calldataRules: [],
    approvedAssets: input.hardBounds.map((bound) => bound.token),
    maximumNativeValue: "0",
    maximumTokenAmount: "50000",
    validUntil: 1_000,
    paused: false,
    revoked: false,
    signerAddress: account.address,
    approvedRiskBoundsHashes: [
      ...new Set(
        input.configuration.boundSets.map((set) =>
          hashActiveBounds(set.activeBounds),
        ),
      ),
    ],
  });
  const rpcState = makeRpc(() => now, account.address);
  let signed = 0;
  let broadcasts = 0;
  let pendingTransaction: string | undefined;
  let loseFirstAcknowledgement = true;
  const wallet: AurkaWalletAdapter = {
    async getPolicy() {
      return policy;
    },
    async getSignerStatus() {
      return {
        walletId: "risk-wallet",
        role: "RISK" as const,
        address: account.address,
        enabled: true,
        revoked: false,
        expiresAt: policy.validUntil,
        policyFingerprint: policy.fingerprint,
      };
    },
    async signTypedData(certificate) {
      signed += 1;
      return account.sign({ hash: hashRiskCertificate(certificate) as Hex });
    },
    async simulateAndSend() {
      if (pendingTransaction === undefined) {
        pendingTransaction = rpcState.submit();
        broadcasts += 1;
      }
      if (loseFirstAcknowledgement) {
        loseFirstAcknowledgement = false;
        return {
          walletId: "risk-wallet",
          status: "SUBMITTED" as const,
          policyFingerprint: policy.fingerprint,
        };
      }
      return {
        walletId: "risk-wallet",
        status: "SUBMITTED" as const,
        transactionHash: pendingTransaction,
        policyFingerprint: policy.fingerprint,
      };
    },
  };
  const service = new AurkaService({ riskNow: () => now });
  try {
    const runtimeOptions = {
      config,
      rpc: rpcState.rpc,
      wallet,
      authorize: async () => ({ signatures: ["0x11"] }),
      graphFetch: (async (_endpoint, init) => {
        const request = JSON.parse(init.body) as {
          variables?: { lastId?: string };
        };
        const sourceId = request.variables?.lastId ? "dex-b" : "dex-a";
        return {
          ok: true,
          status: 200,
          json: async () => graphResponse(now, sourceId),
        };
      }) satisfies GraphFetch,
      now: () => now,
    };
    const runtime = await createRiskRuntime(service, runtimeOptions);
    expect(runtime.positions).toEqual([FIXTURE_POSITION_ID]);
    await expect(runtime.worker.tick(FIXTURE_POSITION_ID)).rejects.toThrow(
      "Wallet returned no transaction hash",
    );
    expect(signed).toBe(1);
    expect(broadcasts).toBe(1);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SIGNED",
    );

    const restarted = await createRiskRuntime(service, runtimeOptions);
    now = 211;
    await restarted.worker.tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SUBMITTED",
    );
    expect(broadcasts).toBe(1);

    rpcState.mine();
    pendingTransaction = undefined;
    now = 221;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "ACTIVE",
    );
    expect(
      (await service.riskService.getPositionLive(FIXTURE_POSITION_ID)).effective
        .source,
    ).toBe("REGISTRY");

    now = 450;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(signed).toBe(2);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SUBMITTED",
    );

    rpcState.mine();
    rpcState.reorg();
    now = 460;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SUBMITTED",
    );

    rpcState.restoreCanonical();
    now = 470;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "ACTIVE",
    );
    pendingTransaction = undefined;

    now = 751;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(signed).toBe(3);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "SUBMITTED",
    );
    rpcState.mine();
    pendingTransaction = undefined;
    now = 762;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "ACTIVE",
    );

    rpcState.revoke();
    now = 780;
    await runtime.worker.tick(FIXTURE_POSITION_ID);
    expect(service.repository.getRiskWorkflow(FIXTURE_POSITION_ID)?.state).toBe(
      "REVOKED",
    );
  } finally {
    service.close();
  }
});

it("turns a Graph outage into explicit fail-safe evaluation input", async () => {
  const input = body();
  const account = privateKeyToAccount(`0x${"00".repeat(31)}01`);
  const config = configFor(
    input.configuration,
    input.hardBounds,
    account.address,
  );
  const service = new AurkaService({ riskNow: () => 200 });
  const policy = createWalletPolicy({
    policyId,
    role: "RISK",
    chainId: 31337,
    router: config.router,
    riskRegistry: config.riskRegistry,
    allowedMethods: ["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"],
    allowedSelectors: [],
    calldataRules: [],
    approvedAssets: input.hardBounds.map((bound) => bound.token),
    maximumNativeValue: "0",
    maximumTokenAmount: "50000",
    validUntil: 1_000,
    paused: false,
    revoked: false,
    signerAddress: account.address,
    approvedRiskBoundsHashes: [
      ...new Set(
        input.configuration.boundSets.map((set) =>
          hashActiveBounds(set.activeBounds),
        ),
      ),
    ],
  });
  try {
    const runtime = await createRiskRuntime(service, {
      config,
      rpc: makeRpc(() => 200, account.address).rpc,
      wallet: {
        getPolicy: async () => policy,
        getSignerStatus: async () => ({
          walletId: "risk-wallet",
          role: "RISK",
          address: account.address,
          enabled: true,
          revoked: false,
          expiresAt: 1_000,
          policyFingerprint: policy.fingerprint,
        }),
        signTypedData: async () => "0x",
        simulateAndSend: async () => ({
          walletId: "risk-wallet",
          status: "SUBMITTED",
          policyFingerprint: policy.fingerprint,
        }),
      },
      authorize: async () => ({ signatures: ["0x11"] }),
      graphFetch: async () => {
        throw new Error("fixture unavailable");
      },
      now: () => 200,
    });
    const evaluationInput =
      await runtime.sources.evaluation(FIXTURE_POSITION_ID);
    expect(evaluationInput.sourceFailures).toEqual(["dex-a", "dex-b"]);
    const result = service.riskService.evaluate(evaluationInput, "worker");
    expect(result.evaluation.mode).toBe("CAUTIOUS");
    expect(result.evaluation.failSafe).toBe(true);
  } finally {
    service.close();
  }
});

it("rejects unapproved runtime metadata before composing adapters", () => {
  const input = body();
  const config = configFor(input.configuration, input.hardBounds);
  expect(() =>
    parseRiskRuntimeConfig({
      ...config,
      riskRegistry: config.policyRegistry,
    }),
  ).toThrow("distinct");
  expect(() =>
    parseRiskRuntimeConfig({
      ...config,
      positions: [
        {
          ...config.positions[0],
          approvedConfigurationHash: `0x${"ff".repeat(32)}`,
        },
      ],
    }),
  ).toThrow("configuration hash");
});

it("accepts the checked-in non-secret runtime fixture", () => {
  const path = fileURLToPath(
    new URL(
      "../../../docs/examples/risk-runtime.fixture.json",
      import.meta.url,
    ),
  );
  const input = JSON.parse(readFileSync(path, "utf8")) as unknown;
  expect(parseRiskRuntimeConfig(input).positions).toHaveLength(1);
});
