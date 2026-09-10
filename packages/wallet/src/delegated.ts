import type { AuthorizationContext as PrivyAuthorizationContext } from "@privy-io/node";
import {
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData,
  recoverAddress,
  type Hex,
} from "viem";
import { z } from "zod";

import {
  delegatedWalletIdentitySchema,
  type DelegatedRecoveryAsset,
  type DelegatedWalletIdentity,
} from "@aurka/shared";

import { routerAbi } from "./routerAbi.js";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const delegatedExecutionPolicySchema = z
  .object({
    walletId: z.string().min(1).max(128),
    walletAddress: addressSchema,
    signerAddress: addressSchema,
    policyId: z.string().min(1).max(128),
    chainId: z.number().int().positive().safe(),
    router: addressSchema,
    inputToken: addressSchema,
    outputToken: addressSchema,
    maximumInputAmount: uintSchema,
    validUntil: z.number().int().nonnegative().safe(),
    paused: z.boolean(),
    revoked: z.boolean(),
    fingerprint: bytes32Schema,
    allowedMethods: z
      .array(
        z.enum(["eth_call", "eth_sendTransaction", "eth_signTypedData_v4"]),
      )
      .min(1),
  })
  .strict();
export type DelegatedExecutionPolicy = z.infer<
  typeof delegatedExecutionPolicySchema
>;

export const delegatedExecutionActionSchema = z
  .object({
    chainId: z.number().int().positive().safe(),
    to: addressSchema,
    data: z.string().regex(/^0x[0-9a-fA-F]*$/),
    value: uintSchema,
    trader: addressSchema,
    inputToken: addressSchema,
    outputToken: addressSchema,
    inputAmount: uintSchema,
    intentHash: bytes32Schema,
    proposalHash: bytes32Schema,
    expiresAt: z.number().int().nonnegative().safe(),
    policyFingerprint: bytes32Schema,
  })
  .strict();
export type DelegatedExecutionAction = z.infer<
  typeof delegatedExecutionActionSchema
>;

export type DelegatedExecutionReceipt = {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly status: "0x1" | "0x0" | null;
};

export interface DelegatedWalletAdapter {
  getStatus(): Promise<DelegatedWalletIdentity>;
  preflight?(input: {
    readonly chainId: number;
    readonly inputToken: string;
    readonly inputAmount: string;
    readonly expiresAt: number;
    readonly policyFingerprint: string;
  }): Promise<void>;
  signIntent(
    typedData: DelegatedIntentTypedData,
    context: PrivyAuthorizationContext,
  ): Promise<string>;
  simulateAndSend(
    action: DelegatedExecutionAction,
    context: PrivyAuthorizationContext,
  ): Promise<{
    readonly transactionHash: string;
    readonly policyFingerprint: string;
  }>;
  getReceipt(
    transactionHash: string,
  ): Promise<DelegatedExecutionReceipt | null>;
  revoke(): Promise<void>;
  /**
   * Recovery is deliberately separate from the delegated signer. The
   * operator callback must use the owner-controlled recovery path and may
   * transfer only the exact, owner-signed assets supplied by the service.
   */
  recover?(input: {
    readonly sessionId: string;
    readonly ownerAddress: string;
    readonly destination: string;
    readonly assets: readonly DelegatedRecoveryAsset[];
  }): Promise<{ readonly transactionHash?: string }>;
}

/** A provider call crossed the broadcast boundary but did not return a
 * trustworthy hash. Callers must reconcile; they must not retry blindly. */
export class DelegatedBroadcastUnknownError extends Error {
  constructor(message = "Privy broadcast status is unknown") {
    super(message);
    this.name = "DelegatedBroadcastUnknownError";
  }
}

export interface DelegatedIntentTypedData {
  readonly domain: {
    readonly name: "AURKA Direct Settlement";
    readonly version: "1";
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: "Intent";
  readonly message: Record<string, unknown>;
}

export interface DelegatedPrivyNodeClient {
  wallets(): {
    ethereum(): {
      signTypedData(
        walletId: string,
        input: Record<string, unknown>,
      ): Promise<unknown>;
      sendTransaction(
        walletId: string,
        input: Record<string, unknown>,
      ): Promise<unknown>;
    };
  };
}

export interface DelegatedChainRpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

export interface DelegatedPrivyAdapterOptions {
  readonly client: DelegatedPrivyNodeClient;
  readonly policy: () => Promise<DelegatedExecutionPolicy>;
  readonly rpc: DelegatedChainRpc;
  readonly authorization: (
    operation: "signTypedData" | "eth_sendTransaction",
    request: Record<string, unknown>,
  ) => Promise<PrivyAuthorizationContext>;
  readonly revokeRemote: () => Promise<void>;
  readonly recoverRemote?: (input: {
    readonly sessionId: string;
    readonly ownerAddress: string;
    readonly destination: string;
    readonly assets: readonly DelegatedRecoveryAsset[];
  }) => Promise<{ readonly transactionHash?: string } | void>;
  readonly now?: () => number;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function asHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`Malformed ${label}`);
  return value;
}

