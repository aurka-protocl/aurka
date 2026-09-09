/* global console, process, setTimeout, URL, fetch, AbortSignal */
import { Buffer } from "node:buffer";
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
  parseAbi,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  AurkaService,
  ServiceError,
  ServiceDatabase,
  FixtureProposalSigner,
  JsonRpcHttpTransport,
  createApiServer,
  listenApiServer,
  ChainEventIndexer,
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

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const DIR = path.join(ROOT, ".fork-space");
const RPC = "http://127.0.0.1:8545";
const API_PORT = 8797;
const APP_PORT = 3011;
const FORK_BLOCK = 22400000;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
// Public Anvil test derivation only. Never consume DEPLOYER_PRIVATE_KEY.
const MNEMONIC = "test test test test test test test test test test test junk";
const stringify = (value) =>
  JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
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
  for (const port of [8545, API_PORT, APP_PORT]) {
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
    await upstreamClient.getBlock({ blockNumber: BigInt(FORK_BLOCK) });
  } catch {
    throw new Error(
      `MAINNET_RPC_URL cannot read Ethereum mainnet block ${FORK_BLOCK}; no demo fallback.`,
    );
  }
  // Refuse an occupied RPC, including another fork instance; never reset arbitrary nodes.
  try {
    await client.getChainId();
    throw new Error(
      "RPC port 8545 is occupied. Stop the existing process before start/reset.",
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
      "127.0.0.1",
      "--port",
      "8545",
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
      "--block-time",
      "1",
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
      "Anvil fork startup failed. Check archive RPC availability and local port 8545.",
    );
  const currentTime = Math.floor(Date.now() / 1000);
  if (Number((await client.getBlock()).timestamp) < currentTime) {
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
    const aqua = await deploy(wallet, client, "MockAqua");
    const oracle = await deploy(wallet, client, "MockPriceOracle");
    const swapVM = await deploy(wallet, client, "AurkaDirectSwapVM");
    const router = await deploy(wallet, client, "AurkaSwapVMRouter", [
      policyRegistry.address,
      riskRegistry.address,
      aqua.address,
      swapVM.address,
    ]);
    console.log("AURKA fork contracts deployed; seeding fork token balances.");
    const alice = accounts[0].address;
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
      STRATEGY_HASH,
      oracle.address,
    ]);
    // Explicitly mocked, fixed reference prices, valid for this one-day test session.
    await write(wallet, client, policyRegistry, "setPriceProtection", [
      POLICY_ID,
      86400n,
      100,
    ]);
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
    for (const [token, amount] of [
      [USDC, 70000n * 1000000n],
      [WETH, 10n * 10n ** 18n],
    ])
      await write(wallet, client, aqua, "seed", [
        alice,
        router.address,
        STRATEGY_HASH,
        token,
        amount,
      ]);
    // Alice explicitly enables allowance and epoch from her browser wallet.
    manifest = {
      mode: "fork",
      name: "Team inventory",
      chainId: CHAIN_ID,
      upstreamChainId: 1,
      forkBlock: FORK_BLOCK,
      rpcUrl: RPC,
      alice,
      bob: accounts[1].address,
      protocolRecipient: accounts[2].address,
      policyId: POLICY_ID,
      positionIdHash: POSITION_ID_HASH,
      strategyHash: STRATEGY_HASH,
      usdc: USDC,
      weth: WETH,
      policyRegistry: policyRegistry.address,
      riskRegistry: riskRegistry.address,
      aqua: aqua.address,
      oracle: oracle.address,
      swapVM: swapVM.address,
      router: router.address,
      deploymentBlock: Number((await client.getBlock()).number),
      mocks: [
        "MockAqua: unrestricted test virtual balances; not production Aqua",
        "MockPriceOracle: fixed USDC=1 and WETH=3200 reference units; valid 24 hours",
        "FixtureProposalSigner: public test solver",
      ],
      funding:
        "Fork-only USDC holder impersonation and WETH deposit; dedicated public Anvil accounts 0/1",
    };
    writeFileSync(manifestFile, stringify(manifest));
  }
  manifest.apiUrl = `http://127.0.0.1:${API_PORT}`;
  delete manifest.ownerUrl;
  delete manifest.traderUrl;
  manifest.appUrl = `http://127.0.0.1:${APP_PORT}/spaces`;
  writeFileSync(manifestFile, stringify(manifest));
  const contracts = Object.fromEntries(
    [
      ["policyRegistry", "AurkaPolicyRegistry"],
      ["riskRegistry", "RiskModeRegistry"],
      ["aqua", "MockAqua"],
      ["oracle", "MockPriceOracle"],
      ["router", "AurkaSwapVMRouter"],
    ].map(([key, name]) => [
      key,
      { address: manifest[key], abi: artifact(name).abi },
    ]),
  );
  contracts.erc20Abi = erc20Abi;
  const solver = new FixtureProposalSigner();
  const epochsFile = path.join(DIR, "epochs.json");
  const epochs = existsSync(epochsFile)
    ? JSON.parse(readFileSync(epochsFile, "utf8"))
    : {};
  class ForkProvider extends LocalChainSnapshotProvider {
    async currentSnapshot() {
      const snapshot = await super.currentSnapshot();
      const active = await client.readContract({
        ...contracts.router,
        functionName: "capacityState",
        args: [POSITION_ID_HASH, WETH, USDC],
        blockNumber: snapshot.snapshotBlock,
      });
      const remembered = epochs[active.capacityEpochId];
      if (
        remembered &&
        String(remembered.policyNonce) === snapshot.policyNonce
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
        POSITION_ID_HASH,
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
  const provider = new ForkProvider(client, contracts, solver.address);
  database = new ServiceDatabase({ filename: path.join(DIR, "service.db") });
  const service = new AurkaService({
    database,
    provider,
    signer: solver,
    chainId: CHAIN_ID,
    settlementContract: manifest.router,
    indexConfirmations: 0,
    rpcTransport: new JsonRpcHttpTransport(RPC),
    seedFixture: false,
  });
  const indexer = new ChainEventIndexer(service.repository);
  let indexedBlock = BigInt(manifest.deploymentBlock) - 1n;
  async function refresh() {
    const snapshot = await provider.currentSnapshot();
    const position = positionForSnapshot(
      snapshot,
      manifest.policyRegistry,
      manifest.alice,
    );
    position.name = manifest.name;
    service.repository.savePosition(position);
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
  await refresh();
  api = createApiServer({ service });
  await listenApiServer(api, 0, "127.0.0.1");
  const apiPort = api.server.address().port;
  const tx = (contract, functionName, args) => ({
    to: contract.address,
    data: encodeFunctionData({ abi: contract.abi, functionName, args }),
    value: "0x0",
  });
  gateway = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/fork") {
        const snapshot = await refresh();
        const atBlock = {
          readContract: (request) =>
            client.readContract({
              ...request,
              blockNumber: snapshot.snapshotBlock,
            }),
        };
        const active = await read(atBlock, contracts.router, "capacityState", [
          POSITION_ID_HASH,
          WETH,
          USDC,
        ]);
        const balances = {};
        for (const [role, account] of [
          ["alice", manifest.alice],
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
            name: manifest.name,
          },
          balances,
          capacity: {
            id: active.capacityEpochId,
            baseline: active.capacityBaselineValue,
            consumed: active.consumedValue,
            authorized:
              active.capacityEpochId === snapshot.capacityEpochId &&
              !!epochs[active.capacityEpochId],
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
        let transaction;
        if (action === "pause" || action === "resume")
          transaction = tx(contracts.policyRegistry, "setPaused", [
            POLICY_ID,
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
            [POLICY_ID, value],
          );
        } else if (action === "allowance" || action === "revoke")
          transaction = tx({ address: USDC, abi: erc20Abi }, "approve", [
            manifest.aqua,
            action === "revoke" ? 0n : 70000n * 1000000n,
          ]);
        else if (action === "authorize") {
          const snapshot =
            await LocalChainSnapshotProvider.prototype.currentSnapshot.call(
              provider,
            );
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
            POLICY_ID,
            contractEpoch(snapshot),
            contractPriceInput(snapshot),
          ]);
        } else throw new Error("Unknown owner action");
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(stringify(transaction));
      } else {
        await refresh();
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
            signal: AbortSignal.timeout(15000),
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
        error.shortMessage ?? error.message,
      );
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(409, { "content-type": "application/json" });
      response.end(stringify({ error: error.shortMessage ?? error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(API_PORT, "127.0.0.1", resolve);
  });
  for (const [app, port] of [["trader", APP_PORT]]) {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        `@aurka/${app}-app`,
        "dev",
        "--host",
        "127.0.0.1",
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
    "Fork ready: AURKA app http://127.0.0.1:3011/spaces · API http://127.0.0.1:8797 · manifest .fork-space/manifest.json. Test funds; mocked Aqua and prices.",
  );
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
main().catch(async (error) => {
  console.error(error.shortMessage ?? error.message);
  await stop();
  process.exitCode = 1;
});
