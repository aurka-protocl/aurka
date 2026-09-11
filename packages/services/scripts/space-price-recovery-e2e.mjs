/* global console, process, fetch, setTimeout, URL, URLSearchParams */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const MNEMONIC = "test test test test test test test test test test test junk";
const CHAIN_ID = 31337;
const runDirectory = path.resolve(
  process.env.AURKA_RECOVERY_RUN_DIR ??
    mkdtempSync(path.join(os.tmpdir(), "aurka-price-recovery-")),
);
mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

const accounts = [0, 1, 2].map((addressIndex) =>
  mnemonicToAccount(MNEMONIC, { addressIndex }),
);
const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const ORACLE_ABI = parseAbi([
  "function setPrice(address,uint256,uint8,uint64,bytes32)",
]);
const INTENT_TYPES = [
  { name: "intentId", type: "bytes32" },
  { name: "policyId", type: "bytes32" },
  { name: "positionIdHash", type: "bytes32" },
  { name: "trader", type: "address" },
  { name: "traderInputToken", type: "address" },
  { name: "traderOutputToken", type: "address" },
  { name: "requestedValue", type: "uint256" },
  { name: "minimumTraderOutputValue", type: "uint256" },
  { name: "exactInput", type: "bool" },
  { name: "allowPartialFill", type: "bool" },
  { name: "deadline", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "balanceSnapshot", type: "bytes32" },
  { name: "priceSnapshot", type: "bytes32" },
  { name: "aquaStrategyHash", type: "bytes32" },
];

function stringify(value) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

async function freePort() {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startFork({ directory, rpcPort, apiPort, appPort, reset }) {
  return spawn(
    "node",
    [
      "--env-file=.env",
      "packages/services/scripts/fork-space.mjs",
      ...(reset ? ["--reset"] : []),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AURKA_FORK_DIR: directory,
        AURKA_FORK_INTEGRATION: "fixture-upstream",
        AURKA_FORK_RPC_PORT: String(rpcPort),
        AURKA_FORK_API_PORT: String(apiPort),
        AURKA_FORK_APP_PORT: String(appPort),
      },
      stdio: "inherit",
    },
  );
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

async function waitForFork(apiUrl) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch(`${apiUrl}/fork`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Fork did not become ready: ${lastError?.message ?? "unknown error"}`,
  );
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`Invalid JSON from ${url} (${response.status})`);
  }
  return { response, body };
}

async function api(apiUrl, route, options) {
  const { response, body } = await requestJson(`${apiUrl}${route}`, options);
  if (!response.ok || body?.ok === false)
    throw new Error(
      `${route}: ${body?.error?.code ?? response.status} ${body?.error?.message ?? "request failed"}`,
    );
  return body?.data ?? body;
}

async function expectApiError(apiUrl, route, options, code) {
  const { response, body } = await requestJson(`${apiUrl}${route}`, options);
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body?.error?.code, code, JSON.stringify(body));
  return body.error;
}

function post(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function sendTransaction(wallet, publicClient, transaction) {
  const hash = await wallet.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: BigInt(transaction.value ?? "0x0"),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction reverted: ${hash}`);
  return hash;
}

async function ownerAction(apiUrl, action, spaceId, params = {}) {
  const query = new URLSearchParams({ action, spaceId, ...params });
  const { response, body } = await requestJson(
    `${apiUrl}/fork/owner?${query.toString()}`,
  );
  if (!response.ok)
    throw new Error(`${action}: ${body?.error?.message ?? response.status}`);
  return body;
}

async function signSpaceMutation(ownerWallet, prepared) {
  const typed = prepared.typedData;
  return ownerWallet.signTypedData({
    domain: typed.domain,
    types: { SpaceMutation: typed.types.SpaceMutation },
    primaryType: "SpaceMutation",
    message: {
      ...typed.message,
      nonce: BigInt(typed.message.nonce),
      deadline: BigInt(typed.message.deadline),
    },
  });
}

