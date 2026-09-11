import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import type { PrivyClient } from "@privy-io/node";
import {
  decodeFunctionData,
  encodeFunctionData,
  recoverAddress,
  type Hex,
} from "viem";
import {
  hashActiveBounds,
  hashRiskCertificate,
  riskCertificateSchema,
  RISK_CERTIFICATE_EIP712_TYPE,
  type RiskCertificate,
} from "@aurka/shared";
import { routerAbi } from "./routerAbi.js";
import { riskRegistryAbi } from "./riskRegistryAbi.js";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const walletRoleSchema = z.enum(["EXECUTION", "RISK"]);
export type WalletRole = z.infer<typeof walletRoleSchema>;

export const authorizationContextSchema = z
  .object({
    signatures: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).min(1),
  })
  .strict();
export type AuthorizationContext = z.infer<typeof authorizationContextSchema>;

export const walletPolicySchema = z
  .object({
    policyId: z.string().min(1).max(128),
    role: walletRoleSchema,
    chainId: z.number().int().positive().safe(),
    router: addressSchema,
    riskRegistry: addressSchema,
    allowedMethods: z
      .array(
        z.enum(["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"]),
      )
      .min(1),
    allowedSelectors: z.array(z.string().regex(/^0x[0-9a-fA-F]{8}$/)),
    calldataRules: z.array(
      z
        .object({
          selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
          wordCount: z.number().int().nonnegative(),
          assetWord: z.number().int().nonnegative().optional(),
          amountWord: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
    approvedAssets: z.array(addressSchema),
    maximumNativeValue: uintSchema,
    maximumTokenAmount: uintSchema,
    validUntil: z.number().int().nonnegative().safe(),
    paused: z.boolean(),
    revoked: z.boolean(),
    signerAddress: addressSchema,
    approvedRiskBoundsHashes: z.array(bytes32Schema).default([]),
    fingerprint: bytes32Schema,
  })
  .strict();
export type WalletPolicy = z.infer<typeof walletPolicySchema>;

export const walletActionSchema = z
  .object({
    operation: z.enum(["ROUTER_EXECUTE", "RISK_CERTIFICATE"]),
    chainId: z.number().int().positive().safe(),
    to: addressSchema,
    data: z.string().regex(/^0x[0-9a-fA-F]*$/),
    value: uintSchema,
    asset: addressSchema.optional(),
    amount: uintSchema.optional(),
    expiresAt: z.number().int().nonnegative().safe(),
    policyFingerprint: bytes32Schema,
  })
  .strict();
export type WalletAction = z.infer<typeof walletActionSchema>;

export const signerStatusSchema = z
  .object({
    walletId: z.string().min(1).max(128),
    role: walletRoleSchema,
    address: addressSchema,
    enabled: z.boolean(),
    revoked: z.boolean(),
    expiresAt: z.number().int().nonnegative().safe(),
    policyFingerprint: bytes32Schema,
  })
  .strict();
export type SignerStatus = z.infer<typeof signerStatusSchema>;

export interface WalletTransactionResult {
  readonly walletId: string;
  readonly status: "SIMULATED" | "SUBMITTED";
  readonly transactionHash?: string;
  readonly policyFingerprint: string;
}

export interface AurkaWalletAdapter {
  getSignerStatus(): Promise<SignerStatus>;
  getPolicy(): Promise<WalletPolicy>;
  signTypedData(
    certificate: RiskCertificate,
    context: AuthorizationContext,
  ): Promise<string>;
  simulateAndSend(
    action: WalletAction,
    context: AuthorizationContext,
  ): Promise<WalletTransactionResult>;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function fingerprint(value: Omit<WalletPolicy, "fingerprint">): string {
  return `0x${Array.from(keccak_256(new TextEncoder().encode(canonical(value))), (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

export function createWalletPolicy(
  input: Omit<WalletPolicy, "fingerprint" | "approvedRiskBoundsHashes"> & {
    approvedRiskBoundsHashes?: string[];
  },
): WalletPolicy {
  const parsed = walletPolicySchema.omit({ fingerprint: true }).parse(input);
  return walletPolicySchema.parse({
    ...parsed,
    fingerprint: fingerprint(parsed),
  });
}

function selector(data: string): string {
  if (data.length < 10)
    throw new Error("Calldata is missing a 4-byte selector");
  return data.slice(0, 10).toLowerCase();
}

function calldataWord(data: string, index: number): string {
  const word = data.slice(10 + index * 64, 10 + (index + 1) * 64);
  if (word.length !== 64)
    throw new Error("Calldata is shorter than the approved layout");
  return word;
}

function enforceMethod(
  policy: WalletPolicy,
  method: "eth_call" | "eth_sendTransaction" | "eth_signTypedData_v4",
): void {
  if (!policy.allowedMethods.includes(method))
    throw new Error(`Wallet RPC method ${method} is not approved`);
}

function enforce(
  action: WalletAction,
  policy: WalletPolicy,
  nowSeconds: number,
): void {
  walletActionSchema.parse(action);
  if (policy.paused || policy.revoked || !policy.signerAddress)
    throw new Error("Wallet policy is paused or revoked");
  if (
    nowSeconds >= policy.validUntil ||
    action.expiresAt > policy.validUntil ||
    nowSeconds >= action.expiresAt
  )
    throw new Error("Wallet policy or action is expired");
  if (action.chainId !== policy.chainId)
    throw new Error("Wallet action chain mismatch");
  if (
    action.policyFingerprint.toLowerCase() !== policy.fingerprint.toLowerCase()
  )
    throw new Error("Wallet policy fingerprint mismatch");
  const target =
    action.operation === "RISK_CERTIFICATE"
      ? policy.riskRegistry
      : policy.router;
  if (action.to.toLowerCase() !== target.toLowerCase())
    throw new Error("Wallet action target is not approved");
  const actionSelector = selector(action.data);
  if (!policy.allowedSelectors.includes(actionSelector))
    throw new Error("Wallet action selector is not approved");
  const rule = policy.calldataRules.find(
    (candidate) => candidate.selector.toLowerCase() === actionSelector,
  );
  if (!rule || action.data.length !== 10 + rule.wordCount * 64)
    throw new Error("Wallet calldata does not match the approved layout");
  if (
    rule.assetWord !== undefined &&
    action.asset?.toLowerCase() !==
      `0x${calldataWord(action.data, rule.assetWord).slice(24).toLowerCase()}`
  )
    throw new Error("Wallet calldata asset does not match the approved asset");
  if (
    rule.amountWord !== undefined &&
    (action.amount === undefined ||
      BigInt(`0x${calldataWord(action.data, rule.amountWord)}`) !==
        BigInt(action.amount))
  )
    throw new Error(
      "Wallet calldata amount does not match the approved amount",
    );
  if (BigInt(action.value) > BigInt(policy.maximumNativeValue))
    throw new Error("Wallet native value cap exceeded");
  if (
    action.asset !== undefined &&
    !policy.approvedAssets.some(
      (asset) => asset.toLowerCase() === action.asset!.toLowerCase(),
    )
  )
    throw new Error("Wallet asset is not approved");
  if (
    action.amount !== undefined &&
    BigInt(action.amount) > BigInt(policy.maximumTokenAmount)
  )
    throw new Error("Wallet token cap exceeded");
  if (action.operation === "ROUTER_EXECUTE" && policy.role !== "EXECUTION")
    throw new Error("Risk signer cannot execute trades");
  if (action.operation === "RISK_CERTIFICATE" && policy.role !== "RISK")
    throw new Error("Execution signer cannot submit risk certificates");
}

function requireAuthorization(context: AuthorizationContext): void {
  if (authorizationContextSchema.safeParse(context).success === false)
    throw new Error("Privy authorization signature is required");
}

export class FakeWalletAdapter implements AurkaWalletAdapter {
  readonly calls: WalletAction[] = [];
  constructor(
    private readonly walletId: string,
    private readonly policy: WalletPolicy,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async getSignerStatus(): Promise<SignerStatus> {
    return signerStatusSchema.parse({
      walletId: this.walletId,
      role: this.policy.role,
      address: this.policy.signerAddress,
      enabled: !this.policy.paused && !this.policy.revoked,
      revoked: this.policy.revoked,
      expiresAt: this.policy.validUntil,
      policyFingerprint: this.policy.fingerprint,
    });
  }

  async getPolicy(): Promise<WalletPolicy> {
    return this.policy;
  }

  async signTypedData(
    certificate: RiskCertificate,
    context: AuthorizationContext,
  ): Promise<string> {
    requireAuthorization(context);
    assertRiskCertificate(certificate, this.policy, this.now());
    throw new Error(
      "Fake wallet signing requires an explicit test signer; no synthetic signature is returned",
    );
  }

  async simulateAndSend(
    action: WalletAction,
    context: AuthorizationContext,
  ): Promise<WalletTransactionResult> {
    requireAuthorization(context);
    enforce(action, this.policy, this.now());
    enforceMethod(this.policy, "eth_sendTransaction");
    this.calls.push(action);
    const transactionHash = `0x${Array.from(keccak_256(new TextEncoder().encode(`${this.walletId}:${this.calls.length}:${canonical(action)}`)), (item) => item.toString(16).padStart(2, "0")).join("")}`;
    return {
      walletId: this.walletId,
      status: "SUBMITTED",
      transactionHash,
      policyFingerprint: this.policy.fingerprint,
    };
  }
}

type EthereumService = ReturnType<
  ReturnType<PrivyClient["wallets"]>["ethereum"]
>;
export interface PrivyNodeClient {
  wallets(): {
    ethereum(): Pick<EthereumService, "signTypedData" | "sendTransaction">;
  };
}
export interface RiskAuthority {
  policyNonce: string;
  watchtowerAuthorizationEpoch: string;
  nextNonce: string;
  authorized: boolean;
}
export interface ChainRpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}
export interface PrivyWalletAdapterOptions {
  readonly walletId: string;
  readonly refreshPolicy: () => Promise<WalletPolicy>;
  readonly readRiskAuthority: (
    policyId: string,
    watchtower: string,
  ) => Promise<RiskAuthority>;
  readonly rpc: ChainRpc;
  readonly now?: () => number;
}
function assertRiskCertificate(
  raw: RiskCertificate,
  policy: WalletPolicy,
  now: number,
): RiskCertificate {
  const certificate = riskCertificateSchema.parse(raw);
  if (policy.paused || policy.revoked || now >= policy.validUntil)
    throw new Error("Wallet policy is expired, paused or revoked");
  if (
    policy.role !== "RISK" ||
    certificate.watchtower.toLowerCase() !== policy.signerAddress.toLowerCase()
  )
    throw new Error("Risk signer mismatch");
  if (
    certificate.chainId !== policy.chainId ||
    certificate.verifyingContract.toLowerCase() !==
      policy.riskRegistry.toLowerCase() ||
    certificate.policyId.toLowerCase() !== policy.policyId.toLowerCase()
  )
    throw new Error("Risk certificate domain mismatch");
  if (
    certificate.issuedAt > now ||
    certificate.expiresAt <= now ||
    certificate.expiresAt > policy.validUntil
  )
    throw new Error("Risk certificate expiry mismatch");
  if (BigInt(certificate.maximumTradeValue) > BigInt(policy.maximumTokenAmount))
    throw new Error("Risk certificate cap exceeded");
  if (
    certificate.riskMode === "PAUSED" &&
    certificate.maximumTradeValue !== "0"
  )
    throw new Error("Paused certificate capacity must be zero");
  const boundsHash = hashActiveBounds(certificate.activeBounds);
  if (
    boundsHash !== certificate.activeBoundsHash ||
    !policy.approvedRiskBoundsHashes.includes(boundsHash)
  )
    throw new Error("Risk bounds are not approved");
  if (
    certificate.riskMode !== "PAUSED" &&
    (certificate.activeBounds.reduce((n, b) => n + b.minimumWeightBps, 0) >
      10000 ||
      certificate.activeBounds.reduce((n, b) => n + b.maximumWeightBps, 0) <
        10000)
  )
    throw new Error("Infeasible risk bounds");
  return certificate;
}
export function encodeRiskSubmission(certificate: RiskCertificate): Hex {
  const { signature } = certificate;
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new Error("A valid risk signature is required");
  return encodeFunctionData({
    abi: riskRegistryAbi,
    functionName: "submitRiskCertificate",
    args: [
      {
        policyId: certificate.policyId as Hex,
        riskMode: { NORMAL: 0, CAUTIOUS: 1, SHOCK: 2, PAUSED: 3 }[
          certificate.riskMode
        ],
        activeBoundsHash: certificate.activeBoundsHash as Hex,
        maximumTradeValue: BigInt(certificate.maximumTradeValue),
        sourceDigest: certificate.sourceDigest as Hex,
        reasonCode: certificate.reasonCode as Hex,
        issuedAt: BigInt(certificate.issuedAt),
        expiresAt: BigInt(certificate.expiresAt),
        nonce: BigInt(certificate.nonce),
        watchtower: certificate.watchtower as Hex,
        watchtowerAuthorizationEpoch: BigInt(
          certificate.watchtowerAuthorizationEpoch,
        ),
        policyNonce: BigInt(certificate.policyNonce),
      },
      certificate.activeBounds.map((b) => ({ ...b, token: b.token as Hex })),
      signature as Hex,
    ],
  });
}
export class PrivyWalletAdapter implements AurkaWalletAdapter {
  private readonly now: () => number;
  constructor(
    private readonly client: PrivyNodeClient,
    private readonly options: PrivyWalletAdapterOptions,
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  async getPolicy(): Promise<WalletPolicy> {
    const policy = walletPolicySchema.parse(await this.options.refreshPolicy());
    const { fingerprint: expected, ...values } = policy;
    if (fingerprint(values) !== expected)
      throw new Error("Wallet policy fingerprint is not authentic");
    return policy;
  }
  async getSignerStatus(): Promise<SignerStatus> {
    const policy = await this.getPolicy();
    return {
      walletId: this.options.walletId,
      role: policy.role,
      address: policy.signerAddress,
      enabled:
        !policy.paused && !policy.revoked && this.now() < policy.validUntil,
      revoked: policy.revoked,
      expiresAt: policy.validUntil,
      policyFingerprint: policy.fingerprint,
    };
  }
  private async assertAuthority(certificate: RiskCertificate): Promise<void> {
    const state = await this.options.readRiskAuthority(
      certificate.policyId,
      certificate.watchtower,
    );
    if (
      !state.authorized ||
      state.policyNonce !== certificate.policyNonce ||
      state.watchtowerAuthorizationEpoch !==
        certificate.watchtowerAuthorizationEpoch ||
      state.nextNonce !== certificate.nonce
    )
      throw new Error("Risk registry authority changed");
  }
  private async assertChain(chainId: number): Promise<void> {
    const actual = await this.options.rpc.request("eth_chainId", []);
    if (
      typeof actual !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(actual) ||
      BigInt(actual) !== BigInt(chainId)
    )
      throw new Error("RPC chain mismatch");
  }
  async signTypedData(
    raw: RiskCertificate,
    context: AuthorizationContext,
  ): Promise<string> {
    requireAuthorization(context);
    const policy = await this.getPolicy();
    enforceMethod(policy, "eth_signTypedData_v4");
    const certificate = assertRiskCertificate(raw, policy, this.now());
    await this.assertChain(policy.chainId);
    await this.assertAuthority(certificate);
    const fields = RISK_CERTIFICATE_EIP712_TYPE.slice(
      RISK_CERTIFICATE_EIP712_TYPE.indexOf("(") + 1,
      -1,
    )
      .split(",")
      .map((field) => {
        const [type, name] = field.split(" ");
        return { type: type!, name: name! };
      });
    const message: Record<string, unknown> = Object.fromEntries(
      fields.map((field) => [
        field.name,
        certificate[field.name as keyof RiskCertificate],
      ]),
    );
    message.riskMode = { NORMAL: 0, CAUTIOUS: 1, SHOCK: 2, PAUSED: 3 }[
      certificate.riskMode
    ];
    const result = await this.client
      .wallets()
      .ethereum()
      .signTypedData(this.options.walletId, {
        params: {
          typed_data: {
            domain: {
              name: "AURKA RiskModeRegistry",
              version: "2",
              chain_id: policy.chainId,
              verifying_contract: policy.riskRegistry,
            },
            types: { RiskCertificate: fields },
            primary_type: "RiskCertificate",
            message,
          },
        },
        authorization_context: context,
      });
    if (
      result.encoding !== "hex" ||
      !/^0x[0-9a-fA-F]{130}$/.test(result.signature)
    )
      throw new Error("Malformed Privy signature");
    const signer = await recoverAddress({
      hash: hashRiskCertificate(certificate) as Hex,
      signature: result.signature as Hex,
    });
    if (signer.toLowerCase() !== policy.signerAddress.toLowerCase())
      throw new Error("Privy signature signer mismatch");
    await this.assertAuthority(certificate);
    const refreshed = await this.getPolicy();
    if (refreshed.fingerprint !== policy.fingerprint)
      throw new Error("Wallet policy changed during signing");
    assertRiskCertificate(certificate, refreshed, this.now());
    return result.signature;
  }
  async simulateAndSend(
    raw: WalletAction,
    context: AuthorizationContext,
  ): Promise<WalletTransactionResult> {
    requireAuthorization(context);
    const action = walletActionSchema.parse(raw),
      policy = await this.getPolicy();
    // Dynamic ABI layouts are decoded below, not trusted as caller metadata.
    const policyForLayout = {
      ...policy,
      calldataRules: [
        {
          selector: selector(action.data),
          wordCount: (action.data.length - 10) / 64,
        },
      ],
    };
    enforce(action, policyForLayout, this.now());
    enforceMethod(policy, "eth_call");
    enforceMethod(policy, "eth_sendTransaction");
    if (action.operation === "ROUTER_EXECUTE") {
      const decoded = decodeFunctionData({
        abi: routerAbi,
        data: action.data as Hex,
      });
      if (
        decoded.functionName !== "execute" &&
        decoded.functionName !== "executeWithSwapVM"
      )
        throw new Error("Unapproved router method");
      const [intent, , proposal] = decoded.args;
      if (
        intent.policyId.toLowerCase() !== policy.policyId.toLowerCase() ||
        intent.deadline < BigInt(this.now()) ||
        intent.deadline > BigInt(policy.validUntil) ||
        proposal.deadline > BigInt(policy.validUntil)
      )
        throw new Error("Execution policy or deadline mismatch");
      for (const token of [
        intent.traderInputToken,
        intent.traderOutputToken,
        proposal.feeToken,
      ])
        if (
          !policy.approvedAssets.some(
            (asset) => asset.toLowerCase() === token.toLowerCase(),
          )
        )
          throw new Error("Decoded asset is not approved");
      for (const amount of [
        proposal.traderInputAmount,
        proposal.traderOutputAmount +
          proposal.solverFeeAmount +
          proposal.protocolFeeAmount,
      ])
        if (amount > BigInt(policy.maximumTokenAmount))
          throw new Error("Decoded token cap exceeded");
      if (
        encodeFunctionData({
          abi: routerAbi,
          functionName: decoded.functionName,
          args: decoded.args,
        }).toLowerCase() !== action.data.toLowerCase()
      )
        throw new Error("Noncanonical router calldata");
    } else {
      const decoded = decodeFunctionData({
        abi: riskRegistryAbi,
        data: action.data as Hex,
      });
      const [c, bounds, signature] = decoded.args;
      const modes = ["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"] as const;
      const certificate = assertRiskCertificate(
        {
          policyId: c.policyId,
          chainId: policy.chainId,
          verifyingContract: policy.riskRegistry,
          signatureVersion: 2,
          riskMode: modes[c.riskMode]!,
          activeBounds: [...bounds],
          activeBoundsHash: c.activeBoundsHash,
          maximumTradeValue: c.maximumTradeValue.toString(),
          sourceDigest: c.sourceDigest,
          reasonCode: c.reasonCode,
          issuedAt: Number(c.issuedAt),
          expiresAt: Number(c.expiresAt),
          nonce: c.nonce.toString(),
          watchtower: c.watchtower,
          watchtowerAuthorizationEpoch:
            c.watchtowerAuthorizationEpoch.toString(),
          policyNonce: c.policyNonce.toString(),
          signature,
        },
        policy,
        this.now(),
      );
      if (
        encodeRiskSubmission(certificate).toLowerCase() !==
        action.data.toLowerCase()
      )
        throw new Error("Noncanonical risk calldata");
      await this.assertAuthority(certificate);
    }
    await this.assertChain(policy.chainId);
    const transaction = {
      to: action.to,
      data: action.data,
      value: `0x${BigInt(action.value).toString(16)}`,
    };
    const simulation = await this.options.rpc.request("eth_call", [
      { ...transaction, from: policy.signerAddress },
      "latest",
    ]);
    if (
      typeof simulation !== "string" ||
      !/^0x([0-9a-fA-F]{2})*$/.test(simulation) ||
      simulation.length !== (action.operation === "RISK_CERTIFICATE" ? 66 : 194)
    )
      throw new Error("Invalid simulation result");
    const latest = await this.getPolicy();
    if (
      latest.fingerprint !== policy.fingerprint ||
      latest.revoked ||
      latest.paused ||
      this.now() >= latest.validUntil
    )
      throw new Error("Wallet policy changed during simulation");
    const result = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(this.options.walletId, {
        caip2: `eip155:${policy.chainId}`,
        params: { transaction },
        authorization_context: context,
        idempotency_key: `aurka:${fingerprint({ ...policy, policyId: action.data })}`,
      });
    if (
      result.caip2 !== `eip155:${policy.chainId}` ||
      !/^0x[0-9a-fA-F]{64}$/.test(result.hash)
    )
      throw new Error("Malformed Privy transaction response");
    return {
      walletId: this.options.walletId,
      status: "SUBMITTED",
      transactionHash: result.hash,
      policyFingerprint: policy.fingerprint,
    };
  }
}
export async function createPrivyNodeClientFromEnv(): Promise<PrivyNodeClient> {
  const appId = process.env.PRIVY_APP_ID,
    appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret)
    throw new Error(
      "PRIVY_APP_ID and PRIVY_APP_SECRET are required at runtime",
    );
  const { PrivyClient } = await import("@privy-io/node");
  return new PrivyClient({ appId, appSecret });
}

export * from "./delegated.js";
