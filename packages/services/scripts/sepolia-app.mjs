/* global AbortSignal, Buffer, URL, console, fetch, process, setTimeout */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  createPublicClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAbiItem,
} from "viem";

import {
  AurkaService,
  FixtureProposalSigner,
  ServiceDatabase,
  createApiServer,
  AuthService,
  TradingAgentService,
  DelegatedAgentWorker,
  createDelegatedSessionServiceFromEnv,
  closeApiServer,
  hashBytes,
  listenApiServer,
  OpenRouterAgent,
  openRouterAgentOptionsFromEnv,
  ServiceError,
} from "../dist/index.js";
import {
  PersistentEpochEventStore,
  RpcRequestCoordinator,
  RpcSyncingError,
  epochEventKey,
  rpcErrorCode,
} from "./sepolia-rpc-recovery.mjs";
import {
  LocalChainSnapshotProvider,
  positionForSnapshot,
} from "./chain-snapshot.mjs";
import { ForkSpaceLifecycle } from "./fork-space-lifecycle.mjs";
import { computeSettlementPriceSnapshotHash } from "@aurka/shared";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const CHAIN_ID = 11_155_111;
const DEFAULT_SPACE_POSITION_ID = "aurka-sepolia-space-v1";
const DEFAULT_API_PORT = 8797;
const INTERNAL_SERVICE_HOST = "127.0.0.1";
const ZERO_HASH = `0x${"00".repeat(32)}`;

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function hasOperatorCredentials() {
  return Boolean(
    value("AURKA_SEPOLIA_PRIVATE_KEY") ||
    value("DEPLOYER_PRIVATE_KEY") ||
    process.env["\nDEPLOYER_PRIVATE_KEY"]?.trim(),
  );
}

function startAutomaticMockPriceOperator(manifest, operatorStateFilename) {
  if (
    manifest.oracle?.mode !== "mock" ||
    value("AURKA_SEPOLIA_AUTO_PRICE_OPERATOR") !== "true" ||
    !hasOperatorCredentials()
  )
    return undefined;
  // Local hackathon mode keeps the labelled mock prices deterministic. The
  // quote path repairs the exact funded Space on demand; a shared background
  // price rotation would invalidate every other Space's capacity epoch.
  if (
    value("AURKA_SEPOLIA_OPERATOR_RUN_ONCE") !== "true" &&
    localMockAutoRecoveryEnabled(manifest)
  )
    return undefined;
  const operator = spawn(
    process.execPath,
    [path.join(ROOT, "packages/services/scripts/sepolia-price-operator.mjs")],
    {
      env: {
        ...process.env,
        AURKA_SEPOLIA_OPERATOR_RUN_ONCE:
          value("AURKA_SEPOLIA_OPERATOR_RUN_ONCE") ?? "false",
        AURKA_SEPOLIA_OPERATOR_MAX_RENEWALS:
          value("AURKA_SEPOLIA_OPERATOR_MAX_RENEWALS") ?? "10000",
        ...(operatorStateFilename
          ? { AURKA_SEPOLIA_OPERATOR_STATE_PATH: operatorStateFilename }
          : {}),
      },
      stdio: "inherit",
    },
  );
  operator.once("error", (error) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "sepolia.price_operator.start_failed",
        error: error instanceof Error ? error.message : "operator_failed",
      }),
    );
  });
  operator.once("exit", (code, signal) => {
    if (code !== 0)
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "sepolia.price_operator.stopped",
          code,
          signal,
        }),
      );
  });
  return operator;
}

function localMockAutoRecoveryEnabled(manifest) {
  const host =
    value("AURKA_SEPOLIA_GATEWAY_HOST") ?? process.env.HOST ?? "127.0.0.1";
  return (
    manifest.oracle?.mode === "mock" &&
    value("AURKA_SEPOLIA_AUTO_PRICE_OPERATOR") === "true" &&
    hasOperatorCredentials() &&
    ["127.0.0.1", "localhost", "::1"].includes(host)
  );
}

function address(result, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(result ?? ""))
    throw new Error(`${label} must be an EVM address`);
  return result;
}

function artifact(relativePath) {
  const filename = path.join(ROOT, relativePath);
  if (!existsSync(filename))
    throw new Error(
      `${relativePath} is missing; use the already-built repository artifacts before starting the app`,
    );
  return JSON.parse(readFileSync(filename, "utf8"));
}

