/* global URL, console, process, setTimeout, clearTimeout */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createPublicClient, defineChain, http } from "viem";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const CHAIN_ID = 11_155_111;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RENEWALS = 48;
const DEFAULT_CHILD_TIMEOUT_MS = 120_000;

const EMPTY_STATE = {
  version: 1,
  operationsSubmitted: 0,
  failures: 0,
  unknownOutcomes: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  nextAttemptAt: null,
  lastError: null,
  pendingAction: null,
  budgetExhausted: false,
};

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function positiveInteger(name, fallback, maximum) {
  const parsed = Number(value(name) ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum)
    throw new Error(`${name} must be a positive integer at most ${maximum}`);
  return parsed;
}

function artifact(relativePath) {
  const filename = path.join(ROOT, relativePath);
  if (!existsSync(filename)) throw new Error(`${relativePath} is missing`);
  return JSON.parse(readFileSync(filename, "utf8"));
}

function address(result, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(result ?? ""))
    throw new Error(`${label} must be an EVM address`);
  return result;
}

function field(value_, name, index) {
  return value_ && typeof value_ === "object" && name in value_
    ? value_[name]
    : value_?.[index];
}

function stateFile(manifestPath) {
  return path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_OPERATOR_STATE_PATH") ??
      path.join(path.dirname(manifestPath), "sepolia-price-operator.json"),
  );
}

export function readOperatorState(filename) {
  if (!existsSync(filename)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8"));
    if (!parsed || parsed.version !== 1) return { ...EMPTY_STATE };
    return {
      ...EMPTY_STATE,
      ...parsed,
      operationsSubmitted:
        Number.isSafeInteger(parsed.operationsSubmitted) &&
        parsed.operationsSubmitted >= 0
          ? parsed.operationsSubmitted
          : EMPTY_STATE.operationsSubmitted,
      failures:
        Number.isSafeInteger(parsed.failures) && parsed.failures >= 0
          ? parsed.failures
          : EMPTY_STATE.failures,
      unknownOutcomes:
        Number.isSafeInteger(parsed.unknownOutcomes) &&
        parsed.unknownOutcomes >= 0
          ? parsed.unknownOutcomes
          : EMPTY_STATE.unknownOutcomes,
    };
  } catch {
    return { ...EMPTY_STATE, lastError: "state_file_invalid" };
  }
}

export function saveOperatorState(filename, state) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, filename);
}

export function nextBackoffMs(failures, intervalMs) {
  const exponent = Math.min(Math.max(failures, 0), 5);
  return Math.min(intervalMs, 1_000 * 2 ** exponent);
}

export function chooseOperatorAction(current, state, maxRenewals) {
  if (!current.needed) return "idle";
  if (state.operationsSubmitted >= maxRenewals) return "budget_exhausted";
  return current.priceRefreshNeeded ? "price-refresh" : "capacity-renewal";
}

export function priceNeedsRefresh(now, observedAt, maxAge, marginSeconds) {
  return (
    observedAt > now ||
    now - observedAt >= Math.max(0, maxAge - Math.max(0, marginSeconds))
  );
}

function manifestAndClient() {
  const manifestPath = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_MANIFEST_PATH") ??
      "deploy/sepolia/sepolia-deployment.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.chain?.id !== CHAIN_ID)
    throw new Error("the Sepolia manifest does not use chain 11155111");
  const rpc = value("AURKA_SEPOLIA_RPC_URL") ?? value("SEPOLIA_RPC_URL");
  if (!rpc)
    throw new Error("AURKA_SEPOLIA_RPC_URL or SEPOLIA_RPC_URL is required");
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Ethereum Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  return {
    manifestPath,
    manifest,
    client: createPublicClient({ chain, transport: http(rpc) }),
  };
}

