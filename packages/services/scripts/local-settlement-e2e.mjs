import {
  LocalChainSnapshotProvider,
  positionForSnapshot,
  contractEpoch,
  contractPriceInput,
  POSITION_ID,
  POLICY_ID,
  POSITION_ID_HASH,
  STRATEGY_HASH,
} from "./chain-snapshot.mjs";
/* global URL, clearTimeout, console, process, setTimeout */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { AurkaClient, AurkaError } from "../../sdk/dist/index.js";
import { protocolEventTopic } from "@aurka/shared";
import {
  AurkaService,
  ChainEventIndexer,
  FixtureProposalSigner,
  JsonRpcHttpTransport,
  ServiceDatabase,
  closeApiServer,
  createApiServer,
  hashBytes,
  listenApiServer,
  signDigest,
} from "../dist/index.js";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const CHAIN_ID = 31_337;
const MNEMONIC = "test test test test test test test test test test test junk";
const MAX_VALUE = 50_000n;
const REQUESTED_VALUE = 200_000n;
const RECEIPT_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 10_000;

const artifactNames = [
  "AurkaPolicyRegistry",
  "RiskModeRegistry",
  "MockERC20",
  "MockAqua",
  "MockPriceOracle",
  "AurkaDirectSwapVM",
  "AurkaSwapVMRouter",
];

function artifact(name) {
  const file = path.join(
    ROOT,
    "contracts",
    "out",
    `${name}.sol`,
    `${name}.json`,
  );
  const value = JSON.parse(readFileSync(file, "utf8"));
  return {
    abi: value.abi,
    bytecode: value.bytecode.object.startsWith("0x")
      ? value.bytecode.object
      : `0x${value.bytecode.object}`,
  };
}

function check(condition, message) {
  assert.ok(condition, message);
}

function asObject(value, index, field) {
  return value && typeof value === "object" && field in value
    ? value[field]
    : value?.[index];
}
function pow10(decimals) {
  return 10n ** BigInt(decimals);
}
function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address && typeof address !== "string", "Could not allocate a port");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startAnvil(port) {
  // stderr/stdout are intentionally discarded: Anvil prints private keys at startup.
  return spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(CHAIN_ID),
      "--accounts",
      "10",
      "--mnemonic",
      MNEMONIC,
      "--disable-code-size-limit",
    ],
    { cwd: ROOT, stdio: "ignore" },
  );
}

