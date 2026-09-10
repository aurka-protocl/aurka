/* global clearTimeout, console, fetch, process, setTimeout */

import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { AurkaClient } from "../../sdk/dist/index.js";
import {
  AurkaService,
  FixtureProposalSigner,
  JsonRpcHttpTransport,
  ServiceDatabase,
  closeApiServer,
  createApiServer,
  hashAquaBalances,
  hashBytes,
  hashCanonical,
  listenApiServer,
  signDigest,
} from "../dist/index.js";
import {
  calculatePortfolioValuation,
  computeCapacityEpochId,
  computePortfolioPriceSnapshotHash,
  computeSettlementPriceSnapshotHash,
} from "@aurka/shared";
import { GraphClient, GraphSignalSource } from "@aurka/graph";

const ROOT = path.resolve(
  new globalThis.URL("../../..", import.meta.url).pathname,
);
const CHAIN_ID = 31_337;
const MNEMONIC = "test test test test test test test test test test test junk";
const POSITION_ID = "position:graph-node-e2e";
const POLICY_ID = hashBytes("policy:graph-node-e2e");
const POSITION_ID_HASH = hashBytes(POSITION_ID);
const STRATEGY_HASH = hashBytes("strategy:graph-node-e2e");
const ZERO_HASH = `0x${"00".repeat(32)}`;
const MAX_VALUE = 50_000n;
const REQUESTED_VALUE = 200_000n;
const STARTUP_TIMEOUT_MS = 45_000;
const INDEX_TIMEOUT_MS = 90_000;
const GRAPH_NODE_VERSION = "v0.41.2";
const POSTGRES_VERSION = "14.11";
const IPFS_VERSION = "v0.17.0";

const artifactNames = [
  "AurkaPolicyRegistry",
  "RiskModeRegistry",
  "MockERC20",
  "MockAqua",
  "MockPriceOracle",
  "AurkaDirectSwapVM",
  "AurkaSwapVMRouter",
];

function check(condition, message) {
  assert.ok(condition, message);
}

function asObject(value, index, field) {
  if (value && typeof value === "object" && field in value) return value[field];
  return value?.[index];
}

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

function pow10(decimals) {
  return 10n ** BigInt(decimals);
}

function ceilDiv(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function valueToRaw(value, asset) {
  return ceilDiv(
    value * pow10(asset.decimals) * pow10(asset.priceDecimals),
    asset.price,
  );
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
  // Anvil is reachable from the Graph Node container through host.docker.internal.
  // The random port and disposable chain keep this local-only.
  return spawn(
    "anvil",
    [
      "--host",
      "0.0.0.0",
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
      // The local node is still starting.
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
    STARTUP_TIMEOUT_MS,
    `deployment of ${name}`,
  );
  check(receipt.status === "success", `${name} deployment reverted`);
  check(receipt.contractAddress, `${name} deployment returned no address`);
  return {
    address: receipt.contractAddress,
    abi,
    blockNumber: receipt.blockNumber,
  };
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
    STARTUP_TIMEOUT_MS,
    `${functionName} transaction`,
  );
  check(receipt.status === "success", `${functionName} transaction reverted`);
  return receipt;
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

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({});
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`),
        );
    });
  });
}

async function waitHttp(url, label, timeout = STARTUP_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become reachable in time`);
}

function composeFile(anvilPort, ports, genesisBlockNumber = 0) {
  return `services:
  postgres:
    image: postgres:${POSTGRES_VERSION}
    environment:
      POSTGRES_USER: graph-node
      POSTGRES_PASSWORD: local-only
      POSTGRES_DB: graph-node
      PGDATA: /var/lib/postgresql/data
      POSTGRES_INITDB_ARGS: -E UTF8 --locale=C
    command: ["postgres", "-cshared_preload_libraries=pg_stat_statements", "-cmax_connections=200"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U graph-node -d graph-node"]
      interval: 2s
      timeout: 3s
      retries: 30
  ipfs:
    image: ipfs/kubo:${IPFS_VERSION}
    healthcheck:
      test: ["CMD", "ipfs", "id"]
      interval: 2s
      timeout: 3s
      retries: 30
    ports:
      - "127.0.0.1:${ports.ipfs}:5001"
  graph-node:
    image: graphprotocol/graph-node:${GRAPH_NODE_VERSION}
    depends_on:
      postgres:
        condition: service_healthy
      ipfs:
        condition: service_healthy
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      postgres_host: postgres
      postgres_user: graph-node
      postgres_pass: local-only
      postgres_db: graph-node
      ipfs: ipfs:5001
      ethereum: localhost:http://host.docker.internal:${anvilPort}
      GRAPH_ETHEREUM_GENESIS_BLOCK_NUMBER: "${genesisBlockNumber}"
      GRAPH_LOG: info
    ports:
      - "127.0.0.1:${ports.graphql}:8000"
      - "127.0.0.1:${ports.admin}:8020"
      - "127.0.0.1:${ports.status}:8030"
`;
}