function stringify(value_) {
  return JSON.stringify(value_, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function objectValue(value_, index, field) {
  return value_ && typeof value_ === "object" && field in value_
    ? value_[field]
    : value_?.[index];
}

function json(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(stringify(body));
}

function rpcCorsHeaders(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return {};
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return {};
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function proxyToApi(request, response, apiPort) {
  const target = `http://${INTERNAL_SERVICE_HOST}:${apiPort}${request.url}`;
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await requestBody(request);
  const headers = {};
  for (const name of [
    "content-type",
    "idempotency-key",
    "x-request-id",
    "cookie",
    "origin",
  ])
    if (request.headers[name]) headers[name] = request.headers[name];
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "cache-control": upstream.headers.get("cache-control") ?? "no-store",
    "content-type":
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    ...(upstream.headers.getSetCookie?.().length
      ? { "set-cookie": upstream.headers.getSetCookie() }
      : {}),
  });
  response.end(responseBody);
}

async function proxyRpcDirect(request, response, rpc) {
  const body = await requestBody(request);
  const upstream = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  response.writeHead(upstream.status, {
    "cache-control": "no-store",
    "content-type":
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    ...rpcCorsHeaders(request),
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function proxyRpc(request, response, coordinator) {
  const body = JSON.parse((await requestBody(request)).toString());
  if (!body || Array.isArray(body) || typeof body.method !== "string") {
    json(
      response,
      400,
      {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: {
          code: -32600,
          message: "A single JSON-RPC request is required",
        },
      },
      rpcCorsHeaders(request),
    );
    return;
  }
  try {
    const result = await coordinator.request({
      method: body.method,
      params: Array.isArray(body.params) ? body.params : [],
    });
    json(
      response,
      200,
      { jsonrpc: "2.0", id: body.id ?? null, result },
      rpcCorsHeaders(request),
    );
  } catch (error) {
    const statusCode =
      typeof error?.statusCode === "number" ? error.statusCode : 503;
    json(
      response,
      statusCode,
      {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: -32005,
          message:
            rpcErrorCode(error) === "RPC_COOLDOWN"
              ? "Sepolia RPC is temporarily rate limited; retry shortly"
              : "Sepolia RPC is temporarily unavailable",
        },
      },
      rpcCorsHeaders(request),
    );
  }
}

function epochEventAbi(routerAbi) {
  return getAbiItem({
    abi: routerAbi,
    name: "CapacityEpochActivated",
  });
}

async function main() {
  const rpc = value("AURKA_SEPOLIA_RPC_URL") ?? value("SEPOLIA_RPC_URL");
  if (!rpc)
    throw new Error(
      "AURKA_SEPOLIA_RPC_URL or SEPOLIA_RPC_URL is required for the Sepolia app",
    );
  const manifestPath = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_MANIFEST_PATH") ??
      "deploy/sepolia/sepolia-deployment.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.chain?.id !== CHAIN_ID)
    throw new Error("the Sepolia manifest does not use chain 11155111");
  if (!manifest.space?.createTransactionHash)
    throw new Error("the manifest has no created Sepolia Space");

  const chain = defineChain({
    id: CHAIN_ID,
    name: "Ethereum Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  let invalidateSnapshotCaches = () => {};
  const rpcCoordinator = new RpcRequestCoordinator({
    url: rpc,
    log: (entry) => console.warn(JSON.stringify(entry)),
    onWrite: () => invalidateSnapshotCaches(),
  });
  const publicClient = createPublicClient({
    chain,
    transport: custom(rpcCoordinator, { retryCount: 0 }),
  });

  const policyRegistryArtifact = artifact(
    "contracts/out/AurkaPolicyRegistry.sol/AurkaPolicyRegistry.json",
  );
  const aquaArtifact = artifact("contracts/out-upstream/Aqua.sol/Aqua.json");
  const oracleArtifact = artifact(
    "contracts/out/MockPriceOracle.sol/MockPriceOracle.json",
  );
  const routerArtifact = artifact(
    "contracts/out/AurkaSepoliaSwapVMRouter.sol/AurkaSepoliaSwapVMRouter.json",
  );
  const erc20Artifact = artifact("contracts/out/MockERC20.sol/MockERC20.json");
  const vaultFactoryArtifact = artifact(
    "contracts/out/AurkaSpaceVaultFactory.sol/AurkaSpaceVaultFactory.json",
  );
  const vaultArtifact = artifact(
    "contracts/out/AurkaSpaceVault.sol/AurkaSpaceVault.json",
  );
  const router = address(manifest.contracts.router.address, "router");
  const usdc = address(manifest.tokens.usdc.address, "USDC");
  const weth = address(manifest.tokens.weth.address, "WETH");
  const registry = address(
    manifest.contracts.policyRegistry.address,
    "policy registry",
  );
  const aqua = address(manifest.contracts.aqua.address, "Aqua");
  const vaultFactory = address(
    manifest.contracts.vaultFactory.address,
    "vault factory",
  );
  const swapVMGuard = address(
    manifest.oneInch.executionHelpers.swapVMGuard,
    "SwapVM guard",
  );
  const oracle = address(manifest.oracle.address, "oracle");
  const localMockAutoRecovery = localMockAutoRecoveryEnabled(manifest);
  const positionId =
    value("AURKA_SEPOLIA_SPACE_POSITION_ID") ?? DEFAULT_SPACE_POSITION_ID;
  const positionIdHash = manifest.space.spaceId;
  if (hashBytes(positionId).toLowerCase() !== positionIdHash.toLowerCase())
    throw new Error(
      "AURKA_SEPOLIA_SPACE_POSITION_ID does not hash to the deployed Space ID",
    );

  const contracts = {
    policyRegistry: { address: registry, abi: policyRegistryArtifact.abi },
    aqua: { address: aqua, abi: aquaArtifact.abi },
    oracle: { address: oracle, abi: oracleArtifact.abi },
    router: { address: router, abi: routerArtifact.abi },
    vaultFactory: { address: vaultFactory, abi: vaultFactoryArtifact.abi },
    vaultAbi: vaultArtifact.abi,
    erc20Abi: erc20Artifact.abi,
  };
  const transaction = (contract, functionName, args) => ({
    to: contract.address,
    data: encodeFunctionData({ abi: contract.abi, functionName, args }),
    value: "0x0",
  });
  const solver = new FixtureProposalSigner();
  const space = {
    positionId,
    policyId: manifest.space.policyId,
    positionIdHash,
    strategyHash: manifest.space.strategyHash,
  };
  const runtimeSpacesPath = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_SPACES_PATH") ?? ".aurka/sepolia-spaces.json",
  );
  const lifecycleStatePath = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_LIFECYCLE_PATH") ??
      ".aurka/sepolia-space-lifecycle.json",
  );
  if (runtimeSpacesPath !== ":memory:")
    mkdirSync(path.dirname(runtimeSpacesPath), {
      recursive: true,
      mode: 0o700,
    });
  const savedRuntime =
    runtimeSpacesPath !== ":memory:" && existsSync(runtimeSpacesPath)
      ? JSON.parse(readFileSync(runtimeSpacesPath, "utf8"))
      : {};
  const spaceDefinitions = [
    space,
    ...(Array.isArray(savedRuntime.spaces) ? savedRuntime.spaces : []).filter(
      (candidate) => candidate?.positionId !== positionId,
    ),
  ];
  const databaseFilename =
    value("AURKA_SEPOLIA_DATABASE_URL") ?? ".aurka/sepolia-service.sqlite";
  const operatorStateFilename = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_OPERATOR_STATE_PATH") ??
      (databaseFilename === ":memory:"
        ? ".aurka/sepolia-price-operator.json"
        : path.join(
            path.dirname(path.resolve(ROOT, databaseFilename)),
            "sepolia-price-operator.json",
          )),
  );
  const epochEventsFilename =
    value("AURKA_SEPOLIA_EPOCH_EVENTS_PATH") ??
    (databaseFilename === ":memory:"
      ? path.resolve(ROOT, ".aurka/sepolia-epoch-events.json")
      : path.join(
          path.dirname(path.resolve(ROOT, databaseFilename)),
          "sepolia-epoch-events.json",
        ));
  const eventSearchStarts = new Map([
    [
      positionIdHash.toLowerCase(),
      BigInt(
        manifest.acceptance?.swapVMTrade?.reactivateBlockNumber ??
          manifest.space.createBlockNumber ??
          0,
      ),
    ],
  ]);
  const activationHints = new Map();
  if (existsSync(lifecycleStatePath)) {
    try {
      const savedLifecycle = JSON.parse(
        readFileSync(lifecycleStatePath, "utf8"),
      );
      for (const plan of Object.values(savedLifecycle.plans ?? {})) {
        const definition = plan?.definition;
        const receiptBlocks = (plan?.receipts ?? [])
          .map((receipt) => receipt?.blockNumber)
          .filter((block) => typeof block === "string");
        if (definition?.positionIdHash && receiptBlocks.length > 0)
          eventSearchStarts.set(
            definition.positionIdHash.toLowerCase(),
            BigInt(receiptBlocks[0]),
          );
        if (definition?.positionIdHash) {
          const hints = (plan?.receipts ?? [])
            .filter(
              (receipt) =>
                typeof receipt?.hash === "string" &&
                /^0x[0-9a-fA-F]{64}$/.test(receipt.hash),
            )
            .map((receipt) => ({
              hash: receipt.hash,
              blockNumber:
                typeof receipt.blockNumber === "string"
                  ? BigInt(receipt.blockNumber)
                  : undefined,
            }));
          if (hints.length > 0)
            activationHints.set(definition.positionIdHash.toLowerCase(), hints);
        }
      }
    } catch {
      // A missing or stale lifecycle cache is recoverable through event lookup.
    }
  }
  const runtimeManifest = {
    chainId: CHAIN_ID,
    spaceCreationMode: "single-transaction",
    vaultFactoryVersion: 2,
    executionEngine: "AURKA_UPSTREAM_LIMIT_SWAP_V1",
    policyRegistry: registry,
    vaultFactory,
    aqua,
    oracle,
    router,
    usdc,
    weth,
    swapVMGuard,
    protocolRecipient: address(manifest.deployer.address, "deployer"),
  };
  const epochEvent = epochEventAbi(routerArtifact.abi);
  const epochEventStore = new PersistentEpochEventStore({
    filename: epochEventsFilename,
    chainId: CHAIN_ID,
    router,
  });
  const cachedEpochEvents = new Map();
  const pendingEpochEvents = new Map();
  const canonicalBlockChecks = new Map();
  const eventMatches = (event, spacePositionIdHash, capacityEpochId) =>
    event?.eventName === "CapacityEpochActivated" &&
    event?.address?.toLowerCase() === router.toLowerCase() &&
    typeof event.blockNumber === "bigint" &&
    /^0x[0-9a-fA-F]{64}$/.test(event.blockHash ?? "") &&
    /^0x[0-9a-fA-F]{64}$/.test(event.transactionHash ?? "") &&
    String(event.args?.positionIdHash ?? "").toLowerCase() ===
      spacePositionIdHash.toLowerCase() &&
    String(event.args?.capacityEpochId ?? "").toLowerCase() ===
      String(capacityEpochId).toLowerCase();
  const verifyCanonicalEvent = async (event) => {
    const checkKey = `${event.blockNumber}:${event.blockHash}`.toLowerCase();
    let check = canonicalBlockChecks.get(checkKey);
    if (!check) {
      check = publicClient
        .getBlock({ blockNumber: event.blockNumber })
        .then(
          (block) =>
            block.hash?.toLowerCase() === event.blockHash.toLowerCase(),
        );
      canonicalBlockChecks.set(checkKey, check);
    }
    return check;
  };
  const rememberEpochEvent = async (
    cacheKey,
    spacePositionIdHash,
    capacityEpochId,
    event,
  ) => {
    if (!eventMatches(event, spacePositionIdHash, capacityEpochId))
      return false;
    if (!(await verifyCanonicalEvent(event))) {
      epochEventStore.delete(cacheKey);
      cachedEpochEvents.delete(cacheKey);
      return false;
    }
    epochEventStore.set(
      cacheKey,
      {
        chainId: CHAIN_ID,
        router,
        positionIdHash: spacePositionIdHash,
        capacityEpochId: String(capacityEpochId),
      },
      event,
    );
    cachedEpochEvents.set(cacheKey, event);
    eventSearchStarts.set(spacePositionIdHash.toLowerCase(), event.blockNumber);
    return true;
  };
  const receiptEvent = async (hash) => {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== router.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: routerArtifact.abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== "CapacityEpochActivated") continue;
        return {
          ...log,
          ...decoded,
          address: router,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex,
        };
      } catch {
        // The router address can have unrelated logs; ignore undecodable ones.
      }
    }
    return undefined;
  };
  const readEpochEvent = async (
    spacePositionIdHash,
    capacityEpochId,
    snapshotBlock,
  ) => {
    const cacheKey = epochEventKey(
      CHAIN_ID,
      router,
      spacePositionIdHash,
      capacityEpochId,
    );
    if (cachedEpochEvents.has(cacheKey)) return cachedEpochEvents.get(cacheKey);
    const persisted = epochEventStore.get(cacheKey);
    if (
      persisted &&
      eventMatches(persisted, spacePositionIdHash, capacityEpochId)
    ) {
      if (await verifyCanonicalEvent(persisted)) {
        cachedEpochEvents.set(cacheKey, persisted);
        return persisted;
      }
      epochEventStore.delete(cacheKey);
    } else if (persisted) {
      epochEventStore.delete(cacheKey);
    }
    const pending = pendingEpochEvents.get(cacheKey);
    if (pending) return pending;
    const lookup = (async () => {
      const latest = snapshotBlock ?? (await publicClient.getBlockNumber());
      const first =
        eventSearchStarts.get(spacePositionIdHash.toLowerCase()) ??
        BigInt(manifest.space.createBlockNumber ?? 0);
      const hints =
        activationHints.get(spacePositionIdHash.toLowerCase()) ?? [];
      for (const hint of hints) {
        if (hint.blockNumber !== undefined && hint.blockNumber > latest)
          continue;
        let hintedEvent;
        try {
          hintedEvent = await receiptEvent(hint.hash);
        } catch (error) {
          if (
            error?.code === "RPC_RATE_LIMITED" ||
            error?.code === "RPC_COOLDOWN" ||
            /rate.?limit|cooling down|429/i.test(error?.message ?? "")
          )
            throw error;
          if (
            /not found|unknown transaction|not processed|missing/i.test(
              error?.message ?? "",
            )
          )
            continue;
          throw error;
        }
        if (
          hintedEvent &&
          (await rememberEpochEvent(
            cacheKey,
            spacePositionIdHash,
            capacityEpochId,
            hintedEvent,
          ))
        )
          return hintedEvent;
      }

      const recentFrom = latest > 1_000n ? latest - 1_000n : 0n;
      const recentStart = recentFrom < first ? first : recentFrom;
      const savedProgress = epochEventStore.getProgress(cacheKey);
      const progress =
        savedProgress?.chainId === CHAIN_ID &&
        savedProgress.router?.toLowerCase() === router.toLowerCase() &&
        savedProgress.positionIdHash?.toLowerCase() ===
          spacePositionIdHash.toLowerCase() &&
        savedProgress.capacityEpochId?.toLowerCase() ===
          String(capacityEpochId).toLowerCase()
          ? { ...savedProgress }
          : {
              chainId: CHAIN_ID,
              router,
              positionIdHash: spacePositionIdHash,
              capacityEpochId: String(capacityEpochId),
              phase: "recent",
              nextTo: latest,
            };
      if (progress.phase === "recent" && latest > BigInt(progress.head ?? 0))
        progress.nextTo = latest;
      progress.head = latest.toString();
      let requests = 0;
      const inspectLogs = async (from, to) => {
        const logs = await publicClient.getLogs({
          address: router,
          event: epochEvent,
          args: { positionIdHash: spacePositionIdHash },
          fromBlock: from,
          toBlock: to,
        });
        requests += 1;
        const event = logs
          .filter(
            (log) =>
              String(log.args?.capacityEpochId ?? "").toLowerCase() ===
              String(capacityEpochId).toLowerCase(),
          )
          .at(-1);
        if (
          event &&
          (await rememberEpochEvent(
            cacheKey,
            spacePositionIdHash,
            capacityEpochId,
            event,
          ))
        )
          return event;
        return undefined;
      };

      while (requests < 10 && progress.phase === "recent") {
        const nextTo = BigInt(progress.nextTo ?? latest.toString());
        if (nextTo < recentStart) {
          progress.phase = "forward";
          progress.nextFrom = first.toString();
          continue;
        }
        const from = nextTo - 9n < recentStart ? recentStart : nextTo - 9n;
        const event = await inspectLogs(from, nextTo);
        if (event) return event;
        progress.nextTo = from > recentStart ? (from - 1n).toString() : "-1";
        if (from === recentStart) {
          progress.phase = "forward";
          progress.nextFrom = first.toString();
        }
        epochEventStore.setProgress(cacheKey, progress);
      }
      while (requests < 10 && progress.phase === "forward") {
        const nextFrom = BigInt(progress.nextFrom ?? first.toString());
        if (nextFrom > latest) break;
        const to = nextFrom + 9n < latest ? nextFrom + 9n : latest;
        const event = await inspectLogs(nextFrom, to);
        if (event) return event;
        progress.nextFrom = (to + 1n).toString();
        epochEventStore.setProgress(cacheKey, progress);
      }
      epochEventStore.setProgress(cacheKey, progress);
      throw new RpcSyncingError(
        "Sepolia chain data is synchronizing; the active capacity event is not cached yet",
        rpcCoordinator.nextRetryAtSeconds ??
          Math.ceil((Date.now() + 2_000) / 1_000),
      );
    })();
    pendingEpochEvents.set(cacheKey, lookup);
    try {
      return await lookup;
    } finally {
      pendingEpochEvents.delete(cacheKey);
    }
  };

  const tokenMetadataCache = new Map();
  const chainInitialization = {
    state: "syncing",
    reason: "snapshot_syncing",
    nextRetryAt: undefined,
    inFlight: undefined,
  };
  class SepoliaSnapshotProvider extends LocalChainSnapshotProvider {
    needsCapacityPriceSync(snapshot) {
      return (
        snapshot.capacityEpochId.toLowerCase() !== ZERO_HASH &&
        snapshot.capacityEpoch.priceSnapshot.toLowerCase() !==
          computeSettlementPriceSnapshotHash(
            snapshot.priceProtection,
          ).toLowerCase()
      );
    }

    async startCapacityPriceRepair() {
      if (this.epochRepair) return this.epochRepair;
      this.epochRepairAfter = Date.now() + 60_000;
      this.epochRepair = new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.join(
              ROOT,
              "packages/services/scripts/sepolia-reactivate.mjs",
            ),
          ],
          {
            env: {
              ...process.env,
              AURKA_SEPOLIA_SPACE_ID: this.space.positionIdHash,
              AURKA_SEPOLIA_REFRESH_PRICES: "false",
              AURKA_SEPOLIA_RENEW_CAPACITY: "true",
              AURKA_SEPOLIA_PENDING_CAPACITY_PATH:
                this.pendingCapacityPath,
              AURKA_SEPOLIA_RETURN_AFTER_SUBMIT: "true",
            },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 90_000,
          },
        );
        let output = "";
        for (const stream of [child.stdout, child.stderr])
          stream?.on("data", (chunk) => {
            output += chunk.toString();
            process.stderr.write(chunk);
          });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(
                new ServiceError(
                  /immutable Space strategy does not match/i.test(output)
                    ? "STRATEGY_MISMATCH"
                    : "CAPACITY_PRICE_SYNC_REQUIRED",
                  /immutable Space strategy does not match/i.test(output)
                    ? "This Space uses an incompatible SwapVM strategy and cannot trade; use an owner-controlled replacement Space"
                    : "Automatic capacity renewal did not complete",
                  409,
                ),
              ),
        );
      }).finally(() => {
        this.cachedSnapshot = undefined;
        this.cachedAt = 0;
        this.epochRepair = undefined;
      });
      return this.epochRepair;
    }

    readPendingCapacityRepair() {
      if (!existsSync(this.pendingCapacityPath)) return undefined;
      try {
        const pending = JSON.parse(
          readFileSync(this.pendingCapacityPath, "utf8"),
        );
        if (
          pending?.version !== 1 ||
          pending.positionId !== this.space.positionIdHash ||
          !/^0x[0-9a-fA-F]{64}$/.test(pending.transactionHash ?? "") ||
          !/^0x[0-9a-fA-F]{64}$/.test(pending.newCapacityEpochId ?? "") ||
          !/^0x[0-9a-fA-F]{64}$/.test(pending.balanceSnapshot ?? "") ||
          !/^0x[0-9a-fA-F]{64}$/.test(pending.priceSnapshot ?? "") ||
          !/^0x[0-9a-fA-F]{64}$/.test(
            pending.portfolioPriceSnapshot ?? "",
          )
        )
          return undefined;
        return pending;
      } catch {
        return undefined;
      }
    }

    applyPendingCapacityRepair(snapshot) {
      const pending = this.readPendingCapacityRepair();
      if (!pending) return snapshot;
      const activeId = snapshot.capacityEpochId.toLowerCase();
      if (activeId === pending.newCapacityEpochId.toLowerCase()) {
        try {
          unlinkSync(this.pendingCapacityPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        return snapshot;
      }
      const currentPriceSnapshot = computeSettlementPriceSnapshotHash(
        snapshot.priceProtection,
      );
      if (
        currentPriceSnapshot.toLowerCase() !==
        pending.priceSnapshot.toLowerCase()
      )
        return snapshot;
      snapshot.capacityEpochId = pending.newCapacityEpochId;
      snapshot.capacityEpoch = {
        ...snapshot.capacityEpoch,
        capacityEpochId: pending.newCapacityEpochId,
        balanceSnapshot: pending.balanceSnapshot,
        priceSnapshot: pending.priceSnapshot,
        portfolioPriceSnapshot: pending.portfolioPriceSnapshot,
        capacityBaselineValue: BigInt(pending.capacityBaseline),
        consumedBefore: 0n,
      };
      snapshot.balancesHash = pending.balanceSnapshot;
      return snapshot;
    }

    async reconcilePendingCapacityRepair() {
      const pending = this.readPendingCapacityRepair();
      if (!pending) return;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: pending.transactionHash,
        pollingInterval: 2_000,
        timeout: 80_000,
      });
      if (receipt.status !== "success")
        throw new ServiceError(
          "CAPACITY_PRICE_SYNC_REQUIRED",
          "Automatic capacity renewal reverted on Sepolia",
          409,
        );
      try {
        unlinkSync(this.pendingCapacityPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.invalidateSnapshot();
    }

    async ensureCapacityPriceSync(input) {
      // Local demo repair only, before building a new unsigned intent. Never
      // grant a public quote endpoint authority over arbitrary owners' Spaces.
      if (
        input.positionId === this.space.positionId &&
        localMockAutoRecovery
      ) {
        if (this.strategyMismatch)
          throw new ServiceError(
            "STRATEGY_MISMATCH",
            "This Space uses an incompatible SwapVM strategy and cannot trade; use an owner-controlled replacement Space",
            409,
          );
        let lastError;
        // A submitted transaction can be confirmed just after the child
        // exits, or another request can win the activation race. Reconcile
        // the authoritative state before treating the renewal as failed.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          this.invalidateSnapshot();
          const snapshot = await this.currentSnapshot();
          if (!this.needsCapacityPriceSync(snapshot)) return;

          let repairCompleted = false;
          try {
            if (!this.epochRepair && Date.now() >= (this.epochRepairAfter ?? 0))
              await this.startCapacityPriceRepair();
            else if (this.epochRepair) await this.epochRepair;
            repairCompleted = true;
          } catch (error) {
            lastError = error;
            if (error?.code === "STRATEGY_MISMATCH") {
              this.strategyMismatch = true;
              throw error;
            }
            // Do not leave the request behind a stale cooldown after a
            // timeout or a reverted replacement transaction.
            this.epochRepairAfter = 0;
          }

          this.invalidateSnapshot();
          if (repairCompleted) this.epochRepairAfter = 0;
          let reconciled;
          try {
            reconciled = await this.currentSnapshot();
          } catch (error) {
            lastError = error;
            continue;
          }
          if (!this.needsCapacityPriceSync(reconciled)) return;
        }

        throw (
          lastError ??
          new ServiceError(
            "CAPACITY_PRICE_SYNC_REQUIRED",
            "Automatic capacity renewal did not complete",
            409,
          )
        );
      }
    }

    async prepareIntent(input) {
      await this.ensureCapacityPriceSync(input);
      this.pendingSnapshotReadsToSkip = 2;
      return super.prepareIntent(input);
    }

    async prepareTokenIntent(input) {
      // The UI uses the token-amount endpoint. Keep the same automatic repair
      // on that path instead of only repairing value-based preparations.
      await this.ensureCapacityPriceSync(input);
      this.pendingSnapshotReadsToSkip = 2;
      return super.prepareTokenIntent(input);
    }

    async getSnapshot(intent) {
      const pending = this.readPendingCapacityRepair();
      if (pending && this.pendingSnapshotReadsToSkip > 0)
        this.pendingSnapshotReadsToSkip -= 1;
      // Local mock mode deliberately does not block quote/solve requests on
      // receipt polling. The pending epoch is only a local bridge while the
      // already-submitted activation is mined; live deployments remain strict
      // because they never create this local pending state.
      const snapshot = await super.getSnapshot(intent);
      if (this.needsCapacityPriceSync(snapshot)) {
        throw new ServiceError(
          "CAPACITY_PRICE_SYNC_REQUIRED",
          "The Space capacity epoch does not match the current oracle observations; renew its epoch before requesting a new quote",
          409,
        );
      }
      return snapshot;
    }

    constructor(definition) {
      super(publicClient, contracts, solver.address, definition, CHAIN_ID, {
        getBlock: () => publicClient.getBlock(),
        tokenMetadataCache,
      });
      this.cachedSnapshot = undefined;
      this.cachedAt = 0;
      this.snapshotInFlight = undefined;
      this.pendingCapacityPath = path.resolve(
        ROOT,
        ".aurka",
        `sepolia-capacity-${definition.positionIdHash.toLowerCase()}.json`,
      );
      this.pendingSnapshotReadsToSkip = 0;
      this.strategyMismatch = false;
    }

    async currentSnapshot() {
      const cacheAge = Date.now() - this.cachedAt;
      if (this.cachedSnapshot && cacheAge < 1_000) return this.cachedSnapshot;
      if (this.snapshotInFlight) return this.snapshotInFlight;

      const request = (async () => {
        const snapshot = await super.currentSnapshot();
        const active = await publicClient.readContract({
          ...contracts.router,
          functionName: "capacityState",
          args: [this.space.positionIdHash, weth, usdc],
          blockNumber: snapshot.snapshotBlock,
        });
        const activeId = objectValue(active, 0, "capacityEpochId");
        const consumed = BigInt(objectValue(active, 2, "consumedValue"));
        if (String(activeId).toLowerCase() === ZERO_HASH) {
          // A recovered or never-authorized Space has no epoch event to
          // index. Preserve its live portfolio/strategy evidence so the
          // service can classify an immutable encoding mismatch instead of
          // collapsing it into a generic snapshot-unavailable error.
          snapshot.capacityEpochId = activeId;
          snapshot.capacityEpoch = {
            ...snapshot.capacityEpoch,
            capacityEpochId: activeId,
            capacityBaselineValue: 0n,
            consumedBefore: consumed,
            chainId: BigInt(CHAIN_ID),
            verifyingContract: router,
          };
          snapshot.swapVMGuard = swapVMGuard;
          return this.applyPendingCapacityRepair(snapshot);
        }
        const event = await readEpochEvent(
          this.space.positionIdHash,
          activeId,
          snapshot.snapshotBlock,
        );
        const args = event.args;
        if (!args) throw new Error("capacity epoch event has no arguments");
        if (activeId.toLowerCase() !== snapshot.capacityEpochId.toLowerCase())
          snapshot.capacityEpochId = activeId;
        snapshot.capacityEpoch = {
          ...snapshot.capacityEpoch,
          capacityEpochId: activeId,
          balanceSnapshot: args.balanceSnapshot,
          priceSnapshot: args.priceSnapshot,
          portfolioPriceSnapshot: args.portfolioPriceSnapshot,
          policyNonce: args.policyNonce,
          riskCertificateHash: args.riskCertificateHash,
          aquaStrategyHash: args.aquaStrategyHash,
          capacityBaselineValue: args.capacityBaselineValue,
          consumedBefore: consumed,
          chainId: BigInt(CHAIN_ID),
          verifyingContract: router,
        };
        snapshot.swapVMGuard = swapVMGuard;
        // The active epoch commits to the balances at activation, not the
        // mutable current Aqua balances after a previous trade.
        snapshot.balancesHash = args.balanceSnapshot;
        return this.applyPendingCapacityRepair(snapshot);
      })();
      this.snapshotInFlight = request;
      try {
        const snapshot = await request;
        this.cachedSnapshot = snapshot;
        this.cachedAt = Date.now();
        return snapshot;
      } catch (error) {
        if (process.env.AURKA_AGENT_TEST_MODE?.trim().toLowerCase() === "true")
          console.error("[AURKA sepolia test] snapshot.failed", {
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          });
        throw error;
      } finally {
        if (this.snapshotInFlight === request)
          this.snapshotInFlight = undefined;
      }
    }

    invalidateSnapshot() {
      this.cachedSnapshot = undefined;
      this.cachedAt = 0;
    }
  }

  const providers = new Map(
    spaceDefinitions.map((definition) => [
      definition.positionId,
      new SepoliaSnapshotProvider(definition),
    ]),
  );
  invalidateSnapshotCaches = () => {
    for (const provider of providers.values()) provider.invalidateSnapshot();
  };
  const selectedProvider = (spaceId) => {
    const selected = providers.get(spaceId);
    if (!selected)
      throw new Error(`Space ${spaceId} is not registered in the Sepolia app`);
    return selected;
  };
  const requireFreshChainState = () => {
    if (chainInitialization.state !== "ready")
      throw new RpcSyncingError(
        "Sepolia chain data is synchronizing; trading is temporarily paused",
        chainInitialization.nextRetryAt,
      );
  };
  const provider = {
    getPositionSnapshot: (spaceId) => {
      requireFreshChainState();
      return selectedProvider(spaceId).getPositionSnapshot(spaceId);
    },
    prepareIntent: (input) => {
      requireFreshChainState();
      return selectedProvider(input.positionId).prepareIntent(input);
    },
    prepareTokenIntent: (input) => {
      requireFreshChainState();
      return selectedProvider(input.positionId).prepareTokenIntent(input);
    },
    getSnapshot: (intent) => {
      requireFreshChainState();
      const selected = [...providers.values()].find(
        (candidate) =>
          candidate.space.positionIdHash.toLowerCase() ===
          intent.positionIdHash.toLowerCase(),
      );
      if (!selected)
        throw new Error(
          "The reviewed intent does not belong to a Sepolia Space",
        );
      return selected.getSnapshot(intent);
    },
  };
  if (databaseFilename !== ":memory:")
    mkdirSync(path.dirname(path.resolve(ROOT, databaseFilename)), {
      recursive: true,
      mode: 0o700,
    });
  const database = new ServiceDatabase({ filename: databaseFilename });
  const emptyRpcReadiness = (reason, nextRetryAt) => ({
    state: "unhealthy",
    observedAt: Math.floor(Date.now() / 1_000),
    reason,
    chainId: null,
    expectedChainId: CHAIN_ID,
    latestBlock: null,
    canonicalBlock: null,
    canonicalBlockHash: null,
    finalizedBlock: null,
    finalizedBlockHash: null,
    finalizedAt: null,
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
  });
  const parseRpcHex = (value_, label) => {
    if (typeof value_ !== "string" || !/^0x[0-9a-fA-F]+$/.test(value_))
      throw new Error(`Malformed ${label}`);
    return BigInt(value_);
  };
  const probeSepoliaRpc = async () => {
    try {
      const chain = Number(
        parseRpcHex(
          await rpcCoordinator.request({ method: "eth_chainId", params: [] }),
          "chain ID",
        ),
      );
      if (!Number.isSafeInteger(chain) || chain !== CHAIN_ID)
        return emptyRpcReadiness("chain_mismatch");
      const latestBlockValue = await rpcCoordinator.request({
        method: "eth_blockNumber",
        params: [],
      });
      const latest = await rpcCoordinator.request({
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      });
      const finalized = await rpcCoordinator.request({
        method: "eth_getBlockByNumber",
        params: ["finalized", false],
      });
      if (!latest || typeof latest !== "object")
        return emptyRpcReadiness("latest_head_unavailable");
      if (!finalized || typeof finalized !== "object")
        return emptyRpcReadiness("finalized_head_unavailable");
      const latestNumber = parseRpcHex(latest.number, "latest block number");
      const finalizedNumber = parseRpcHex(
        finalized.number,
        "finalized block number",
      );
      const latestBlock = parseRpcHex(latestBlockValue, "latest block");
      if (
        typeof latest.hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(latest.hash) ||
        typeof finalized.hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(finalized.hash) ||
        finalizedNumber > latestNumber ||
        latestNumber < latestBlock
      )
        return emptyRpcReadiness("invalid_canonical_head");
      const finalizedAt = Number(
        parseRpcHex(finalized.timestamp, "finalized timestamp"),
      );
      if (finalizedAt > Math.floor(Date.now() / 1_000))
        return emptyRpcReadiness("finalized_head_from_future");
      const state =
        chainInitialization.state === "ready" ? "healthy" : "unhealthy";
      return {
        state,
        observedAt: Math.floor(Date.now() / 1_000),
        reason: state === "healthy" ? null : chainInitialization.reason,
        chainId: chain,
        expectedChainId: CHAIN_ID,
        latestBlock: latestNumber.toString(),
        canonicalBlock: latestNumber.toString(),
        canonicalBlockHash: latest.hash,
        finalizedBlock: finalizedNumber.toString(),
        finalizedBlockHash: finalized.hash,
        finalizedAt,
        ...(chainInitialization.nextRetryAt === undefined
          ? {}
          : { nextRetryAt: chainInitialization.nextRetryAt }),
      };
    } catch (error) {
      const code = rpcErrorCode(error);
      return emptyRpcReadiness(
        code === "RPC_RATE_LIMITED"
          ? "rpc_rate_limited"
          : code === "RPC_COOLDOWN"
            ? "rpc_cooldown"
            : code === "RPC_SYNCING"
              ? "snapshot_syncing"
              : "rpc_unavailable",
        rpcCoordinator.nextRetryAtSeconds ?? chainInitialization.nextRetryAt,
      );
    }
  };
  const probePriceOperator = async () => {
    try {
      if (!existsSync(operatorStateFilename))
        return {
          state: "unknown",
          observedAt: null,
          reason: "operator_not_started",
          sources: [],
        };
      const state = JSON.parse(readFileSync(operatorStateFilename, "utf8"));
      const now = Math.floor(Date.now() / 1_000);
      const lastSuccessAt =
        typeof state.lastSuccessAt === "number" ? state.lastSuccessAt : null;
      const runAt =
        typeof state.lastRunAt === "number" ? state.lastRunAt : null;
      const nextAttemptAt =
        typeof state.nextAttemptAt === "number" ? state.nextAttemptAt : null;
      const failures =
        typeof state.failures === "number" && state.failures >= 0
          ? state.failures
          : 0;
      const unhealthyReason = state.budgetExhausted
        ? "budget_exhausted"
        : state.lastError === "transaction_outcome_unknown"
          ? "transaction_outcome_unknown"
          : state.pendingAction
            ? "transaction_in_flight"
            : lastSuccessAt === null
              ? "operator_not_ready"
              : now - lastSuccessAt > 300
                ? "operator_stale"
                : null;
      return {
        state: unhealthyReason ? "unhealthy" : "healthy",
        observedAt: runAt ?? lastSuccessAt,
        reason: unhealthyReason,
        sources: [
          {
            sourceId: "sepolia-price-operator",
            lastObservedAt: lastSuccessAt,
            indexedBlock: null,
            lagBlocks: null,
            state: unhealthyReason ? "unhealthy" : "healthy",
            observedAt: lastSuccessAt,
            reason: unhealthyReason,
            lastSuccessAt,
            nextAttemptAt,
            failures,
            budgetExhausted: state.budgetExhausted === true,
          },
        ],
      };
    } catch {
      return {
        state: "unhealthy",
        observedAt: Math.floor(Date.now() / 1_000),
        reason: "operator_state_unavailable",
        sources: [],
      };
    }
  };
  const priceOperatorReady = () => {
    try {
      const state = JSON.parse(readFileSync(operatorStateFilename, "utf8"));
      const lastSuccessAt =
        typeof state.lastSuccessAt === "number" ? state.lastSuccessAt : null;
      return (
        lastSuccessAt !== null &&
        Math.floor(Date.now() / 1_000) - lastSuccessAt <= 300 &&
        state.budgetExhausted !== true &&
        !state.pendingAction &&
        state.lastError !== "transaction_outcome_unknown"
      );
    } catch {
      return false;
    }
  };
  const service = new AurkaService({
    database,
    provider,
    signer: solver,
    chainId: CHAIN_ID,
    settlementContract: router,
    indexConfirmations: 0,
    rpcFinalityMaxAgeSeconds: Number(
      value("AURKA_RPC_FINALITY_MAX_AGE_SECONDS") ?? "1800",
    ),
    readiness: {
      // The Sepolia gateway has no Graph indexer or risk-runtime process. The
      // API's readiness contract should therefore verify the database and
      // canonical RPC without reporting unrelated disabled subsystems as
      // deployment failures.
      requirements: {
        rpc: true,
        indexer: false,
        // Local mock prices are repaired synchronously for the exact Space
        // being quoted. A failed background operator for another Space must
        // not make this local demo globally unavailable.
        sources: !localMockAutoRecovery,
        worker: false,
        signer: false,
        registry: false,
      },
      probes: {
        rpc: probeSepoliaRpc,
        // There is intentionally no indexer in this deployment. Supplying a
        // disabled probe prevents the generic live-service default from
        // spending another RPC read on every readiness request.
        indexer: async () => ({
          state: "disabled",
          observedAt: null,
          reason: "disabled",
          checkpointBlock: null,
          checkpointHash: null,
          latestBlock: null,
          lagBlocks: null,
        }),
        sources: probePriceOperator,
      },
    },
    rpcTransport: rpcCoordinator,
    spaceMode: "testnet",
    spaceAssets: [
      { token: usdc, decimals: Number(manifest.tokens.usdc.decimals) },
      { token: weth, decimals: Number(manifest.tokens.weth.decimals) },
    ],
    seedFixture: false,
  });

  const epochsPath = path.resolve(
    ROOT,
    value("AURKA_SEPOLIA_EPOCHS_PATH") ?? ".aurka/sepolia-space-epochs.json",
  );
  const lifecyclePath = path.resolve(lifecycleStatePath);
  for (const filename of [epochsPath, lifecyclePath])
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const epochs = existsSync(epochsPath)
    ? JSON.parse(readFileSync(epochsPath, "utf8"))
    : {};
  const saveRuntimeSpaces = () => {
    if (runtimeSpacesPath === ":memory:") return;
    writeFileSync(
      runtimeSpacesPath,
      `${JSON.stringify({ chainId: CHAIN_ID, spaces: spaceDefinitions }, null, 2)}\n`,
      { mode: 0o600 },
    );
  };
  const lifecycle = new ForkSpaceLifecycle({
    client: publicClient,
    contracts,
    manifest: runtimeManifest,
    service,
    providers,
    definitions: spaceDefinitions,
    makeProvider: (definition) => {
      const selected = new SepoliaSnapshotProvider(definition);
      providers.set(definition.positionId, selected);
      return selected;
    },
    file: lifecyclePath,
    epochs,
    saveEpochs: () =>
      writeFileSync(epochsPath, `${stringify(epochs)}\n`, {
        mode: 0o600,
      }),
    saveManifest: saveRuntimeSpaces,
    mode: "testnet",
  });

  const recoveryTokens = [
    { symbol: "USDC", address: usdc, decimals: 6 },
    { symbol: "WETH", address: weth, decimals: 18 },
  ];
  const ownerRecoveryState = async (spaceId) => {
    const current = service.getSpace(spaceId);
    const vault = current.identity.treasuryAddress;
    const code = await publicClient.getCode({ address: vault });
    const hasVault = typeof code === "string" && code !== "0x";
    const aquaBalances = {};
    const vaultBalances = {};
    const ownerBalances = {};
    let aquaApp;
    let paused = current.position?.policy.paused === true;
    if (hasVault) {
      aquaApp = await publicClient.readContract({
        ...contracts.router,
        functionName: "aquaApp",
      });
      paused = await publicClient.readContract({
        ...contracts.policyRegistry,
        functionName: "isPaused",
        args: [current.identity.policyId],
      });
    }
    for (const token of recoveryTokens) {
      const ownerBalance = await publicClient.readContract({
        address: token.address,
        abi: contracts.erc20Abi,
        functionName: "balanceOf",
        args: [current.identity.ownerAddress],
      });
      ownerBalances[token.symbol] = ownerBalance.toString();
      if (!hasVault) {
        aquaBalances[token.symbol] = {
          token: token.address,
          balance: "0",
          tokensCount: 0,
        };
        vaultBalances[token.symbol] = "0";
        continue;
      }
      const raw = await publicClient.readContract({
        ...contracts.aqua,
        functionName: "rawBalances",
        args: [vault, aquaApp, current.identity.strategyId, token.address],
      });
      aquaBalances[token.symbol] = {
        token: token.address,
        balance: BigInt(objectValue(raw, 0, "balance")).toString(),
        tokensCount: Number(objectValue(raw, 1, "tokensCount")),
      };
      vaultBalances[token.symbol] = (
        await publicClient.readContract({
          address: token.address,
          abi: contracts.erc20Abi,
          functionName: "balanceOf",
          args: [vault],
        })
      ).toString();
    }
    return {
      spaceId,
      owner: current.identity.ownerAddress,
      vault,
      hasVault,
      paused,
      aqua: aqua,
      aquaApp: aquaApp ?? null,
      strategyHash: current.identity.strategyId,
      tokens: recoveryTokens,
      aquaBalances,
      vaultBalances,
      ownerBalances,
    };
  };

  const persistFreshSnapshot = (snapshot) => {
    const position = positionForSnapshot(
      snapshot,
      registry,
      manifest.space.owner,
    );
    position.name = "AURKA Sepolia Space";
    service.repository.savePosition(position);
    service.repository.saveSpaceIdentity({
      id: position.id,
      name: position.name,
      ownerAddress: position.owner,
      controllerAddress: position.policy.governance,
      treasuryAddress: position.treasury,
      chainId: CHAIN_ID,
      policyId: position.policy.id,
      strategyId: manifest.space.strategyHash,
      policyRegistryAddress: registry,
      mode: "testnet",
      state: position.policy.paused ? "PAUSED" : "ACTIVE",
    });
    // Older Sepolia rehearsals persisted their real-chain Spaces with the
    // historical `fork` label. Migrate only records already bound to Sepolia;
    // a local 31337 record must never become visible in this testnet runtime.
    for (const record of service.repository.listSpaces(1_000).items) {
      if (record.identity.chainId !== CHAIN_ID) continue;
      if (record.identity.mode !== "fork") continue;
      service.repository.saveSpaceIdentity(
        { ...record.identity, mode: "testnet" },
        record.draft,
      );
    }
  };
  let knownSpaceReconcileTimer;
  let knownSpaceReconcileInFlight;
  const reconcileKnownSpaceStatuses = async () => {
    if (knownSpaceReconcileInFlight) return knownSpaceReconcileInFlight;
    const reconcile = (async () => {
      const failed = [];
      for (const definition of spaceDefinitions) {
        if (
          definition.positionId === positionId ||
          !service.repository.getPosition(definition.positionId)
        )
          continue;
        try {
          await service.refreshPosition(definition.positionId);
        } catch (error) {
          failed.push(definition.positionId);
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "sepolia.space.status_reconcile_failed",
              positionId: definition.positionId,
              code: rpcErrorCode(error),
            }),
          );
        }
      }
      if (failed.length > 0 && knownSpaceReconcileTimer === undefined) {
        knownSpaceReconcileTimer = setTimeout(() => {
          knownSpaceReconcileTimer = undefined;
          void reconcileKnownSpaceStatuses();
        }, 30_000);
      }
    })();
    knownSpaceReconcileInFlight = reconcile;
    try {
      await reconcile;
    } finally {
      if (knownSpaceReconcileInFlight === reconcile)
        knownSpaceReconcileInFlight = undefined;
    }
  };
  const initializeChainState = async () => {
    if (chainInitialization.inFlight) return chainInitialization.inFlight;
    const attempt = (async () => {
      chainInitialization.state = "syncing";
      chainInitialization.reason = "snapshot_syncing";
      try {
        const chainId = Number(
          parseRpcHex(
            await rpcCoordinator.request({
              method: "eth_chainId",
              params: [],
            }),
            "chain ID",
          ),
        );
        if (chainId !== CHAIN_ID) {
          const error = new Error(
            "AURKA_SEPOLIA_RPC_URL is not connected to Sepolia",
          );
          error.code = "CHAIN_MISMATCH";
          error.permanent = true;
          throw error;
        }
        let snapshot;
        let initializationBlock;
        try {
          snapshot = await selectedProvider(positionId).currentSnapshot();
          initializationBlock = snapshot.snapshotBlock;
        } catch (error) {
          if (
            !/Portfolio NAV must be positive/i.test(
              error instanceof Error ? error.message : String(error),
            )
          )
            throw error;
          // An owner may have withdrawn the seeded demo Space completely.
          // Deployment/RPC readiness must not depend on that Space retaining
          // liquidity; funded Spaces can still be refreshed independently.
          const block = await publicClient.getBlock();
          initializationBlock = block.number;
          console.warn(
            JSON.stringify({
              level: "info",
              message: "sepolia.seed_space_empty",
              positionId,
              block: block.number.toString(),
            }),
          );
        }
        const aquaApp = await publicClient.readContract({
          ...contracts.router,
          functionName: "aquaApp",
          blockNumber: initializationBlock,
        });
        if (
          !aquaApp ||
          aquaApp === "0x0000000000000000000000000000000000000000" ||
          (snapshot &&
            snapshot.verifyingContract?.toLowerCase() !== router.toLowerCase())
        ) {
          const error = new Error(
            "The Sepolia router deployment does not match the manifest",
          );
          error.code = "DEPLOYMENT_MISMATCH";
          error.permanent = true;
          throw error;
        }
        if (snapshot) persistFreshSnapshot(snapshot);
        // Reconcile already-persisted owner-created Spaces once after the
        // canonical chain is available. This marks immutable strategy
        // mismatches before the first quote, while keeping a single failed
        // historical Space from preventing the API from starting.
        await reconcileKnownSpaceStatuses();
        chainInitialization.state = "ready";
        chainInitialization.reason = undefined;
        chainInitialization.nextRetryAt = undefined;
        service.configureReadiness({ probes: { rpc: probeSepoliaRpc } });
        console.log(
          JSON.stringify({
            level: "info",
            message: "sepolia.chain.ready",
            block: initializationBlock.toString(),
          }),
        );
      } catch (error) {
        const code = rpcErrorCode(error);
        chainInitialization.state =
          error?.permanent === true ? "misconfigured" : "degraded";
        chainInitialization.reason =
          code === "RPC_SYNCING" ? "snapshot_syncing" : code;
        chainInitialization.nextRetryAt =
          error?.permanent === true
            ? undefined
            : (rpcCoordinator.nextRetryAtSeconds ??
              Math.ceil((Date.now() + 2_000) / 1_000));
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "sepolia.chain.initialization_failed",
            code,
            nextRetryAt: chainInitialization.nextRetryAt,
          }),
        );
        service.configureReadiness({ probes: { rpc: probeSepoliaRpc } });
        if (error?.permanent === true) return;
        throw error;
      } finally {
        chainInitialization.inFlight = undefined;
      }
    })();
    chainInitialization.inFlight = attempt;
    return attempt;
  };
  const initializeChainStateLoop = async () => {
    while (
      chainInitialization.state !== "ready" &&
      chainInitialization.state !== "misconfigured"
    ) {
      try {
        await initializeChainState();
      } catch {
        // The HTTP server remains available while the bounded retry loop
        // waits for the provider to recover.
      }
      if (
        chainInitialization.state === "ready" ||
        chainInitialization.state === "misconfigured"
      )
        break;
      const retryAt =
        chainInitialization.nextRetryAt ??
        Math.ceil((Date.now() + 2_000) / 1_000);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(250, retryAt * 1_000 - Date.now())),
      );
    }
  };

  const agent = new OpenRouterAgent(service, openRouterAgentOptionsFromEnv());
  const auth = new AuthService(service.repository, undefined, CHAIN_ID);
  const privyUserAgentConfig = [
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_DELEGATED_OWNER_ID",
    "PRIVY_DELEGATED_CHAIN_ID",
    "PRIVY_DELEGATED_ROUTER",
    "PRIVY_DELEGATED_INPUT_TOKEN",
    "PRIVY_DELEGATED_OUTPUT_TOKEN",
    "PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY",
    "PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY",
    "PRIVY_DELEGATED_MAX_INPUT_AMOUNT",
    "PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT",
    "PRIVY_DELEGATED_POLICY_VALID_UNTIL",
  ].every((name) => value(name));
  const userAgents = privyUserAgentConfig
    ? new TradingAgentService(service, service.repository)
    : undefined;
  const delegated = await createDelegatedSessionServiceFromEnv(
    service,
    agent,
    userAgents
      ? {
          walletResolver: async (walletId) => {
            const record =
              service.repository.getTradingAgentByWalletId(walletId);
            if (!record)
              throw new Error("Per-user Privy agent is not registered");
            return userAgents.adapter(record);
          },
        }
      : {},
  );
  const api = createApiServer({
    service,
    agent,
    delegated,
    auth,
    agents: userAgents,
    agentReady: () =>
      chainInitialization.state === "ready" && priceOperatorReady(),
  });
  const worker = new DelegatedAgentWorker(delegated, service.repository, {
    ready: () => chainInitialization.state === "ready",
  });
  worker.start();
  const gatewayHost =
    value("AURKA_SEPOLIA_GATEWAY_HOST") ?? process.env.HOST ?? "127.0.0.1";
  await listenApiServer(api, 0, INTERNAL_SERVICE_HOST);
  const internalPort = api.server.address().port;
  const configuredPublicRpcUrl = value("AURKA_SEPOLIA_PUBLIC_RPC_URL");
  const apiPort = Number(value("AURKA_SEPOLIA_API_PORT") ?? DEFAULT_API_PORT);
  let lifecycleQueue = Promise.resolve();
  const gateway = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "OPTIONS" && requestUrl.pathname === "/rpc") {
        response.writeHead(204, {
          "cache-control": "no-store",
          ...rpcCorsHeaders(request),
        });
        response.end();
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/rpc") {
        if (configuredPublicRpcUrl) {
          await proxyRpcDirect(request, response, configuredPublicRpcUrl);
        } else {
          await proxyRpc(request, response, rpcCoordinator);
        }
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/testnet/owner"
      ) {
        const action = requestUrl.searchParams.get("action");
        const requestedSpaceId = requestUrl.searchParams.get("spaceId");
        if (!requestedSpaceId)
          throw new ServiceError(
            "SPACE_NOT_FOUND",
            "A Space ID is required",
            400,
          );
        if (!action || !["state", "pause", "dock", "withdraw"].includes(action))
          throw new ServiceError(
            "SPACE_OWNER_ACTION_UNSUPPORTED",
            "Use state, pause, dock, or withdraw",
            400,
          );
        const current = service.getSpace(requestedSpaceId);
        const state = await ownerRecoveryState(requestedSpaceId);
        if (action === "state") {
          json(response, 200, state);
          return;
        }
        if (!state.hasVault)
          throw new ServiceError(
            "SPACE_VAULT_NOT_FOUND",
            "This Space has no deployed vault to recover",
            409,
          );
        let ownerTransaction;
        if (action === "pause") {
          if (state.paused) {
            json(response, 200, { ...state, complete: true });
            return;
          }
          ownerTransaction = transaction(
            contracts.policyRegistry,
            "setPaused",
            [current.identity.policyId, true],
          );
        } else if (action === "dock") {
          if (
            !recoveryTokens.some(
              (token) => BigInt(state.aquaBalances[token.symbol].balance) > 0n,
            )
          ) {
            json(response, 200, { ...state, complete: true });
            return;
          }
          ownerTransaction = transaction(
            { address: state.vault, abi: contracts.vaultAbi },
            "dockAquaStrategy",
            [state.aqua, state.aquaApp, state.strategyHash, [usdc, weth]],
          );
        } else {
          const tokenName = requestUrl.searchParams.get("token")?.toUpperCase();
          const token = recoveryTokens.find(
            (candidate) => candidate.symbol === tokenName,
          );
          if (!token)
            throw new ServiceError(
              "UNSUPPORTED_ASSET",
              "Withdraw requires token=USDC or token=WETH",
              400,
            );
          const available = BigInt(state.vaultBalances[token.symbol]);
          const amountText =
            requestUrl.searchParams.get("amount") ?? available.toString();
          if (!/^[0-9]+$/.test(amountText) || BigInt(amountText) <= 0n)
            throw new ServiceError(
              "INVALID_WITHDRAW_AMOUNT",
              "Withdraw amount must be a positive raw integer",
              400,
            );
          const amount = BigInt(amountText);
          if (amount > available)
            throw new ServiceError(
              "WITHDRAW_AMOUNT_EXCEEDS_BALANCE",
              `Withdraw amount exceeds the ${token.symbol} vault balance`,
              409,
              { available: available.toString() },
            );
          ownerTransaction = transaction(
            { address: state.vault, abi: contracts.vaultAbi },
            "withdraw",
            [token.address, state.owner, amount],
          );
        }
        json(response, 200, {
          ...ownerTransaction,
          owner: state.owner,
          vault: state.vault,
          strategyHash: state.strategyHash,
          action,
          note: "Unsigned owner transaction; sign and broadcast it from the Space owner wallet.",
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/testnet/spaces/delete"
      ) {
        const body = JSON.parse((await requestBody(request)).toString());
        const requestedSpaceId = body?.spaceId;
        const ownerAddress = body?.ownerAddress;
        if (
          typeof requestedSpaceId !== "string" ||
          typeof ownerAddress !== "string"
        )
          throw new ServiceError(
            "INVALID_REQUEST",
            "Space ID and owner address are required",
            400,
          );
        if (requestedSpaceId === positionId)
          throw new ServiceError(
            "SPACE_DELETE_UNSUPPORTED",
            "The seeded AURKA Sepolia Space cannot be removed from the app; withdraw its assets instead",
            409,
          );
        const current = service.getSpace(requestedSpaceId);
        if (
          current.identity.ownerAddress.toLowerCase() !==
          ownerAddress.toLowerCase()
        )
          throw new ServiceError(
            "SPACE_OWNER_REQUIRED",
            "Only the recorded Space owner can delete this Space",
            403,
          );
        const state = await ownerRecoveryState(requestedSpaceId);
        if (state.hasVault && !state.paused)
          throw new ServiceError(
            "SPACE_PAUSE_REQUIRED",
            "Pause the Space before deleting it",
            409,
          );
        const remaining = recoveryTokens.filter(
          (token) =>
            BigInt(state.aquaBalances[token.symbol].balance) > 0n ||
            BigInt(state.vaultBalances[token.symbol]) > 0n,
        );
        if (remaining.length > 0)
          throw new ServiceError(
            "SPACE_ASSETS_REMAIN",
            "Withdraw all Space assets before deleting it",
            409,
            {
              remaining: Object.fromEntries(
                remaining.map((token) => [
                  token.symbol,
                  {
                    aqua: state.aquaBalances[token.symbol].balance,
                    vault: state.vaultBalances[token.symbol],
                  },
                ]),
              ),
            },
          );
        service.repository.deleteSpace(requestedSpaceId);
        providers.delete(requestedSpaceId);
        for (let index = spaceDefinitions.length - 1; index >= 0; index -= 1)
          if (spaceDefinitions[index].positionId === requestedSpaceId)
            spaceDefinitions.splice(index, 1);
        delete lifecycle.plans[requestedSpaceId];
        for (const key of Object.keys(lifecycle.operations))
          if (key.startsWith(`${requestedSpaceId}:`))
            delete lifecycle.operations[key];
        lifecycle.persist();
        saveRuntimeSpaces();
        json(response, 200, { spaceId: requestedSpaceId, deleted: true });
        return;
      }
      if (
        request.method === "POST" &&
        [
          "/testnet/spaces/prepare",
          "/testnet/spaces/confirm",
          "/testnet/spaces/reconcile",
          "/testnet/spaces/recover",
        ].includes(requestUrl.pathname)
      ) {
        requireFreshChainState();
        const body = JSON.parse((await requestBody(request)).toString());
        const work = lifecycleQueue.then(() => {
          if (requestUrl.pathname.endsWith("/reconcile"))
            return body.batch
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
                );
          if (requestUrl.pathname.endsWith("/recover"))
            return lifecycle.recoverTransaction(
              body.spaceId,
              body.step,
              body.hash,
              body.operation,
              body.planId,
              body.planCommitment,
            );
          if (requestUrl.pathname.endsWith("/confirm"))
            return body.batch
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
                );
          return lifecycle.prepare(body.spaceId, body.operation);
        });
        lifecycleQueue = work.catch(() => {});
        const result = await work;
        json(response, 200, result);
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/testnet") {
        requireFreshChainState();
        const requestedSpaceId =
          requestUrl.searchParams.get("spaceId") ?? positionId;
        const selected = selectedProvider(requestedSpaceId);
        await service.refreshSpace(requestedSpaceId);
        const current = await selected.currentSnapshot();
        json(response, 200, {
          chainId: CHAIN_ID,
          rpcUrl: configuredPublicRpcUrl ?? `http://127.0.0.1:${apiPort}/rpc`,
          testnetBlock: Number(current.snapshotBlock),
          integrationMode: "real",
          aquaKind: "REAL_AQUA",
          oracleKind: "MOCK_ORACLE",
          bob: service.getSpace(requestedSpaceId).identity.ownerAddress,
          router,
          usdc,
          weth,
          mocks: ["MockERC20", "MockPriceOracle"],
          position: service.getSpace(requestedSpaceId).position,
          block: current.snapshotBlock,
          timestamp: current.priceProtection.nowSeconds,
          balances: {},
          capacity: {
            id: current.capacityEpochId,
            baseline: current.capacityEpoch.capacityBaselineValue,
            consumed: current.capacityEpoch.consumedBefore,
            authorized:
              current.capacityEpochId.toLowerCase() !== ZERO_HASH &&
              current.portfolioSnapshot.assets.some(
                (asset) => BigInt(asset.balance) > 0n,
              ) &&
              current.capacityEpoch.capacityBaselineValue >
                current.capacityEpoch.consumedBefore,
          },
        });
        return;
      }
      await proxyToApi(request, response, internalPort);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          message: "sepolia.gateway.failure",
          path: request.url,
          code: rpcErrorCode(error),
        }),
      );
      const candidate =
        error && typeof error === "object"
          ? /** @type {{ statusCode?: unknown; code?: unknown; details?: unknown }} */ (
              error
            )
          : undefined;
      const statusCode =
        typeof candidate?.statusCode === "number" &&
        Number.isInteger(candidate.statusCode) &&
        candidate.statusCode >= 400 &&
        candidate.statusCode <= 599
          ? candidate.statusCode
          : 500;
      const code =
        typeof candidate?.code === "string" ? candidate.code : "INTERNAL_ERROR";
      const message =
        statusCode === 500
          ? "The Sepolia setup service could not complete that request."
          : error instanceof Error
            ? error.message
            : "Sepolia app gateway failed";
      json(
        response,
        statusCode,
        {
          ok: false,
          error: {
            code,
            message,
            ...(candidate?.details && typeof candidate.details === "object"
              ? { details: candidate.details }
              : {}),
          },
        },
        request.url?.startsWith("/rpc") ? rpcCorsHeaders(request) : {},
      );
    }
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(apiPort, gatewayHost, resolve);
  });
  const automaticMockPriceOperator = startAutomaticMockPriceOperator(
    manifest,
    operatorStateFilename,
  );
  const operatorRunsOnce = value("AURKA_SEPOLIA_OPERATOR_RUN_ONCE") === "true";
  const automaticMockPriceOperatorReady =
    automaticMockPriceOperator && operatorRunsOnce
    ? new Promise((resolve) => automaticMockPriceOperator.once("exit", resolve))
    : Promise.resolve();

  console.log(
    JSON.stringify(
      {
        appApi: `http://${gatewayHost}:${apiPort}`,
        chainId: CHAIN_ID,
        positionId,
        router,
        initialization: "syncing",
        next: "Start the frontend with pnpm app:testnet",
      },
      null,
      2,
    ),
  );

  const shutdown = async () => {
    automaticMockPriceOperator?.kill("SIGTERM");
    await worker.stop();
    await new Promise((resolve) => gateway.close(resolve));
    await closeApiServer(api);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  // One-shot price setup must finish before snapshots are initialized. A
  // continuous operator stays alive by design, so waiting for its exit would
  // leave the API permanently stuck in snapshot_syncing.
  await automaticMockPriceOperatorReady;
  void initializeChainStateLoop();
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