export async function readOperatorStatus(refreshMarginSeconds = 60) {
  const { manifestPath, manifest, client } = manifestAndClient();
  const oracleAbi = artifact(
    "contracts/out/MockPriceOracle.sol/MockPriceOracle.json",
  ).abi;
  const registryAbi = artifact(
    "contracts/out/AurkaPolicyRegistry.sol/AurkaPolicyRegistry.json",
  ).abi;
  const routerAbi = artifact(
    "contracts/out/AurkaSepoliaSwapVMRouter.sol/AurkaSepoliaSwapVMRouter.json",
  ).abi;
  const registry = address(
    manifest.contracts.policyRegistry.address,
    "policy registry",
  );
  const router = address(manifest.contracts.router.address, "router");
  const oracle = address(manifest.oracle.address, "oracle");
  const weth = address(manifest.tokens.weth.address, "WETH");
  const usdc = address(manifest.tokens.usdc.address, "USDC");
  const block = await client.getBlock();
  const blockNumber = block.number;
  const [policy, prices, capacity] = await Promise.all([
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getPolicy",
      args: [manifest.space.policyId],
      blockNumber,
    }),
    Promise.all(
      [usdc, weth].map((token) =>
        client.readContract({
          address: oracle,
          abi: oracleAbi,
          functionName: "getPrice",
          args: [token],
          blockNumber,
        }),
      ),
    ),
    client.readContract({
      address: router,
      abi: routerAbi,
      functionName: "capacityState",
      args: [manifest.space.spaceId, weth, usdc],
      blockNumber,
    }),
  ]);
  const now = Number(block.timestamp);
  const maxAge = Number(field(policy, "priceMaxAgeSeconds", 5));
  const priceRows = prices.map((price, index) => ({
    token: [usdc, weth][index],
    observedAt: Number(field(price, "observedAt", 2)),
  }));
  const stalePrices = priceRows.filter((price) =>
    priceNeedsRefresh(now, price.observedAt, maxAge, refreshMarginSeconds),
  );
  const baseline = BigInt(field(capacity, "capacityBaselineValue", 1));
  const consumed = BigInt(field(capacity, "consumedValue", 2));
  const capacityExhausted = baseline === 0n || consumed >= baseline;
  return {
    manifestPath,
    now,
    block: blockNumber.toString(),
    maxAge,
    prices: priceRows.map((price) => ({
      ...price,
      ageSeconds: now - price.observedAt,
    })),
    stalePrices,
    capacity: {
      baseline: baseline.toString(),
      consumed: consumed.toString(),
      exhausted: capacityExhausted,
    },
    priceRefreshNeeded: stalePrices.length > 0,
    refreshMarginSeconds,
    capacityRenewalNeeded: capacityExhausted,
    needed: stalePrices.length > 0 || capacityExhausted,
  };
}

function runAction(action, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "packages/services/scripts/sepolia-reactivate.mjs")],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          AURKA_SEPOLIA_REFRESH_PRICES:
            action === "price-refresh" ? "true" : "false",
          AURKA_SEPOLIA_RENEW_CAPACITY:
            action === "capacity-renewal" ? "true" : "false",
        },
      },
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error(
        `${action} timed out before its transaction outcome was known`,
      );
      error.code = "OPERATOR_ACTION_UNKNOWN";
      reject(error);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.code = "OPERATOR_ACTION_UNKNOWN";
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const error = new Error(
          `${action} exited with ${code ?? signal}; transaction outcome requires reconciliation`,
        );
        error.code = "OPERATOR_ACTION_UNKNOWN";
        reject(error);
      }
    });
  });
}