function asQuantity(value: unknown, label: string): bigint {
  return BigInt(asHex(value, label));
}

function methodAllowed(
  policy: DelegatedExecutionPolicy,
  method: "eth_call" | "eth_sendTransaction" | "eth_signTypedData_v4",
): void {
  if (!policy.allowedMethods.includes(method))
    throw new Error(`Delegated Privy policy does not allow ${method}`);
}

function assertPolicy(policy: DelegatedExecutionPolicy, now: number): void {
  delegatedExecutionPolicySchema.parse(policy);
  if (policy.paused || policy.revoked || now >= policy.validUntil)
    throw new Error("Delegated Privy policy is paused, revoked, or expired");
}

type DecodedIntent = {
  readonly trader: string;
  readonly traderInputToken: string;
  readonly traderOutputToken: string;
  readonly deadline: bigint;
  readonly policyId: string;
};

type DecodedProposal = {
  readonly intentHash: string;
  readonly traderInputToken: string;
  readonly traderOutputToken: string;
  readonly traderInputAmount: bigint;
  readonly deadline: bigint;
};

function decodeExecute(data: string): {
  readonly intent: DecodedIntent;
  readonly proposal: DecodedProposal;
  readonly args: readonly unknown[];
} {
  const decoded = decodeFunctionData({ abi: routerAbi, data: data as Hex });
  if (decoded.functionName !== "execute")
    throw new Error("Delegated action is not the approved router method");
  const [intent, , proposal] = decoded.args as readonly [
    DecodedIntent,
    unknown,
    DecodedProposal,
    ...unknown[],
  ];
  if (!intent || !proposal) throw new Error("Router calldata is incomplete");
  return { intent, proposal, args: decoded.args };
}

function assertAction(
  action: DelegatedExecutionAction,
  policy: DelegatedExecutionPolicy,
  now: number,
): {
  readonly intent: DecodedIntent;
  readonly proposal: DecodedProposal;
  readonly args: readonly unknown[];
} {
  delegatedExecutionActionSchema.parse(action);
  assertPolicy(policy, now);
  if (action.chainId !== policy.chainId)
    throw new Error("Delegated chain mismatch");
  if (
    action.policyFingerprint.toLowerCase() !== policy.fingerprint.toLowerCase()
  )
    throw new Error("Delegated policy fingerprint mismatch");
  if (now >= action.expiresAt || action.expiresAt > policy.validUntil)
    throw new Error("Delegated action is expired");
  if (action.to.toLowerCase() !== policy.router.toLowerCase())
    throw new Error("Delegated target is not the approved router");
  if (action.value !== "0")
    throw new Error("Delegated router call must not send native value");
  if (action.trader.toLowerCase() !== policy.walletAddress.toLowerCase())
    throw new Error("Delegated trader is not the funded wallet");
  if (action.inputToken.toLowerCase() !== policy.inputToken.toLowerCase())
    throw new Error("Delegated input token is not approved");
  if (action.outputToken.toLowerCase() !== policy.outputToken.toLowerCase())
    throw new Error("Delegated output token is not approved");
  if (BigInt(action.inputAmount) > BigInt(policy.maximumInputAmount))
    throw new Error("Delegated input cap exceeded");

  const decoded = decodeExecute(action.data);
  if (
    decoded.intent.trader.toLowerCase() !== action.trader.toLowerCase() ||
    decoded.intent.traderInputToken.toLowerCase() !==
      action.inputToken.toLowerCase() ||
    decoded.intent.traderOutputToken.toLowerCase() !==
      action.outputToken.toLowerCase() ||
    decoded.proposal.traderInputToken.toLowerCase() !==
      action.inputToken.toLowerCase() ||
    decoded.proposal.traderOutputToken.toLowerCase() !==
      action.outputToken.toLowerCase() ||
    decoded.proposal.intentHash.toLowerCase() !==
      action.intentHash.toLowerCase() ||
    decoded.proposal.traderInputAmount !== BigInt(action.inputAmount) ||
    decoded.intent.deadline < BigInt(now) ||
    decoded.proposal.deadline < BigInt(now) ||
    decoded.intent.deadline > BigInt(policy.validUntil) ||
    decoded.proposal.deadline > BigInt(policy.validUntil)
  )
    throw new Error(
      "Decoded delegated calldata does not match the reviewed action",
    );
  if (
    encodeFunctionData({
      abi: routerAbi,
      functionName: "execute",
      args: decoded.args as never,
    }).toLowerCase() !== action.data.toLowerCase()
  )
    throw new Error("Delegated router calldata is not canonical");
  return decoded;
}