export async function startGraphStack(anvilPort, requestedPorts = {}) {
  const ports = {
    graphql: requestedPorts.graphql ?? (await freePort()),
    admin: requestedPorts.admin ?? (await freePort()),
    status: requestedPorts.status ?? (await freePort()),
    ipfs: requestedPorts.ipfs ?? (await freePort()),
  };
  const directory = mkdtempSync(path.join(os.tmpdir(), "aurka-graph-node-"));
  const compose = path.join(directory, "docker-compose.yml");
  writeFileSync(
    compose,
    composeFile(anvilPort, ports, requestedPorts.genesisBlockNumber ?? 0),
  );
  const project =
    process.env.AURKA_GRAPH_PROJECT ??
    `aurka-graph-${process.pid}-${Date.now()}`;
  await run("docker", ["compose", "-p", project, "-f", compose, "up", "-d"]);
  try {
    await waitHttp(`http://127.0.0.1:${ports.graphql}`, "Graph Node GraphQL");
    await waitHttp(
      `http://127.0.0.1:${ports.ipfs}/api/v0/version`,
      "local IPFS",
    );
  } catch (error) {
    await run(
      "docker",
      ["compose", "-p", project, "-f", compose, "logs", "--no-color"],
      {
        timeout: 10_000,
      },
    ).catch(() => {});
    await run(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        compose,
        "down",
        "-v",
        "--remove-orphans",
      ],
      { timeout: 30_000 },
    ).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    compose,
    project,
    graphql: `http://127.0.0.1:${ports.graphql}`,
    admin: `http://127.0.0.1:${ports.admin}`,
    ipfs: `http://127.0.0.1:${ports.ipfs}`,
  };
}

export async function stopGraphStack(stack) {
  if (!stack) return;
  await run(
    "docker",
    [
      "compose",
      "-p",
      stack.project,
      "-f",
      stack.compose,
      "down",
      "-v",
      "--remove-orphans",
    ],
    { timeout: 30_000 },
  ).catch(() => {});
  rmSync(stack.directory, { recursive: true, force: true });
}

export function temporaryManifest(stackDirectory, deployments) {
  // Deploy from the source manifest so graph-cli performs codegen/build for
  // this runtime-calibrated manifest. Deploying the checked-in build manifest
  // makes graph-cli look for a source file named `*.wasm.ts`.
  const source = path.join(ROOT, "packages/graph/subgraph");
  const target = path.join(stackDirectory, "manifest");
  cpSync(source, target, { recursive: true });
  let manifest = readFileSync(path.join(target, "subgraph.yaml"), "utf8");
  for (const [name, deployment] of Object.entries(deployments)) {
    const pattern = new RegExp(
      `(name: ${name}[\\s\\S]*?address: ")[^"]+("[\\s\\S]*?startBlock:) 0`,
    );
    const updated = manifest.replace(
      pattern,
      `$1${deployment.address}$2 ${deployment.blockNumber.toString()}`,
    );
    check(
      updated !== manifest,
      `Manifest data source ${name} was not replaced`,
    );
    manifest = updated;
  }
  writeFileSync(path.join(target, "subgraph.yaml"), manifest);
  // graph-cli resolves project dependencies relative to the manifest. The
  // generated directory is intentionally disposable, so link the workspace
  // modules instead of copying or mutating the checked-in subgraph tree.
  symlinkSync(
    path.join(ROOT, "packages/graph/node_modules"),
    path.join(target, "node_modules"),
    "dir",
  );
  return target;
}

export async function deploySubgraph(stack, manifestDirectory) {
  const name = `aurka-local-${process.pid}-${Date.now()}`.toLowerCase();
  const graphCli = path.join(ROOT, "packages/graph/node_modules/.bin/graph");
  await run(graphCli, ["create", name, "--node", `${stack.admin}/`]);
  await run(
    graphCli,
    [
      "deploy",
      name,
      "subgraph.yaml",
      "--node",
      `${stack.admin}/`,
      "--ipfs",
      `${stack.ipfs}/api/v0`,
      "--version-label",
      "local",
    ],
    { cwd: manifestDirectory },
  );
  return { name, endpoint: `${stack.graphql}/subgraphs/name/${name}` };
}

async function graphQuery(endpoint, query, variables = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  check(response.ok, `GraphQL HTTP ${response.status}`);
  if (body.errors?.length)
    throw new Error(body.errors.map((item) => item.message).join("; "));
  check(body.data, "GraphQL response did not include data");
  return body.data;
}

export { graphQuery, waitForIndexedBlock };