async function main() {
  const intervalMs = positiveInteger(
    "AURKA_SEPOLIA_OPERATOR_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
    60_000,
  );
  const maxRenewals = positiveInteger(
    "AURKA_SEPOLIA_OPERATOR_MAX_RENEWALS",
    DEFAULT_MAX_RENEWALS,
    10_000,
  );
  const childTimeoutMs = positiveInteger(
    "AURKA_SEPOLIA_OPERATOR_CHILD_TIMEOUT_MS",
    DEFAULT_CHILD_TIMEOUT_MS,
    900_000,
  );
  const manifestPath = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_MANIFEST_PATH") ??
      "deploy/sepolia/sepolia-deployment.json",
  );
  const filename = stateFile(manifestPath);
  let state = readOperatorState(filename);
  if (state.pendingAction) {
    state = {
      ...state,
      pendingAction: null,
      unknownOutcomes: state.unknownOutcomes + 1,
      failures: state.failures + 1,
      lastError: "operator_restarted_with_unknown_transaction",
    };
    saveOperatorState(filename, state);
  }
  console.log(
    JSON.stringify({
      level: "info",
      message: "sepolia.price_operator.started",
      intervalMs,
      maxRenewals,
      operationsSubmitted: state.operationsSubmitted,
      stateFile: filename,
    }),
  );
  for (;;) {
    const runAt = Math.floor(Date.now() / 1_000);
    state = { ...state, lastRunAt: runAt, nextAttemptAt: null };
    saveOperatorState(filename, state);
    try {
      const current = await readOperatorStatus(
        Math.ceil(intervalMs / 1_000) + 30,
      );
      const action = chooseOperatorAction(current, state, maxRenewals);
      if (action === "idle") {
        state = {
          ...state,
          failures: 0,
          budgetExhausted: false,
          lastSuccessAt: runAt,
          lastError: null,
        };
        saveOperatorState(filename, state);
        console.log(
          JSON.stringify({
            level: "info",
            message: "sepolia.price_operator.idle",
            ...current,
            operationsSubmitted: state.operationsSubmitted,
          }),
        );
      } else if (action === "budget_exhausted") {
        state = {
          ...state,
          budgetExhausted: true,
          lastError: "renewal_budget_exhausted",
        };
        saveOperatorState(filename, state);
        console.error(
          JSON.stringify({
            level: "error",
            message: "sepolia.price_operator.budget_exhausted",
            operationsSubmitted: state.operationsSubmitted,
            maxRenewals,
            priceRefreshNeeded: current.priceRefreshNeeded,
            capacityRenewalNeeded: current.capacityRenewalNeeded,
          }),
        );
        return;
      } else {
        state = {
          ...state,
          pendingAction: action,
          lastAttemptAt: runAt,
          // Reserve the bounded operation before spawning. A timeout or a
          // process restart must not replay a transaction with unknown outcome.
          operationsSubmitted: state.operationsSubmitted + 1,
          budgetExhausted: false,
        };
        saveOperatorState(filename, state);
        console.log(
          JSON.stringify({
            level: "info",
            message: "sepolia.price_operator.submitting",
            action,
            operation: state.operationsSubmitted,
            maxRenewals,
            ...current,
          }),
        );
        try {
          await runAction(action, childTimeoutMs);
          state = {
            ...state,
            pendingAction: null,
            failures: 0,
            lastSuccessAt: Math.floor(Date.now() / 1_000),
            lastError: null,
          };
          saveOperatorState(filename, state);
          console.log(
            JSON.stringify({
              level: "info",
              message: "sepolia.price_operator.succeeded",
              action,
              operationsSubmitted: state.operationsSubmitted,
            }),
          );
        } catch (error) {
          state = {
            ...state,
            pendingAction: null,
            failures: state.failures + 1,
            unknownOutcomes: state.unknownOutcomes + 1,
            lastError:
              error.code === "OPERATOR_ACTION_UNKNOWN"
                ? "transaction_outcome_unknown"
                : "operator_action_failed",
          };
          saveOperatorState(filename, state);
          console.error(
            JSON.stringify({
              level: "error",
              message: "sepolia.price_operator.failed",
              action,
              operationsSubmitted: state.operationsSubmitted,
              error: state.lastError,
            }),
          );
          if (error.code === "OPERATOR_ACTION_UNKNOWN") return;
        }
      }
    } catch {
      const failures = state.failures + 1;
      const backoffMs = nextBackoffMs(failures, intervalMs);
      state = {
        ...state,
        failures,
        lastError: "rpc_or_status_unavailable",
        nextAttemptAt: Math.ceil((Date.now() + backoffMs) / 1_000),
      };
      saveOperatorState(filename, state);
      console.error(
        JSON.stringify({
          level: "warn",
          message: "sepolia.price_operator.status_failed",
          retryInMs: backoffMs,
          error: "rpc_or_status_unavailable",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export { EMPTY_STATE };

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "sepolia.price_operator.fatal",
        error: error instanceof Error ? error.message : "operator_failed",
      }),
    );
    process.exitCode = 1;
  });
