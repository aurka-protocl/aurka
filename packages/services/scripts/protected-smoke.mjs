/* global AbortSignal, console, fetch, process */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]+$/;
const DEFAULT_TIMEOUT_MS = 5_000;

function required(name, values) {
  const value = process.env[name];
  if (!value) values.push(name);
  return value;
}

function result(name, status, reason) {
  return { name, status, reason };
}

function safeReason(error) {
  if (!(error instanceof Error)) return "probe_failed";
  if (error.name === "TimeoutError" || error.name === "AbortError")
    return "probe_timeout";
  return "probe_failed";
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("rpc_http_error");
  const body = await response.json();
  if (body.error || !("result" in body)) throw new Error("rpc_error");
  return body.result;
}

async function checkChain(values) {
  const expected = Number(values.chainId);
  if (!Number.isSafeInteger(expected) || expected <= 0)
    return result("rpc", "failed", "invalid_expected_chain");
  try {
    const chain = Number(BigInt(await rpc(values.rpcUrl, "eth_chainId")));
    if (chain !== expected) return result("rpc", "failed", "chain_mismatch");
    const latest = await rpc(values.rpcUrl, "eth_blockNumber");
    if (typeof latest !== "string" || !/^0x[0-9a-fA-F]+$/.test(latest))
      return result("rpc", "failed", "latest_head_invalid");
    const latestHead = await rpc(values.rpcUrl, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const finalizedHead = await rpc(values.rpcUrl, "eth_getBlockByNumber", [
      "finalized",
      false,
    ]);
    if (
      !latestHead ||
      typeof latestHead !== "object" ||
      !finalizedHead ||
      typeof finalizedHead !== "object"
    )
      return result("rpc", "failed", "canonical_finalized_head_missing");
    return result("rpc", "passed", "chain_and_finalized_head_verified");
  } catch (error) {
    return result("rpc", "failed", safeReason(error));
  }
}

async function checkContracts(values) {
  const contracts = [
    ["settlement_contract", values.settlementContract],
    ["policy_registry", values.policyRegistry],
    ["risk_registry", values.riskRegistry],
  ];
  if (contracts.some(([, address]) => !HEX_ADDRESS.test(address ?? "")))
    return result("contracts", "failed", "invalid_contract_address");
  try {
    for (const [, address] of contracts) {
      const code = await rpc(values.rpcUrl, "eth_getCode", [address, "latest"]);
      if (typeof code !== "string" || !HEX_BYTES.test(code) || code === "0x")
        return result("contracts", "failed", "contract_code_missing");
    }
    return result("contracts", "passed", "configured_contracts_have_code");
  } catch (error) {
    return result("contracts", "failed", safeReason(error));
  }
}

async function checkGraph(values) {
  const query = `query ProtectedAurkaSmoke { _meta { deployment hasIndexingErrors block { number hash timestamp } } riskObservations(first: 1, orderBy: observedAt, orderDirection: desc) { id observedAt indexedBlock indexedBlockHash sourceId deploymentId schemaVersion queryVersion } }`;
  try {
    const headers = { "content-type": "application/json" };
    if (values.graphApiKey)
      headers.authorization = `Bearer ${values.graphApiKey}`;
    const response = await fetch(values.graphEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("graph_http_error");
    const body = await response.json();
    if (Array.isArray(body.errors) || !body.data?._meta)
      return result("graph", "failed", "graph_query_failed");
    const meta = body.data._meta;
    if (meta.deployment !== values.graphDeploymentId)
      return result("graph", "failed", "deployment_mismatch");
    if (meta.hasIndexingErrors)
      return result("graph", "failed", "indexing_errors");
    const metaBlock = Number(meta.block?.number);
    if (!Number.isSafeInteger(metaBlock) || metaBlock < 0)
      return result("graph", "failed", "graph_head_missing");
    const observed = body.data.riskObservations?.[0];
    if (!observed) return result("graph", "failed", "no_risk_observation");
    const now = Math.floor(Date.now() / 1000);
    const maxAge = Number(values.graphMaxAgeSeconds ?? 900);
    if (!Number.isSafeInteger(maxAge) || maxAge <= 0)
      return result("graph", "failed", "invalid_freshness_budget");
    const observedAt = Number(observed.observedAt);
    if (
      !Number.isSafeInteger(observedAt) ||
      observedAt < now - maxAge ||
      observedAt > now + 30 ||
      !Number.isSafeInteger(Number(observed.indexedBlock)) ||
      Number(observed.indexedBlock) > metaBlock
    )
      return result("graph", "failed", "observation_not_fresh");
    return result(
      "graph",
      "passed",
      "deployment_schema_query_and_freshness_verified",
    );
  } catch (error) {
    return result("graph", "failed", safeReason(error));
  }
}

async function checkWalletPolicy(values) {
  try {
    const headers = { "x-aurka-wallet-id": values.walletId };
    if (values.walletPolicyToken)
      headers.authorization = `Bearer ${values.walletPolicyToken}`;
    const response = await fetch(values.walletPolicyUrl, {
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("wallet_policy_http_error");
    const body = await response.json();
    if (
      body?.enabled !== true ||
      body?.revoked !== false ||
      (body.walletId !== undefined && body.walletId !== values.walletId) ||
      (body.policyFingerprint !== undefined &&
        !/^0x[0-9a-fA-F]{64}$/.test(body.policyFingerprint))
    )
      return result("wallet_policy", "failed", "wallet_policy_not_authorized");
    return result(
      "wallet_policy",
      "passed",
      "wallet_and_policy_visibility_verified",
    );
  } catch (error) {
    return result("wallet_policy", "failed", safeReason(error));
  }
}

function writeArtifact(summary) {
  const directory = process.env.AURKA_ARTIFACT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "protected-smoke.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

async function main() {
  const mode = process.env.AURKA_SMOKE_MODE ?? "read-only";
  if (mode === "write-smoke") {
    const summary = {
      status: "blocked",
      reason:
        process.env.AURKA_WRITE_CONFIRMATION ===
        "AUTHORIZE_AURKA_PROTECTED_WRITE"
          ? "write_smoke_not_implemented"
          : "explicit_write_confirmation_required",
      checks: [],
    };
    writeArtifact(summary);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }
  if (mode !== "read-only") throw new Error("invalid_smoke_mode");

  const missing = [];
  const values = {
    rpcUrl: required("AURKA_RPC_URL", missing),
    chainId: required("AURKA_CHAIN_ID", missing),
    settlementContract: required("AURKA_SETTLEMENT_CONTRACT", missing),
    policyRegistry: required("AURKA_POLICY_REGISTRY", missing),
    riskRegistry: required("AURKA_RISK_REGISTRY", missing),
    graphEndpoint: required("AURKA_GRAPH_ENDPOINT", missing),
    graphDeploymentId: required("AURKA_GRAPH_DEPLOYMENT_ID", missing),
    walletPolicyUrl: required("AURKA_WALLET_POLICY_URL", missing),
    walletId: required("AURKA_WALLET_ID", missing),
    graphApiKey: process.env.AURKA_GRAPH_API_KEY,
    walletPolicyToken: process.env.AURKA_WALLET_POLICY_TOKEN,
    graphMaxAgeSeconds: process.env.AURKA_GRAPH_MAX_AGE_SECONDS,
  };
  if (missing.length > 0) {
    const summary = { status: "blocked", reason: "missing_inputs", missing };
    writeArtifact(summary);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }

  const checks = [
    await checkChain(values),
    await checkContracts(values),
    await checkGraph(values),
    await checkWalletPolicy(values),
  ];
  const summary = {
    status: checks.every((checkValue) => checkValue.status === "passed")
      ? "passed"
      : "failed",
    checks,
  };
  writeArtifact(summary);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  const summary = {
    status: "failed",
    reason: error instanceof Error ? error.message : "protected_smoke_failed",
  };
  writeArtifact(summary);
  console.error(JSON.stringify(summary));
  process.exitCode = 1;
});
