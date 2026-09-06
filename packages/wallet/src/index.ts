import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

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
      .array(z.enum(["eth_call", "eth_sendTransaction", "eth_sign"]))
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
  signTypedData(digest: string, context: AuthorizationContext): Promise<string>;
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
  input: Omit<WalletPolicy, "fingerprint">,
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
  method: "eth_call" | "eth_sendTransaction" | "eth_sign",
): void {
  if (!policy.allowedMethods.includes(method))
    throw new Error(`Wallet RPC method ${method} is not approved`);
}

function enforce(
  action: WalletAction,
  policy: WalletPolicy,
  nowSeconds: number,
): void {
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
    digest: string,
    context: AuthorizationContext,
  ): Promise<string> {
    requireAuthorization(context);
    if (this.policy.role !== "RISK")
      throw new Error("Only the risk signer may sign risk certificates");
    enforceMethod(this.policy, "eth_sign");
    if (!bytes32Schema.safeParse(digest).success)
      throw new Error("Typed-data digest must be bytes32");
    enforce(
      {
        operation: "RISK_CERTIFICATE",
        chainId: this.policy.chainId,
        to: this.policy.riskRegistry,
        data: "0x00000000",
        value: "0",
        expiresAt: this.policy.validUntil,
        policyFingerprint: this.policy.fingerprint,
      },
      {
        ...this.policy,
        allowedSelectors: ["0x00000000"],
        calldataRules: [{ selector: "0x00000000", wordCount: 0 }],
      },
      this.now(),
    );
    return digest;
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

/** Minimal structural surface of the current `@privy-io/node` wallet RPC. */
export interface PrivyNodeClient {
  wallets(): {
    rpc(
      walletId: string,
      request: {
        readonly method: string;
        readonly params?: unknown;
        readonly authorization_context?: AuthorizationContext;
      },
    ): Promise<unknown>;
  };
}

export interface PrivyWalletAdapterOptions {
  readonly walletId: string;
  readonly policy: WalletPolicy;
  readonly authorizationContext: AuthorizationContext;
  readonly now?: () => number;
}

function responseString(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["signature", "result", "hash", "transactionHash"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  throw new Error(`Privy response did not contain ${name}`);
}

/**
 * Server-only adapter. It never accepts a private key and passes a caller
 * supplied authorization signature to each sensitive Privy RPC request.
 */
export class PrivyWalletAdapter implements AurkaWalletAdapter {
  private readonly now: () => number;
  private readonly context: AuthorizationContext;
  constructor(
    private readonly client: PrivyNodeClient,
    private readonly options: PrivyWalletAdapterOptions,
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.context = authorizationContextSchema.parse(
      options.authorizationContext,
    );
  }

  async getSignerStatus(): Promise<SignerStatus> {
    return signerStatusSchema.parse({
      walletId: this.options.walletId,
      role: this.options.policy.role,
      address: this.options.policy.signerAddress,
      enabled: !this.options.policy.paused && !this.options.policy.revoked,
      revoked: this.options.policy.revoked,
      expiresAt: this.options.policy.validUntil,
      policyFingerprint: this.options.policy.fingerprint,
    });
  }

  async getPolicy(): Promise<WalletPolicy> {
    return this.options.policy;
  }

  async signTypedData(
    digest: string,
    context: AuthorizationContext,
  ): Promise<string> {
    requireAuthorization(context);
    enforceMethod(this.options.policy, "eth_sign");
    enforce(
      {
        operation: "RISK_CERTIFICATE",
        chainId: this.options.policy.chainId,
        to: this.options.policy.riskRegistry,
        data: "0x00000000",
        value: "0",
        expiresAt: this.options.policy.validUntil,
        policyFingerprint: this.options.policy.fingerprint,
      },
      {
        ...this.options.policy,
        allowedSelectors: ["0x00000000"],
        calldataRules: [{ selector: "0x00000000", wordCount: 0 }],
      },
      this.now(),
    );
    const result = await this.client.wallets().rpc(this.options.walletId, {
      method: "eth_sign",
      params: [this.options.policy.signerAddress, digest],
      authorization_context: context,
    });
    return responseString(result, "signature");
  }

  async simulateAndSend(
    action: WalletAction,
    context: AuthorizationContext,
  ): Promise<WalletTransactionResult> {
    requireAuthorization(context);
    enforce(action, this.options.policy, this.now());
    enforceMethod(this.options.policy, "eth_call");
    enforceMethod(this.options.policy, "eth_sendTransaction");
    await this.client.wallets().rpc(this.options.walletId, {
      method: "eth_call",
      params: [
        {
          to: action.to,
          data: action.data,
          value: `0x${BigInt(action.value).toString(16)}`,
        },
        "latest",
      ],
      authorization_context: context,
    });
    const result = await this.client.wallets().rpc(this.options.walletId, {
      method: "eth_sendTransaction",
      params: [
        {
          to: action.to,
          data: action.data,
          value: `0x${BigInt(action.value).toString(16)}`,
        },
      ],
      authorization_context: context,
    });
    return {
      walletId: this.options.walletId,
      status: "SUBMITTED",
      transactionHash: responseString(result, "transaction hash"),
      policyFingerprint: this.options.policy.fingerprint,
    };
  }
}

export async function createPrivyNodeClientFromEnv(): Promise<PrivyNodeClient> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret)
    throw new Error(
      "PRIVY_APP_ID and PRIVY_APP_SECRET are required at runtime",
    );
  const module = await import("@privy-io/node");
  return new module.PrivyClient({
    appId,
    appSecret,
  }) as unknown as PrivyNodeClient;
}
