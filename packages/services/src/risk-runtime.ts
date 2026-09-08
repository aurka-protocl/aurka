import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import {
  GraphClient,
  GraphSignalSource,
  UniswapV4SignalSource,
  type CanonicalChainReader,
  type GraphFetch,
  type GraphConfig,
} from "@aurka/graph";
import {
  activeAssetBoundSchema,
  hashActiveBounds,
  riskConfigurationSchema,
  type ActiveAssetBound,
  type RiskCertificate,
  type RiskConfiguration,
} from "@aurka/shared";
import type { riskObservationSchema } from "@aurka/shared";
import {
  authorizationContextSchema,
  createPrivyNodeClientFromEnv,
  PrivyWalletAdapter,
  type AurkaWalletAdapter,
  type AuthorizationContext,
  type PrivyNodeClient,
  type WalletAction,
  type WalletPolicy,
} from "@aurka/wallet";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";

import { createRegistryRiskReader } from "./risk-registry.js";
import { JsonRpcHttpTransport, type Eip1193Transport } from "./solver/rpc.js";
import type { AurkaService } from "./service.js";
import type {
  ReadinessProbeSet,
  RpcReadiness,
  SourcesReadiness,
  WorkerReadiness,
  SignerReadiness,
  RegistryReadiness,
} from "./readiness.js";
import {
  RiskCertificateWorker,
  type RegistryContext,
  type RiskWorkerOptions,
  type RiskWorkerSources,
} from "./risk-worker.js";

const address = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);
const bytes32 = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);
const identifier = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const moduleReference = (value: string): boolean =>
  value.length > 0 && (isAbsolute(value) || value.startsWith("./"));
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Only HTTP(S) endpoints are supported");

const graphSourceConfigSchema = z
  .object({
    sourceId: z.string().refine(identifier, "Invalid source identifier"),
    sourceKind: z.enum(["AURKA_SUBGRAPH", "DEX_SUBGRAPH", "FIXTURE"]),
    endpoint: httpUrl,
    deploymentId: z.string().min(1).max(128),
    schemaVersion: z.string().min(1).max(32),
    queryVersion: z.string().min(1).max(32),
    poolId: z.string().refine(bytes32, "A pool ID must be bytes32").optional(),
    apiKeyEnv: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9_]*$/,
        "API-key references must name an environment variable",
      )
      .optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    attempts: z.number().int().positive().max(5).default(3),
    pageSize: z.number().int().positive().max(1_000).default(100),
    maxObservationAgeSeconds: z.number().int().positive().safe(),
    maxIndexedLagBlocks: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.sourceKind === "DEX_SUBGRAPH" && source.poolId === undefined)
      context.addIssue({
        code: "custom",
        message: "DEX sources require an explicit bytes32 poolId",
        path: ["poolId"],
      });
    if (source.sourceKind !== "DEX_SUBGRAPH" && source.poolId !== undefined)
      context.addIssue({
        code: "custom",
        message: "poolId is only valid for DEX_SUBGRAPH sources",
        path: ["poolId"],
      });
  });

export type RiskGraphSourceConfig = z.infer<typeof graphSourceConfigSchema>;

const riskPositionRuntimeConfigSchema = z
  .object({
    positionId: z.string().refine(identifier, "Invalid position identifier"),
    policyId: z.string().refine(bytes32, "Policy ID must be bytes32"),
    watchtower: z.string().refine(address, "Watchtower must be an address"),
    deploymentId: z.string().min(1).max(128),
    configuration: riskConfigurationSchema,
    approvedConfigurationHash: z
      .string()
      .refine(bytes32, "Approved configuration hash must be bytes32"),
    approvedHardBoundsHash: z
      .string()
      .refine(bytes32, "Approved hard-bounds hash must be bytes32"),
    sources: z.array(graphSourceConfigSchema).min(1),
  })
  .strict()
  .superRefine((position, context) => {
    const sourceIds = new Set<string>();
    for (const [index, source] of position.sources.entries()) {
      if (sourceIds.has(source.sourceId))
        context.addIssue({
          code: "custom",
          message: "Source identifiers must be unique per position",
          path: ["sources", index, "sourceId"],
        });
      sourceIds.add(source.sourceId);
      if (source.deploymentId !== position.deploymentId)
        context.addIssue({
          code: "custom",
          message:
            "All sources in a position must use its configured deploymentId",
          path: ["sources", index, "deploymentId"],
        });
      if (
        source.maxObservationAgeSeconds !==
        position.configuration.maxObservationAgeSeconds
      )
        context.addIssue({
          code: "custom",
          message: "Graph freshness must equal the approved risk configuration",
          path: ["sources", index, "maxObservationAgeSeconds"],
        });
      if (
        source.maxIndexedLagBlocks !==
        position.configuration.maxIndexedLagBlocks
      )
        context.addIssue({
          code: "custom",
          message:
            "Graph lag budget must equal the approved risk configuration",
          path: ["sources", index, "maxIndexedLagBlocks"],
        });
    }
  });