async function createAndActivateSpace({
  apiUrl,
  identity,
  ownerWallet,
  publicClient,
  funding,
  id,
  name,
}) {
  const draft = {
    draftVersion: 2,
    id,
    name,
    ownerAddress: ownerWallet.account.address,
    chainId: CHAIN_ID,
    assets: [
      {
        token: identity.usdc,
        symbol: "USDC",
        decimals: 6,
        minimumWeightBps: 6000,
        maximumWeightBps: 10000,
      },
      {
        token: identity.weth,
        symbol: "WETH",
        decimals: 18,
        minimumWeightBps: 0,
        maximumWeightBps: 4000,
      },
    ],
    maximumTransactionValue: "5000",
    funding,
  };
  const prepared = await api(
    apiUrl,
    "/v1/spaces/prepare",
    post({
      operation: "CREATE",
      spaceId: id,
      ownerAddress: draft.ownerAddress,
      draft,
    }),
  );
  const signature = await signSpaceMutation(ownerWallet, prepared);
  await api(
    apiUrl,
    "/v1/spaces/confirm",
    post({
      operation: "CREATE",
      spaceId: id,
      ownerAddress: draft.ownerAddress,
      draft,
      authorization: { ...prepared.authorization, signature },
    }),
  );

  const context = await api(apiUrl, "/fork/identity");
  let setup = await api(
    apiUrl,
    "/fork/spaces/prepare",
    post({
      forkGeneration: context.forkGeneration,
      spaceId: id,
      operation: "ACTIVATE",
    }),
  );
  for (const prerequisite of setup.prerequisites ?? [])
    await sendTransaction(ownerWallet, publicClient, prerequisite.transaction);
  setup = await api(
    apiUrl,
    "/fork/spaces/prepare",
    post({
      forkGeneration: context.forkGeneration,
      spaceId: id,
      operation: "ACTIVATE",
    }),
  );
  assert.equal(setup.complete, false);
  const setupHash = await sendTransaction(
    ownerWallet,
    publicClient,
    setup.transaction,
  );
  const activated = await api(
    apiUrl,
    "/fork/spaces/confirm",
    post({
      forkGeneration: context.forkGeneration,
      spaceId: id,
      operation: "ACTIVATE",
      step: setup.step,
      hash: setupHash,
      planId: setup.planId,
      planCommitment: setup.planCommitment,
    }),
  );
  assert.equal(activated.complete, true);
  const space = await api(apiUrl, `/v1/spaces/${encodeURIComponent(id)}`);
  assert.equal(space.identity.state, "ACTIVE");
  return { draft, setupHash, space };
}

function intentTypedData(intent, manifest) {
  const message = {
    ...intent,
    requestedValue: BigInt(intent.requestedValue),
    minimumTraderOutputValue: BigInt(intent.minimumTraderOutputValue),
    deadline: BigInt(intent.deadline),
    nonce: BigInt(intent.nonce),
  };
  return {
    domain: {
      name: "AURKA Direct Settlement",
      version: "1",
      chainId: manifest.chainId,
      verifyingContract: manifest.router,
    },
    types: { Intent: INTENT_TYPES },
    primaryType: "Intent",
    message,
  };
}

async function prepareIntent(apiUrl, spaceId, trader, manifest, nonce) {
  const latest = Math.floor(Date.now() / 1000) + 600;
  return api(
    apiUrl,
    "/v1/intents/prepare",
    post({
      positionId: spaceId,
      trader,
      traderInputToken: manifest.weth,
      traderOutputToken: manifest.usdc,
      requestedValue: "1000",
      minimumTraderOutputValue: "900",
      nonce: String(nonce),
      deadline: latest,
    }),
  );
}