async function waitForIndexedBlock(endpoint, blockNumber) {
  const started = Date.now();
  let last;
  while (Date.now() - started < INDEX_TIMEOUT_MS) {
    try {
      last = await graphQuery(
        endpoint,
        "{ _meta { deployment hasIndexingErrors block { number hash timestamp } } }",
      );
      if (Number(last._meta.block.number) >= Number(blockNumber)) {
        check(
          !last._meta.hasIndexingErrors,
          "Graph Node reports indexing errors",
        );
        return last._meta;
      }
    } catch {
      // The deployment is created before its first block is indexed.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Graph Node did not index block ${blockNumber}; last=${JSON.stringify(last)}`,
  );
}

async function waitForGraphReorg(endpoint, orphanHash, replacementHash) {
  const started = Date.now();
  let last;
  while (Date.now() - started < INDEX_TIMEOUT_MS) {
    try {
      last = await graphQuery(endpoint, ENTITY_QUERY);
      const hasOrphan = last.policyMutations.some(
        (item) =>
          item.transactionHash.toLowerCase() === orphanHash.toLowerCase(),
      );
      const hasReplacement = last.policyMutations.some(
        (item) =>
          item.transactionHash.toLowerCase() === replacementHash.toLowerCase(),
      );
      if (!hasOrphan && hasReplacement) return last;
    } catch {
      // The deployment can briefly be unavailable while Graph Node rewinds.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Graph Node did not replace the orphaned block; last=${JSON.stringify(last)}`,
  );
}

function policyFrom(raw) {
  const fee = raw?.fee ?? raw?.[9];
  return {
    treasury: asObject(raw, 0, "treasury"),
    governance: asObject(raw, 1, "governance"),
    maximumTransactionValue: BigInt(
      asObject(raw, 3, "maximumTransactionValue"),
    ),
    nonce: BigInt(asObject(raw, 4, "nonce")),
    priceMaxAgeSeconds: Number(asObject(raw, 5, "priceMaxAgeSeconds")),
    maximumPriceDeviationBps: Number(
      asObject(raw, 6, "maximumPriceDeviationBps"),
    ),
    paused: Boolean(asObject(raw, 7, "paused")),
    fee: {
      baseFeeBps: Number(asObject(fee, 0, "baseFeeBps")),
      slopeBps: Number(asObject(fee, 1, "slopeBps")),
      maximumFeeBps: Number(asObject(fee, 2, "maximumFeeBps")),
      treasuryBaseFeeBps: Number(asObject(fee, 3, "treasuryBaseFeeBps")),
      solverFeeBps: Number(asObject(fee, 4, "solverFeeBps")),
      protocolFeeBps: Number(asObject(fee, 5, "protocolFeeBps")),
      treasuryFeeRecipient: asObject(fee, 6, "treasuryFeeRecipient"),
      protocolFeeRecipient: asObject(fee, 7, "protocolFeeRecipient"),
    },
  };
}

class LocalChainSnapshotProvider {
  constructor(publicClient, contracts, solverAddress) {
    this.publicClient = publicClient;
    this.contracts = contracts;
    this.solverAddress = solverAddress;
  }

  async getPositionSnapshot(positionId) {
    const snapshot = await this.currentSnapshot();
    if (positionId !== snapshot.positionId)
      throw new Error("Unknown local position");
    return snapshot;
  }

  async prepareIntent(input) {
    const snapshot = await this.currentSnapshot();
    const intent = {
      intentId: hashBytes(JSON.stringify(input)),
      policyId: snapshot.policyId,
      positionIdHash: POSITION_ID_HASH,
      trader: input.trader,
      traderInputToken: input.traderInputToken,
      traderOutputToken: input.traderOutputToken,
      requestedValue: input.requestedValue,
      minimumTraderOutputValue: input.minimumTraderOutputValue,
      exactInput: false,
      allowPartialFill: true,
      deadline: input.deadline,
      nonce: input.nonce,
      balanceSnapshot: snapshot.balancesHash,
      priceSnapshot: computeSettlementPriceSnapshotHash(
        snapshot.priceProtection,
      ),
      aquaStrategyHash: snapshot.aquaStrategyHash,
    };
    await this.getSnapshot(intent);
    return intent;
  }

  async getSnapshot(intent) {
    const snapshot = await this.currentSnapshot();
    if (intent.policyId.toLowerCase() !== snapshot.policyId.toLowerCase())
      throw new Error("Unknown policy");
    if (intent.positionIdHash.toLowerCase() !== POSITION_ID_HASH.toLowerCase())
      throw new Error("Unknown position");
    if (
      intent.aquaStrategyHash.toLowerCase() !==
      snapshot.aquaStrategyHash.toLowerCase()
    )
      throw new Error("Unauthorized Aqua strategy");
    if (
      intent.traderInputToken.toLowerCase() !==
        snapshot.capacityEpoch.traderInputToken.toLowerCase() ||
      intent.traderOutputToken.toLowerCase() !==
        snapshot.capacityEpoch.traderOutputToken.toLowerCase()
    )
      throw new Error("Unsupported local settlement direction");
    if (
      intent.balanceSnapshot.toLowerCase() !==
      snapshot.balancesHash.toLowerCase()
    )
      throw new Error("Balance snapshot is stale");
    if (
      intent.priceSnapshot.toLowerCase() !==
      computeSettlementPriceSnapshotHash(snapshot.priceProtection).toLowerCase()
    )
      throw new Error("Price snapshot is stale");
    return snapshot;
  }

  async currentSnapshot() {
    const { policyRegistry, aqua, oracle, router, erc20Abi } = this.contracts;
    const block = await this.publicClient.getBlock();
    const chainPolicy = policyFrom(
      await this.publicClient.readContract({
        address: policyRegistry.address,
        abi: policyRegistry.abi,
        functionName: "getPolicy",
        args: [POLICY_ID],
      }),
    );
    const tokenAddresses = await this.publicClient.readContract({
      address: policyRegistry.address,
      abi: policyRegistry.abi,
      functionName: "assets",
      args: [POLICY_ID],
    });
    const managedAssets = [];
    const prices = [];
    const balances = [];
    for (const tokenAddress of tokenAddresses) {
      const symbol = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "symbol",
      });
      const boundsRaw = await this.publicClient.readContract({
        address: policyRegistry.address,
        abi: policyRegistry.abi,
        functionName: "assetBounds",
        args: [POLICY_ID, tokenAddress],
      });
      const priceRaw = await this.publicClient.readContract({
        address: oracle.address,
        abi: oracle.abi,
        functionName: "getPrice",
        args: [tokenAddress],
      });
      const balanceRaw = await this.publicClient.readContract({
        address: aqua.address,
        abi: aqua.abi,
        functionName: "rawBalances",
        args: [
          chainPolicy.treasury,
          router.address,
          STRATEGY_HASH,
          tokenAddress,
        ],
      });
      const bounds = {
        decimals: Number(asObject(boundsRaw, 0, "decimals")),
        minimumWeightBps: Number(asObject(boundsRaw, 1, "minimumWeightBps")),
        maximumWeightBps: Number(asObject(boundsRaw, 2, "maximumWeightBps")),
      };
      const price = {
        token: tokenAddress,
        snapshotId: asObject(priceRaw, 3, "snapshotId"),
        price: BigInt(asObject(priceRaw, 0, "price")),
        priceDecimals: Number(asObject(priceRaw, 1, "priceDecimals")),
        observedAt: Number(asObject(priceRaw, 2, "observedAt")),
      };
      const balance = BigInt(asObject(balanceRaw, 0, "balance"));
      managedAssets.push({
        token: tokenAddress,
        symbol,
        balance,
        decimals: bounds.decimals,
        price: price.price,
        priceDecimals: price.priceDecimals,
        minimumWeightBps: bounds.minimumWeightBps,
        maximumWeightBps: bounds.maximumWeightBps,
      });
      prices.push(price);
      balances.push(balance);
    }
    const portfolio = calculatePortfolioValuation(managedAssets, 0);
    const inputAsset = managedAssets.find(
      (asset) => asset.token.toLowerCase() === tokenAddresses[1].toLowerCase(),
    );
    const outputAsset = managedAssets.find(
      (asset) => asset.token.toLowerCase() === tokenAddresses[0].toLowerCase(),
    );
    check(inputAsset && outputAsset, "Local settlement pair is not managed");
    const inputPrice = prices.find(
      (price) => price.token.toLowerCase() === inputAsset.token.toLowerCase(),
    );
    const outputPrice = prices.find(
      (price) => price.token.toLowerCase() === outputAsset.token.toLowerCase(),
    );
    check(inputPrice && outputPrice, "Local settlement prices are incomplete");
    const priceProtection = {
      traderInputReferencePrice: inputPrice,
      traderInputExecutionPrice: inputPrice,
      traderOutputReferencePrice: outputPrice,
      traderOutputExecutionPrice: outputPrice,
      approvedTraderInputSnapshotId: inputPrice.snapshotId,
      approvedTraderOutputSnapshotId: outputPrice.snapshotId,
      traderInputAmount: valueToRaw(MAX_VALUE, inputAsset),
      traderOutputAmount: valueToRaw(MAX_VALUE, outputAsset),
      traderInputDecimals: inputAsset.decimals,
      traderOutputDecimals: outputAsset.decimals,
      valueDecimals: 0,
      nowSeconds: Number(block.timestamp),
      maximumPriceAgeSeconds: chainPolicy.priceMaxAgeSeconds,
      maximumPriceDeviationBps: chainPolicy.maximumPriceDeviationBps,
    };
    const priceSnapshot = computeSettlementPriceSnapshotHash(priceProtection);
    const portfolioPriceSnapshot = computePortfolioPriceSnapshotHash(prices);
    const balancesHash = hashAquaBalances(
      managedAssets.map((asset) => asset.token),
      balances,
    );
    const capacityEpoch = {
      positionId: POSITION_ID,
      traderInputToken: inputAsset.token,
      traderOutputToken: outputAsset.token,
      balanceSnapshot: balancesHash,
      priceSnapshot,
      portfolioPriceSnapshot,
      policyNonce: chainPolicy.nonce,
      riskCertificateHash: ZERO_HASH,
      aquaStrategyHash: STRATEGY_HASH,
      capacityBaselineValue: chainPolicy.maximumTransactionValue,
      consumedBefore: 0n,
      chainId: BigInt(CHAIN_ID),
      verifyingContract: router.address,
    };
    return {
      positionId: POSITION_ID,
      chainId: CHAIN_ID,
      verifyingContract: router.address,
      policyId: POLICY_ID,
      policy: {
        maximumTransactionValue: chainPolicy.maximumTransactionValue,
        assets: managedAssets.map((asset) => ({
          token: asset.token,
          minimumWeightBps: asset.minimumWeightBps,
          maximumWeightBps: asset.maximumWeightBps,
        })),
      },
      fee: {
        baseFeeBps: chainPolicy.fee.baseFeeBps,
        slopeBps: chainPolicy.fee.slopeBps,
        maximumFeeBps: chainPolicy.fee.maximumFeeBps,
        treasuryBaseFeeBps: chainPolicy.fee.treasuryBaseFeeBps,
        solverFeeBps: chainPolicy.fee.solverFeeBps,
        protocolFeeBps: chainPolicy.fee.protocolFeeBps,
      },
      feeAccounting: {
        feeToken: outputAsset.token,
        feePaymentMode: "OUTPUT_TOKEN",
        treasuryRecipient: chainPolicy.treasury,
        solverRecipient: this.solverAddress,
        protocolRecipient: chainPolicy.fee.protocolFeeRecipient,
      },
      riskMode: "NORMAL",
      riskCertificateHash: ZERO_HASH,
      policyNonce: chainPolicy.nonce.toString(),
      portfolio,
      portfolioSnapshot: {
        positionId: POSITION_ID,
        blockNumber: block.number.toString(),
        observedAt: Number(block.timestamp),
        nav: portfolio.nav.toString(),
        valueDecimals: portfolio.valueDecimals,
        assets: portfolio.assets.map((asset) => ({
          token: asset.token,
          symbol: asset.symbol,
          decimals: asset.decimals,
          balance: asset.balance.toString(),
          price: asset.price.toString(),
          priceDecimals: asset.priceDecimals,
          value: asset.value.toString(),
          weightBps: Number(asset.weightBps),
        })),
        snapshotHash: hashCanonical(portfolio),
      },
      capacityEpoch,
      capacityEpochId: computeCapacityEpochId(capacityEpoch),
      priceProtection,
      snapshotBlock: block.number,
      aquaStrategyHash: STRATEGY_HASH,
      balancesHash,
      rawAmountsForValue: (traderInputValue, treasuryOutputValue) => ({
        traderInputAmount: valueToRaw(traderInputValue, inputAsset),
        traderOutputAmount: valueToRaw(treasuryOutputValue, outputAsset),
      }),
      outputAmountForValue: (value) => valueToRaw(value, outputAsset),
    };
  }
}

