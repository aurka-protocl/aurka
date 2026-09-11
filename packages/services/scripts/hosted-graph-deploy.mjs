/* global URL, console, fetch, process */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { temporaryManifest } from "./local-graph-node-e2e.mjs";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const runtimeUrl =
  process.env.AURKA_HOSTED_RUNTIME_URL ?? "http://127.0.0.1:8797";
const graphqlUrl =
  process.env.AURKA_HOSTED_GRAPHQL_URL ?? "http://127.0.0.1:18000";
const adminUrl =
  process.env.AURKA_HOSTED_GRAPH_ADMIN_URL ?? "http://127.0.0.1:18020";
const ipfsUrl =
  process.env.AURKA_HOSTED_IPFS_URL ?? "http://127.0.0.1:15001/api/v0";
const name = (process.env.AURKA_GRAPH_SUBGRAPH_NAME ?? "aurka-hosted").replace(
  /[^a-z0-9-]/g,
  "-",
);

function check(value, message) {
  if (!value) throw new Error(message);
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code ?? signal}`)),
    );
  });
}

async function main() {
  check(
    name.length > 0,
    "AURKA_GRAPH_SUBGRAPH_NAME must contain a-z, 0-9, or -",
  );
  const response = await fetch(`${runtimeUrl}/fork/identity`);
  check(
    response.ok,
    `Fork identity request failed with HTTP ${response.status}`,
  );
  const identity = await response.json();
  const deployment = identity.deployment;
  const blockNumber = Number(identity.forkAnchor?.blockNumber);
  check(
    Number.isSafeInteger(blockNumber),
    "Fork identity has no deployment block",
  );
  for (const key of [
    "router",
    "vaultFactory",
    "riskRegistry",
    "policyRegistry",
  ])
    check(
      /^0x[0-9a-fA-F]{40}$/.test(deployment?.[key] ?? ""),
      `Missing ${key} address`,
    );

  const directory = mkdtempSync(path.join(os.tmpdir(), "aurka-hosted-graph-"));
  try {
    const manifestDirectory = temporaryManifest(directory, {
      AurkaSwapVMRouter: { address: deployment.router, blockNumber },
      AurkaSpaceVaultFactory: { address: deployment.vaultFactory, blockNumber },
      RiskModeRegistry: { address: deployment.riskRegistry, blockNumber },
      AurkaPolicyRegistry: { address: deployment.policyRegistry, blockNumber },
    });
    const graphCli = path.join(ROOT, "packages/graph/node_modules/.bin/graph");
    await run(graphCli, ["create", name, "--node", `${adminUrl}/`]);
    await run(
      graphCli,
      [
        "deploy",
        name,
        "subgraph.yaml",
        "--node",
        `${adminUrl}/`,
        "--ipfs",
        ipfsUrl,
        "--version-label",
        "hosted-demo",
      ],
      { cwd: manifestDirectory },
    );
    const evidence = {
      status: "deployed",
      chainId: identity.chainId,
      forkGeneration: identity.forkGeneration,
      deploymentBlock: blockNumber,
      subgraph: name,
      endpoint: `${graphqlUrl}/subgraphs/name/${name}`,
      source: "same-fork-graph-node",
    };
    if (process.env.AURKA_HOSTED_GRAPH_EVIDENCE_FILE)
      writeFileSync(
        process.env.AURKA_HOSTED_GRAPH_EVIDENCE_FILE,
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