async function main() {
  const [rpcPort, apiPort, appPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const forkDirectory = path.join(runDirectory, "fork");
  let fork;
  const start = (reset) =>
    startFork({ directory: forkDirectory, rpcPort, apiPort, appPort, reset });
  fork = start(true);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const chain = defineChain({
    id: CHAIN_ID,
    name: "AURKA price recovery fixture",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const ownerWallet = createWalletClient({
    account: accounts[0],
    chain,
    transport: http(rpcUrl),
  });
  const bobWallet = createWalletClient({
    account: accounts[1],
    chain,
    transport: http(rpcUrl),
  });
  try {
    await waitForFork(apiUrl);
    let manifest = JSON.parse(
      readFileSync(path.join(forkDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.integrationMode, "fixture-upstream");
    assert.equal(manifest.oracleKind, "MOCK_ORACLE");
    assert.equal(manifest.aquaKind, "MOCK_AQUA");
    assert.equal(manifest.executionEngine, "AURKA_UPSTREAM_LIMIT_SWAP_V1");

    const oldId = "space:price-recovery-old";
    const funding = { usdc: "24000", weth: "4" };
    const old = await createAndActivateSpace({
      apiUrl,
      identity: manifest,
      ownerWallet,
      publicClient,
      funding,
      id: oldId,
      name: "Price recovery old Space",
    });
    let oldFork = await api(
      apiUrl,
      `/fork?spaceId=${encodeURIComponent(oldId)}`,
    );
    const oldBefore = await ownerAction(apiUrl, "state", oldId);
    const oldIntent = await prepareIntent(
      apiUrl,
      oldId,
      accounts[1].address,
      manifest,
      1,
    );
    const oldSolved = await api(
      apiUrl,
      "/v1/solve",
      post({ intent: oldIntent }),
    );

    const oracleBlock = await publicClient.getBlock();
    const priceChangeHash = await ownerWallet.writeContract({
      address: manifest.oracle,
      abi: ORACLE_ABI,
      functionName: "setPrice",
      args: [
        manifest.usdc,
        2n,
        0,
        oracleBlock.timestamp,
        `0x${"33".repeat(32)}`,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: priceChangeHash });
    oldFork = await api(apiUrl, `/fork?spaceId=${encodeURIComponent(oldId)}`);
    const staleSpace = await api(
      apiUrl,
      `/v1/spaces/${encodeURIComponent(oldId)}`,
    );
    assert.equal(staleSpace.identity.state, "PRICING_NEEDS_RENEWAL");
    assert.equal(oldFork.capacity.authorized, false);
    const renewalError = await expectApiError(
      apiUrl,
      "/v1/quote",
      post({ intent: oldIntent }),
      "PRICING_RENEWAL_REQUIRED",
    );
    await expectApiError(
      apiUrl,
      "/v1/execute",
      post({
        intentHash: oldSolved.proposal.intentHash,
        proposalHash: oldSolved.proposalHash,
      }),
      "PRICING_RENEWAL_REQUIRED",
    );

    const pause = await ownerAction(apiUrl, "pause", oldId);
    const pauseHash = await sendTransaction(ownerWallet, publicClient, pause);
    await api(apiUrl, `/fork?spaceId=${encodeURIComponent(oldId)}`);
    const pausedSpace = await api(
      apiUrl,
      `/v1/spaces/${encodeURIComponent(oldId)}`,
    );
    assert.equal(pausedSpace.identity.state, "PAUSED");

    const dock = await ownerAction(apiUrl, "dock", oldId);
    await assert.rejects(
      publicClient.call({
        account: accounts[1].address,
        to: dock.to,
        data: dock.data,
        value: BigInt(dock.value),
      }),
    );
    const dockHash = await sendTransaction(ownerWallet, publicClient, dock);
    const afterDock = await ownerAction(apiUrl, "state", oldId);
    for (const token of [manifest.usdc, manifest.weth]) {
      assert.equal(afterDock.aquaBalances[token].balance, "0");
      assert.equal(afterDock.aquaBalances[token].tokensCount, 255);
      assert.equal(
        afterDock.vaultBalances[token],
        oldBefore.aquaBalances[token].balance,
      );
    }

    const withdrawUsdc = await ownerAction(apiUrl, "withdraw", oldId, {
      token: "USDC",
      amount: oldBefore.aquaBalances[manifest.usdc].balance,
    });
    const withdrawWeth = await ownerAction(apiUrl, "withdraw", oldId, {
      token: "WETH",
      amount: oldBefore.aquaBalances[manifest.weth].balance,
    });
    await assert.rejects(
      publicClient.call({
        account: accounts[1].address,
        to: withdrawUsdc.to,
        data: withdrawUsdc.data,
        value: BigInt(withdrawUsdc.value),
      }),
    );
    const withdrawUsdcHash = await sendTransaction(
      ownerWallet,
      publicClient,
      withdrawUsdc,
    );
    const withdrawWethHash = await sendTransaction(
      ownerWallet,
      publicClient,
      withdrawWeth,
    );
    const afterWithdraw = await ownerAction(apiUrl, "state", oldId);
    for (const token of [manifest.usdc, manifest.weth]) {
      assert.equal(afterWithdraw.vaultBalances[token], "0");
      assert.equal(
        BigInt(afterWithdraw.ownerBalances[token]) -
          BigInt(oldBefore.ownerBalances[token]),
        BigInt(oldBefore.aquaBalances[token].balance),
      );
    }
    const retry = await requestJson(
      `${apiUrl}/fork/owner?${new URLSearchParams({
        action: "withdraw",
        spaceId: oldId,
        token: "USDC",
        amount: oldBefore.aquaBalances[manifest.usdc].balance,
      }).toString()}`,
    );
    assert.equal(retry.response.status, 409);

    // The fork state and lifecycle journal survive an operator restart.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await stopProcess(fork);
    fork = start(false);
    await waitForFork(apiUrl);
    const afterRestart = await ownerAction(apiUrl, "state", oldId);
    assert.deepEqual(afterRestart.vaultBalances, afterWithdraw.vaultBalances);
    assert.deepEqual(afterRestart.ownerBalances, afterWithdraw.ownerBalances);
    assert.deepEqual(afterRestart.aquaBalances, afterWithdraw.aquaBalances);
    manifest = JSON.parse(
      readFileSync(path.join(forkDirectory, "manifest.json"), "utf8"),
    );

    const replacementId = "space:price-recovery-replacement";
    const replacement = await createAndActivateSpace({
      apiUrl,
      identity: manifest,
      ownerWallet,
      publicClient,
      funding,
      id: replacementId,
      name: "Price recovery replacement Space",
    });
    const replacementFork = await api(
      apiUrl,
      `/fork?spaceId=${encodeURIComponent(replacementId)}`,
    );
    assert.notEqual(
      replacement.space.identity.treasuryAddress,
      old.space.identity.treasuryAddress,
    );
    assert.notEqual(
      replacement.space.identity.strategyId,
      old.space.identity.strategyId,
    );
    assert.equal(replacement.space.identity.state, "ACTIVE");
    assert.equal(replacementFork.capacity.authorized, true);
    assert.equal(
      replacementFork.position.currentPortfolio.assets.find(
        (asset) => asset.symbol === "USDC",
      ).price,
      "2",
    );

    const freshIntent = await prepareIntent(
      apiUrl,
      replacementId,
      accounts[1].address,
      manifest,
      2,
    );
    const freshSolved = await api(
      apiUrl,
      "/v1/solve",
      post({ intent: freshIntent }),
    );
    const inputAmount = BigInt(freshSolved.proposal.traderInputAmount);
    const approvalHash = await bobWallet.writeContract({
      address: manifest.weth,
      abi: USDC_ABI,
      functionName: "approve",
      args: [manifest.router, inputAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    const intentSignature = await bobWallet.signTypedData(
      intentTypedData(freshIntent, manifest),
    );
    const executable = await api(
      apiUrl,
      "/v1/execute",
      post({
        intentHash: freshSolved.proposal.intentHash,
        proposalHash: freshSolved.proposalHash,
        externalSignature: intentSignature,
      }),
    );
    const tradeHash = await sendTransaction(
      bobWallet,
      publicClient,
      executable.transactionRequest,
    );
    const afterTrade = await api(
      apiUrl,
      `/fork?spaceId=${encodeURIComponent(replacementId)}`,
    );
    assert(BigInt(afterTrade.capacity.consumed) > 0n);

    const evidence = {
      scenario: "TASK1009-003 space price recovery",
      integrationMode: manifest.integrationMode,
      oracleKind: manifest.oracleKind,
      aquaKind: manifest.aquaKind,
      executionEngine: manifest.executionEngine,
      fork: {
        chainId: manifest.chainId,
        forkBlock: manifest.forkBlock,
        deploymentBlock: manifest.deploymentBlock,
        deploymentBlockHash: manifest.deploymentBlockHash,
      },
      contracts: {
        oracle: manifest.oracle,
        aqua: manifest.aqua,
        aquaApp: manifest.aquaApp,
        router: manifest.router,
        vaultFactory: manifest.vaultFactory,
        swapVM: manifest.swapVM,
        usdc: manifest.usdc,
        weth: manifest.weth,
        swapVMUpstreamCommit: manifest.swapVMUpstreamCommit,
        aquaUpstreamCommit: manifest.aquaUpstreamCommit,
      },
      oldSpace: {
        id: oldId,
        owner: old.space.identity.ownerAddress,
        vault: old.space.identity.treasuryAddress,
        strategyHash: old.space.identity.strategyId,
        before: oldBefore,
        afterDock,
        afterWithdraw,
        afterRestart,
      },
      replacementSpace: {
        id: replacementId,
        owner: replacement.space.identity.ownerAddress,
        vault: replacement.space.identity.treasuryAddress,
        strategyHash: replacement.space.identity.strategyId,
        capacity: replacementFork.capacity,
        freshTradeCapacity: afterTrade.capacity,
      },
      typedGuard: {
        changedOutputPrice: "2",
        freshSnapshot: true,
        state: staleSpace.identity.state,
        executable: false,
        errorCode: renewalError.code,
        oldProposalBlocked: true,
      },
      transactions: {
        oldCreation: old.setupHash,
        priceChange: priceChangeHash,
        pause: pauseHash,
        dock: dockHash,
        withdrawUsdc: withdrawUsdcHash,
        withdrawWeth: withdrawWethHash,
        replacementCreation: replacement.setupHash,
        replacementInputApproval: approvalHash,
        freshTrade: tradeHash,
      },
      limitations:
        "Controlled MockPriceOracle/MockAqua proof on an isolated local Anvil fork; it is not a live Chainlink update or a production recovery claim.",
    };
    const evidenceFile = path.resolve(
      process.env.AURKA_RECOVERY_EVIDENCE_FILE ??
        path.join(runDirectory, "task1009-003-space-price-recovery.json"),
    );
    mkdirSync(path.dirname(evidenceFile), { recursive: true, mode: 0o700 });
    writeFileSync(evidenceFile, `${stringify(evidence)}\n`, { mode: 0o600 });
    console.log(
      `TASK1009-003 price recovery passed; evidence: ${evidenceFile}`,
    );
  } finally {
    await stopProcess(fork);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
}