function positionForSnapshot(snapshot, registry, treasury) {
  return {
    id: snapshot.positionId,
    name: "AURKA Graph Node E2E treasury",
    chainId: snapshot.chainId,
    owner: treasury,
    treasury,
    policy: {
      id: snapshot.policyId,
      chainId: snapshot.chainId,
      registry,
      treasury,
      governance: treasury,
      assets: snapshot.portfolio.assets.map((asset) => ({
        token: asset.token,
        symbol: asset.symbol ?? "ASSET",
        decimals: asset.decimals,
        minimumWeightBps: Number(asset.minimumWeightBps),
        maximumWeightBps: Number(asset.maximumWeightBps),
      })),
      maximumTransactionValue:
        snapshot.policy.maximumTransactionValue.toString(),
      quoteTtlSeconds: 60,
      priceMaxAgeSeconds: snapshot.priceProtection.maximumPriceAgeSeconds,
      maximumPriceDeviationBps: Number(
        snapshot.priceProtection.maximumPriceDeviationBps,
      ),
      fee: {
        baseFeeBps: Number(snapshot.fee.baseFeeBps),
        slopeBps: Number(snapshot.fee.slopeBps),
        maximumFeeBps: Number(snapshot.fee.maximumFeeBps),
        treasuryBaseFeeBps: Number(snapshot.fee.treasuryBaseFeeBps),
        solverFeeBps: Number(snapshot.fee.solverFeeBps),
        protocolFeeBps: Number(snapshot.fee.protocolFeeBps),
        treasuryFeeRecipient: treasury,
        protocolFeeRecipient: snapshot.feeAccounting.protocolRecipient,
      },
      nonce: snapshot.policyNonce,
      paused: false,
    },
    riskMode: "NORMAL",
    currentPortfolio: snapshot.portfolioSnapshot,
    createdAt: snapshot.priceProtection.nowSeconds,
    updatedAt: snapshot.priceProtection.nowSeconds,
  };
}