async function readTokenCall(
  rpc: DelegatedChainRpc,
  token: string,
  data: string,
): Promise<bigint> {
  return asQuantity(
    await rpc.request("eth_call", [{ to: token, data }, "latest"]),
    "token call result",
  );
}

async function readWalletBalances(
  rpc: DelegatedChainRpc,
  policy: DelegatedExecutionPolicy,
): Promise<
  | {
      readonly native: string;
      readonly inputToken: string;
      readonly outputToken: string;
      readonly inputAllowance: string;
    }
  | undefined
> {
  try {
    const balanceData = `0x70a08231${policy.walletAddress.slice(2).toLowerCase().padStart(64, "0")}`;
    const allowanceData = `0xdd62ed3e${policy.walletAddress.slice(2).toLowerCase().padStart(64, "0")}${policy.router.slice(2).toLowerCase().padStart(64, "0")}`;
    const [native, inputToken, outputToken, inputAllowance] = await Promise.all(
      [
        rpc.request("eth_getBalance", [policy.walletAddress, "latest"]),
        readTokenCall(rpc, policy.inputToken, balanceData),
        readTokenCall(rpc, policy.outputToken, balanceData),
        readTokenCall(rpc, policy.inputToken, allowanceData),
      ],
    );
    return {
      native: asQuantity(native, "native balance").toString(),
      inputToken: inputToken.toString(),
      outputToken: outputToken.toString(),
      inputAllowance: inputAllowance.toString(),
    };
  } catch {
    return undefined;
  }
}

export class PrivyDelegatedExecutionAdapter implements DelegatedWalletAdapter {
  private readonly now: () => number;