export type RiskPositionRuntimeConfig = z.infer<
  typeof riskPositionRuntimeConfigSchema
>;

export const riskRuntimeConfigSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    rpcUrl: httpUrl,
    policyRegistry: z
      .string()
      .refine(address, "Policy registry must be an address"),
    riskRegistry: z
      .string()
      .refine(address, "Risk registry must be an address"),
    router: z.string().refine(address, "Router must be an address"),
    walletId: z.string().min(1).max(128),
    walletPolicyReference: z.string().min(1).max(256),
    walletPolicyModule: z
      .string()
      .refine(
        moduleReference,
        "Wallet policy module must be a local module reference",
      )
      .optional(),
    authorizationModule: z
      .string()
      .refine(
        moduleReference,
        "Authorization module must be a local module reference",
      )
      .optional(),
    finalityMaxAgeSeconds: z.number().int().positive().safe(),
    certificateLifetimeSeconds: z.number().int().positive().safe().default(300),
    renewalLeadSeconds: z.number().int().nonnegative().safe().default(60),
    positions: z.array(riskPositionRuntimeConfigSchema).min(1),
  })
  .strict()
  .superRefine((config, context) => {
    const registries = [
      config.policyRegistry,
      config.riskRegistry,
      config.router,
    ].map((value) => value.toLowerCase());
    if (new Set(registries).size !== registries.length)
      context.addIssue({
        code: "custom",
        message: "Policy registry, risk registry and router must be distinct",
        path: ["riskRegistry"],
      });
    const positions = new Set<string>();
    for (const [index, position] of config.positions.entries()) {
      if (positions.has(position.positionId))
        context.addIssue({
          code: "custom",
          message: "Position identifiers must be unique",
          path: ["positions", index, "positionId"],
        });
      positions.add(position.positionId);
    }
  });

export type RiskRuntimeConfig = z.infer<typeof riskRuntimeConfigSchema>;

