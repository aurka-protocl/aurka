/* global Buffer, console, process, fetch, setTimeout */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  deploySubgraph,
  graphQuery,
  startGraphStack,
  stopGraphStack,
  temporaryManifest,
  waitForIndexedBlock,
} from "./local-graph-node-e2e.mjs";

const ROOT = path.resolve(
  new globalThis.URL("../../..", import.meta.url).pathname,
);
const FORK_BLOCK = 25_500_000;
const STARTUP_TIMEOUT_MS = 120_000;
const dir = path.resolve(
  process.env.AURKA_RELEASE_EVIDENCE_DIR ??
    mkdtempSync(path.join(os.tmpdir(), "aurka-real-release-")),
);
mkdirSync(dir, { recursive: true, mode: 0o700 });

function check(condition, message) {
  assert.ok(condition, message);
}

async function freePort() {
  const net = await import("node:net");
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

function child(command, args, env = {}) {
  return spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

async function stopProcess(processHandle) {
  if (
    !processHandle ||
    processHandle.exitCode !== null ||
    processHandle.signalCode !== null
  )
    return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    once(processHandle, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill("SIGKILL");
    await Promise.race([
      once(processHandle, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function waitForExit(processHandle, label) {
  const [code, signal] =
    processHandle.exitCode !== null || processHandle.signalCode !== null
      ? [processHandle.exitCode, processHandle.signalCode]
      : await once(processHandle, "exit");
  check(code === 0, `${label} failed (${code ?? signal})`);
}

async function waitHttp(url, label, timeout = STARTUP_TIMEOUT_MS) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${label} did not become reachable: ${lastError?.message ?? "unknown error"}`,
  );
}

async function rpc(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  check(
    response.ok && !body.error,
    `${method} failed: ${JSON.stringify(body.error)}`,
  );
  return body.result;
}

async function currentBlock(rpcUrl) {
  return BigInt(await rpc(rpcUrl, "eth_blockNumber"));
}

const graphReleaseQuery = `query ReleaseActivity {
  spaceInitializeds(first: 100, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    spaceId policyId owner vault usdcAmount wethAmount capacityEpochId capacityBaseline
  }
  tradeExecuteds(first: 100, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    policyId positionIdHash intentHash proposalHash capacityEpochId trader treasury
    traderInputToken traderOutputToken traderInputValue traderOutputValue
    treasuryOutputValue totalFeeAmount consumedBefore consumedAfter expectedPostStateHash
  }
  feesRouteds(first: 100, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    proposalHash feeToken solver protocolRecipient solverAmount protocolAmount treasuryAmount
  }
  policyMutations(first: 100, orderBy: id, orderDirection: asc) {
    id chainId contract blockNumber blockHash occurredAt transactionHash logIndex
    policyId eventName nonce actor paused payload
  }
  _meta { deployment hasIndexingErrors block { number hash timestamp } }
}`;

function assertEntityTrace(data, manifest, indexedBlock) {
  check(!data._meta.hasIndexingErrors, "Graph Node reports indexing errors");
  check(
    Number(data._meta.block.number) >= Number(indexedBlock),
    "Graph index did not catch up to the fork head",
  );
  check(
    data.spaceInitializeds.length >= 2,
    "Graph did not index both SpaceInitialized events",
  );
  check(data.tradeExecuteds.length >= 2, "Graph did not index both Bob trades");
  check(data.feesRouteds.length >= 2, "Graph did not index both fee events");
  check(
    data.tradeExecuteds.every(
      (trade) => Number(trade.chainId) === manifest.chainId,
    ),
    "Graph returned an entity from the wrong chain",
  );
  check(
    data.tradeExecuteds.every(
      (trade) => trade.blockHash && trade.transactionHash,
    ),
    "Graph trade evidence is missing canonical hashes",
  );
  const policyEvents = new Set(
    data.policyMutations.map((event) => event.eventName),
  );
  for (const eventName of [
    "PauseStatusUpdated",
    "MaximumTransactionValueUpdated",
  ])
    check(policyEvents.has(eventName), `Graph did not index ${eventName}`);
  check(
    data.policyMutations
      .filter((event) => event.eventName === "PauseStatusUpdated")
      .every(
        (event) =>
          event.actor &&
          event.actor.toLowerCase() === manifest.alice.toLowerCase(),
      ),
    "Graph policy actor evidence does not identify Alice",
  );
}

async function main() {
  const rpcPort = await freePort();
  const apiPort = await freePort();
  const appPort = await freePort();
  const forkDirectory = path.join(dir, "fork");
  const graphEndpointFile = path.join(dir, "graph-endpoint.txt");
  const fork = child(
    "node",
    ["--env-file=.env", "packages/services/scripts/fork-space.mjs", "--reset"],
    {
      AURKA_FORK_DIR: forkDirectory,
      AURKA_FORK_INTEGRATION: "real",
      AURKA_FORK_BLOCK: String(FORK_BLOCK),
      AURKA_FORK_RPC_PORT: String(rpcPort),
      AURKA_FORK_API_PORT: String(apiPort),
      AURKA_FORK_APP_PORT: String(appPort),
      AURKA_FORK_BIND_HOST: "0.0.0.0",
      AURKA_GRAPH_ENDPOINT_FILE: graphEndpointFile,
    },
  );
  let stack;
  let browser;
  try {
    await waitHttp(`http://127.0.0.1:${apiPort}/fork`, "real fork API");
    const manifestFile = path.join(forkDirectory, "manifest.json");
    check(existsSync(manifestFile), "Real fork did not write a manifest");
    let manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    check(
      manifest.integrationMode === "real",
      "Release runner did not start real integration mode",
    );
    check(
      manifest.aquaKind === "REAL_AQUA",
      "Real fork manifest does not identify Aqua",
    );
    check(
      manifest.oracleKind === "CHAINLINK_V3",
      "Real fork manifest does not identify Chainlink",
    );
    check(
      !manifest.mocks.some((item) => item.startsWith("Mock")),
      "Real mode contains a mock core integration",
    );

    stack = await startGraphStack(rpcPort, {
      genesisBlockNumber: manifest.deploymentBlock - 1,
    });
    const manifestDirectory = temporaryManifest(stack.directory, {
      AurkaSwapVMRouter: {
        address: manifest.router,
        blockNumber: manifest.deploymentBlock,
      },
      RiskModeRegistry: {
        address: manifest.riskRegistry,
        blockNumber: manifest.deploymentBlock,
      },
      AurkaPolicyRegistry: {
        address: manifest.policyRegistry,
        blockNumber: manifest.deploymentBlock,
      },
      AurkaSpaceVaultFactory: {
        address: manifest.vaultFactory,
        blockNumber: manifest.deploymentBlock,
      },
    });
    const subgraph = await deploySubgraph(stack, manifestDirectory);
    writeFileSync(graphEndpointFile, `${subgraph.endpoint}\n`, { mode: 0o600 });
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.graph = {
      endpoint: subgraph.endpoint,
      source: "same-fork-graph-node",
      query: "TradeExecuted + FeesRouted + PolicyMutation + SpaceInitialized",
      indexedBlock: null,
    };
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    // Graph Node reports the last block before a data source's start block
    // until a post-deployment transaction gives it work to index.
    await waitForIndexedBlock(
      subgraph.endpoint,
      Math.max(0, manifest.deploymentBlock - 1),
    );
    console.log(
      "Graph initial deployment block indexed; starting browser wallet journey",
    );
    browser = child("node", ["packages/services/scripts/fork-spaces-e2e.mjs"], {
      AURKA_FORK_DIR: forkDirectory,
    });
    await waitForExit(browser, "two-Space wallet journey");
    console.log("Browser wallet journey exited successfully");
    browser = undefined;

    const head = await currentBlock(manifest.rpcUrl);
    const indexedMeta = await waitForIndexedBlock(subgraph.endpoint, head);
    const graphData = await graphQuery(subgraph.endpoint, graphReleaseQuery);
    assertEntityTrace(graphData, manifest, head);
    manifest.graph.indexedBlock = indexedMeta;
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const activity = await fetch(
      `${manifest.apiUrl}/v1/activity?type=SWAP&status=CONFIRMED&limit=20`,
    );
    const activityBody = await activity.json();
    check(
      activity.ok && activityBody.ok,
      `Graph-backed Activity failed: ${JSON.stringify(activityBody)}`,
    );
    check(
      activityBody.data.items.length >= 2,
      "App Activity did not consume both Graph trades",
    );
    check(
      activityBody.data.items
        .filter((item) => item.status === "CONFIRMED")
        .every(
          (item) =>
            item.source === "CHAIN_EVENT" && item.evidence?.graphEntityId,
        ),
      "Confirmed Activity is missing Graph entity evidence",
    );

    const stopped = await fetch(
      `${manifest.apiUrl}/v1/activity?type=SWAP&limit=20`,
    );
    check(stopped.ok, "Pre-outage Graph Activity check failed");
    const stopResult = await runDocker(stack, ["stop", "graph-node"]);
    check(stopResult === 0, "Graph Node stop failed");
    const unavailable = await fetch(
      `${manifest.apiUrl}/v1/activity?type=SWAP&limit=20`,
    );
    const unavailableBody = await unavailable.json();
    check(
      unavailable.status === 503,
      "Graph outage did not fail closed with 503",
    );
    check(
      unavailableBody.error?.code === "GRAPH_ACTIVITY_UNAVAILABLE",
      "Graph outage error code was not actionable",
    );
    check(
      (await runDocker(stack, ["start", "graph-node"])) === 0,
      "Graph Node restart failed",
    );
    await waitForIndexedBlock(subgraph.endpoint, head);
    const recovered = await fetch(
      `${manifest.apiUrl}/v1/activity?type=SWAP&status=CONFIRMED&limit=20`,
    );
    check(recovered.ok, "Graph-backed Activity did not recover after restart");

    const evidence = {
      integrationMode: manifest.integrationMode,
      fork: {
        chainId: manifest.chainId,
        upstreamChainId: manifest.upstreamChainId,
        block: manifest.forkBlock,
        deploymentBlock: manifest.deploymentBlock,
        deploymentBlockHash: manifest.deploymentBlockHash,
      },
      contracts: {
        aqua: manifest.aqua,
        router: manifest.router,
        vaultFactory: manifest.vaultFactory,
        oracle: manifest.oracle,
        swapVM: manifest.swapVM,
        tokens: { usdc: manifest.usdc, weth: manifest.weth },
      },
      graph: {
        endpoint: subgraph.endpoint,
        indexed: indexedMeta,
        counts: {
          spaces: graphData.spaceInitializeds.length,
          trades: graphData.tradeExecuteds.length,
          fees: graphData.feesRouteds.length,
          policyMutations: graphData.policyMutations.length,
        },
        tradeReceipts: graphData.tradeExecuteds.map((trade) => ({
          entityId: trade.id,
          transactionHash: trade.transactionHash,
          blockNumber: trade.blockNumber,
          blockHash: trade.blockHash,
          proposalHash: trade.proposalHash,
        })),
        feeReceipts: graphData.feesRouteds.map((fee) => ({
          entityId: fee.id,
          transactionHash: fee.transactionHash,
          blockNumber: fee.blockNumber,
          blockHash: fee.blockHash,
          proposalHash: fee.proposalHash,
        })),
      },
      journeyEvidence: path.join(forkDirectory, "evidence"),
      graphOutage:
        "503 GRAPH_ACTIVITY_UNAVAILABLE then successful query after Graph Node restart",
    };
    writeFileSync(
      path.join(dir, "release.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      `Real integration release rehearsal passed; evidence: ${path.join(dir, "release.json")}`,
    );
  } catch (error) {
    if (stack) {
      await new Promise((resolve) => {
        const output = [];
        const diagnostic = spawn(
          "docker",
          [
            "compose",
            "-p",
            stack.project,
            "-f",
            stack.compose,
            "logs",
            "--no-color",
          ],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        diagnostic.stdout.on("data", (chunk) => output.push(chunk));
        diagnostic.stderr.on("data", (chunk) => output.push(chunk));
        diagnostic.once("exit", () => {
          writeFileSync(
            path.join(dir, "graph-diagnostic.log"),
            Buffer.concat(output),
            { mode: 0o600 },
          );
          resolve();
        });
      });
    }
    throw error;
  } finally {
    await stopProcess(browser);
    await stopProcess(fork);
    await stopGraphStack(stack);
    if (!process.env.AURKA_RELEASE_EVIDENCE_DIR)
      rmSync(dir, { recursive: true, force: true });
  }
}

async function runDocker(stack, args) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(
      "docker",
      ["compose", "-p", stack.project, "-f", stack.compose, ...args],
      { cwd: ROOT, stdio: "inherit" },
    );
    processHandle.once("error", reject);
    processHandle.once("exit", (code) => resolve(code ?? 1));
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
}
