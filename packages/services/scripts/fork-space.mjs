/* global console, process, setTimeout, URL, fetch, AbortSignal */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  AurkaService,
  ServiceError,
  ServiceDatabase,
  FixtureProposalSigner,
  buildUpstreamSwapVMStrategy,
  JsonRpcHttpTransport,
  createApiServer,
  listenApiServer,
  ChainEventIndexer,
  OpenRouterAgent,
  openRouterAgentOptionsFromEnv,
  createDelegatedSessionServiceFromEnv,
} from "../dist/index.js";
import {
  calculateDirectSettlement,
  computeCapacityEpochId,
} from "@aurka/shared";
import {
  LocalChainSnapshotProvider,
  positionForSnapshot,
  contractEpoch,
  contractPriceInput,
  CHAIN_ID,
  POLICY_ID,
  POSITION_ID_HASH,
  STRATEGY_HASH,
  DEFAULT_SPACE,
  SECOND_SPACE,
} from "./chain-snapshot.mjs";
import {
  artifact,
  deploy,
  write,
  read,
  receiptLogs,
  blockObservedLogs,
  stopProcess,
} from "./local-settlement-e2e.mjs";

import { ForkSpaceLifecycle } from "./fork-space-lifecycle.mjs";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const DIR = process.env.AURKA_FORK_DIR
  ? path.resolve(process.env.AURKA_FORK_DIR)
  : path.join(ROOT, ".fork-space");
const RPC_PORT = Number(process.env.AURKA_FORK_RPC_PORT ?? 8545);
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const FORK_BIND_HOST = process.env.AURKA_FORK_BIND_HOST ?? "127.0.0.1";
const API_PORT = Number(process.env.AURKA_FORK_API_PORT ?? 8797);
const APP_PORT = Number(process.env.AURKA_FORK_APP_PORT ?? 3011);
const PUBLIC_RPC_URL = process.env.AURKA_FORK_PUBLIC_RPC_URL;
const PUBLIC_API_URL = process.env.AURKA_FORK_PUBLIC_API_URL;
const PUBLIC_APP_URL = process.env.AURKA_FORK_PUBLIC_APP_URL;
const SKIP_APP = process.env.AURKA_FORK_SKIP_APP === "true";
const FORK_REQUEST_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.OPENROUTER_TIMEOUT_MS ?? 15_000) + 5_000,
  Number(process.env.AURKA_FORK_REQUEST_TIMEOUT_MS ?? 30_000),
);
const GRAPH_ENDPOINT = process.env.AURKA_GRAPH_ENDPOINT;
const GRAPH_ENDPOINT_FILE = process.env.AURKA_GRAPH_ENDPOINT_FILE;
const INTEGRATION_MODE = process.env.AURKA_FORK_INTEGRATION ?? "real";
const UPSTREAM_MODE =
  INTEGRATION_MODE === "real" || INTEGRATION_MODE === "fixture-upstream";
if (
  INTEGRATION_MODE !== "real" &&
  INTEGRATION_MODE !== "fixture" &&
  INTEGRATION_MODE !== "fixture-upstream"
)
  throw new Error(
    'AURKA_FORK_INTEGRATION must be "real", "fixture", or "fixture-upstream".',
  );
const FORK_BLOCK = Number(
  process.env.AURKA_FORK_BLOCK ??
    (INTEGRATION_MODE === "real" ? 25500000 : 22400000),
);
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
// Official 1inch Aqua deployment on Ethereum mainnet. Real mode uses the
// pinned upstream VM as the Aqua app; fixture mode keeps the direct adapter
// as an explicit regression/reference deployment.
const REAL_AQUA = "0x499943e74fb0ce105688beee8ef2abec5d936d31";
const CHAINLINK_ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const CHAINLINK_USDC_USD = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";
const CHAINLINK_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const REAL_AQUA_ABI = parseAbi([
  "function rawBalances(address,address,bytes32,address) view returns (uint248 balance, uint8 tokensCount)",
  "function safeBalances(address,address,bytes32,address,address) view returns (uint256 balance0, uint256 balance1)",
  "function ship(address,bytes,address[],uint256[]) returns (bytes32)",
  "function dock(address,bytes32,address[])",
  "function pull(address,bytes32,address,uint256,address)",
  "function push(address,address,bytes32,address,uint256)",
]);

const UPSTREAM_SWAPVM_COMMIT = "afd99c408b4ed610027f4426c6f98650acac9f5f";
const UPSTREAM_AQUA_COMMIT = "9c5c42e5840e8741fba3597c48456c9510212b66";

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(value) {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function tupleValue(value, index, name) {
  return value && typeof value === "object" && name in value
    ? value[name]
    : value?.[index];
}

function upstreamStrategy(maker, guard, prices, scale) {
  const inputPrice = prices.weth;
  const outputPrice = prices.usdc;
  const inputUnit =
    (10n ** 18n * 10n ** BigInt(inputPrice.priceDecimals) - 1n) /
      inputPrice.price +
    1n;
  const outputUnit =
    (10n ** 6n * 10n ** BigInt(outputPrice.priceDecimals) - 1n) /
      outputPrice.price +
    1n;
  const program = `0x9040${word(outputUnit * scale + 1n)}${word(inputUnit * scale)}530100`;
  const traits =
    (1n << 254n) |
    (1n << 250n) |
    (1n << 246n) |
    (60n << 208n) |
    (60n << 192n) |
    (40n << 176n) |
    (40n << 160n);
  const orderData = `0x${addressWord(USDC).slice(24)}${addressWord(WETH).slice(24)}${addressWord(guard).slice(24)}${program.slice(2)}`;
  const strategy = `0x${word(32)}${addressWord(maker)}${word(traits)}${word(96)}${word(orderData.length / 2 - 1)}${orderData.slice(2).padEnd(Math.ceil((orderData.length - 2) / 64) * 64, "0")}`;
  return {
    strategy,
    strategyHash: keccak256(strategy),
    traits,
    orderData,
    program,
  };
}
// Public Anvil test derivation only. Never consume DEPLOYER_PRIVATE_KEY.
const MNEMONIC = "test test test test test test test test test test test junk";
const stringify = (value) =>
  JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );

const GRAPH_ACTIVITY_QUERY = `query AurkaActivity {
  tradeExecuteds(first: 200, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    policyId positionIdHash intentHash proposalHash trader treasury
    traderInputToken traderOutputToken traderInputValue traderOutputValue
    totalFeeAmount consumedBefore consumedAfter expectedPostStateHash
  }
  feesRouteds(first: 200, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    proposalHash feeToken solver protocolRecipient solverAmount protocolAmount treasuryAmount
  }
  policyMutations(first: 200, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    policyId eventName nonce paused actor payload
  }
  spaceInitializeds(first: 200, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    spaceId policyId owner vault usdcAmount wethAmount capacityEpochId capacityBaseline
  }
  _meta { deployment hasIndexingErrors block { number hash timestamp } }
}`;