export function canonicalRuntimeJson(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

export function hashRiskConfiguration(
  configuration: RiskConfiguration,
): string {
  return `0x${Array.from(
    keccak_256(new TextEncoder().encode(canonicalRuntimeJson(configuration))),
    (item) => item.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function parseRiskRuntimeConfig(input: unknown): RiskRuntimeConfig {
  const config = riskRuntimeConfigSchema.parse(input);
  for (const position of config.positions) {
    if (
      hashRiskConfiguration(position.configuration).toLowerCase() !==
      position.approvedConfigurationHash.toLowerCase()
    )
      throw new Error(
        `Approved risk configuration hash does not match ${position.positionId}`,
      );
  }
  return config;
}

function parseJsonEnvironment(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

/** Loads public deployment metadata only; secrets are referenced by name. */
export function loadRiskRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RiskRuntimeConfig {
  const required = (name: string): string => {
    const value = environment[name];
    if (!value) throw new Error(`${name} is required for a risk runtime`);
    return value;
  };
  const number = (name: string): number => {
    const value = Number(required(name));
    if (!Number.isSafeInteger(value))
      throw new Error(`${name} must be an integer`);
    return value;
  };
  return parseRiskRuntimeConfig({
    chainId: number("RISK_CHAIN_ID"),
    rpcUrl: required("RISK_RPC_URL"),
    policyRegistry: required("RISK_POLICY_REGISTRY"),
    riskRegistry: required("RISK_RISK_REGISTRY"),
    router: required("RISK_ROUTER"),
    walletId: required("RISK_WALLET_ID"),
    walletPolicyReference: required("RISK_WALLET_POLICY_REFERENCE"),
    ...(environment.RISK_WALLET_POLICY_MODULE
      ? { walletPolicyModule: environment.RISK_WALLET_POLICY_MODULE }
      : {}),
    ...(environment.RISK_AUTHORIZATION_MODULE
      ? { authorizationModule: environment.RISK_AUTHORIZATION_MODULE }
      : {}),
    finalityMaxAgeSeconds: number("RISK_FINALITY_MAX_AGE_SECONDS"),
    ...(environment.RISK_CERTIFICATE_LIFETIME_SECONDS
      ? {
          certificateLifetimeSeconds: number(
            "RISK_CERTIFICATE_LIFETIME_SECONDS",
          ),
        }
      : {}),
    ...(environment.RISK_RENEWAL_LEAD_SECONDS
      ? { renewalLeadSeconds: number("RISK_RENEWAL_LEAD_SECONDS") }
      : {}),
    positions: parseJsonEnvironment(
      required("RISK_POSITIONS_JSON"),
      "RISK_POSITIONS_JSON",
    ),
  });
}

const policyAbi = parseAbi([
  "function policyNonce(bytes32 policyId) view returns (uint256)",
  "function maximumTransactionValue(bytes32 policyId) view returns (uint256)",
  "function isPaused(bytes32 policyId) view returns (bool)",
  "function assets(bytes32 policyId) view returns (address[])",
  "function assetBounds(bytes32 policyId,address token) view returns (uint8,uint16,uint16,bool)",
]);
const riskAbi = parseAbi([
  "function policyRegistry() view returns (address)",
  "function isWatchtower(bytes32 policyId,address watchtower) view returns (bool)",
  "function watchtowerAuthorizationEpoch(bytes32 policyId,address watchtower) view returns (uint256)",
  "function lastNonce(bytes32 policyId) view returns (uint256)",
]);

interface FinalizedSnapshot {
  readonly number: bigint;
  readonly hash: string;
  readonly timestamp: number;
}

export interface RiskPolicySnapshot {
  readonly policyNonce: string;
  readonly maximumTransactionValue: string;
  readonly paused: boolean;
  readonly assets: readonly string[];
  readonly hardBounds: readonly ActiveAssetBound[];
}

function parseHex(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`Malformed ${label}`);
  return BigInt(value);
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`Malformed ${label}`);
  return value;
}

function parseBlock(value: unknown): {
  readonly number: bigint;
  readonly hash: string;
  readonly timestamp: number;
} {
  if (!value || typeof value !== "object")
    throw new Error("Finalized block is unavailable");
  const block = value as {
    number?: unknown;
    hash?: unknown;
    timestamp?: unknown;
  };
  const number = parseHex(block.number, "block number");
  const hash = parseHash(block.hash, "block hash");
  const timestampValue = parseHex(block.timestamp, "block timestamp");
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp))
    throw new Error("Block timestamp is out of range");
  return { number, hash, timestamp };
}

export class CanonicalRpcReader implements CanonicalChainReader {
  constructor(
    private readonly rpc: Eip1193Transport,
    private readonly chainId: number,
    private readonly finalityMaxAgeSeconds: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async getChainId(): Promise<number> {
    const value = await this.rpc.request({ method: "eth_chainId", params: [] });
    const chain = parseHex(value, "chain ID");
    if (chain > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Chain ID is out of range");
    return Number(chain);
  }

  async getLatestBlock(): Promise<bigint> {
    return parseHex(
      await this.rpc.request({ method: "eth_blockNumber", params: [] }),
      "latest block number",
    );
  }

  async getBlockHash(blockNumber: bigint): Promise<string | undefined> {
    const value = await this.rpc.request({
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, false],
    });
    if (value === null) return undefined;
    try {
      if (!value || typeof value !== "object") return undefined;
      return parseHash((value as { hash?: unknown }).hash, "block hash");
    } catch {
      return undefined;
    }
  }

  async finalized(): Promise<FinalizedSnapshot> {
    const chainId = await this.getChainId();
    if (chainId !== this.chainId) throw new Error("RPC chain mismatch");
    const snapshot = parseBlock(
      await this.rpc.request({
        method: "eth_getBlockByNumber",
        params: ["finalized", false],
      }),
    );
    const latest = await this.getLatestBlock();
    if (snapshot.number > latest)
      throw new Error("RPC finalized block is ahead of the latest block");
    const now = this.now();
    if (
      snapshot.timestamp > now ||
      now - snapshot.timestamp > this.finalityMaxAgeSeconds
    )
      throw new Error(
        "RPC finalized block is outside the configured freshness budget",
      );
    return snapshot;
  }

  private async call<T>(
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    to: string,
    block:
      | string
      | { readonly blockHash: string; readonly requireCanonical: boolean },
  ): Promise<T> {
    const data = encodeFunctionData({
      abi,
      functionName: functionName as never,
      args: args as never,
    });
    const result = await this.rpc.request({
      method: "eth_call",
      params: [{ to, data }, block],
    });
    if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(result))
      throw new Error(`Malformed eth_call result for ${functionName}`);
    return decodeFunctionResult({
      abi,
      functionName: functionName as never,
      data: result as Hex,
    }) as T;
  }

  private async callAtLatest<T>(
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    to: string,
  ): Promise<T> {
    return this.call(abi, functionName, args, to, "latest");
  }

  async assertDeployment(
    policyRegistry: string,
    riskRegistry: string,
  ): Promise<void> {
    if ((await this.getChainId()) !== this.chainId)
      throw new Error("RPC chain mismatch");
    const actual = await this.callAtLatest<string>(
      riskAbi,
      "policyRegistry",
      [],
      riskRegistry,
    );
    if (actual.toLowerCase() !== policyRegistry.toLowerCase())
      throw new Error("Risk registry is bound to a different policy registry");
  }

  async readPolicy(
    policyId: string,
    policyRegistry: string,
    snapshot: FinalizedSnapshot,
  ): Promise<RiskPolicySnapshot> {
    const block = { blockHash: snapshot.hash, requireCanonical: true } as const;
    const assets = await this.call<string[]>(
      policyAbi,
      "assets",
      [policyId as Hex],
      policyRegistry,
      block,
    );
    if (!Array.isArray(assets) || assets.length === 0)
      throw new Error("Policy has no managed assets");
    const normalized = assets.map((token) => {
      if (!address(token))
        throw new Error("Policy returned a malformed asset address");
      return token;
    });
    if (
      new Set(normalized.map((token) => token.toLowerCase())).size !==
      normalized.length
    )
      throw new Error("Policy returned duplicate assets");
    const hardBounds: ActiveAssetBound[] = [];
    for (const token of normalized) {
      const value = await this.call<readonly [number, number, number, boolean]>(
        policyAbi,
        "assetBounds",
        [policyId as Hex, token as Hex],
        policyRegistry,
        block,
      );
      const [, minimumWeightBps, maximumWeightBps, managed] = value;
      if (!managed) throw new Error(`Policy asset ${token} is not managed`);
      hardBounds.push(
        activeAssetBoundSchema.parse({
          token,
          minimumWeightBps,
          maximumWeightBps,
          paused: false,
        }),
      );
    }
    return {
      policyNonce: (
        await this.call<bigint>(
          policyAbi,
          "policyNonce",
          [policyId as Hex],
          policyRegistry,
          block,
        )
      ).toString(),
      maximumTransactionValue: (
        await this.call<bigint>(
          policyAbi,
          "maximumTransactionValue",
          [policyId as Hex],
          policyRegistry,
          block,
        )
      ).toString(),
      paused: await this.call<boolean>(
        policyAbi,
        "isPaused",
        [policyId as Hex],
        policyRegistry,
        block,
      ),
      assets: normalized,
      hardBounds,
    };
  }

  async readContext(
    policyId: string,
    watchtower: string,
    policyRegistry: string,
    riskRegistry: string,
  ): Promise<RegistryContext> {
    const actualRegistry = await this.callAtLatest<string>(
      riskAbi,
      "policyRegistry",
      [],
      riskRegistry,
    );
    if (actualRegistry.toLowerCase() !== policyRegistry.toLowerCase())
      throw new Error("Risk registry policy registry mismatch");
    const [policyNonce, authorized, epoch, lastNonce] = await Promise.all([
      this.callAtLatest<bigint>(
        policyAbi,
        "policyNonce",
        [policyId as Hex],
        policyRegistry,
      ),
      this.callAtLatest<boolean>(
        riskAbi,
        "isWatchtower",
        [policyId as Hex, watchtower as Hex],
        riskRegistry,
      ),
      this.callAtLatest<bigint>(
        riskAbi,
        "watchtowerAuthorizationEpoch",
        [policyId as Hex, watchtower as Hex],
        riskRegistry,
      ),
      this.callAtLatest<bigint>(
        riskAbi,
        "lastNonce",
        [policyId as Hex],
        riskRegistry,
      ),
    ]);
    return {
      policyId,
      chainId: this.chainId,
      registry: riskRegistry,
      watchtower,
      policyNonce: policyNonce.toString(),
      authorizationEpoch: epoch.toString(),
      nextNonce: (lastNonce + 1n).toString(),
      authorized,
    };
  }

  async readRiskAuthority(
    policyId: string,
    watchtower: string,
    policyRegistry: string,
    riskRegistry: string,
  ): Promise<{
    readonly policyNonce: string;
    readonly watchtowerAuthorizationEpoch: string;
    readonly nextNonce: string;
    readonly authorized: boolean;
  }> {
    const context = await this.readContext(
      policyId,
      watchtower,
      policyRegistry,
      riskRegistry,
    );
    return {
      policyNonce: context.policyNonce,
      watchtowerAuthorizationEpoch: context.authorizationEpoch,
      nextNonce: context.nextNonce,
      authorized: context.authorized,
    };
  }

  async receipt(hash: string): Promise<{
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly success: boolean;
  } | null> {
    const value = await this.rpc.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (value === null) return null;
    if (!value || typeof value !== "object")
      throw new Error("Malformed transaction receipt");
    const receipt = value as {
      blockNumber?: unknown;
      blockHash?: unknown;
      status?: unknown;
    };
    const blockNumber = parseHex(
      receipt.blockNumber,
      "receipt block number",
    ).toString();
    const blockHash = parseHash(receipt.blockHash, "receipt block hash");
    if (receipt.status !== "0x0" && receipt.status !== "0x1")
      throw new Error("Receipt status is unknown");
    return { blockNumber, blockHash, success: receipt.status === "0x1" };
  }

  async finalizedBlock(): Promise<bigint> {
    return (await this.finalized()).number;
  }
}

export interface RiskRuntimeOperatorModule {
  getWalletPolicy?: (
    walletId: string,
    reference: string,
  ) => Promise<WalletPolicy> | WalletPolicy;
  authorize?: (
    request: RiskCertificate | WalletAction,
  ) => Promise<AuthorizationContext> | AuthorizationContext;
}

export interface RiskRuntimeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: RiskRuntimeConfig;
  readonly rpc?: Eip1193Transport;
  readonly wallet?: AurkaWalletAdapter;
  readonly privyClient?: PrivyNodeClient;
  readonly graphFetch?: GraphFetch;
  readonly getWalletPolicy?: (
    walletId: string,
    reference: string,
  ) => Promise<WalletPolicy> | WalletPolicy;
  readonly authorize?: (
    request: RiskCertificate | WalletAction,
  ) => Promise<AuthorizationContext> | AuthorizationContext;
  readonly now?: () => number;
}

export interface RiskRuntime {
  readonly worker: RiskCertificateWorker;
  readonly positions: readonly string[];
  readonly readRisk: ReturnType<typeof createRegistryRiskReader>;
  readonly riskRegistry: string;
  readonly sources: RiskWorkerSources;
  readonly config: RiskRuntimeConfig;
  /** Read-only, bounded inputs consumed by the service readiness monitor. */
  readonly readiness: ReadinessProbeSet;
}

async function loadOperatorModule(
  reference: string,
): Promise<RiskRuntimeOperatorModule> {
  const module = (await import(
    pathToFileURL(resolve(reference)).href
  )) as RiskRuntimeOperatorModule;
  return module;
}

function requireAuthorizationContext(
  value: AuthorizationContext,
): AuthorizationContext {
  return authorizationContextSchema.parse(value);
}

function graphSource(
  config: RiskGraphSourceConfig,
  chainId: number,
  environment: NodeJS.ProcessEnv,
  fetcher: GraphFetch | undefined,
  now: () => number,
): GraphSignalSource | UniswapV4SignalSource {
  const apiKey = config.apiKeyEnv ? environment[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !apiKey)
    throw new Error(
      `Graph API key environment reference ${config.apiKeyEnv} is not set`,
    );
  const graphConfig: GraphConfig = {
    endpoint: config.endpoint,
    ...(apiKey ? { apiKey } : {}),
    chainId,
    deploymentId: config.deploymentId,
    schemaVersion: config.schemaVersion,
    queryVersion: config.queryVersion,
    timeoutMs: config.timeoutMs,
    attempts: config.attempts,
    pageSize: config.pageSize,
    maxObservationAgeSeconds: config.maxObservationAgeSeconds,
    maxIndexedLagBlocks: config.maxIndexedLagBlocks,
  };
  const client = new GraphClient(
    graphConfig,
    fetcher === undefined ? { now } : { fetch: fetcher, now },
  );
  return config.poolId
    ? new UniswapV4SignalSource(client, config.poolId)
    : new GraphSignalSource(client, config.sourceId);
}

function assertWalletPolicy(
  policy: WalletPolicy,
  config: RiskRuntimeConfig,
): void {
  if (policy.role !== "RISK")
    throw new Error("Risk runtime requires a RISK wallet policy");
  if (policy.chainId !== config.chainId)
    throw new Error("Wallet policy chain mismatch");
  if (policy.router.toLowerCase() !== config.router.toLowerCase())
    throw new Error("Wallet policy router mismatch");
  if (policy.riskRegistry.toLowerCase() !== config.riskRegistry.toLowerCase())
    throw new Error("Wallet policy risk registry mismatch");
  for (const position of config.positions) {
    if (policy.policyId.toLowerCase() !== position.policyId.toLowerCase())
      throw new Error(`Wallet policy does not cover ${position.positionId}`);
    if (
      policy.signerAddress.toLowerCase() !== position.watchtower.toLowerCase()
    )
      throw new Error(
        `Wallet signer does not match ${position.positionId} watchtower`,
      );
    for (const boundSet of position.configuration.boundSets) {
      const boundHash = hashActiveBounds(boundSet.activeBounds);
      if (
        !policy.approvedRiskBoundsHashes.some(
          (value) => value.toLowerCase() === boundHash.toLowerCase(),
        )
      )
        throw new Error(
          `Wallet policy has not approved ${boundSet.mode} bounds for ${position.positionId}`,
        );
    }
  }
}

function positionConfig(
  config: RiskRuntimeConfig,
  positionId: string,
): RiskPositionRuntimeConfig {
  const position = config.positions.find(
    (item) => item.positionId === positionId,
  );
  if (!position)
    throw new Error(`Risk runtime position is not configured: ${positionId}`);
  return position;
}

function sourceToObservationOptions(
  source: RiskGraphSourceConfig,
  chain: CanonicalRpcReader,
  finalityBlock: bigint,
  nowSeconds: number,
): Parameters<GraphSignalSource["fetchObservations"]>[0] {
  return {
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    nowSeconds,
    canonical: chain,
    finalityBlock,
  };
}

/**
 * Composes the trusted server runtime. It is intentionally not imported by
 * the default CLI path; set RISK_RUNTIME_MODULE explicitly to start it.
 */
export async function createRiskRuntime(
  service: AurkaService,
  dependencies: RiskRuntimeDependencies = {},
): Promise<RiskRuntime> {
  const environment = dependencies.env ?? process.env;
  const config = dependencies.config
    ? parseRiskRuntimeConfig(dependencies.config)
    : loadRiskRuntimeConfig(environment);
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const rpc = dependencies.rpc ?? new JsonRpcHttpTransport(config.rpcUrl);
  const chain = new CanonicalRpcReader(
    rpc,
    config.chainId,
    config.finalityMaxAgeSeconds,
    now,
  );
  await chain.assertDeployment(config.policyRegistry, config.riskRegistry);

  const getWalletPolicy =
    dependencies.getWalletPolicy ??
    (async (walletId: string, reference: string) => {
      if (!config.walletPolicyModule)
        throw new Error("A Privy runtime requires RISK_WALLET_POLICY_MODULE");
      const module = await loadOperatorModule(config.walletPolicyModule);
      if (!module.getWalletPolicy)
        throw new Error("Wallet policy module must export getWalletPolicy");
      return module.getWalletPolicy(walletId, reference);
    });
  const authorize: RiskWorkerOptions["authorize"] = dependencies.authorize
    ? async (request) =>
        requireAuthorizationContext(await dependencies.authorize!(request))
    : async (request) => {
        if (!config.authorizationModule)
          throw new Error("A Privy runtime requires RISK_AUTHORIZATION_MODULE");
        const module = await loadOperatorModule(config.authorizationModule);
        if (!module.authorize)
          throw new Error("Authorization module must export authorize");
        return requireAuthorizationContext(await module.authorize(request));
      };

  let wallet = dependencies.wallet;
  if (!wallet) {
    const privy =
      dependencies.privyClient ?? (await createPrivyNodeClientFromEnv());
    wallet = new PrivyWalletAdapter(privy, {
      walletId: config.walletId,
      refreshPolicy: async () =>
        getWalletPolicy(config.walletId, config.walletPolicyReference),
      readRiskAuthority: async (policyId, watchtower) =>
        chain.readRiskAuthority(
          policyId,
          watchtower,
          config.policyRegistry,
          config.riskRegistry,
        ),
      rpc: {
        // Privy uses request(method, params); service transports use an
        // EIP-1193 object. Keep this bridge explicit at the boundary.
        request: (method, params) => rpc.request({ method, params }),
      },
      now,
    });
  }
  const walletPolicy = await wallet.getPolicy();
  assertWalletPolicy(walletPolicy, config);
  const signerStatus = await wallet.getSignerStatus();
  if (!signerStatus.enabled || signerStatus.revoked)
    throw new Error("Configured risk signer is disabled or revoked");

  const sourcesByPosition = new Map<
    string,
    readonly ReturnType<typeof graphSource>[]
  >();
  for (const position of config.positions) {
    const sources = position.sources.map((source) => {
      const graph = graphSource(
        source,
        config.chainId,
        environment,
        dependencies.graphFetch,
        now,
      );
      return graph;
    });
    sourcesByPosition.set(position.positionId, sources);
  }

  const context = async (positionId: string): Promise<RegistryContext> => {
    const configured = positionConfig(config, positionId);
    const position = service.getPosition(positionId);
    if (
      position.chainId !== config.chainId ||
      position.policy.id.toLowerCase() !== configured.policyId.toLowerCase()
    )
      throw new Error(
        `Service position ${positionId} is not bound to the trusted runtime policy`,
      );
    const value = await chain.readContext(
      configured.policyId,
      configured.watchtower,
      config.policyRegistry,
      config.riskRegistry,
    );
    if (value.policyId.toLowerCase() !== configured.policyId.toLowerCase())
      throw new Error("Registry context policy mismatch");
    return value;
  };

  // Fail during composition, before the polling loop can sign anything, if a
  // selected position, hard policy, registry authority or reviewed bounds hash
  // is not the deployment described by the operator configuration.
  for (const configured of config.positions) {
    const authority = await context(configured.positionId);
    if (!authority.authorized)
      throw new Error(
        `Configured watchtower is not authorized for ${configured.positionId}`,
      );
    const snapshot = await chain.finalized();
    const policy = await chain.readPolicy(
      configured.policyId,
      config.policyRegistry,
      snapshot,
    );
    const position = service.getPosition(configured.positionId);
    if (
      position.policy.nonce !== policy.policyNonce ||
      position.policy.maximumTransactionValue !==
        policy.maximumTransactionValue ||
      position.policy.paused !== policy.paused ||
      hashActiveBounds(policy.hardBounds).toLowerCase() !==
        configured.approvedHardBoundsHash.toLowerCase()
    )
      throw new Error(
        `Canonical policy does not match the trusted runtime for ${configured.positionId}`,
      );
  }

  const evaluation = async (positionId: string) => {
    const configured = positionConfig(config, positionId);
    const position = service.getPosition(positionId);
    if (
      position.chainId !== config.chainId ||
      position.policy.id.toLowerCase() !== configured.policyId.toLowerCase()
    )
      throw new Error(
        `Service position ${positionId} is not bound to the trusted runtime policy`,
      );
    const finalized = await chain.finalized();
    const policy = await chain.readPolicy(
      configured.policyId,
      config.policyRegistry,
      finalized,
    );
    if (
      position.policy.nonce !== policy.policyNonce ||
      position.policy.maximumTransactionValue !==
        policy.maximumTransactionValue ||
      position.policy.paused !== policy.paused
    )
      throw new Error(
        "Persisted service policy is stale relative to the canonical registry",
      );
    const hardBoundsHash = hashActiveBounds(policy.hardBounds);
    if (
      hardBoundsHash.toLowerCase() !==
      configured.approvedHardBoundsHash.toLowerCase()
    )
      throw new Error(
        `Canonical hard bounds do not match the approved ${positionId} hash`,
      );

    const observations: z.input<typeof riskObservationSchema>[] = [];
    const sourceFailures: string[] = [];
    const sources = sourcesByPosition.get(positionId)!;
    for (const [index, sourceConfig] of configured.sources.entries()) {
      try {
        const source = sources[index]!;
        const fetched = await source.fetchObservations(
          sourceToObservationOptions(
            sourceConfig,
            chain,
            finalized.number,
            now(),
          ),
        );
        observations.push(
          ...fetched.map((observation) => ({
            ...observation,
            affectedAssets: [...observation.affectedAssets],
            payload: { ...observation.payload },
          })),
        );
      } catch {
        // Preserve the outage as structured fail-safe input. Error text can
        // contain URLs or provider data and is deliberately not persisted.
        sourceFailures.push(sourceConfig.sourceId);
      }
    }
    const canonicalBlockHashes: Record<string, string> = {};
    for (const observation of observations) {
      if (canonicalBlockHashes[observation.indexedBlock] === undefined) {
        try {
          const blockHash = await chain.getBlockHash(
            BigInt(observation.indexedBlock),
          );
          if (blockHash === undefined)
            sourceFailures.push(`rpc:${observation.sourceId.slice(0, 124)}`);
          else canonicalBlockHashes[observation.indexedBlock] = blockHash;
        } catch {
          sourceFailures.push(`rpc:${observation.sourceId.slice(0, 124)}`);
        }
      }
    }
    canonicalBlockHashes[finalized.number.toString()] = finalized.hash;
    return {
      positionId,
      observations,
      sourceFailures: [...new Set(sourceFailures)],
      configuration: configured.configuration,
      hardMaximumTradeValue: policy.maximumTransactionValue,
      hardBounds: policy.hardBounds.map((bound) => ({ ...bound })),
      chainId: config.chainId,
      deploymentId: configured.deploymentId,
      canonicalBlock: finalized.number.toString(),
      canonicalBlockHashes,
      nowSeconds: now(),
    };
  };

  const sources: RiskWorkerSources = {
    context,
    evaluation,
    receipt: (hash) => chain.receipt(hash),
    canonicalHash: async (blockNumber) =>
      (await chain.getBlockHash(BigInt(blockNumber))) ?? null,
    finalizedBlock: () => chain.finalizedBlock(),
  };
  const readRisk = createRegistryRiskReader({
    rpc,
    chainId: config.chainId,
    registry: config.riskRegistry as Hex,
    policyRegistry: config.policyRegistry as Hex,
    maximumAgeSeconds: config.finalityMaxAgeSeconds,
    now,
  });
  service.riskService.configureCertificateRegistry(config.riskRegistry);
  service.riskService.configureRegistryReader(readRisk);
  const workerOptions: RiskWorkerOptions = {
    repository: service.repository,
    risk: service.riskService,
    wallet,
    sources,
    authorize,
    now,
    certificateLifetimeSeconds: config.certificateLifetimeSeconds,
    renewalLeadSeconds: config.renewalLeadSeconds,
  };
  const worker = new RiskCertificateWorker(workerOptions);

  const readiness: ReadinessProbeSet = {
    rpc: async (): Promise<RpcReadiness> => {
      const finalized = await chain.finalized();
      const latest = await chain.getLatestBlock();
      const latestHash = await chain.getBlockHash(latest);
      if (latestHash === undefined) throw new Error("latest_head_unavailable");
      return {
        state: "healthy",
        observedAt: now(),
        reason: null,
        chainId: config.chainId,
        expectedChainId: config.chainId,
        latestBlock: latest.toString(),
        canonicalBlock: latest.toString(),
        canonicalBlockHash: latestHash,
        finalizedBlock: finalized.number.toString(),
        finalizedBlockHash: finalized.hash,
        finalizedAt: finalized.timestamp,
      };
    },
    sources: async (): Promise<SourcesReadiness> => {
      const sourceChecks: SourcesReadiness["sources"] = [];
      for (const configured of config.positions) {
        try {
          const input = await evaluation(configured.positionId);
          const failures = new Set(input.sourceFailures);
          for (const source of configured.sources) {
            const observations = input.observations.filter(
              (observation) => observation.sourceId === source.sourceId,
            );
            const latest = observations.toSorted(
              (left, right) => right.observedAt - left.observedAt,
            )[0];
            const failed =
              failures.has(source.sourceId) ||
              failures.has(`rpc:${source.sourceId.slice(0, 124)}`) ||
              !latest;
            sourceChecks.push({
              state: failed ? "unhealthy" : "healthy",
              observedAt: now(),
              reason: failed
                ? failures.has(source.sourceId)
                  ? "source_probe_failed"
                  : "no_fresh_observations"
                : null,
              sourceId: source.sourceId,
              lastObservedAt: latest?.observedAt ?? null,
              indexedBlock: latest?.indexedBlock ?? null,
              lagBlocks: latest
                ? Number(
                    BigInt(input.canonicalBlock) - BigInt(latest.indexedBlock),
                  )
                : null,
            });
          }
        } catch {
          for (const source of configured.sources)
            sourceChecks.push({
              state: "unhealthy",
              observedAt: now(),
              reason: "source_probe_failed",
              sourceId: source.sourceId,
              lastObservedAt: null,
              indexedBlock: null,
              lagBlocks: null,
            });
        }
      }
      const healthy =
        sourceChecks.length > 0 &&
        sourceChecks.every((source) => source.state === "healthy");
      return {
        state: healthy ? "healthy" : "unhealthy",
        observedAt: now(),
        reason: healthy ? null : "source_not_fresh",
        sources: sourceChecks,
      };
    },
    worker: async (): Promise<WorkerReadiness> => {
      const diagnostics = worker.getDiagnostics();
      const completed = diagnostics.lastCompletedAt;
      const staleAfter = Math.max(
        ...config.positions.map(
          (position) => position.configuration.maxObservationAgeSeconds,
        ),
      );
      const stale = completed === null || now() - completed > staleAfter;
      const unhealthy = diagnostics.lastError !== null || stale;
      return {
        state: unhealthy ? "unhealthy" : "healthy",
        observedAt: now(),
        reason: diagnostics.lastError
          ? "worker_failed"
          : stale
            ? "worker_stale"
            : null,
        lastAttemptAt: diagnostics.lastAttemptAt,
        lastCompletedAt: completed,
        leaseExpiresAt: diagnostics.leaseExpiresAt,
        inFlight: diagnostics.inFlight,
      };
    },
    signer: async (): Promise<SignerReadiness> => {
      const [policy, status] = await Promise.all([
        wallet!.getPolicy(),
        wallet!.getSignerStatus(),
      ]);
      const expired = status.expiresAt <= now() || policy.validUntil <= now();
      const healthy = status.enabled && !status.revoked && !expired;
      return {
        state: healthy ? "healthy" : "unhealthy",
        observedAt: now(),
        reason: healthy
          ? null
          : status.revoked
            ? "signer_revoked"
            : !status.enabled
              ? "signer_disabled"
              : "signer_expired",
        address: status.address,
        enabled: status.enabled,
        revoked: status.revoked,
        expiresAt: Math.min(status.expiresAt, policy.validUntil),
        policyFingerprint: status.policyFingerprint,
      };
    },
    registry: async (): Promise<RegistryReadiness> => {
      let effective: Awaited<ReturnType<typeof readRisk>> | undefined;
      for (const position of config.positions) {
        const value = await readRisk(position.positionId, position.policyId);
        if (value.source === "UNAVAILABLE")
          throw new Error("effective_registry_read_unavailable");
        effective = value;
      }
      return {
        state: "healthy",
        observedAt: now(),
        reason: null,
        source: effective?.source ?? "UNAVAILABLE",
        mode: effective?.mode ?? null,
        effectiveObservedAt: effective?.observedAt ?? null,
      };
    },
  };
  return {
    worker,
    positions: config.positions.map((position) => position.positionId),
    readRisk,
    riskRegistry: config.riskRegistry,
    sources,
    config,
    readiness,
  };
}
