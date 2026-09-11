/* global AbortSignal, Buffer, URL, console, fetch, process */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createPublicClient, defineChain, getAbiItem, http } from "viem";

import {
  AurkaService,
  FixtureProposalSigner,
  JsonRpcHttpTransport,
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
} from "../dist/index.js";
import {
  LocalChainSnapshotProvider,
  positionForSnapshot,
} from "./chain-snapshot.mjs";
import { ForkSpaceLifecycle } from "./fork-space-lifecycle.mjs";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const CHAIN_ID = 11_155_111;
const DEFAULT_SPACE_POSITION_ID = "aurka-sepolia-space-v1";
const DEFAULT_API_PORT = 8797;
const DEFAULT_SERVICE_HOST = "127.0.0.1";

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
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

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(stringify(body));
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
  const target = `http://${DEFAULT_SERVICE_HOST}:${apiPort}${request.url}`;
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

async function proxyRpc(request, response, rpc) {
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
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
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
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  if ((await publicClient.getChainId()) !== CHAIN_ID)
    throw new Error("AURKA_SEPOLIA_RPC_URL is not connected to Sepolia");

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
  const aquaApp = await publicClient.readContract({
    ...contracts.router,
    functionName: "aquaApp",
  });
  contracts.aquaApp = aquaApp;
  const epochEvent = epochEventAbi(routerArtifact.abi);
  const cachedEpochEvents = new Map();
  const pendingEpochEvents = new Map();
  const readEpochEvent = async (spacePositionIdHash, capacityEpochId) => {
    const cacheKey = `${spacePositionIdHash}:${capacityEpochId}`.toLowerCase();
    if (cachedEpochEvents.has(cacheKey)) return cachedEpochEvents.get(cacheKey);
    const pending = pendingEpochEvents.get(cacheKey);
    if (pending) return pending;
    const lookup = (async () => {
      const latest = await publicClient.getBlockNumber();
      const first =
        eventSearchStarts.get(spacePositionIdHash.toLowerCase()) ??
        BigInt(manifest.space.createBlockNumber ?? 0);
      for (let from = first; from <= latest; from += 10n) {
        const to = from + 9n < latest ? from + 9n : latest;
        const logs = await publicClient.getLogs({
          address: router,
          event: epochEvent,
          args: { positionIdHash: spacePositionIdHash },
          fromBlock: from,
          toBlock: to,
        });
        const event = logs
          .filter(
            (log) =>
              log.args?.capacityEpochId?.toLowerCase() ===
              capacityEpochId.toLowerCase(),
          )
          .at(-1);
        if (event) {
          cachedEpochEvents.set(cacheKey, event);
          return event;
        }
      }
      throw new Error("active Sepolia capacity epoch event was not found");
    })();
    pendingEpochEvents.set(cacheKey, lookup);
    try {
      return await lookup;
    } finally {
      pendingEpochEvents.delete(cacheKey);
    }
  };

  class SepoliaSnapshotProvider extends LocalChainSnapshotProvider {
    constructor(definition) {
      super(publicClient, contracts, solver.address, definition, CHAIN_ID);
      this.cachedSnapshot = undefined;
      this.cachedAt = 0;
      this.snapshotInFlight = undefined;
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
        });
        const activeId = objectValue(active, 0, "capacityEpochId");
        const consumed = BigInt(objectValue(active, 2, "consumedValue"));
        const event = await readEpochEvent(this.space.positionIdHash, activeId);
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
        return snapshot;
      })();
      this.snapshotInFlight = request;
      try {
        const snapshot = await request;
        this.cachedSnapshot = snapshot;
        this.cachedAt = Date.now();
        return snapshot;
      } finally {
        if (this.snapshotInFlight === request)
          this.snapshotInFlight = undefined;
      }
    }
  }

  const providers = new Map(
    spaceDefinitions.map((definition) => [
      definition.positionId,
      new SepoliaSnapshotProvider(definition),
    ]),
  );
  const selectedProvider = (spaceId) => {
    const selected = providers.get(spaceId);
    if (!selected)
      throw new Error(`Space ${spaceId} is not registered in the Sepolia app`);
    return selected;
  };
  const provider = {
    getPositionSnapshot: (spaceId) =>
      selectedProvider(spaceId).getPositionSnapshot(spaceId),
    prepareIntent: (input) =>
      selectedProvider(input.positionId).prepareIntent(input),
    prepareTokenIntent: (input) =>
      selectedProvider(input.positionId).prepareTokenIntent(input),
    getSnapshot: (intent) => {
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
  const databaseFilename =
    value("AURKA_SEPOLIA_DATABASE_URL") ?? ".aurka/sepolia-service.sqlite";
  if (databaseFilename !== ":memory:")
    mkdirSync(path.dirname(path.resolve(ROOT, databaseFilename)), {
      recursive: true,
      mode: 0o700,
    });
  const database = new ServiceDatabase({ filename: databaseFilename });
  const service = new AurkaService({
    database,
    provider,
    signer: solver,
    chainId: CHAIN_ID,
    settlementContract: router,
    indexConfirmations: 0,
    rpcTransport: new JsonRpcHttpTransport(rpc),
    spaceMode: "testnet",
    spaceAssets: [
      { token: usdc, decimals: Number(manifest.tokens.usdc.decimals) },
      { token: weth, decimals: Number(manifest.tokens.weth.decimals) },
    ],
    seedFixture: false,
  });
  const snapshot = await selectedProvider(positionId).currentSnapshot();
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

  const agent = new OpenRouterAgent(service, openRouterAgentOptionsFromEnv());
  const auth = new AuthService(service.repository, undefined, CHAIN_ID);
  const privyUserAgentConfig = [
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_DELEGATED_OWNER_ID",
    "PRIVY_DELEGATED_SIGNER_ID",
    "PRIVY_DELEGATED_POLICY_ID",
    "PRIVY_DELEGATED_CHAIN_ID",
    "PRIVY_DELEGATED_ROUTER",
    "PRIVY_DELEGATED_INPUT_TOKEN",
    "PRIVY_DELEGATED_OUTPUT_TOKEN",
    "PRIVY_DELEGATED_SIGNER_ADDRESS",
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
      ? { walletResolver: async (walletId) => {
          const record = service.repository.getTradingAgentByWalletId(walletId);
          if (!record) throw new Error("Per-user Privy agent is not registered");
          return userAgents.adapter(record);
        } }
      : {},
  );
  const api = createApiServer({ service, agent, delegated, auth, agents: userAgents });
  const worker = new DelegatedAgentWorker(delegated, service.repository);
  worker.start();
  await listenApiServer(api, 0, DEFAULT_SERVICE_HOST);
  const internalPort = api.server.address().port;
  const configuredPublicRpcUrl = value("AURKA_SEPOLIA_PUBLIC_RPC_URL");
  const apiPort = Number(value("AURKA_SEPOLIA_API_PORT") ?? DEFAULT_API_PORT);
  let lifecycleQueue = Promise.resolve();
  const gateway = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && requestUrl.pathname === "/rpc") {
        if (configuredPublicRpcUrl) {
          await proxyRpc(request, response, configuredPublicRpcUrl);
        } else {
          await proxyRpc(request, response, rpc);
        }
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
            authorized: true,
          },
        });
        return;
      }
      await proxyToApi(request, response, internalPort);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "sepolia.gateway.failure",
          path: request.url,
          error:
            error instanceof Error ? (error.stack ?? error.message) : error,
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
      json(response, statusCode, {
        ok: false,
        error: {
          code,
          message,
          ...(candidate?.details && typeof candidate.details === "object"
            ? { details: candidate.details }
            : {}),
        },
      });
    }
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(apiPort, DEFAULT_SERVICE_HOST, resolve);
  });

  console.log(
    JSON.stringify(
      {
        appApi: `http://${DEFAULT_SERVICE_HOST}:${apiPort}`,
        chainId: CHAIN_ID,
        positionId,
        router,
        spaceCapacity: {
          baseline: String(
            objectValue(
              await publicClient.readContract({
                ...contracts.router,
                functionName: "capacityState",
                args: [positionIdHash, weth, usdc],
              }),
              1,
              "capacityBaselineValue",
            ),
          ),
          note: "Capacity is read from the live router; run pnpm sepolia:reactivate before a new trade if consumed or price snapshots are stale.",
        },
        next: "Start the frontend with pnpm app:testnet",
      },
      null,
      2,
    ),
  );

  const shutdown = async () => {
    await worker.stop();
    await new Promise((resolve) => gateway.close(resolve));
    await closeApiServer(api);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