async function readGraphActivity() {
  const endpoint =
    GRAPH_ENDPOINT ??
    (GRAPH_ENDPOINT_FILE && existsSync(GRAPH_ENDPOINT_FILE)
      ? readFileSync(GRAPH_ENDPOINT_FILE, "utf8").trim()
      : undefined);
  if (!endpoint) return undefined;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: GRAPH_ACTIVITY_QUERY, variables: {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Graph HTTP ${response.status}`);
    const body = await response.json();
    if (body.errors?.length)
      throw new Error(body.errors.map((item) => item.message).join("; "));
    if (!body.data?._meta) throw new Error("Graph response has no metadata");
    const meta = body.data._meta;
    if (meta.hasIndexingErrors)
      throw new Error("Graph Node reports indexing errors");
    if (!meta.block || Number(meta.block.number) < 0)
      throw new Error("Graph response has no indexed block");
    return body.data;
  } catch (error) {
    throw new ServiceError(
      "GRAPH_ACTIVITY_UNAVAILABLE",
      `Confirmed Activity is unavailable until the same-fork Graph endpoint recovers: ${error instanceof Error ? error.message : String(error)}`,
      503,
      { endpoint, state: "UNAVAILABLE" },
    );
  }
}

function graphHex(value) {
  return typeof value === "string" ? value : "0x";
}

function graphPosition(definitions, positionIdHash) {
  return definitions.find(
    (space) =>
      space.positionIdHash?.toLowerCase() === positionIdHash?.toLowerCase(),
  );
}

function graphTradeActivity(data, definitions) {
  const fees = new Map(
    (data.feesRouteds ?? []).map((fee) => [
      fee.proposalHash.toLowerCase(),
      fee,
    ]),
  );
  return (data.tradeExecuteds ?? []).flatMap((trade) => {
    const definition = graphPosition(definitions, trade.positionIdHash);
    if (!definition) return [];
    const fee = fees.get(trade.proposalHash.toLowerCase());
    const totalFee = fee
      ? BigInt(fee.solverAmount) +
        BigInt(fee.protocolAmount) +
        BigInt(fee.treasuryAmount)
      : BigInt(trade.totalFeeAmount);
    return [
      {
        id: `graph:trade:${trade.id}`,
        type: "SWAP",
        spaceId: definition.positionId,
        spaceName: definition.name ?? definition.positionId,
        positionId: definition.positionId,
        chainId: Number(trade.chainId),
        status: "CONFIRMED",
        source: "CHAIN_EVENT",
        transactionHash: trade.transactionHash,
        intentHash: graphHex(trade.intentHash),
        proposalHash: graphHex(trade.proposalHash),
        trader: trade.trader,
        actor: trade.trader,
        treasury: trade.treasury,
        traderInputToken: trade.traderInputToken,
        traderOutputToken: trade.traderOutputToken,
        traderInputSymbol: "WETH",
        traderOutputSymbol: "USDC",
        requestedTraderInputValue: trade.traderInputValue,
        executedTraderInputValue: trade.traderInputValue,
        traderOutputValue: trade.traderOutputValue,
        submittedAt: Number(trade.occurredAt),
        occurredAt: Number(trade.occurredAt),
        confirmedAt: Number(trade.occurredAt),
        blockNumber: String(trade.blockNumber),
        bindingConstraint: "NONE",
        feeState: fee ? "EARNED" : "NONE",
        ...(fee
          ? {
              earnedFee: {
                feeToken: fee.feeToken,
                treasuryAmount: fee.treasuryAmount,
                solverAmount: fee.solverAmount,
                protocolAmount: fee.protocolAmount,
                totalAmount: totalFee.toString(),
                unit: "NORMALIZED_SETTLEMENT_VALUE",
                eventId: `graph:fee:${fee.id}`,
              },
            }
          : {}),
        expectedPostStateHash: graphHex(trade.expectedPostStateHash),
        evidence: {
          tradeEventId: `graph:trade:${trade.id}`,
          ...(fee ? { feeEventId: `graph:fee:${fee.id}` } : {}),
          graphEntityId: trade.id,
          receiptHash: trade.transactionHash,
          blockHash: trade.blockHash,
        },
      },
    ];
  });
}

function graphChangeActivity(data, definitions) {
  return (data.policyMutations ?? []).flatMap((change) => {
    const definition = definitions.find(
      (space) =>
        space.policyId?.toLowerCase() === change.policyId?.toLowerCase(),
    );
    if (!definition) return [];
    const statusEvent = change.eventName === "PauseStatusUpdated";
    const type = statusEvent ? "TRADING_STATUS" : "RULE_CHANGE";
    return [
      {
        id: `graph:policy:${change.id}`,
        type,
        spaceId: definition.positionId,
        spaceName: definition.name ?? definition.positionId,
        positionId: definition.positionId,
        chainId: Number(change.chainId),
        status: "CONFIRMED",
        source: "CHAIN_EVENT",
        actor: change.actor,
        transactionHash: change.transactionHash,
        submittedAt: Number(change.occurredAt),
        occurredAt: Number(change.occurredAt),
        confirmedAt: Number(change.occurredAt),
        blockNumber: String(change.blockNumber),
        eventType:
          type === "TRADING_STATUS"
            ? change.paused
              ? "SPACE_PAUSED"
              : "SPACE_RESUMED"
            : "SPACE_UPDATED",
        evidence: {
          receiptHash: change.transactionHash,
          blockHash: change.blockHash,
          graphEntityId: change.id,
        },
        payload: {
          eventName: change.eventName,
          nonce: String(change.nonce),
          graphEntityId: change.id,
        },
      },
    ];
  });
}

function graphSpaceActivity(data, definitions) {
  return (data.spaceInitializeds ?? []).flatMap((event) => {
    const definition = definitions.find(
      (space) =>
        space.positionIdHash?.toLowerCase() === event.spaceId?.toLowerCase(),
    );
    if (!definition) return [];
    return [
      {
        id: `graph:space:${event.id}`,
        type: "RULE_CHANGE",
        spaceId: definition.positionId,
        spaceName: definition.name ?? definition.positionId,
        positionId: definition.positionId,
        chainId: Number(event.chainId),
        status: "CONFIRMED",
        source: "CHAIN_EVENT",
        actor: event.owner,
        transactionHash: event.transactionHash,
        submittedAt: Number(event.occurredAt),
        occurredAt: Number(event.occurredAt),
        confirmedAt: Number(event.occurredAt),
        blockNumber: String(event.blockNumber),
        eventType: "SPACE_ACTIVATED",
        evidence: {
          receiptHash: event.transactionHash,
          blockHash: event.blockHash,
          graphEntityId: event.id,
        },
        payload: { eventName: "SpaceInitialized", graphEntityId: event.id },
      },
    ];
  });
}

async function graphActivityPage(query, localService, definitions) {
  const data = await readGraphActivity();
  const graphItems = [
    ...graphTradeActivity(data, definitions),
    ...graphChangeActivity(data, definitions),
    ...graphSpaceActivity(data, definitions),
  ];
  const local = localService.listActivity(query);
  const graphTransactions = new Set(
    graphItems
      .map((item) => item.transactionHash?.toLowerCase())
      .filter(Boolean),
  );
  const retainedLocal = local.items.filter(
    (item) =>
      item.status === "PREPARED" ||
      item.status === "PENDING" ||
      item.status === "FAILED" ||
      !item.transactionHash ||
      !graphTransactions.has(item.transactionHash.toLowerCase()),
  );
  const merged = [...graphItems, ...retainedLocal]
    .filter(
      (item) => query.spaceId === undefined || item.spaceId === query.spaceId,
    )
    .filter(
      (item) =>
        query.positionId === undefined || item.positionId === query.positionId,
    )
    .filter(
      (item) => query.chainId === undefined || item.chainId === query.chainId,
    )
    .filter((item) => query.type === undefined || item.type === query.type)
    .filter(
      (item) => query.status === undefined || item.status === query.status,
    )
    .filter(
      (item) =>
        query.from === undefined ||
        (item.occurredAt ?? item.submittedAt) >= query.from,
    )
    .filter(
      (item) =>
        query.to === undefined ||
        (item.occurredAt ?? item.submittedAt) <= query.to,
    )
    .sort(
      (left, right) =>
        (right.occurredAt ?? right.submittedAt) -
          (left.occurredAt ?? left.submittedAt) ||
        right.id.localeCompare(left.id),
    );
  return { items: merged.slice(0, query.limit), nextCursor: null };
}
const accounts = [0, 1, 2].map((addressIndex) =>
  mnemonicToAccount(MNEMONIC, { addressIndex }),
);
const chain = defineChain({
  id: CHAIN_ID,
  name: "AURKA Ethereum fork (test funds)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({
  account: accounts[0],
  chain,
  transport: http(RPC),
});
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function deposit() payable",
]);
const children = [];
let api, gateway, database;
let integrationEvidence;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  gateway?.close();
  api?.server.close();
  database?.close();
  for (const child of children.reverse()) {
    if (child.spawnfile === "pnpm" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already stopped */
      }
    }
    await stopProcess(child);
  }
}
async function main() {
  for (const port of [RPC_PORT, API_PORT, APP_PORT]) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", () =>
        reject(
          new Error(
            `Fork port ${port} is occupied. Stop its owner or use a separate environment; existing services were not changed.`,
          ),
        ),
      );
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const upstream = process.env.MAINNET_RPC_URL;
  if (!upstream)
    throw new Error(
      "MAINNET_RPC_URL is required: Ethereum mainnet archive RPC; no demo fallback.",
    );
  try {
    const upstreamClient = createPublicClient({
      transport: http(upstream, { timeout: 15000, retryCount: 0 }),
    });
    if ((await upstreamClient.getChainId()) !== 1) throw new Error();
    const forkBlock = await upstreamClient.getBlock({
      blockNumber: BigInt(FORK_BLOCK),
    });
    if (INTEGRATION_MODE === "real") {
      const codeTargets = {
        aqua: REAL_AQUA,
        usdc: USDC,
        weth: WETH,
        chainlinkEthUsd: CHAINLINK_ETH_USD,
        chainlinkUsdcUsd: CHAINLINK_USDC_USD,
      };
      const code = {};
      for (const [name, address] of Object.entries(codeTargets)) {
        const runtime = await upstreamClient.getCode({
          address,
          blockNumber: BigInt(FORK_BLOCK),
        });
        if (!runtime || runtime === "0x")
          throw new Error(`${name} has no bytecode at the pinned fork block`);
        code[name] = {
          address,
          bytes: (runtime.length - 2) / 2,
          codeHash: keccak256(runtime),
        };
      }
      const feeds = {};
      for (const [name, feed] of [
        ["ETH/USD", CHAINLINK_ETH_USD],
        ["USDC/USD", CHAINLINK_USDC_USD],
      ]) {
        const decimals = await upstreamClient.readContract({
          address: feed,
          abi: CHAINLINK_ABI,
          functionName: "decimals",
          blockNumber: BigInt(FORK_BLOCK),
        });
        const round = await upstreamClient.readContract({
          address: feed,
          abi: CHAINLINK_ABI,
          functionName: "latestRoundData",
          blockNumber: BigInt(FORK_BLOCK),
        });
        const answer = round[1];
        const updatedAt = round[3];
        if (
          decimals > 36 ||
          answer <= 0n ||
          updatedAt === 0n ||
          updatedAt > forkBlock.timestamp
        )
          throw new Error(
            `${name} is not a valid positive round at the pinned fork block`,
          );
        feeds[name] = {
          address: feed,
          decimals,
          roundId: round[0],
          answer,
          observedAt: updatedAt,
        };
      }
      integrationEvidence = {
        chainId: 1,
        forkBlock: FORK_BLOCK,
        forkTimestamp: forkBlock.timestamp,
        aqua: code.aqua,
        tokens: { USDC: code.usdc, WETH: code.weth },
        priceFeeds: feeds,
      };
    }
  } catch {
    throw new Error(
      `MAINNET_RPC_URL cannot read Ethereum mainnet block ${FORK_BLOCK}; no demo fallback.`,
    );
  }
  // Refuse an occupied RPC, including another fork instance; never reset arbitrary nodes.
  try {
    await client.getChainId();
    throw new Error(
      `RPC port ${RPC_PORT} is occupied. Stop the existing process before start/reset.`,
    );
  } catch (error) {
    if (error.message.startsWith("RPC port")) throw error;
  }
  if (process.argv.includes("--reset")) {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
  }
  const stateFile = path.join(DIR, "anvil.json");
  const anvil = spawn(
    "anvil",
    [
      "--host",
      FORK_BIND_HOST,
      "--port",
      String(RPC_PORT),
      "--chain-id",
      String(CHAIN_ID),
      "--fork-url",
      upstream,
      "--fork-block-number",
      String(FORK_BLOCK),
      "--mnemonic",
      MNEMONIC,
      "--disable-code-size-limit",
      "--state",
      stateFile,
      "--state-interval",
      "5",
      ...(INTEGRATION_MODE !== "real" ? ["--block-time", "1"] : []),
    ],
    { cwd: ROOT, stdio: "ignore" },
  );
  children.push(anvil);
  anvil.on("error", () =>
    console.error("Unable to start Anvil; install Foundry."),
  );
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await client.getChainId()) === CHAIN_ID) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    if (anvil.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready)
    throw new Error(
      `Anvil fork startup failed. Check archive RPC availability and local port ${RPC_PORT}.`,
    );
  // Real mode keeps the fork's historical clock. Rewriting it to wall-clock
  // time would falsely make a historical oracle round appear fresh.
  const currentTime = Math.floor(Date.now() / 1000);
  if (
    INTEGRATION_MODE !== "real" &&
    Number((await client.getBlock()).timestamp) < currentTime
  ) {
    await client.request({
      method: "evm_setNextBlockTimestamp",
      params: [currentTime],
    });
    await client.request({ method: "evm_mine", params: [] });
  }
  let manifest;
  const manifestFile = path.join(DIR, "manifest.json");
  if (existsSync(manifestFile)) {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if ((manifest.integrationMode ?? "fixture") !== INTEGRATION_MODE)
      throw new Error(
        `Saved fork uses ${manifest.integrationMode ?? "fixture"} integrations; requested ${INTEGRATION_MODE}. Stop it and use a separate AURKA_FORK_DIR or reset only that isolated fork.`,
      );
    if (!(await client.getCode({ address: manifest.router })))
      throw new Error(
        "Saved deployment is absent from fork state; run fork:reset.",
      );
  } else {
    for (const address of [USDC, WETH])
      if (!(await client.getCode({ address })))
        throw new Error("Required fork token contract is unavailable.");
    const policyRegistry = await deploy(wallet, client, "AurkaPolicyRegistry");
    const riskRegistry = await deploy(wallet, client, "RiskModeRegistry", [
      policyRegistry.address,
    ]);
    const aqua =
      INTEGRATION_MODE === "real"
        ? { address: REAL_AQUA, abi: REAL_AQUA_ABI }
        : await deploy(wallet, client, "MockAqua");
    const oracle =
      INTEGRATION_MODE === "real"
        ? await deploy(wallet, client, "ChainlinkPriceOracle", [
            [USDC, WETH],
            [CHAINLINK_USDC_USD, CHAINLINK_ETH_USD],
            0,
          ])
        : await deploy(wallet, client, "MockPriceOracle");
    const alice = accounts[0].address;
    const swapVM = await deploy(
      wallet,
      client,
      UPSTREAM_MODE ? "AurkaUpstreamAquaSwapVMRouter" : "AurkaDirectSwapVM",
      UPSTREAM_MODE ? [aqua.address, WETH, alice] : [],
    );
    const router = await deploy(wallet, client, "AurkaSwapVMRouter", [
      policyRegistry.address,
      riskRegistry.address,
      aqua.address,
      swapVM.address,
    ]);
    const aquaApp = await read(client, router, "aquaApp", []);
    const swapVMGuard = UPSTREAM_MODE
      ? await read(client, router, "swapVMGuard", [])
      : undefined;
    if (INTEGRATION_MODE !== "real") {
      const block = await client.getBlock();
      for (const [token, price, byte] of [
        [USDC, 1n, "11"],
        [WETH, 3200n, "22"],
      ])
        await write(wallet, client, oracle, "setPrice", [
          token,
          price,
          0,
          block.timestamp,
          `0x${byte.repeat(32)}`,
        ]);
    }
    let upstreamPrimary;
    let upstreamSecondary;
    if (UPSTREAM_MODE) {
      const usdcPriceRaw = await read(client, oracle, "getPrice", [USDC]);
      const wethPriceRaw = await read(client, oracle, "getPrice", [WETH]);
      const prices = {
        usdc: {
          price: BigInt(tupleValue(usdcPriceRaw, 0, "price")),
          priceDecimals: Number(tupleValue(usdcPriceRaw, 1, "priceDecimals")),
        },
        weth: {
          price: BigInt(tupleValue(wethPriceRaw, 0, "price")),
          priceDecimals: Number(tupleValue(wethPriceRaw, 1, "priceDecimals")),
        },
      };
      upstreamPrimary = upstreamStrategy(alice, swapVMGuard, prices, 1n);
      upstreamSecondary = upstreamStrategy(alice, swapVMGuard, prices, 2n);
    }
    const vaultFactory = await deploy(
      wallet,
      client,
      "AurkaSpaceVaultFactory",
      [policyRegistry.address, router.address, aqua.address, USDC, WETH],
    );
    await write(wallet, client, policyRegistry, "setInitializationFactory", [
      vaultFactory.address,
    ]);
    console.log(
      INTEGRATION_MODE === "real"
        ? "AURKA real fork contracts deployed; registering strategies in upstream Aqua."
        : INTEGRATION_MODE === "fixture-upstream"
          ? "AURKA controlled upstream fixture deployed; seeding MockAqua balances."
          : "AURKA fixture fork contracts deployed; seeding fixture balances.",
    );
    await write(wallet, client, policyRegistry, "createPolicy", [
      POLICY_ID,
      alice,
      alice,
      [
        {
          token: USDC,
          decimals: 6,
          minimumWeightBps: 6000,
          maximumWeightBps: 10000,
        },
        {
          token: WETH,
          decimals: 18,
          minimumWeightBps: 0,
          maximumWeightBps: 4000,
        },
      ],
      5000n,
      {
        baseFeeBps: 20,
        slopeBps: 80,
        maximumFeeBps: 100,
        treasuryBaseFeeBps: 10,
        solverFeeBps: 5,
        protocolFeeBps: 5,
        treasuryFeeRecipient: alice,
        protocolFeeRecipient: accounts[2].address,
      },
    ]);
    await write(wallet, client, policyRegistry, "setSettlementConfiguration", [
      POLICY_ID,
      POSITION_ID_HASH,
      upstreamPrimary?.strategyHash ?? STRATEGY_HASH,
      oracle.address,
    ]);
    await write(wallet, client, policyRegistry, "setPriceProtection", [
      POLICY_ID,
      86400n,
      100,
    ]);
    await write(wallet, client, policyRegistry, "createPolicy", [
      SECOND_SPACE.policyId,
      alice,
      alice,
      [
        {
          token: USDC,
          decimals: 6,
          minimumWeightBps: 7000,
          maximumWeightBps: 10000,
        },
        {
          token: WETH,
          decimals: 18,
          minimumWeightBps: 0,
          maximumWeightBps: 3000,
        },
      ],
      2500n,
      {
        baseFeeBps: 20,
        slopeBps: 80,
        maximumFeeBps: 100,
        treasuryBaseFeeBps: 10,
        solverFeeBps: 5,
        protocolFeeBps: 5,
        treasuryFeeRecipient: alice,
        protocolFeeRecipient: accounts[2].address,
      },
    ]);
    await write(wallet, client, policyRegistry, "setSettlementConfiguration", [
      SECOND_SPACE.policyId,
      SECOND_SPACE.positionIdHash,
      upstreamSecondary?.strategyHash ?? SECOND_SPACE.strategyHash,
      oracle.address,
    ]);
    await write(wallet, client, policyRegistry, "setPriceProtection", [
      SECOND_SPACE.policyId,
      86400n,
      100,
    ]);
    // Local impersonation transfers real fork USDC; never broadcast to upstream.
    const holder = "0x55FE002aefF02F77364de339a1292923A15844B8";
    await client.request({
      method: "anvil_setBalance",
      params: [holder, "0x56bc75e2d63100000"],
    });
    await client.request({
      method: "anvil_impersonateAccount",
      params: [holder],
    });
    try {
      const donor = createWalletClient({
        account: holder,
        chain,
        transport: http(RPC),
      });
      for (const [account, amount] of [
        [alice, 70000n],
        [accounts[1].address, 10000n],
      ])
        await write(
          donor,
          client,
          { address: USDC, abi: erc20Abi },
          "transfer",
          [account, amount * 1000000n],
        );
    } finally {
      await client.request({
        method: "anvil_stopImpersonatingAccount",
        params: [holder],
      });
    }
    for (const [account, amount] of [
      [accounts[0], 10n],
      [accounts[1], 10n],
    ]) {
      const w = createWalletClient({ account, chain, transport: http(RPC) });
      const hash = await w.writeContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "deposit",
        value: amount * 10n ** 18n,
      });
      if (
        (await client.waitForTransactionReceipt({ hash })).status !== "success"
      )
        throw new Error("WETH funding failed");
    }
    // These are runner-only seed presets for the two pre-created demo Spaces.
    // User-created Spaces take their funding from the signed draft and the
    // lifecycle planner; these values are not runtime requirements.
    const strategies = UPSTREAM_MODE
      ? [
          [
            upstreamPrimary.strategy,
            upstreamPrimary.strategyHash,
            [70000n * 1000000n, 10n * 10n ** 18n],
          ],
          [
            upstreamSecondary.strategy,
            upstreamSecondary.strategyHash,
            [35000n * 1000000n, 5n * 10n ** 18n],
          ],
        ]
      : [
          [
            stringToHex("strategy:local-settlement-e2e"),
            STRATEGY_HASH,
            [70000n * 1000000n, 10n * 10n ** 18n],
          ],
          [
            stringToHex("strategy:local-settlement-e2e-secondary"),
            SECOND_SPACE.strategyHash,
            [35000n * 1000000n, 5n * 10n ** 18n],
          ],
        ];
    if (INTEGRATION_MODE === "real") {
      for (const [strategy, expectedHash, amounts] of strategies) {
        for (const [token, amount] of [
          [USDC, amounts[0]],
          [WETH, amounts[1]],
        ]) {
          await write(
            wallet,
            client,
            { address: token, abi: erc20Abi },
            "approve",
            [REAL_AQUA, amount],
          );
        }
        const hash = await write(wallet, client, aqua, "ship", [
          aquaApp,
          strategy,
          [USDC, WETH],
          amounts,
        ]);
        if (keccak256(strategy).toLowerCase() !== expectedHash.toLowerCase())
          throw new Error(
            "Pinned local strategy hash does not match Aqua strategy bytes",
          );
        void hash;
      }
    } else {
      for (const [, strategyHash, amounts] of strategies)
        for (const [token, amount] of [
          [USDC, amounts[0]],
          [WETH, amounts[1]],
        ])
          await write(wallet, client, aqua, "seed", [
            alice,
            aquaApp,
            strategyHash,
            token,
            amount,
          ]);
    }
    // Alice explicitly enables allowance and epoch from her browser wallet.
    const swapVMRuntime = await client.getCode({ address: swapVM.address });
    const upstreamWrapper = UPSTREAM_MODE
      ? {
          address: swapVM.address,
          runtimeBytes: (swapVMRuntime.length - 2) / 2,
          runtimeCodeHash: keccak256(swapVMRuntime),
          sourceHash: keccak256(
            stringToHex(
              readFileSync(
                path.join(
                  ROOT,
                  "contracts/upstream/AurkaUpstreamAquaSwapVMRouter.sol",
                ),
                "utf8",
              ),
            ),
          ),
          constructor: { aqua: aqua.address, weth: WETH, owner: alice },
        }
      : undefined;
    manifest = {
      mode: "fork",
      integrationMode: INTEGRATION_MODE,
      name: "Team inventory",
      chainId: CHAIN_ID,
      upstreamChainId: 1,
      forkBlock: FORK_BLOCK,
      rpcUrl: PUBLIC_RPC_URL ?? RPC,
      alice,
      bob: accounts[1].address,
      protocolRecipient: accounts[2].address,
      policyId: POLICY_ID,
      positionIdHash: POSITION_ID_HASH,
      strategyHash: upstreamPrimary?.strategyHash ?? STRATEGY_HASH,
      usdc: USDC,
      weth: WETH,
      policyRegistry: policyRegistry.address,
      riskRegistry: riskRegistry.address,
      aqua: aqua.address,
      oracle: oracle.address,
      swapVM: swapVM.address,
      upstreamWrapper,
      aquaApp,
      swapVMGuard,
      swapVMUpstreamCommit: UPSTREAM_MODE ? UPSTREAM_SWAPVM_COMMIT : undefined,
      aquaUpstreamCommit: UPSTREAM_MODE ? UPSTREAM_AQUA_COMMIT : undefined,
      router: router.address,
      vaultFactory: vaultFactory.address,
      vaultFactoryVersion: 2,
      spaceCreationMode: "single-transaction",
      deploymentBlock: Number((await client.getBlock()).number),
      aquaKind: INTEGRATION_MODE === "real" ? "REAL_AQUA" : "MOCK_AQUA",
      oracleKind: INTEGRATION_MODE === "real" ? "CHAINLINK_V3" : "MOCK_ORACLE",
      priceSource:
        INTEGRATION_MODE === "real"
          ? {
              quoteCurrency: "USD",
              feeds: { USDC: CHAINLINK_USDC_USD, WETH: CHAINLINK_ETH_USD },
              feedDecimals: 8,
              settlementPriceDecimals: 0,
              normalization:
                "nearest whole settlement value; raw round is fingerprinted",
              maximumAgeSeconds: 86400,
            }
          : { quoteCurrency: "fixture-value", maximumAgeSeconds: 86400 },
      graph: GRAPH_ENDPOINT
        ? {
            endpoint: GRAPH_ENDPOINT,
            source: "same-fork-graph-node",
            query:
              "TradeExecuted + FeesRouted + PolicyMutation + SpaceInitialized",
          }
        : { status: "not-configured" },
      executionEngine: UPSTREAM_MODE
        ? "AURKA_UPSTREAM_LIMIT_SWAP_V1"
        : "AURKA_DIRECT_PAIR_V1 (AurkaDirectSwapVM reference adapter)",
      integrationEvidence,
      mocks:
        INTEGRATION_MODE === "real"
          ? ["FixtureProposalSigner: public test solver"]
          : [
              "MockAqua: explicit fixture-only virtual balances",
              "MockPriceOracle: fixed USDC=1 and WETH=3200 fixture values",
              "FixtureProposalSigner: public test solver",
            ],
      funding:
        "Fork-only USDC holder impersonation and WETH deposit; dedicated public Anvil accounts 0/1",
      spaces: [
        {
          ...DEFAULT_SPACE,
          name: "Team inventory",
          strategyHash:
            upstreamPrimary?.strategyHash ?? DEFAULT_SPACE.strategyHash,
          strategy: upstreamPrimary?.strategy ?? DEFAULT_SPACE.strategy,
        },
        {
          ...SECOND_SPACE,
          name: "Research inventory",
          strategyHash:
            upstreamSecondary?.strategyHash ?? SECOND_SPACE.strategyHash,
          strategy: upstreamSecondary?.strategy ?? SECOND_SPACE.strategy,
        },
      ],
    };
    writeFileSync(manifestFile, stringify(manifest));
  }
  if (
    manifest.spaceCreationMode !== "single-transaction" ||
    manifest.vaultFactoryVersion !== 2
  ) {
    throw new Error(
      "This fork predates single-transaction Space creation. Stop it and run pnpm fork:reset in an isolated environment; existing fork state was not changed.",
    );
  }
  if (!manifest.vaultFactory) {
    throw new Error(
      "The configured fork is missing its atomic Space factory. Run pnpm fork:reset in an isolated environment.",
    );
  }
  let configuredFactory;
  try {
    configuredFactory = await client.readContract({
      address: manifest.policyRegistry,
      abi: artifact("AurkaPolicyRegistry").abi,
      functionName: "initializationFactory",
    });
  } catch {
    throw new Error(
      "This fork's policy registry predates single-transaction Space creation. Stop it and run pnpm fork:reset in an isolated environment; existing fork state was not changed.",
    );
  }
  if (configuredFactory.toLowerCase() !== manifest.vaultFactory.toLowerCase())
    throw new Error(
      "The fork factory is not the registry initialization authority. Run pnpm fork:reset in an isolated environment; existing fork state was not changed.",
    );
  if (!manifest.forkGeneration)
    manifest.forkGeneration = randomBytes(16).toString("hex");
  const deploymentBlock = await client.getBlock({
    blockNumber: BigInt(manifest.deploymentBlock),
  });
  if (!deploymentBlock?.hash)
    throw new Error(
      "Fork deployment identity cannot be read from the local RPC.",
    );
  if (
    manifest.deploymentBlockHash &&
    manifest.deploymentBlockHash.toLowerCase() !==
      deploymentBlock.hash.toLowerCase()
  )
    throw new Error(
      "Fork deployment identity changed. The configured fork was reset; use its new browser session and do not reuse pending setup hashes.",
    );
  manifest.deploymentBlockHash = deploymentBlock.hash;
  manifest.rpcUrl = PUBLIC_RPC_URL ?? manifest.rpcUrl ?? RPC;
  manifest.apiUrl = PUBLIC_API_URL ?? `http://127.0.0.1:${API_PORT}`;
  delete manifest.ownerUrl;
  delete manifest.traderUrl;
  manifest.appUrl = PUBLIC_APP_URL ?? `http://127.0.0.1:${APP_PORT}/spaces`;
  writeFileSync(manifestFile, stringify(manifest));
  const contracts = Object.fromEntries(
    [
      ["vaultFactory", "AurkaSpaceVaultFactory"],
      ["policyRegistry", "AurkaPolicyRegistry"],
      ["riskRegistry", "RiskModeRegistry"],
      ["router", "AurkaSwapVMRouter"],
    ].map(([key, name]) => [
      key,
      { address: manifest[key], abi: artifact(name).abi },
    ]),
  );
  contracts.aqua = {
    address: manifest.aqua,
    abi:
      manifest.aquaKind === "REAL_AQUA"
        ? REAL_AQUA_ABI
        : artifact("MockAqua").abi,
  };
  contracts.oracle = {
    address: manifest.oracle,
    abi:
      manifest.oracleKind === "CHAINLINK_V3"
        ? artifact("ChainlinkPriceOracle").abi
        : artifact("MockPriceOracle").abi,
  };
  contracts.erc20Abi = erc20Abi;
  contracts.vaultAbi = artifact("AurkaSpaceVault").abi;
  const solver = new FixtureProposalSigner();
  const epochsFile = path.join(DIR, "epochs.json");
  const epochs = existsSync(epochsFile)
    ? JSON.parse(readFileSync(epochsFile, "utf8"))
    : {};
  const spaceDefinitions = manifest.spaces ?? [
    { ...DEFAULT_SPACE, name: manifest.name },
  ];
  const closedSpaces = new Set();
  const strategyIsClosed = async (definition, maker) => {
    if (!maker) return false;
    const states = await Promise.all(
      [USDC, WETH].map((token) =>
        client.readContract({
          ...contracts.aqua,
          functionName: "rawBalances",
          args: [maker, manifest.aquaApp, definition.strategyHash, token],
        }),
      ),
    );
    return states.every(
      (raw) => Number(tupleValue(raw, 1, "tokensCount")) === 255,
    );
  };
  const closedStrategyError = (positionId) =>
    new ServiceError(
      "PRICING_RENEWAL_REQUIRED",
      "Pricing needs renewal: this fixed-price Space has already been recovered and its Aqua strategy is closed",
      409,
      {
        positionId,
        state: "PRICING_NEEDS_RENEWAL",
        executable: false,
        recovery:
          "Use the recorded owner recovery receipts and trade only against the replacement Space.",
      },
    );
  class ForkProvider extends LocalChainSnapshotProvider {
    constructor(space) {
      super(client, contracts, solver.address, space);
      this.space = space;
    }
    async currentSnapshot() {
      if (closedSpaces.has(this.space.positionId))
        throw closedStrategyError(this.space.positionId);
      const snapshot = await super.currentSnapshot();
      if (manifest.executionEngine === "AURKA_UPSTREAM_LIMIT_SWAP_V1") {
        snapshot.swapVMGuard = manifest.swapVMGuard;
      }
      const active = await client.readContract({
        ...contracts.router,
        functionName: "capacityState",
        args: [this.space.positionIdHash, WETH, USDC],
        blockNumber: snapshot.snapshotBlock,
      });
      const remembered = epochs[active.capacityEpochId];
      if (
        remembered &&
        String(remembered.policyNonce) === snapshot.policyNonce &&
        remembered.balanceSnapshot === snapshot.capacityEpoch.balanceSnapshot &&
        remembered.priceSnapshot === snapshot.capacityEpoch.priceSnapshot &&
        remembered.portfolioPriceSnapshot ===
          snapshot.capacityEpoch.portfolioPriceSnapshot &&
        remembered.riskCertificateHash ===
          snapshot.capacityEpoch.riskCertificateHash &&
        remembered.aquaStrategyHash === snapshot.capacityEpoch.aquaStrategyHash
      ) {
        snapshot.capacityEpoch = {
          ...remembered,
          consumedBefore: active.consumedValue,
        };
        snapshot.capacityEpochId = active.capacityEpochId;
      }
      return snapshot;
    }
    async getSnapshot(intent) {
      const snapshot = await super.getSnapshot(intent);
      if (snapshot.chainPolicy.paused)
        throw new ServiceError(
          "POLICY_PAUSED",
          "Alice has paused trading.",
          409,
        );
      const active = await read(client, contracts.router, "capacityState", [
        this.space.positionIdHash,
        WETH,
        USDC,
      ]);
      if (
        active.capacityEpochId !== snapshot.capacityEpochId ||
        !epochs[active.capacityEpochId]
      )
        throw new ServiceError(
          "AUTHORIZATION_REQUIRED",
          "Alice must authorize the current trading capacity from her wallet.",
          409,
        );
      return snapshot;
    }
  }
  const providers = new Map(
    spaceDefinitions.map((space) => [
      space.positionId,
      new ForkProvider(space),
    ]),
  );
  const provider = {
    getPositionSnapshot: (positionId) => {
      const selected = providers.get(positionId);
      if (!selected)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      return selected.getPositionSnapshot(positionId);
    },
    prepareIntent: (input) => {
      const selected = providers.get(input.positionId);
      if (!selected)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      return selected.prepareIntent(input);
    },
    prepareTokenIntent: (input) => {
      const selected = providers.get(input.positionId);
      if (!selected)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      return selected.prepareTokenIntent(input);
    },
    getSnapshot: (intent) => {
      const selected = spaceDefinitions
        .map((space) => providers.get(space.positionId))
        .find(
          (candidate) =>
            candidate &&
            intent.positionIdHash.toLowerCase() ===
              candidate.space.positionIdHash.toLowerCase(),
        );
      if (!selected)
        throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
      return selected.getSnapshot(intent);
    },
  };
  database = new ServiceDatabase({ filename: path.join(DIR, "service.db") });
  const service = new AurkaService({
    database,
    provider,
    signer: solver,
    chainId: CHAIN_ID,
    settlementContract: manifest.router,
    indexConfirmations: 0,
    rpcTransport: new JsonRpcHttpTransport(RPC),
    spaceMode: "fork",
    seedFixture: false,
  });
  const indexer = new ChainEventIndexer(service.repository);
  let indexedBlock = BigInt(manifest.deploymentBlock) - 1n;
  const pricingNeedsRenewal = (snapshot) =>
    manifest.executionEngine === "AURKA_UPSTREAM_LIMIT_SWAP_V1" &&
    buildUpstreamSwapVMStrategy(
      snapshot,
      WETH,
      USDC,
    ).strategyHash.toLowerCase() !== snapshot.aquaStrategyHash.toLowerCase();
  async function refresh(spaceId = DEFAULT_SPACE.positionId) {
    const selected = providers.get(spaceId);
    if (!selected)
      throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
    const definition = spaceDefinitions.find(
      (space) => space.positionId === spaceId,
    );
    if (definition?.lifecycle)
      await lifecycle.reconcile(lifecycle.plans[spaceId]);
    for (const operation of [
      ...lifecycle.history,
      ...Object.values(lifecycle.operations),
    ])
      if (operation.definition.positionId === spaceId)
        await lifecycle.reconcile(operation);
    const snapshot = await selected.currentSnapshot();
    const activeCapacity = await client.readContract({
      ...contracts.router,
      functionName: "capacityState",
      args: [definition.positionIdHash, WETH, USDC],
      blockNumber: snapshot.snapshotBlock,
    });
    const needsPricingRenewal = pricingNeedsRenewal(snapshot);
    const tradingReady =
      !needsPricingRenewal &&
      activeCapacity.capacityEpochId === snapshot.capacityEpochId &&
      !!epochs[activeCapacity.capacityEpochId] &&
      [
        snapshot.priceProtection.traderInputReferencePrice,
        snapshot.priceProtection.traderOutputReferencePrice,
      ].every(
        (price) =>
          price.observedAt <= snapshot.priceProtection.nowSeconds &&
          snapshot.priceProtection.nowSeconds - price.observedAt <=
            snapshot.priceProtection.maximumPriceAgeSeconds,
      );
    const position = positionForSnapshot(
      snapshot,
      manifest.policyRegistry,
      manifest.alice,
    );
    position.name =
      service.repository.getSpace(spaceId)?.identity.name ??
      definition?.name ??
      manifest.name;
    service.repository.savePosition(position);
    service.repository.saveSpaceIdentity({
      id: position.id,
      name: position.name,
      ownerAddress: position.owner,
      controllerAddress: position.policy.governance,
      treasuryAddress: position.treasury,
      chainId: position.chainId,
      policyId: position.policy.id,
      strategyId: definition?.strategyHash ?? manifest.strategyHash,
      policyRegistryAddress: position.policy.registry,
      mode: "fork",
      state: position.policy.paused
        ? "PAUSED"
        : needsPricingRenewal
          ? "PRICING_NEEDS_RENEWAL"
          : tradingReady
            ? "ACTIVE"
            : "REACTIVATION_REQUIRED",
    });
    const end = snapshot.snapshotBlock;
    if (end > indexedBlock) {
      const logs = await client.getLogs({
        address: manifest.router,
        fromBlock: indexedBlock + 1n,
        toBlock: end,
      });
      indexer.ingest(
        await blockObservedLogs(client, receiptLogs(logs, manifest.router)),
      );
      indexedBlock = end;
    }
    return snapshot;
  }
  const lifecycle = new ForkSpaceLifecycle({
    client,
    contracts,
    manifest,
    service,
    providers,
    definitions: spaceDefinitions,
    makeProvider: (space) => new ForkProvider(space),
    file: path.join(DIR, "space-setup.json"),
    epochs,
    saveEpochs: () => writeFileSync(epochsFile, stringify(epochs)),
    saveManifest: () => {
      manifest.spaces = spaceDefinitions;
      writeFileSync(manifestFile, stringify(manifest));
    },
  });
  const forkContext = async () => {
    const head = await client.getBlock();
    return {
      chainId: manifest.chainId,
      forkGeneration: manifest.forkGeneration,
      forkAnchor: {
        blockNumber: String(manifest.deploymentBlock),
        blockHash: manifest.deploymentBlockHash,
      },
      observedBlock: {
        blockNumber: head.number.toString(),
        blockHash: head.hash,
      },
      deployment: {
        policyRegistry: manifest.policyRegistry,
        riskRegistry: manifest.riskRegistry,
        vaultFactory: manifest.vaultFactory,
        aqua: manifest.aqua,
        router: manifest.router,
      },
    };
  };
  const assertForkContext = (body) => {
    if (
      body?.forkGeneration !== undefined &&
      body.forkGeneration !== manifest.forkGeneration
    )
      throw new ServiceError(
        "FORK_CONTEXT_MISMATCH",
        "This setup was prepared by a different local fork instance; inspect the saved hash before retrying.",
        409,
        {
          expectedForkGeneration: manifest.forkGeneration,
          receivedForkGeneration: body.forkGeneration,
        },
      );
  };
  for (const plan of Object.values(lifecycle.plans)) {
    if (plan.complete) {
      if (await strategyIsClosed(plan.definition, plan.treasury)) {
        closedSpaces.add(plan.definition.positionId);
        continue;
      }
      try {
        await lifecycle.prepare(plan.definition.positionId);
      } catch (error) {
        console.error(
          "Space setup needs recovery:",
          plan.definition.positionId,
          error.message,
        );
      }
    }
  }
  for (const space of spaceDefinitions)
    if (providers.has(space.positionId) && !closedSpaces.has(space.positionId))
      await refresh(space.positionId);
  const agent = new OpenRouterAgent(service, openRouterAgentOptionsFromEnv());
  const delegated = await createDelegatedSessionServiceFromEnv(service, agent);
  api = createApiServer({ service, agent, delegated });
  await listenApiServer(api, 0, "127.0.0.1");
  const apiPort = api.server.address().port;
  const tx = (contract, functionName, args) => ({
    to: contract.address,
    data: encodeFunctionData({ abi: contract.abi, functionName, args }),
    value: "0x0",
  });
  let lifecycleQueue = Promise.resolve();
  gateway = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/fork/identity") {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(stringify(await forkContext()));
        return;
      }
      if (
        request.method === "POST" &&
        [
          "/fork/spaces/prepare",
          "/fork/spaces/confirm",
          "/fork/spaces/reconcile",
          "/fork/spaces/recover",
        ].includes(url.pathname)
      ) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16384) throw new Error("Request too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assertForkContext(body);
        const work = lifecycleQueue.then(() =>
          url.pathname.endsWith("/reconcile")
            ? body.batch
              ? lifecycle.reconcileBatch(
                  body.spaceId,
                  body.hashes,
                  body.operation,
                  body.batchId,
                  body.batchPlanId,
                  body.batchCommitment,
                  body.atomic,
                  body.status,
                )
              : lifecycle.reconcileTransaction(
                  body.spaceId,
                  body.step,
                  body.hash,
                  body.operation,
                  body.planId,
                  body.planCommitment,
                )
            : url.pathname.endsWith("/recover")
              ? lifecycle.recoverTransaction(
                  body.spaceId,
                  body.step,
                  body.hash,
                  body.operation,
                  body.planId,
                  body.planCommitment,
                )
              : url.pathname.endsWith("/confirm")
                ? body.batch
                  ? lifecycle.confirmBatch(
                      body.spaceId,
                      body.hashes,
                      body.operation,
                      body.batchId,
                      body.batchPlanId,
                      body.batchCommitment,
                      body.atomic,
                    )
                  : lifecycle.confirm(
                      body.spaceId,
                      body.step,
                      body.hash,
                      body.operation,
                      body.planId,
                      body.planCommitment,
                    )
                : lifecycle.prepare(body.spaceId, body.operation),
        );
        lifecycleQueue = work.catch(() => {});
        const result = await work;
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(stringify({ ...(await forkContext()), ...result }));
      } else if (request.method === "GET" && url.pathname === "/fork") {
        const spaceId =
          url.searchParams.get("spaceId") ?? DEFAULT_SPACE.positionId;
        const definition = spaceDefinitions.find(
          (space) => space.positionId === spaceId,
        );
        const selected = providers.get(spaceId);
        if (!definition || !selected)
          throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
        const snapshot = await refresh(spaceId);
        const atBlock = {
          readContract: (request) =>
            client.readContract({
              ...request,
              blockNumber: snapshot.snapshotBlock,
            }),
        };
        const active = await read(atBlock, contracts.router, "capacityState", [
          definition.positionIdHash,
          WETH,
          USDC,
        ]);
        const balances = {};
        for (const [role, account] of [
          ["alice", manifest.alice],
          ["treasury", snapshot.chainPolicy.treasury],
          ["bob", manifest.bob],
          ["solver", solver.address],
          ["protocol", manifest.protocolRecipient],
        ])
          balances[role] = {
            usdc: await read(
              atBlock,
              { address: USDC, abi: erc20Abi },
              "balanceOf",
              [account],
            ),
            weth: await read(
              atBlock,
              { address: WETH, abi: erc20Abi },
              "balanceOf",
              [account],
            ),
          };
        const payload = stringify({
          ...manifest,
          solver: solver.address,
          position: {
            ...positionForSnapshot(
              snapshot,
              manifest.policyRegistry,
              manifest.alice,
            ),
            name: definition.name,
          },
          balances,
          capacity: {
            id: active.capacityEpochId,
            baseline: active.capacityBaselineValue,
            consumed: active.consumedValue,
            authorized:
              !pricingNeedsRenewal(snapshot) &&
              active.capacityEpochId === snapshot.capacityEpochId &&
              !!epochs[active.capacityEpochId] &&
              [
                snapshot.priceProtection.traderInputReferencePrice,
                snapshot.priceProtection.traderOutputReferencePrice,
              ].every(
                (price) =>
                  price.observedAt <= snapshot.priceProtection.nowSeconds &&
                  snapshot.priceProtection.nowSeconds - price.observedAt <=
                    snapshot.priceProtection.maximumPriceAgeSeconds,
              ),
          },
          block: snapshot.snapshotBlock,
          timestamp: snapshot.priceProtection.nowSeconds,
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(payload);
      } else if (request.method === "GET" && url.pathname === "/fork/owner") {
        const action = url.searchParams.get("action");
        const spaceId =
          url.searchParams.get("spaceId") ?? DEFAULT_SPACE.positionId;
        const definition = spaceDefinitions.find(
          (space) => space.positionId === spaceId,
        );
        const selected = providers.get(spaceId);
        if (!definition || (!selected && action === "authorize"))
          throw new ServiceError("SPACE_NOT_FOUND", "Space was not found", 404);
        const space = service.getSpace(spaceId);
        const vault = space.identity.treasuryAddress;
        const strategyHash =
          definition.strategyHash ?? space.identity.strategyId;
        const recoveryState = async () => {
          const tokens = [USDC, WETH];
          const aquaBalances = {};
          const vaultBalances = {};
          const ownerBalances = {};
          for (const token of tokens) {
            const raw = await client.readContract({
              ...contracts.aqua,
              functionName: "rawBalances",
              args: [vault, manifest.aquaApp, strategyHash, token],
            });
            aquaBalances[token] = {
              balance: BigInt(tupleValue(raw, 0, "balance")).toString(),
              tokensCount: Number(tupleValue(raw, 1, "tokensCount")),
            };
            vaultBalances[token] = (
              await client.readContract({
                address: token,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [vault],
              })
            ).toString();
            ownerBalances[token] = (
              await client.readContract({
                address: token,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [space.identity.ownerAddress],
              })
            ).toString();
          }
          return {
            spaceId,
            owner: space.identity.ownerAddress,
            vault,
            aqua: manifest.aqua,
            aquaApp: manifest.aquaApp,
            strategyHash,
            tokens: { usdc: USDC, weth: WETH },
            aquaBalances,
            vaultBalances,
            ownerBalances,
          };
        };
        let transaction;
        if (action === "state") {
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(stringify(await recoveryState()));
          return;
        } else if (action === "pause" || action === "resume")
          transaction = tx(contracts.policyRegistry, "setPaused", [
            definition.policyId,
            action === "pause",
          ]);
        else if (action === "limit") {
          const value = BigInt(url.searchParams.get("value") ?? "0");
          if (value < 1n || value > 5000n)
            throw new Error(
              "Choose a whole transaction limit between 1 and 5000.",
            );
          transaction = tx(
            contracts.policyRegistry,
            "setMaximumTransactionValue",
            [definition.policyId, value],
          );
          // Legacy control for the runner's pre-seeded Team inventory, not the
          // configurable owner-created Space path.
        } else if (action === "allowance" || action === "revoke")
          transaction = tx({ address: USDC, abi: erc20Abi }, "approve", [
            manifest.aqua,
            action === "revoke" ? 0n : 70000n * 1000000n,
          ]);
        else if (action === "authorize") {
          const snapshot = await selected.currentSnapshot();
          if (snapshot.chainPolicy.paused)
            throw new Error("Resume the policy before authorizing capacity.");
          const fill = calculateDirectSettlement({
            portfolio: snapshot.portfolio,
            policy: snapshot.policy,
            fee: snapshot.fee,
            feeAccounting: snapshot.feeAccounting,
            traderInputToken: WETH,
            traderOutputToken: USDC,
            requestedValue: snapshot.policy.maximumTransactionValue,
            capacityBaselineValue: snapshot.capacityEpoch.capacityBaselineValue,
            consumedBefore: 0n,
            capacityEpochId: snapshot.capacityEpochId,
            capacityEpoch: snapshot.capacityEpoch,
            priceProtection: snapshot.priceProtection,
          });
          snapshot.capacityEpoch.capacityBaselineValue = fill.maximumSafeValue;
          snapshot.capacityEpochId = computeCapacityEpochId(
            snapshot.capacityEpoch,
          );
          epochs[snapshot.capacityEpochId] = snapshot.capacityEpoch;
          writeFileSync(epochsFile, stringify(epochs));
          transaction = tx(contracts.router, "activateCapacityEpoch", [
            definition.policyId,
            contractEpoch(snapshot),
            contractPriceInput(snapshot),
          ]);
        } else if (action === "dock") {
          transaction = tx(
            { address: vault, abi: contracts.vaultAbi },
            "dockAquaStrategy",
            [manifest.aqua, manifest.aquaApp, strategyHash, [USDC, WETH]],
          );
        } else if (action === "withdraw") {
          const tokenName = url.searchParams.get("token")?.toLowerCase();
          const token =
            tokenName === "usdc"
              ? USDC
              : tokenName === "weth"
                ? WETH
                : undefined;
          const amountText = url.searchParams.get("amount") ?? "";
          if (
            !token ||
            !/^[0-9]+$/.test(amountText) ||
            BigInt(amountText) <= 0n
          )
            throw new Error(
              "Withdraw requires token=USDC|WETH and a positive raw integer amount.",
            );
          const vaultBalance = await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [vault],
          });
          if (BigInt(amountText) > vaultBalance)
            throw new Error("Withdraw amount exceeds the vault token balance.");
          transaction = tx(
            { address: vault, abi: contracts.vaultAbi },
            "withdraw",
            [token, space.identity.ownerAddress, BigInt(amountText)],
          );
        } else throw new Error("Unknown owner action");
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          stringify({
            ...transaction,
            owner: space.identity.ownerAddress,
            vault,
            strategyHash,
            note: "Unsigned owner transaction; sign and broadcast from the Space owner wallet.",
          }),
        );
      } else if (
        request.method === "GET" &&
        url.pathname === "/v1/activity" &&
        (GRAPH_ENDPOINT ||
          (GRAPH_ENDPOINT_FILE && existsSync(GRAPH_ENDPOINT_FILE)))
      ) {
        const numberValue = (name) => {
          const value = url.searchParams.get(name);
          return value === null ? undefined : Number(value);
        };
        const query = {
          ...(url.searchParams.get("spaceId")
            ? { spaceId: url.searchParams.get("spaceId") }
            : {}),
          ...(url.searchParams.get("positionId")
            ? { positionId: url.searchParams.get("positionId") }
            : {}),
          ...(url.searchParams.get("chainId")
            ? { chainId: numberValue("chainId") }
            : {}),
          ...(url.searchParams.get("status")
            ? { status: url.searchParams.get("status") }
            : {}),
          ...(url.searchParams.get("type")
            ? { type: url.searchParams.get("type") }
            : {}),
          ...(url.searchParams.get("from")
            ? { from: numberValue("from") }
            : {}),
          ...(url.searchParams.get("to") ? { to: numberValue("to") } : {}),
          limit: numberValue("limit") ?? 20,
        };
        const page = await graphActivityPage(query, service, spaceDefinitions);
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(stringify({ ok: true, data: page }));
      } else {
        for (const space of spaceDefinitions)
          if (
            providers.has(space.positionId) &&
            !closedSpaces.has(space.positionId)
          )
            await refresh(space.positionId);
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1048576) throw new Error("Request too large");
          chunks.push(chunk);
        }
        const result = await fetch(
          `http://127.0.0.1:${apiPort}${request.url}`,
          {
            method: request.method,
            headers: { "content-type": "application/json" },
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
            signal: AbortSignal.timeout(FORK_REQUEST_TIMEOUT_MS),
          },
        );
        response.writeHead(result.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(await result.text());
      }
    } catch (error) {
      console.error(
        "Fork request failed:",
        error.stack ?? error.shortMessage ?? error.message,
      );
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const code = error.code ?? "FORK_REQUEST_FAILED";
      const statusCode = Number.isInteger(error.statusCode)
        ? error.statusCode
        : 409;
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(
        stringify({
          error: {
            code,
            message: error.shortMessage ?? error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(API_PORT, FORK_BIND_HOST, resolve);
  });
  for (const [app, port] of SKIP_APP ? [] : [["trader", APP_PORT]]) {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        `@aurka/${app}-app`,
        "dev",
        "--host",
        FORK_BIND_HOST,
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: ROOT,
        stdio: "inherit",
        detached: true,
        env: {
          ...process.env,
          VITE_AURKA_MODE: "fork",
          AURKA_SERVICE_URL: `http://127.0.0.1:${API_PORT}`,
        },
      },
    );
    children.push(child);
    child.once("exit", () => {
      console.error(`${app} stopped; shutting down fork environment.`);
      void stop();
    });
  }
  console.log(
    `Fork ready: AURKA app ${manifest.appUrl} · API ${manifest.apiUrl} · manifest ${path.join(DIR, "manifest.json")}. ${INTEGRATION_MODE === "real" ? "Real Aqua + Chainlink prices + pinned upstream SwapVM; test funds." : INTEGRATION_MODE === "fixture-upstream" ? "Controlled MockAqua + MockPriceOracle + pinned upstream SwapVM; test funds." : "Fixture-only Aqua and prices; test funds."}`,
  );
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
main().catch(async (error) => {
  console.error(error.stack ?? error.shortMessage ?? error.message);
  await stop();
  process.exitCode = 1;
});