  constructor(private readonly options: DelegatedPrivyAdapterOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getStatus(): Promise<DelegatedWalletIdentity> {
    const policy = delegatedExecutionPolicySchema.parse(
      await this.options.policy(),
    );
    const balances = await readWalletBalances(this.options.rpc, policy);
    return delegatedWalletIdentitySchema.parse({
      configured: true,
      walletId: policy.walletId,
      address: policy.walletAddress,
      chainId: policy.chainId,
      signerAddress: policy.signerAddress,
      policyId: policy.policyId,
      policyFingerprint: policy.fingerprint,
      enabled:
        !policy.paused && !policy.revoked && this.now() < policy.validUntil,
      revoked: policy.revoked,
      validUntil: policy.validUntil,
      reason: null,
      ...(balances ? { balances } : {}),
    });
  }

  async signIntent(
    typedData: DelegatedIntentTypedData,
    context: PrivyAuthorizationContext,
  ): Promise<string> {
    const policy = delegatedExecutionPolicySchema.parse(
      await this.options.policy(),
    );
    assertPolicy(policy, this.now());
    methodAllowed(policy, "eth_signTypedData_v4");
    if (typedData.domain.chainId !== policy.chainId)
      throw new Error("Delegated chain mismatch");
    if (
      typedData.primaryType !== "Intent" ||
      typedData.domain.verifyingContract.toLowerCase() !==
        policy.router.toLowerCase()
    )
      throw new Error(
        "Delegated typed-data domain is not the approved settlement router",
      );
    const chain = asQuantity(
      await this.options.rpc.request("eth_chainId", []),
      "chain ID",
    );
    if (chain !== BigInt(policy.chainId))
      throw new Error("Delegated RPC chain mismatch");
    if (
      typeof typedData.message.trader !== "string" ||
      typedData.message.trader.toLowerCase() !==
        policy.walletAddress.toLowerCase()
    )
      throw new Error("Delegated typed-data trader is not the funded wallet");
    const request = {
      params: {
        typed_data: {
          domain: {
            name: typedData.domain.name,
            version: typedData.domain.version,
            chain_id: typedData.domain.chainId,
            verifying_contract: typedData.domain.verifyingContract,
          },
          types: typedData.types,
          primary_type: typedData.primaryType,
          message: typedData.message,
        },
      },
      authorization_context: context,
    } satisfies Record<string, unknown>;
    const authorized = await this.options.authorization(
      "signTypedData",
      request,
    );
    const result = await this.options.client
      .wallets()
      .ethereum()
      .signTypedData(policy.walletId, {
        ...request,
        authorization_context: authorized,
        idempotency_key: `aurka-delegation-intent:${String(typedData.message.intentId)}`,
      });
    const value = result as { encoding?: unknown; signature?: unknown };
    if (
      value.encoding !== "hex" ||
      typeof value.signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(value.signature)
    )
      throw new Error("Malformed Privy delegated signature");
    const signer = await recoverAddress({
      hash: hashTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      } as never),
      signature: value.signature as Hex,
    });
    if (signer.toLowerCase() !== policy.walletAddress.toLowerCase())
      throw new Error("Privy delegated signature signer mismatch");
    const refreshed = delegatedExecutionPolicySchema.parse(
      await this.options.policy(),
    );
    if (
      refreshed.fingerprint.toLowerCase() !== policy.fingerprint.toLowerCase()
    )
      throw new Error("Delegated policy changed during signing");
    return value.signature;
  }

  async preflight(input: {
    readonly chainId: number;
    readonly inputToken: string;
    readonly inputAmount: string;
    readonly expiresAt: number;
    readonly policyFingerprint: string;
  }): Promise<void> {
    const policy = delegatedExecutionPolicySchema.parse(
      await this.options.policy(),
    );
    assertPolicy(policy, this.now());
    methodAllowed(policy, "eth_call");
    if (
      input.chainId !== policy.chainId ||
      input.inputToken.toLowerCase() !== policy.inputToken.toLowerCase() ||
      input.policyFingerprint.toLowerCase() !== policy.fingerprint.toLowerCase()
    )
      throw new Error("Delegated preflight does not match the current policy");
    if (this.now() >= input.expiresAt || input.expiresAt > policy.validUntil)
      throw new Error("Delegated preflight is expired");
    if (BigInt(input.inputAmount) > BigInt(policy.maximumInputAmount))
      throw new Error("Delegated input cap exceeded");
    const chain = asQuantity(
      await this.options.rpc.request("eth_chainId", []),
      "chain ID",
    );
    if (chain !== BigInt(policy.chainId))
      throw new Error("Delegated RPC chain mismatch");
    const nativeBalance = asQuantity(
      await this.options.rpc.request("eth_getBalance", [
        policy.walletAddress,
        "latest",
      ]),
      "native balance",
    );
    if (nativeBalance === 0n)
      throw new Error("Delegated wallet has no native gas balance");
    const balanceData = `0x70a08231${policy.walletAddress.slice(2).toLowerCase().padStart(64, "0")}`;
    const allowanceData = `0xdd62ed3e${policy.walletAddress.slice(2).toLowerCase().padStart(64, "0")}${policy.router.slice(2).toLowerCase().padStart(64, "0")}`;
    const [balance, allowance] = await Promise.all([
      readTokenCall(this.options.rpc, policy.inputToken, balanceData),
      readTokenCall(this.options.rpc, policy.inputToken, allowanceData),
    ]);
    if (balance < BigInt(input.inputAmount))
      throw new Error("Delegated wallet balance is below the reviewed amount");
    if (allowance < BigInt(input.inputAmount))
      throw new Error(
        "Delegated router allowance is below the reviewed amount",
      );
    asQuantity(
      await this.options.rpc.request("eth_getTransactionCount", [
        policy.walletAddress,
        "pending",
      ]),
      "transaction nonce",
    );
  }

  async simulateAndSend(
    raw: DelegatedExecutionAction,
    context: PrivyAuthorizationContext,
  ): Promise<{
    readonly transactionHash: string;
    readonly policyFingerprint: string;
  }> {
    const action = delegatedExecutionActionSchema.parse(raw);
    const policy = delegatedExecutionPolicySchema.parse(
      await this.options.policy(),
    );
    assertAction(action, policy, this.now());
    methodAllowed(policy, "eth_call");
    methodAllowed(policy, "eth_sendTransaction");
    const chain = asQuantity(
      await this.options.rpc.request("eth_chainId", []),
      "chain ID",
    );
    if (chain !== BigInt(policy.chainId))
      throw new Error("Delegated RPC chain mismatch");
    const nativeBalance = asQuantity(
      await this.options.rpc.request("eth_getBalance", [
        policy.walletAddress,
        "latest",
      ]),
      "native balance",
    );
    if (nativeBalance === 0n)
      throw new Error("Delegated wallet has no native gas balance");
    const balanceData = `0x70a08231${policy.walletAddress.slice(2).toLowerCase().padStart(64, "0")}`;
    const allowanceData = `0xdd62ed3e${policy.walletAddress.slice(2).toLowerCase().padStart(64, "0")}${policy.router.slice(2).toLowerCase().padStart(64, "0")}`;
    const [balance, allowance] = await Promise.all([
      readTokenCall(this.options.rpc, policy.inputToken, balanceData),
      readTokenCall(this.options.rpc, policy.inputToken, allowanceData),
    ]);
    if (balance < BigInt(action.inputAmount))
      throw new Error("Delegated wallet balance is below the reviewed amount");
    if (allowance < BigInt(action.inputAmount))
      throw new Error(
        "Delegated router allowance is below the reviewed amount",
      );
    const nonce = asQuantity(
      await this.options.rpc.request("eth_getTransactionCount", [
        policy.walletAddress,
        "pending",
      ]),
      "transaction nonce",
    );
    const transaction = {
      from: policy.walletAddress,
      to: action.to,
      data: action.data as Hex,
      value: hex(BigInt(action.value)),
      nonce: hex(nonce),
      chain_id: hex(BigInt(policy.chainId)),
    };
    const simulation = await this.options.rpc.request("eth_call", [
      transaction,
      "latest",
    ]);
    asHex(simulation, "delegated simulation result");
    const latest = delegatedExecutionPolicySchema.parse(
      await this.options.policy(),
    );
    assertAction(action, latest, this.now());
    if (latest.fingerprint.toLowerCase() !== policy.fingerprint.toLowerCase())
      throw new Error("Delegated policy changed during simulation");
    const authorized = await this.options.authorization("eth_sendTransaction", {
      params: { transaction },
      authorization_context: context,
    });
    let result: unknown;
    try {
      result = await this.options.client
        .wallets()
        .ethereum()
        .sendTransaction(policy.walletId, {
          caip2: `eip155:${policy.chainId}`,
          params: { transaction },
          authorization_context: authorized,
          idempotency_key: `aurka-d:${action.intentHash.slice(2, 18)}${action.proposalHash.slice(2, 18)}`,
        });
    } catch {
      throw new DelegatedBroadcastUnknownError();
    }
    const value = result as { caip2?: unknown; hash?: unknown };
    if (
      value.caip2 !== `eip155:${policy.chainId}` ||
      typeof value.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.hash)
    )
      throw new DelegatedBroadcastUnknownError(
        "Privy accepted the delegated transaction but returned no trustworthy hash",
      );
    return {
      transactionHash: value.hash,
      policyFingerprint: policy.fingerprint,
    };
  }

  async getReceipt(
    transactionHash: string,
  ): Promise<DelegatedExecutionReceipt | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))
      throw new Error("Malformed transaction hash");
    const value = await this.options.rpc.request("eth_getTransactionReceipt", [
      transactionHash,
    ]);
    if (value === null) return null;
    if (!value || typeof value !== "object")
      throw new Error("Malformed transaction receipt");
    const receipt = value as {
      transactionHash?: unknown;
      blockNumber?: unknown;
      status?: unknown;
    };
    const hash = asHex(receipt.transactionHash, "receipt transaction hash");
    const blockNumber = asHex(receipt.blockNumber, "receipt block number");
    if (
      hash.toLowerCase() !== transactionHash.toLowerCase() ||
      (receipt.status !== "0x1" && receipt.status !== "0x0")
    )
      throw new Error("Malformed transaction receipt");
    return { transactionHash: hash, blockNumber, status: receipt.status };
  }

  async revoke(): Promise<void> {
    await this.options.revokeRemote();
  }

  async recover(input: {
    readonly sessionId: string;
    readonly ownerAddress: string;
    readonly destination: string;
    readonly assets: readonly DelegatedRecoveryAsset[];
  }): Promise<{ readonly transactionHash?: string }> {
    if (!this.options.recoverRemote)
      throw new Error("Owner recovery is not configured");
    const result = await this.options.recoverRemote(input);
    if (result === undefined) return {};
    if (
      result.transactionHash !== undefined &&
      !/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)
    )
      throw new Error("Owner recovery returned a malformed transaction hash");
    return result;
  }
}

export function createDelegatedPrivyClient(
  client: unknown,
): DelegatedPrivyNodeClient {
  return client as unknown as DelegatedPrivyNodeClient;
}