async function waitForRpc(transport) {
  const started = Date.now();
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    try {
      const chain = await transport.request({
        method: "eth_chainId",
        params: [],
      });
      if (chain === `0x${CHAIN_ID.toString(16)}`) return;
    } catch {
      // Anvil is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Anvil did not expose the configured chain in time");
}

async function deploy(wallet, publicClient, name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await withTimeout(
    publicClient.waitForTransactionReceipt({ hash }),
    RECEIPT_TIMEOUT_MS,
    `deployment of ${name}`,
  );
  check(receipt.status === "success", `${name} deployment reverted`);
  check(receipt.contractAddress, `${name} deployment returned no address`);
  return { address: receipt.contractAddress, abi };
}

async function write(wallet, publicClient, contract, functionName, args) {
  const hash = await wallet.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const receipt = await withTimeout(
    publicClient.waitForTransactionReceipt({ hash }),
    RECEIPT_TIMEOUT_MS,
    `${functionName} transaction`,
  );
  check(receipt.status === "success", `${functionName} transaction reverted`);
  return receipt;
}

async function read(publicClient, contract, functionName, args) {
  return publicClient.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
}

function receiptLogs(logs, routerAddress) {
  const upstreamExecutionTopic = keccak256(
    stringToHex(
      "UpstreamSwapVMExecuted(bytes32,bytes32,address,address,address,uint256,uint256,bytes32)",
    ),
  ).toLowerCase();
  const names = new Map(
    ["CapacityEpochActivated", "FeesRouted", "TradeExecuted"].map((name) => [
      protocolEventTopic(name).toLowerCase(),
      name,
    ]),
  );
  return logs
    .filter((log) => log.address.toLowerCase() === routerAddress.toLowerCase())
    .map((log) => {
      const topic = log.topics[0]?.toLowerCase();
      if (topic === upstreamExecutionTopic) return undefined;
      const name = names.get(topic);
      check(name, "Receipt contains an unknown indexed router event");
      return {
        chainId: CHAIN_ID,
        contract: routerAddress,
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        name,
        payload: {},
        topics: [...log.topics],
        data: log.data,
        observedAt: 0,
        removed: false,
      };
    })
    .filter((log) => log !== undefined);
}

async function blockObservedLogs(publicClient, logs) {
  const timestamps = new Map();
  return Promise.all(
    logs.map(async (log) => {
      const key = log.blockNumber;
      if (!timestamps.has(key)) {
        const block = await publicClient.getBlock({ blockNumber: BigInt(key) });
        timestamps.set(key, Number(block.timestamp));
      }
      return { ...log, observedAt: timestamps.get(key) };
    }),
  );
}

async function expectRevert(publicClient, request, label) {
  try {
    await publicClient.call({
      to: request.to,
      data: request.data,
      value: BigInt(request.value),
    });
  } catch (error) {
    check(error instanceof Error, `${label} did not return an error`);
    return error.message;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

function changeByte(data, byteFromEnd = 1) {
  const chars = data.slice(2).split("");
  const index = chars.length - byteFromEnd * 2;
  const current = Number.parseInt(chars.slice(index, index + 2).join(""), 16);
  const changed = (current ^ 0xff).toString(16).padStart(2, "0");
  chars.splice(index, 2, ...changed);
  return `0x${chars.join("")}`;
}

function changeWord(data, wordIndex, value) {
  const offset = 8 + wordIndex * 64;
  const chars = data.slice(2).split("");
  const replacement = value.toString(16).padStart(64, "0");
  chars.splice(offset, 64, ...replacement);
  return `0x${chars.join("")}`;
}

async function main() {
  for (const name of artifactNames)
    check(
      artifact(name).bytecode.length > 2,
      `${name} artifact is missing; run forge build`,
    );
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = new JsonRpcHttpTransport(rpcUrl);
  const anvil = startAnvil(port);
  const anvilPidFile = process.env.AURKA_ANVIL_PID_FILE;
  if (anvilPidFile && anvil.pid) writeFileSync(anvilPidFile, `${anvil.pid}\n`);
  let api;
  let database;
  let restartedDatabase;
  const databaseDirectory = mkdtempSync(
    path.join(os.tmpdir(), "aurka-local-settlement-"),
  );
  const databaseFilename = path.join(databaseDirectory, "service.sqlite");
  try {
    await waitForRpc(transport);
    const chain = defineChain({
      id: CHAIN_ID,
      name: "AURKA isolated Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const governanceAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
    const traderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
    const protocolAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const governanceWallet = createWalletClient({
      account: governanceAccount,
      chain,
      transport: http(rpcUrl),
    });
    const traderWallet = createWalletClient({
      account: traderAccount,
      chain,
      transport: http(rpcUrl),
    });
    const chainId = await publicClient.getChainId();
    check(
      chainId === CHAIN_ID,
      `Anvil chain mismatch: expected ${CHAIN_ID}, got ${chainId}`,
    );

    const policyRegistry = await deploy(
      governanceWallet,
      publicClient,
      "AurkaPolicyRegistry",
    );
    const riskRegistry = await deploy(
      governanceWallet,
      publicClient,
      "RiskModeRegistry",
      [policyRegistry.address],
    );
    const usdc = await deploy(governanceWallet, publicClient, "MockERC20", [
      "USDC",
      6,
    ]);
    const weth = await deploy(governanceWallet, publicClient, "MockERC20", [
      "WETH",
      18,
    ]);
    const link = await deploy(governanceWallet, publicClient, "MockERC20", [
      "LINK",
      8,
    ]);
    const aqua = await deploy(governanceWallet, publicClient, "MockAqua");
    const oracle = await deploy(
      governanceWallet,
      publicClient,
      "MockPriceOracle",
    );
    const swapVM = await deploy(
      governanceWallet,
      publicClient,
      "AurkaDirectSwapVM",
    );
    const router = await deploy(
      governanceWallet,
      publicClient,
      "AurkaSwapVMRouter",
      [
        policyRegistry.address,
        riskRegistry.address,
        aqua.address,
        swapVM.address,
      ],
    );
    const tokenArtifacts = [
      { ...usdc, symbol: "USDC" },
      { ...weth, symbol: "WETH" },
      { ...link, symbol: "LINK" },
    ];
    const treasury = governanceAccount.address;
    const tokens = tokenArtifacts;
    const assetConfigs = [
      {
        token: usdc.address,
        decimals: 6,
        minimumWeightBps: 5_500,
        maximumWeightBps: 10_000,
      },
      {
        token: weth.address,
        decimals: 18,
        minimumWeightBps: 0,
        maximumWeightBps: 3_500,
      },
      {
        token: link.address,
        decimals: 8,
        minimumWeightBps: 0,
        maximumWeightBps: 1_500,
      },
    ];
    const feeConfig = {
      baseFeeBps: 20,
      slopeBps: 80,
      maximumFeeBps: 100,
      treasuryBaseFeeBps: 10,
      solverFeeBps: 5,
      protocolFeeBps: 5,
      treasuryFeeRecipient: treasury,
      protocolFeeRecipient: protocolAccount.address,
    };
    await write(
      governanceWallet,
      publicClient,
      policyRegistry,
      "createPolicy",
      [
        POLICY_ID,
        treasury,
        governanceAccount.address,
        assetConfigs,
        MAX_VALUE,
        feeConfig,
      ],
    );
    await write(
      governanceWallet,
      publicClient,
      policyRegistry,
      "setSettlementConfiguration",
      [POLICY_ID, POSITION_ID_HASH, STRATEGY_HASH, oracle.address],
    );
    const latestBeforePrices = await publicClient.getBlock();
    const observedAt = latestBeforePrices.timestamp;
    const prices = [
      {
        token: usdc.address,
        price: 1n,
        priceDecimals: 0,
        snapshotId: `0x${"11".repeat(32)}`,
      },
      {
        token: weth.address,
        price: 1n,
        priceDecimals: 0,
        snapshotId: `0x${"22".repeat(32)}`,
      },
      {
        token: link.address,
        price: 1n,
        priceDecimals: 0,
        snapshotId: `0x${"33".repeat(32)}`,
      },
    ];
    for (const price of prices)
      await write(governanceWallet, publicClient, oracle, "setPrice", [
        price.token,
        price.price,
        price.priceDecimals,
        observedAt,
        price.snapshotId,
      ]);
    const usdcTreasuryBalance = 1_000_000n * pow10(6);
    const wethTraderBalance = 1_000_000n * pow10(18);
    const aquaUsdcBalance = 600_000n * pow10(6);
    const aquaWethBalance = 300_000n * pow10(18);
    const aquaLinkBalance = 100_000n * pow10(8);
    await write(governanceWallet, publicClient, usdc, "mint", [
      treasury,
      usdcTreasuryBalance,
    ]);
    await write(governanceWallet, publicClient, weth, "mint", [
      traderAccount.address,
      wethTraderBalance,
    ]);
    await write(governanceWallet, publicClient, usdc, "approve", [
      aqua.address,
      2n ** 256n - 1n,
    ]);
    await write(governanceWallet, publicClient, weth, "approve", [
      aqua.address,
      2n ** 256n - 1n,
    ]);
    await write(governanceWallet, publicClient, aqua, "seed", [
      treasury,
      router.address,
      STRATEGY_HASH,
      usdc.address,
      aquaUsdcBalance,
    ]);
    await write(governanceWallet, publicClient, aqua, "seed", [
      treasury,
      router.address,
      STRATEGY_HASH,
      weth.address,
      aquaWethBalance,
    ]);
    await write(governanceWallet, publicClient, aqua, "seed", [
      treasury,
      router.address,
      STRATEGY_HASH,
      link.address,
      aquaLinkBalance,
    ]);
    await write(traderWallet, publicClient, weth, "approve", [
      router.address,
      2n ** 256n - 1n,
    ]);

    const solver = new FixtureProposalSigner();
    const contracts = {
      policyRegistry,
      riskRegistry,
      aqua,
      oracle,
      router,
      erc20Abi: usdc.abi,
    };
    const provider = new LocalChainSnapshotProvider(
      publicClient,
      contracts,
      solver.address,
    );
    const initialSnapshot = await provider.currentSnapshot();
    check(
      initialSnapshot.portfolio.assets[0].decimals !==
        initialSnapshot.portfolio.assets[1].decimals,
      "Settlement pair must use mixed decimals",
    );
    const position = positionForSnapshot(
      initialSnapshot,
      policyRegistry.address,
      treasury,
    );
    database = new ServiceDatabase({ filename: databaseFilename });
    const service = new AurkaService({
      database,
      provider,
      signer: solver,
      chainId: CHAIN_ID,
      settlementContract: router.address,
      indexConfirmations: 0,
      rpcTransport: transport,
      seedFixture: false,
    });
    service.repository.savePosition(position);
    api = createApiServer({ service });
    await listenApiServer(api, 0, "127.0.0.1");
    const apiAddress = api.server.address();
    check(
      apiAddress && typeof apiAddress !== "string",
      "API did not bind a TCP port",
    );
    const client = new AurkaClient({
      baseUrl: `http://127.0.0.1:${apiAddress.port}`,
      timeout: 5_000,
    });

    const preparationBlock = await publicClient.getBlock();
    const deadline = Number(preparationBlock.timestamp) + 300;
    const intent = await client.prepareIntent({
      positionId: POSITION_ID,
      trader: traderAccount.address,
      traderInputToken: weth.address,
      traderOutputToken: usdc.address,
      requestedValue: REQUESTED_VALUE.toString(),
      minimumTraderOutputValue: "49700",
      nonce: "1",
      deadline,
    });
    const submitted = await client.submitIntent(intent);
    const epochSnapshot = await provider.getSnapshot(intent);
    const activationReceipt = await write(
      governanceWallet,
      publicClient,
      router,
      "activateCapacityEpoch",
      [
        POLICY_ID,
        contractEpoch(epochSnapshot),
        contractPriceInput(epochSnapshot),
      ],
    );
    const quote = await client.quote(intent);
    const solved = await client.solve(intent);
    check(
      quote.simulationStatus === "AUTHORIZATION_PENDING",
      "Quote must remain authorization-pending before trader authorization",
    );
    check(
      solved.simulation.status === "AUTHORIZATION_PENDING",
      "Solve preflight must wait for trader authorization",
    );
    check(
      solved.proposal.traderInputValue === "50000",
      "Router proposal did not use the safe local fill",
    );
    check(
      solved.proposal.traderOutputValue === "49766",
      "Unexpected normalized trader output",
    );
    check(
      solved.proposal.treasuryOutputValue === "49816",
      "Unexpected normalized treasury output",
    );
    check(
      solved.proposal.solverFeeAmount === "25000000",
      "Unexpected raw solver fee for 6-decimal output token",
    );
    check(
      solved.proposal.protocolFeeAmount === "25000000",
      "Unexpected raw protocol fee for 6-decimal output token",
    );
    check(
      BigInt(solved.proposal.traderInputAmount) === MAX_VALUE * pow10(18),
      "Input raw amount was not scaled by WETH decimals",
    );
    check(
      BigInt(solved.proposal.traderOutputAmount) === 49_766n * pow10(6),
      "Output raw amount was not scaled by USDC decimals",
    );
    check(
      solved.proposal.traderInputAmount !== solved.proposal.traderInputValue,
      "Raw input accidentally equals normalized value",
    );

    const wrongDomainSignature = signDigest(
      hashBytes("wrong-router-domain"),
      traderAccount.getHdKey().privKeyBytes,
    );
    for (const [label, signature] of [
      [
        "wrong trader",
        signDigest(
          submitted.intentHash,
          protocolAccount.getHdKey().privKeyBytes,
        ),
      ],
      ["wrong domain", wrongDomainSignature],
    ]) {
      try {
        await client.execute(
          submitted.intentHash,
          solved.proposalHash,
          signature,
        );
      } catch (error) {
        check(
          error instanceof AurkaError && error.code === "INVALID_SIGNATURE",
          `${label} signature was not rejected at the API boundary`,
        );
        continue;
      }
      throw new Error(`${label} signature unexpectedly passed`);
    }
    const traderSignature = signDigest(
      submitted.intentHash,
      traderAccount.getHdKey().privKeyBytes,
    );
    const executionResult = await client.execute(
      submitted.intentHash,
      solved.proposalHash,
      traderSignature,
      "local-settlement-execute",
    );
    const transactionRequest = executionResult.transactionRequest;
    check(
      transactionRequest.to.toLowerCase() === router.address.toLowerCase(),
      "API returned the wrong settlement target",
    );
    const traderInputBefore = await read(publicClient, weth, "balanceOf", [
      traderAccount.address,
    ]);
    const traderOutputBefore = await read(publicClient, usdc, "balanceOf", [
      traderAccount.address,
    ]);
    const solverOutputBefore = await read(publicClient, usdc, "balanceOf", [
      solver.address,
    ]);
    const protocolOutputBefore = await read(publicClient, usdc, "balanceOf", [
      protocolAccount.address,
    ]);
    const capacityBefore = await read(publicClient, router, "capacityState", [
      POSITION_ID_HASH,
      weth.address,
      usdc.address,
    ]);
    const sentHash = await traderWallet.sendTransaction({
      to: transactionRequest.to,
      data: transactionRequest.data,
      value: BigInt(transactionRequest.value),
    });
    const settlementReceipt = await withTimeout(
      publicClient.waitForTransactionReceipt({ hash: sentHash }),
      RECEIPT_TIMEOUT_MS,
      "settlement receipt",
    );
    check(
      settlementReceipt.status === "success",
      "SDK/API-generated settlement reverted on Anvil",
    );
    const traderInputAfter = await read(publicClient, weth, "balanceOf", [
      traderAccount.address,
    ]);
    const traderOutputAfter = await read(publicClient, usdc, "balanceOf", [
      traderAccount.address,
    ]);
    const solverOutputAfter = await read(publicClient, usdc, "balanceOf", [
      solver.address,
    ]);
    const protocolOutputAfter = await read(publicClient, usdc, "balanceOf", [
      protocolAccount.address,
    ]);
    check(
      traderInputBefore - traderInputAfter === 50_000n * pow10(18),
      "Trader input raw delta does not reconcile",
    );
    check(
      traderOutputAfter - traderOutputBefore === 49_766n * pow10(6),
      "Trader output raw delta does not reconcile",
    );
    check(
      solverOutputAfter - solverOutputBefore === 25n * pow10(6),
      "Solver raw fee delta does not reconcile",
    );
    check(
      protocolOutputAfter - protocolOutputBefore === 25n * pow10(6),
      "Protocol raw fee delta does not reconcile",
    );
    const capacityAfter = await read(publicClient, router, "capacityState", [
      POSITION_ID_HASH,
      weth.address,
      usdc.address,
    ]);
    check(
      asObject(capacityAfter, 2, "consumedValue") === 50_000n,
      "Onchain capacity did not consume the executed value",
    );
    check(
      asObject(capacityAfter, 0, "capacityEpochId") ===
        solved.proposal.capacityEpochId,
      "Onchain capacity epoch differs from the solver commitment",
    );
    check(
      asObject(capacityBefore, 2, "consumedValue") === 0n,
      "Capacity was consumed before the settlement",
    );

    const currentAfterSettlement = await provider.currentSnapshot();
    check(
      currentAfterSettlement.portfolio.assets.find(
        (asset) => asset.token.toLowerCase() === usdc.address.toLowerCase(),
      ).value === 550_184n,
      "USDC normalized portfolio delta does not reconcile",
    );
    check(
      currentAfterSettlement.portfolio.assets.find(
        (asset) => asset.token.toLowerCase() === weth.address.toLowerCase(),
      ).value === 350_000n,
      "WETH normalized portfolio delta does not reconcile",
    );
    check(
      currentAfterSettlement.portfolio.assets.find(
        (asset) => asset.token.toLowerCase() === link.address.toLowerCase(),
      ).value === 100_000n,
      "Untraded LINK portfolio value changed",
    );
    const rawLogs = await blockObservedLogs(
      publicClient,
      receiptLogs(activationReceipt.logs, router.address).concat(
        receiptLogs(settlementReceipt.logs, router.address),
      ),
    );
    check(
      rawLogs.length === 3,
      `Expected activation, fee, and trade logs; got ${rawLogs.length}`,
    );
    const byName = new Map(rawLogs.map((log) => [log.name, log]));
    const feeLog = byName.get("FeesRouted");
    const tradeLog = byName.get("TradeExecuted");
    check(
      feeLog && tradeLog,
      "Receipt logs did not include both settlement events",
    );
    const databaseIndexer = new ChainEventIndexer(service.repository);
    const firstProjection = databaseIndexer.ingest(rawLogs);
    const duplicateProjection = databaseIndexer.ingest(rawLogs);
    check(
      firstProjection.inserted === 3 && duplicateProjection.inserted === 3,
      "Actual receipt logs were not accepted by the shared decoder",
    );
    check(
      service.repository.listEvents(CHAIN_ID, 20).items.length === 3,
      "Duplicate receipt replay created duplicate raw events",
    );
    check(
      service.repository.getCapacityEpoch(
        POSITION_ID,
        weth.address.toLowerCase(),
        usdc.address.toLowerCase(),
      )?.consumedValue === "50000",
      "Capacity projection did not consume the actual TradeExecuted log",
    );
    const pendingExecution = service.getExecution(
      executionResult.execution.transactionHash,
    );
    check(
      pendingExecution.status === "PENDING",
      "Service claimed a confirmed status without an authorized receipt projection",
    );

    const stateBeforeRejections = {
      traderInput: await read(publicClient, weth, "balanceOf", [
        traderAccount.address,
      ]),
      traderOutput: await read(publicClient, usdc, "balanceOf", [
        traderAccount.address,
      ]),
      solverOutput: await read(publicClient, usdc, "balanceOf", [
        solver.address,
      ]),
      protocolOutput: await read(publicClient, usdc, "balanceOf", [
        protocolAccount.address,
      ]),
      consumed: asObject(
        await read(publicClient, router, "capacityState", [
          POSITION_ID_HASH,
          weth.address,
          usdc.address,
        ]),
        2,
        "consumedValue",
      ),
    };
    const modifiedProposalData = changeWord(
      transactionRequest.data,
      24,
      BigInt(solved.proposal.traderInputAmount) + 1n,
    );
    const modifiedProgramData = changeByte(transactionRequest.data);
    await expectRevert(
      publicClient,
      { ...transactionRequest, data: modifiedProposalData },
      "modified proposal calldata",
    );
    await expectRevert(
      publicClient,
      { ...transactionRequest, data: modifiedProgramData },
      "modified direct-program calldata",
    );
    await expectRevert(publicClient, transactionRequest, "replayed intent");
    await transport.request({ method: "evm_increaseTime", params: [400] });
    await transport.request({ method: "evm_mine", params: [] });
    await expectRevert(publicClient, transactionRequest, "expired intent");
    const stateAfterRejections = {
      traderInput: await read(publicClient, weth, "balanceOf", [
        traderAccount.address,
      ]),
      traderOutput: await read(publicClient, usdc, "balanceOf", [
        traderAccount.address,
      ]),
      solverOutput: await read(publicClient, usdc, "balanceOf", [
        solver.address,
      ]),
      protocolOutput: await read(publicClient, usdc, "balanceOf", [
        protocolAccount.address,
      ]),
      consumed: asObject(
        await read(publicClient, router, "capacityState", [
          POSITION_ID_HASH,
          weth.address,
          usdc.address,
        ]),
        2,
        "consumedValue",
      ),
    };
    assert.deepEqual(
      stateAfterRejections,
      stateBeforeRejections,
      "Rejected settlements changed balances or capacity",
    );

    await closeApiServer(api);
    api = undefined;
    restartedDatabase = new ServiceDatabase({ filename: databaseFilename });
    const restartedService = new AurkaService({
      database: restartedDatabase,
      provider,
      signer: solver,
      chainId: CHAIN_ID,
      settlementContract: router.address,
      indexConfirmations: 0,
      rpcTransport: transport,
      seedFixture: false,
    });
    const restartedIndexer = new ChainEventIndexer(restartedService.repository);
    const restartReplay = restartedIndexer.ingest(rawLogs);
    check(
      restartReplay.inserted === 3,
      "Receipt logs were not replayable after database restart",
    );
    check(
      restartedService.repository.listEvents(CHAIN_ID, 20).items.length === 3,
      "Restart replay duplicated receipt events",
    );
    check(
      restartedService.repository.getCapacityEpoch(
        POSITION_ID,
        weth.address.toLowerCase(),
        usdc.address.toLowerCase(),
      )?.consumedValue === "50000",
      "Restart replay lost projected capacity",
    );
    check(
      restartedService.getExecution(executionResult.execution.transactionHash)
        .status === "PENDING",
      "Restart lost the persisted execution record",
    );
    restartedService.close();
    restartedDatabase = undefined;
    database = undefined;

    console.log(
      JSON.stringify(
        {
          status: "passed",
          chainId: CHAIN_ID,
          router: router.address,
          policyRegistry: policyRegistry.address,
          riskRegistry: riskRegistry.address,
          aqua: aqua.address,
          oracle: oracle.address,
          swapVM: swapVM.address,
          tokens: tokens.map((token) => ({
            symbol: token.symbol,
            address: token.address,
          })),
          activationTransaction: activationReceipt.transactionHash,
          settlementTransaction: sentHash,
          eventCount: rawLogs.length,
          normalized: {
            traderInputValue: "50000",
            traderOutputValue: "49766",
            treasuryOutputValue: "49816",
            totalFee: quote.fees.totalFeeAmount,
          },
          rawDeltas: {
            traderInput: (traderInputBefore - traderInputAfter).toString(),
            traderOutput: (traderOutputAfter - traderOutputBefore).toString(),
            solverFee: (solverOutputAfter - solverOutputBefore).toString(),
            protocolFee: (
              protocolOutputAfter - protocolOutputBefore
            ).toString(),
          },
          projection: {
            duplicateReplayEvents: 3,
            restartReplayEvents: 3,
            consumedValue: "50000",
            executionStatus: "PENDING",
          },
          rejections: [
            "wrong-trader-signature",
            "wrong-domain-signature",
            "modified-proposal",
            "modified-direct-program",
            "replayed-intent",
            "expired-intent",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (api) await closeApiServer(api).catch(() => {});
    if (api) database = undefined;
    if (database) database.close();
    if (restartedDatabase) restartedDatabase.close();
    rmSync(databaseDirectory, { recursive: true, force: true });
    await stopProcess(anvil);
    if (anvilPidFile) rmSync(anvilPidFile, { force: true });
  }
}

export {
  artifact,
  deploy,
  write,
  read,
  receiptLogs,
  blockObservedLogs,
  stopProcess,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