function bytes32Address(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function contractEpoch(snapshot) {
  return {
    positionIdHash: POSITION_ID_HASH,
    traderInputTokenId: bytes32Address(snapshot.capacityEpoch.traderInputToken),
    traderOutputTokenId: bytes32Address(
      snapshot.capacityEpoch.traderOutputToken,
    ),
    balanceSnapshot: snapshot.capacityEpoch.balanceSnapshot,
    priceSnapshot: snapshot.capacityEpoch.priceSnapshot,
    portfolioPriceSnapshot: snapshot.capacityEpoch.portfolioPriceSnapshot,
    policyNonce: snapshot.capacityEpoch.policyNonce,
    riskCertificateHash: snapshot.capacityEpoch.riskCertificateHash,
    aquaStrategyHash: snapshot.capacityEpoch.aquaStrategyHash,
    capacityBaseline: snapshot.capacityEpoch.capacityBaselineValue,
    consumedBefore: snapshot.capacityEpoch.consumedBefore,
    chainId: snapshot.capacityEpoch.chainId,
    verifyingContract: snapshot.capacityEpoch.verifyingContract,
    capacityEpochId: snapshot.capacityEpochId,
  };
}

function contractPriceInput(snapshot) {
  const price = snapshot.priceProtection;
  return {
    traderInputToken: price.traderInputReferencePrice.token,
    traderOutputToken: price.traderOutputReferencePrice.token,
    traderInputReferencePrice: price.traderInputReferencePrice,
    traderInputExecutionPrice: price.traderInputExecutionPrice,
    traderOutputReferencePrice: price.traderOutputReferencePrice,
    traderOutputExecutionPrice: price.traderOutputExecutionPrice,
    approvedTraderInputSnapshotId: price.approvedTraderInputSnapshotId,
    approvedTraderOutputSnapshotId: price.approvedTraderOutputSnapshotId,
    traderInputAmount: price.traderInputAmount,
    traderOutputAmount: price.traderOutputAmount,
    traderInputDecimals: price.traderInputDecimals,
    traderOutputDecimals: price.traderOutputDecimals,
    valueDecimals: price.valueDecimals,
    currentTime: BigInt(price.nowSeconds),
    maximumPriceAgeSeconds: price.maximumPriceAgeSeconds,
    maximumPriceDeviationBps: price.maximumPriceDeviationBps,
  };
}

async function submitRiskModeCertificate(
  publicClient,
  watchtowerWallet,
  riskRegistry,
  policyRegistry,
  tokens,
  now,
) {
  const activeBounds = [
    {
      token: tokens.usdc.address,
      minimumWeightBps: 5_500,
      maximumWeightBps: 10_000,
      paused: false,
    },
    {
      token: tokens.weth.address,
      minimumWeightBps: 0,
      maximumWeightBps: 3_500,
      paused: false,
    },
    {
      token: tokens.link.address,
      minimumWeightBps: 0,
      maximumWeightBps: 1_500,
      paused: false,
    },
  ];
  const activeBoundsHash = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "token", type: "address" },
            { name: "minimumWeightBps", type: "uint16" },
            { name: "maximumWeightBps", type: "uint16" },
            { name: "paused", type: "bool" },
          ],
        },
      ],
      [activeBounds],
    ),
  );
  const policyNonce = await publicClient.readContract({
    address: policyRegistry.address,
    abi: policyRegistry.abi,
    functionName: "policyNonce",
    args: [POLICY_ID],
  });
  const certificate = {
    policyId: POLICY_ID,
    riskMode: 1,
    activeBoundsHash,
    maximumTradeValue: MAX_VALUE,
    sourceDigest: hashBytes("graph-node-e2e-source"),
    reasonCode: hashBytes("graph-node-e2e-cautious"),
    issuedAt: BigInt(now),
    expiresAt: BigInt(now + 3_600),
    nonce: 1n,
    watchtower: watchtowerWallet.account.address,
    watchtowerAuthorizationEpoch: 1n,
    policyNonce,
  };
  const signature = await watchtowerWallet.signTypedData({
    domain: {
      name: "AURKA RiskModeRegistry",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: riskRegistry.address,
    },
    types: {
      RiskCertificate: [
        { name: "policyId", type: "bytes32" },
        { name: "riskMode", type: "uint8" },
        { name: "activeBoundsHash", type: "bytes32" },
        { name: "maximumTradeValue", type: "uint256" },
        { name: "sourceDigest", type: "bytes32" },
        { name: "reasonCode", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "watchtower", type: "address" },
        { name: "watchtowerAuthorizationEpoch", type: "uint256" },
        { name: "policyNonce", type: "uint256" },
      ],
    },
    primaryType: "RiskCertificate",
    message: certificate,
  });
  return write(
    watchtowerWallet,
    publicClient,
    riskRegistry,
    "submitRiskCertificate",
    [certificate, activeBounds, signature],
  );
}

const ENTITY_QUERY = `{
  policyMutations(first: 100, orderBy: id, orderDirection: asc) { id chainId contract blockNumber blockHash transactionHash logIndex policyId eventName nonce payload }
  riskModeChangeds(first: 100, orderBy: id, orderDirection: asc) { id chainId contract blockNumber blockHash transactionHash logIndex policyId riskMode maximumTradeValue expiresAt nonce watchtower certificateHash }
  feesRouteds(first: 100, orderBy: id, orderDirection: asc) { id chainId contract blockNumber blockHash transactionHash logIndex proposalHash feeToken solver protocolRecipient solverAmount protocolAmount treasuryAmount }
  tradeExecuteds(first: 100, orderBy: id, orderDirection: asc) { id chainId contract blockNumber blockHash transactionHash logIndex policyId positionIdHash intentHash proposalHash traderInputValue traderOutputValue totalFeeAmount }
}`;

async function main() {
  for (const name of artifactNames)
    check(
      artifact(name).bytecode.length > 2,
      `${name} artifact is missing; run forge build`,
    );
  const anvilPort = await freePort();
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  const transport = new JsonRpcHttpTransport(rpcUrl);
  const anvil = startAnvil(anvilPort);
  const anvilPidFile = process.env.AURKA_ANVIL_PID_FILE;
  if (anvilPidFile && anvil.pid) writeFileSync(anvilPidFile, `${anvil.pid}\n`);
  let stack;
  let api;
  let service;
  const workspace = mkdtempSync(
    path.join(os.tmpdir(), "aurka-graph-node-e2e-"),
  );
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
    const watchtowerAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
      cacheTime: 0,
    });
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
    const watchtowerWallet = createWalletClient({
      account: watchtowerAccount,
      chain,
      transport: http(rpcUrl),
    });
    check(
      (await publicClient.getChainId()) === CHAIN_ID,
      "Anvil chain mismatch",
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
    const tokens = { usdc, weth, link };
    const treasury = governanceAccount.address;
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
      [POLICY_ID, treasury, treasury, assetConfigs, MAX_VALUE, feeConfig],
    );
    await write(
      governanceWallet,
      publicClient,
      policyRegistry,
      "setSettlementConfiguration",
      [POLICY_ID, POSITION_ID_HASH, STRATEGY_HASH, oracle.address],
    );
    const priceBlock = await publicClient.getBlock();
    for (const [token, snapshotId] of [
      [usdc.address, `0x${"11".repeat(32)}`],
      [weth.address, `0x${"22".repeat(32)}`],
      [link.address, `0x${"33".repeat(32)}`],
    ])
      await write(governanceWallet, publicClient, oracle, "setPrice", [
        token,
        1n,
        0,
        priceBlock.timestamp,
        snapshotId,
      ]);
    await write(governanceWallet, publicClient, usdc, "mint", [
      treasury,
      1_000_000n * pow10(6),
    ]);
    await write(governanceWallet, publicClient, weth, "mint", [
      traderAccount.address,
      1_000_000n * pow10(18),
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
      600_000n * pow10(6),
    ]);
    await write(governanceWallet, publicClient, aqua, "seed", [
      treasury,
      router.address,
      STRATEGY_HASH,
      weth.address,
      300_000n * pow10(18),
    ]);
    await write(governanceWallet, publicClient, aqua, "seed", [
      treasury,
      router.address,
      STRATEGY_HASH,
      link.address,
      100_000n * pow10(8),
    ]);
    await write(traderWallet, publicClient, weth, "approve", [
      router.address,
      2n ** 256n - 1n,
    ]);
    await write(governanceWallet, publicClient, riskRegistry, "setWatchtower", [
      POLICY_ID,
      watchtowerAccount.address,
      true,
    ]);

    stack = await startGraphStack(anvilPort);
    const manifestDirectory = temporaryManifest(workspace, {
      AurkaSwapVMRouter: router,
      RiskModeRegistry: riskRegistry,
      AurkaPolicyRegistry: policyRegistry,
    });
    const subgraph = await deploySubgraph(stack, manifestDirectory);
    const deploymentMeta = await waitForIndexedBlock(
      subgraph.endpoint,
      await publicClient.getBlockNumber(),
    );
    const deploymentId = deploymentMeta.deployment;

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
    const database = new ServiceDatabase({
      filename: path.join(workspace, "service.sqlite"),
    });
    service = new AurkaService({
      database,
      provider,
      signer: solver,
      chainId: CHAIN_ID,
      settlementContract: router.address,
      indexConfirmations: 0,
      rpcTransport: transport,
      seedFixture: false,
    });
    service.repository.savePosition(
      positionForSnapshot(initialSnapshot, policyRegistry.address, treasury),
    );
    api = createApiServer({ service });
    await listenApiServer(api, 0, "127.0.0.1");
    const apiAddress = api.server.address();
    check(apiAddress && typeof apiAddress !== "string", "API did not bind");
    const sdk = new AurkaClient({
      baseUrl: `http://127.0.0.1:${apiAddress.port}`,
      timeout: 5_000,
    });
    const block = await publicClient.getBlock();
    const intent = await sdk.prepareIntent({
      positionId: POSITION_ID,
      trader: traderAccount.address,
      traderInputToken: weth.address,
      traderOutputToken: usdc.address,
      requestedValue: REQUESTED_VALUE.toString(),
      minimumTraderOutputValue: "49700",
      nonce: "1",
      deadline: Number(block.timestamp) + 300,
    });
    const submitted = await sdk.submitIntent(intent);
    const epochSnapshot = await provider.getSnapshot(intent);
    const activation = await write(
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
    const solved = await sdk.solve(intent);
    check(
      solved.proposal.traderInputValue === "50000",
      "Expected safe fill of 50000",
    );
    check(
      solved.proposal.traderOutputValue === "49766",
      "Unexpected output value",
    );
    const traderSignature = signDigest(
      submitted.intentHash,
      traderAccount.getHdKey().privKeyBytes,
    );
    const prepared = await sdk.execute(
      submitted.intentHash,
      solved.proposalHash,
      traderSignature,
      "graph-node-e2e",
    );
    const settlementHash = await traderWallet.sendTransaction({
      to: prepared.transactionRequest.to,
      data: prepared.transactionRequest.data,
      value: BigInt(prepared.transactionRequest.value),
    });
    const settlement = await publicClient.waitForTransactionReceipt({
      hash: settlementHash,
    });
    check(settlement.status === "success", "Actual router settlement reverted");
    // Advance the disposable chain head explicitly so Graph Node observes the
    // post-deployment blocks even when Anvil has no pending transactions.
    await transport.request({ method: "evm_mine", params: [] });
    await waitForIndexedBlock(subgraph.endpoint, settlement.blockNumber);

    const riskBlock = await publicClient.getBlock();
    const riskReceipt = await submitRiskModeCertificate(
      publicClient,
      watchtowerWallet,
      riskRegistry,
      policyRegistry,
      tokens,
      Number(riskBlock.timestamp),
    );
    await waitForIndexedBlock(subgraph.endpoint, riskReceipt.blockNumber);

    const entities = await graphQuery(subgraph.endpoint, ENTITY_QUERY);
    check(
      entities.policyMutations.some(
        (item) => item.eventName === "PolicyCreated",
      ),
      "PolicyCreated was not persisted",
    );
    check(
      entities.policyMutations.some(
        (item) => item.eventName === "SettlementConfigurationUpdated",
      ),
      "Settlement mutation was not persisted",
    );
    check(
      entities.policyMutations.some(
        (item) => item.eventName === "WatchtowerAuthorizationChanged",
      ),
      "Watchtower authorization was not persisted",
    );
    check(
      entities.riskModeChangeds.length === 1,
      "RiskModeChanged was not persisted",
    );
    check(
      entities.feesRouteds.length === 1 && entities.tradeExecuteds.length === 1,
      "Router events were not persisted",
    );
    check(
      entities.feesRouteds[0].transactionHash.toLowerCase() ===
        settlementHash.toLowerCase(),
      "Fee transaction identity changed",
    );
    check(
      entities.tradeExecuteds[0].transactionHash.toLowerCase() ===
        settlementHash.toLowerCase(),
      "Trade transaction identity changed",
    );
    check(
      entities.feesRouteds[0].logIndex !== entities.tradeExecuteds[0].logIndex,
      "Same-transaction log identities collided",
    );
    check(
      entities.tradeExecuteds[0].traderInputValue === "50000",
      "Normalized trade amount changed",
    );
    check(
      entities.feesRouteds[0].solverAmount === "25",
      `Normalized fee amount changed units: ${entities.feesRouteds[0].solverAmount}`,
    );
    check(
      entities.tradeExecuteds[0].blockHash ===
        entities.feesRouteds[0].blockHash,
      "Same-transaction block identity changed",
    );

    const finalityBlock = riskReceipt.blockNumber;
    const finalBlock = await publicClient.getBlock({
      blockNumber: finalityBlock,
    });
    const canonical = {
      getChainId: async () => CHAIN_ID,
      getLatestBlock: async () => await publicClient.getBlockNumber(),
      getBlockHash: async (number) =>
        (await publicClient.getBlock({ blockNumber: number })).hash,
    };
    const graphClient = new GraphClient({
      endpoint: subgraph.endpoint,
      chainId: CHAIN_ID,
      deploymentId,
      schemaVersion: "risk-v1",
      queryVersion: "observations-v1",
      pageSize: 1,
      maxObservationAgeSeconds: 3_600,
      maxIndexedLagBlocks: 2,
    });
    const graphOptions = {
      sourceId: "aurka-protocol",
      sourceKind: "AURKA_SUBGRAPH",
      nowSeconds: Number(finalBlock.timestamp),
      finalityBlock,
      canonical,
    };
    const observations = await new GraphSignalSource(
      graphClient,
      "aurka-protocol",
    ).fetchObservations(graphOptions);
    check(
      observations.length === 2,
      "GraphSignalSource did not paginate actual mapping output",
    );
    const tradeObservation = observations.find(
      (item) => item.signal === "AURKA_EXECUTIONS",
    );
    const riskObservation = observations.find(
      (item) => item.signal === "BOUNDARY_PRESSURE",
    );
    check(
      tradeObservation?.payload.traderInputValue === "50000",
      "Trade observation payload bytes were not decoded",
    );
    check(
      riskObservation?.payload.maximumTradeValue === "50000",
      "Risk observation payload bytes were not decoded",
    );
    check(
      observations.every((item) => item.finality === "FINAL"),
      "Canonical finality boundary was not applied",
    );
    const strictLagClient = new GraphClient({
      ...graphClient.getConfig(),
      maxIndexedLagBlocks: 1,
    });
    await assert.rejects(
      () =>
        new GraphSignalSource(
          strictLagClient,
          "aurka-protocol",
        ).fetchObservations(graphOptions),
      /stale/,
      "GraphSignalSource accepted an observation outside the configured lag bound",
    );
    const filteredClient = new GraphClient({
      ...graphClient.getConfig(),
      maxObservationAgeSeconds: 1,
    });
    const filtered = await new GraphSignalSource(
      filteredClient,
      "aurka-protocol",
    ).fetchObservations({
      ...graphOptions,
      nowSeconds: Number(finalBlock.timestamp) + 2,
    });
    check(
      filtered.length === 0,
      "Graph observedAt freshness filter was not applied",
    );

    const snapshot = await transport.request({
      method: "evm_snapshot",
      params: [],
    });
    const orphanReceipt = await write(
      governanceWallet,
      publicClient,
      policyRegistry,
      "setMaximumTransactionValue",
      [POLICY_ID, 49_999n],
    );
    await transport.request({ method: "evm_mine", params: [] });
    await waitForIndexedBlock(subgraph.endpoint, orphanReceipt.blockNumber);
    const orphanEntities = await graphQuery(subgraph.endpoint, ENTITY_QUERY);
    check(
      orphanEntities.policyMutations.some(
        (item) =>
          item.transactionHash.toLowerCase() ===
          orphanReceipt.transactionHash.toLowerCase(),
      ),
      "Orphan setup event was not observed before rewind",
    );
    check(
      await transport.request({ method: "evm_revert", params: [snapshot] }),
      "Anvil rewind failed",
    );
    const replacementReceipt = await write(
      governanceWallet,
      publicClient,
      policyRegistry,
      "setMaximumTransactionValue",
      [POLICY_ID, 49_998n],
    );
    await transport.request({ method: "evm_mine", params: [] });
    // Move beyond the old branch head so Graph Node compares the replacement
    // parent hash even if both branches reach the same block height.
    await transport.request({ method: "evm_mine", params: [] });
    const replacementEntities = await waitForGraphReorg(
      subgraph.endpoint,
      orphanReceipt.transactionHash,
      replacementReceipt.transactionHash,
    );

    console.log(
      JSON.stringify(
        {
          status: "passed",
          chainId: CHAIN_ID,
          graphNode: GRAPH_NODE_VERSION,
          postgres: POSTGRES_VERSION,
          ipfs: IPFS_VERSION,
          subgraph: subgraph.name,
          deployment: deploymentId,
          contracts: {
            router: router.address,
            policyRegistry: policyRegistry.address,
            riskRegistry: riskRegistry.address,
          },
          transactions: {
            activation: activation.transactionHash,
            settlement: settlementHash,
            riskMode: riskReceipt.transactionHash,
            orphan: orphanReceipt.transactionHash,
            replacement: replacementReceipt.transactionHash,
          },
          entities: {
            policyMutations: replacementEntities.policyMutations.length,
            riskModeChanged: replacementEntities.riskModeChangeds.length,
            feesRouted: replacementEntities.feesRouteds.length,
            tradeExecuted: replacementEntities.tradeExecuteds.length,
            observations: observations.length,
          },
          sameTransactionLogIndexes: [
            entities.feesRouteds[0].logIndex,
            entities.tradeExecuteds[0].logIndex,
          ],
          finality: observations.every((item) => item.finality === "FINAL")
            ? "FINAL"
            : "UNEXPECTED",
          pagination: "2 actual rows across pageSize=1",
          freshnessLag: "observedAt filtered and one-block lag bound rejected",
          reorg: "orphan removed and replacement indexed",
        },
        null,
        2,
      ),
    );
  } finally {
    if (api) await closeApiServer(api).catch(() => {});
    if (service) service.close();
    await stopGraphStack(stack);
    rmSync(workspace, { recursive: true, force: true });
    await stopProcess(anvil);
    if (anvilPidFile) rmSync(anvilPidFile, { force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
