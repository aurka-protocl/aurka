/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  type FundAgentRequest,
  type DelegatedStatus,
  tradingAgentSchema,
  type TradingAgent,
  type AgentMandate,
  mandateSchema,
} from "@aurka/shared";
import {
  createDelegatedPrivyClient,
  createPrivyNodeClientFromEnv,
  PrivyDelegatedExecutionAdapter,
  type DelegatedChainRpc,
  type DelegatedPrivyAdapterOptions,
  type DelegatedWalletAdapter,
} from "@aurka/wallet";

import type { AurkaService } from "../service.js";
import { ServiceError } from "../service.js";
import type { ServiceRepository } from "../db/repository.js";

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const erc20MintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type PrivyClientLike = {
  wallets(): {
    get(id: string): Promise<Record<string, any>>;
    create(input: Record<string, unknown>): Promise<Record<string, any>>;
    update(id: string, input: Record<string, unknown>): Promise<unknown>;
    ethereum(): {
      sendTransaction(id: string, input: Record<string, unknown>): Promise<any>;
      signTransaction(id: string, input: Record<string, unknown>): Promise<any>;
    };
  };
  policies(): {
    get(id: string): Promise<Record<string, any>>;
    create(input: Record<string, unknown>): Promise<Record<string, any>>;
  };
};

type AgentFunding = {
  readonly eth: string;
  readonly usdc: string;
  readonly weth: string;
  readonly pending?: {
    readonly eth: string;
    readonly usdc: string;
    readonly weth: string;
  };
  readonly pendingRequested?: {
    readonly eth: string;
    readonly usdc: string;
    readonly weth: string;
  };
  readonly pendingOperationId?: string;
  readonly lastFundingAt?: number;
  readonly transactions?: readonly string[];
};

function value(name: string): string | undefined {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function required(name: string): string {
  const result = value(name);
  if (!result) throw new Error(`${name} is required for user agents`);
  return result;
}

function address(value_: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value_))
    throw new Error(`${label} must be an EVM address`);
  return value_;
}

function decimal(value_: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value_))
    throw new ServiceError(
      "AGENT_FUNDING_INVALID",
      `${label} must be a decimal base-unit amount`,
      400,
    );
  return BigInt(value_);
}

function transactionMethod(): "eth_sendTransaction" | "eth_signTransaction" {
  return value("PRIVY_DELEGATED_BROADCAST_MODE") === "sign-and-broadcast"
    ? "eth_signTransaction"
    : "eth_sendTransaction";
}

function routerMethod(): "execute" | "executeWithSwapVM" {
  const result = value("PRIVY_DELEGATED_ROUTER_METHOD") ?? "executeWithSwapVM";
  if (result !== "execute" && result !== "executeWithSwapVM")
    throw new Error(
      "PRIVY_DELEGATED_ROUTER_METHOD must be execute or executeWithSwapVM",
    );
  return result;
}

function recoveryRules(input: {
  readonly chainId: number;
  readonly inputToken: string;
  readonly outputToken: string;
  readonly ownerAddress: string;
  readonly maximum: string;
}): readonly Record<string, unknown>[] {
  return [input.inputToken, input.outputToken].map((token) => ({
    name: `recovery ${token.slice(0, 10)}`,
    action: "ALLOW",
    method: transactionMethod(),
    conditions: [
      {
        field_source: "ethereum_transaction",
        field: "to",
        operator: "eq",
        value: token,
      },
      {
        field_source: "ethereum_transaction",
        field: "value",
        operator: "eq",
        value: "0x0",
      },
      {
        field_source: "ethereum_transaction",
        field: "chain_id",
        operator: "eq",
        value: `0x${input.chainId.toString(16)}`,
      },
      {
        field_source: "ethereum_calldata",
        field: "function_name",
        abi: erc20TransferAbi,
        operator: "eq",
        value: "transfer",
      },
      {
        field_source: "ethereum_calldata",
        field: "transfer.to",
        abi: erc20TransferAbi,
        operator: "eq",
        value: input.ownerAddress,
      },
      {
        field_source: "ethereum_calldata",
        field: "transfer.amount",
        abi: erc20TransferAbi,
        operator: "lte",
        value: input.maximum,
      },
    ],
  }));
}

function routerExecutionAbi(): readonly Record<string, unknown>[] {
  return [
    {
      type: "function",
      name: routerMethod(),
      stateMutability: "nonpayable",
      inputs: [
        { name: "intent", type: "tuple" },
        { name: "intentSignature", type: "bytes" },
        { name: "proposal", type: "tuple" },
        { name: "proposalSignature", type: "bytes" },
        { name: "assets", type: "tuple[]" },
        { name: "epoch", type: "tuple" },
        { name: "priceInput", type: "tuple" },
        { name: "directProgram", type: "bytes" },
        ...(routerMethod() === "executeWithSwapVM"
          ? [
              { name: "makerTraits", type: "uint256" },
              { name: "orderData", type: "bytes" },
              { name: "takerTraitsAndData", type: "bytes" },
            ]
          : []),
      ],
    },
  ];
}

function condition(
  rule: any,
  fieldSource: string,
  field: string,
  operator: string,
  expected: string,
): boolean {
  return (
    Array.isArray(rule?.conditions) &&
    rule.conditions.some(
      (item: any) =>
        item?.field_source === fieldSource &&
        item?.field === field &&
        item?.operator === operator &&
        (Array.isArray(item.value) ? item.value : [item.value]).some(
          (candidate: unknown) =>
            String(candidate).toLowerCase() === expected.toLowerCase(),
        ),
    )
  );
}

function abiFunction(
  item: any,
  expectedAbi: readonly Record<string, unknown>[],
): boolean {
  if (!Array.isArray(item?.abi) || item.abi.length !== 1) return false;
  const expected = expectedAbi[0] as any;
  const actual = item.abi[0];
  return (
    actual?.type === "function" &&
    actual?.name === expected.name &&
    actual?.stateMutability === expected.stateMutability &&
    Array.isArray(actual.inputs) &&
    actual.inputs.length === expected.inputs.length &&
    actual.inputs.every(
      (input: any, index: number) =>
        input?.name === expected.inputs[index]?.name &&
        input?.type === expected.inputs[index]?.type,
    )
  );
}

function calldataCondition(
  rule: any,
  field: string,
  operator: string,
  expected: string,
  abi: readonly Record<string, unknown>[],
): boolean {
  return (
    condition(rule, "ethereum_calldata", field, operator, expected) &&
    Array.isArray(rule?.conditions) &&
    rule.conditions.some(
      (item: any) =>
        item?.field_source === "ethereum_calldata" &&
        item?.field === field &&
        item?.operator === operator &&
        abiFunction(item, abi),
    )
  );
}

function transactionRule(
  rule: any,
  method: string,
  to: string,
  chainId: number,
): boolean {
  return (
    rule?.action === "ALLOW" &&
    rule?.method === method &&
    condition(
      rule,
      "ethereum_transaction",
      "chain_id",
      "eq",
      `0x${chainId.toString(16)}`,
    ) &&
    condition(rule, "ethereum_transaction", "to", "eq", to) &&
    condition(rule, "ethereum_transaction", "value", "eq", "0x0")
  );
}

function exactIds(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((id) => actual.includes(id))
  );
}

function validateExecutionPolicy(
  wallet: Record<string, any>,
  policy: Record<string, any>,
  ownerId: string,
  signerId: string,
  executionPolicyId: string,
  recoveryPolicyId: string,
  chainId: number,
  router: string,
  inputToken: string,
  maximumInputAmount: string,
  requireSigner: boolean,
): void {
  if (
    policy.id !== executionPolicyId ||
    policy.chain_type !== "ethereum" ||
    policy.version !== "1.0" ||
    policy.owner_id !== ownerId
  )
    throw new Error("Privy execution policy identity readback mismatch");
  if (
    !Array.isArray(wallet.policy_ids) ||
    wallet.policy_ids.length !== 1 ||
    wallet.policy_ids[0] !== recoveryPolicyId
  )
    throw new Error("Privy agent wallet recovery policy readback mismatch");
  const signers = Array.isArray(wallet.additional_signers)
    ? wallet.additional_signers
    : [];
  if (signers.some((item: any) => item?.signer_id !== signerId))
    throw new Error("Privy agent wallet has an unexpected additional signer");
  if (signers.length > 1)
    throw new Error("Privy agent wallet has unexpected additional signers");
  const signer = signers.find((item: any) => item?.signer_id === signerId);
  if (requireSigner && !signer)
    throw new Error("Privy agent execution signer is not attached");
  if (signer && !exactIds(signer.override_policy_ids, [executionPolicyId]))
    throw new Error("Privy agent signer policy override readback mismatch");
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const method = transactionMethod();
  if (
    rules.some(
      (rule: any) =>
        rule?.action === "ALLOW" &&
        ![method, "eth_signTypedData_v4"].includes(rule.method),
    )
  )
    throw new Error(
      "Privy execution policy contains an unexpected ALLOW method",
    );
  const typedRules = rules.filter(
    (rule: any) =>
      rule?.action === "ALLOW" && rule?.method === "eth_signTypedData_v4",
  );
  const typedRule = typedRules.find(
    (rule: any) =>
      condition(
        rule,
        "ethereum_typed_data_domain",
        "chainId",
        "eq",
        String(chainId),
      ) &&
      condition(
        rule,
        "ethereum_typed_data_domain",
        "verifyingContract",
        "eq",
        router,
      ),
  );
  const methodRules = rules.filter(
    (rule: any) =>
      rule?.action === "ALLOW" &&
      (rule?.method === method || rule?.method === "*"),
  );
  const routerRules = methodRules.filter(
    (rule: any) =>
      transactionRule(rule, method, router, chainId) &&
      calldataCondition(
        rule,
        "function_name",
        "eq",
        routerMethod(),
        routerExecutionAbi(),
      ),
  );
  const approvalRules = methodRules.filter((rule: any) =>
    transactionRule(rule, method, inputToken, chainId),
  );
  const exactApproval =
    approvalRules.length === 1 &&
    calldataCondition(
      approvalRules[0],
      "function_name",
      "eq",
      "approve",
      erc20ApproveAbi,
    ) &&
    calldataCondition(
      approvalRules[0],
      "approve.spender",
      "eq",
      router,
      erc20ApproveAbi,
    ) &&
    calldataCondition(
      approvalRules[0],
      "approve.amount",
      "lte",
      maximumInputAmount,
      erc20ApproveAbi,
    );
  if (
    typedRules.length !== 1 ||
    !typedRule ||
    methodRules.length !== 2 ||
    routerRules.length !== 1 ||
    !exactApproval
  )
    throw new Error(
      "Privy execution policy is missing the exact typed-data, router, or approval restrictions",
    );
}

function validateRecoveryPolicy(
  wallet: Record<string, any>,
  policy: Record<string, any>,
  ownerId: string,
  recoveryPolicyId: string,
  ownerAddress: string,
  chainId: number,
  inputToken: string,
  outputToken: string,
  maximumRecoveryAmount: string,
): void {
  if (
    !Array.isArray(wallet.policy_ids) ||
    wallet.policy_ids.length !== 1 ||
    wallet.policy_ids[0] !== recoveryPolicyId
  )
    throw new Error(
      "Privy recovery policy is not attached to the agent wallet",
    );
  if (
    policy.id !== recoveryPolicyId ||
    policy.chain_type !== "ethereum" ||
    policy.version !== "1.0" ||
    policy.owner_id !== ownerId
  )
    throw new Error("Privy recovery policy identity readback mismatch");
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const method = transactionMethod();
  const allowed = rules.filter(
    (rule: any) =>
      rule?.action === "ALLOW" &&
      (rule?.method === method || rule?.method === "*"),
  );
  const exactRecovery = (rule: any, token: string): boolean =>
    transactionRule(rule, method, token, chainId) &&
    calldataCondition(
      rule,
      "function_name",
      "eq",
      "transfer",
      erc20TransferAbi,
    ) &&
    calldataCondition(
      rule,
      "transfer.to",
      "eq",
      ownerAddress,
      erc20TransferAbi,
    ) &&
    calldataCondition(
      rule,
      "transfer.amount",
      "lte",
      maximumRecoveryAmount,
      erc20TransferAbi,
    );
  if (
    rules.some(
      (rule: any) => rule?.action === "ALLOW" && rule?.method !== method,
    ) ||
    allowed.length !== 2 ||
    allowed.filter((rule: any) => exactRecovery(rule, inputToken)).length !==
      1 ||
    allowed.filter((rule: any) => exactRecovery(rule, outputToken)).length !== 1
  )
    throw new Error(
      "Privy recovery policy must contain only exact owner-directed token transfers",
    );
}

function executionFingerprint(policy: Record<string, any>): string {
  return keccak256(
    stringToHex(
      JSON.stringify({
        id: policy.id,
        version: policy.version,
        chainType: policy.chain_type,
        rules: policy.rules ?? [],
      }),
    ),
  );
}

function fundingFrom(value_: Record<string, unknown>): AgentFunding {
  const pendingValue =
    value_.pending && typeof value_.pending === "object"
      ? (value_.pending as Record<string, unknown>)
      : undefined;
  const pendingRequestedValue =
    value_.pendingRequested && typeof value_.pendingRequested === "object"
      ? (value_.pendingRequested as Record<string, unknown>)
      : undefined;
  return {
    eth: typeof value_.eth === "string" ? value_.eth : "0",
    usdc: typeof value_.usdc === "string" ? value_.usdc : "0",
    weth: typeof value_.weth === "string" ? value_.weth : "0",
    ...(pendingValue
      ? {
          pending: {
            eth: typeof pendingValue.eth === "string" ? pendingValue.eth : "0",
            usdc:
              typeof pendingValue.usdc === "string" ? pendingValue.usdc : "0",
            weth:
              typeof pendingValue.weth === "string" ? pendingValue.weth : "0",
          },
        }
      : {}),
    ...(pendingRequestedValue
      ? {
          pendingRequested: {
            eth:
              typeof pendingRequestedValue.eth === "string"
                ? pendingRequestedValue.eth
                : "0",
            usdc:
              typeof pendingRequestedValue.usdc === "string"
                ? pendingRequestedValue.usdc
                : "0",
            weth:
              typeof pendingRequestedValue.weth === "string"
                ? pendingRequestedValue.weth
                : "0",
          },
        }
      : {}),
    ...(typeof value_.pendingOperationId === "string"
      ? { pendingOperationId: value_.pendingOperationId }
      : {}),
    ...(typeof value_.lastFundingAt === "number"
      ? { lastFundingAt: value_.lastFundingAt }
      : {}),
    ...(Array.isArray(value_.transactions)
      ? {
          transactions: value_.transactions.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
  };
}

export class TradingAgentService {
  private readonly clientPromise: Promise<PrivyClientLike>;
  private readonly provisioningLeaseId = randomUUID();
  private readonly provisioningInFlight = new Map<
    string,
    Promise<TradingAgent>
  >();
  private readonly fundingInFlight = new Map<
    string,
    {
      readonly ownerAddress: string;
      readonly input: FundAgentRequest;
      readonly promise: Promise<TradingAgent>;
    }
  >();
  private readonly rpc: DelegatedChainRpc;
  private readonly ownerId: string;
  private readonly signerId: string;
  private readonly executionPolicyId: string;
  private readonly chainId: number;
  private readonly router: string;
  private readonly inputToken: string;
  private readonly outputToken: string;
  private readonly signerAddress: string;
  private readonly authorizationKey: string;
  private readonly ownerAuthorizationKey: string;
  private readonly maximumInputAmount: string;
  private readonly maximumRecoveryAmount: string;
  private readonly validUntil: number;
  private readonly rpcUrl: string | undefined;

  constructor(
    private readonly service: AurkaService,
    private readonly repository: ServiceRepository,
  ) {
    this.clientPromise =
      createPrivyNodeClientFromEnv() as unknown as Promise<PrivyClientLike>;
    this.ownerId = required("PRIVY_DELEGATED_OWNER_ID");
    this.signerId = required("PRIVY_DELEGATED_SIGNER_ID");
    this.executionPolicyId = required("PRIVY_DELEGATED_POLICY_ID");
    this.chainId = Number(required("PRIVY_DELEGATED_CHAIN_ID"));
    this.router = address(
      required("PRIVY_DELEGATED_ROUTER"),
      "PRIVY_DELEGATED_ROUTER",
    );
    this.inputToken = address(
      required("PRIVY_DELEGATED_INPUT_TOKEN"),
      "PRIVY_DELEGATED_INPUT_TOKEN",
    );
    this.outputToken = address(
      required("PRIVY_DELEGATED_OUTPUT_TOKEN"),
      "PRIVY_DELEGATED_OUTPUT_TOKEN",
    );
    this.signerAddress = address(
      required("PRIVY_DELEGATED_SIGNER_ADDRESS"),
      "PRIVY_DELEGATED_SIGNER_ADDRESS",
    );
    this.authorizationKey = required(
      "PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY",
    );
    this.ownerAuthorizationKey = required(
      "PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY",
    );
    this.maximumInputAmount = required("PRIVY_DELEGATED_MAX_INPUT_AMOUNT");
    this.maximumRecoveryAmount = required(
      "PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT",
    );
    this.validUntil = Number(required("PRIVY_DELEGATED_POLICY_VALID_UNTIL"));
    this.rpcUrl = value("AURKA_SEPOLIA_RPC_URL") ?? value("SEPOLIA_RPC_URL");
    this.rpc = {
      request: (method, params) =>
        service.rpcTransport!.request({ method, params }),
    };
    if (this.chainId !== service.runtime.chainId)
      throw new Error(
        "PRIVY_DELEGATED_CHAIN_ID does not match the service chain",
      );
  }

  private async client(): Promise<PrivyClientLike> {
    return this.clientPromise;
  }

  get(ownerAddress: string, chainId = this.chainId): TradingAgent | undefined {
    return this.repository.getTradingAgent(ownerAddress, chainId);
  }

  async status(
    ownerAddress: string,
    chainId = this.chainId,
  ): Promise<DelegatedStatus> {
    const agent = this.get(ownerAddress, chainId);
    if (!agent)
      return {
        wallet: {
          configured: false,
          walletId: null,
          address: null,
          chainId: null,
          signerAddress: null,
          policyId: null,
          policyFingerprint: null,
          enabled: false,
          revoked: false,
          validUntil: null,
          reason: "Create a trading agent to view its delegated wallet",
        },
        ownerAddress,
        activeSessions: 0,
      };
    return {
      wallet: await (await this.adapter(agent)).getStatus(),
      ownerAddress,
      activeSessions: this.repository
        .listDelegatedSessions(ownerAddress)
        .filter((session) => ["AUTHORIZED", "ACTIVE"].includes(session.state))
        .length,
    };
  }

  private async readWallet(walletId: string): Promise<Record<string, any>> {
    const wallet = await (await this.client()).wallets().get(walletId);
    if (wallet.chain_type !== "ethereum")
      throw new Error("Privy agent wallet is not Ethereum");
    if (wallet.owner_id !== this.ownerId)
      throw new Error("Privy agent owner readback mismatch");
    return wallet;
  }

  async provision(
    ownerAddress: string,
    chainId: number,
  ): Promise<TradingAgent> {
    if (chainId !== this.chainId)
      throw new ServiceError(
        "CHAIN_MISMATCH",
        "Trading agents are only available on the configured Sepolia chain",
        409,
      );
    address(ownerAddress, "owner address");
    const normalizedOwner = ownerAddress.toLowerCase();
    const existing = this.get(normalizedOwner, chainId);
    const provisioningKey = `${normalizedOwner}:${chainId}`;
    if (existing) {
      const operation = this.repository.getAgentProvisioning(
        normalizedOwner,
        chainId,
      );
      if (operation && operation.state !== "READY") {
        this.repository.updateAgentProvisioning(operation.id, {
          state: "READY",
          lastError: null,
        });
      }

      return existing;
    }
    const inFlight = this.provisioningInFlight.get(provisioningKey);
    if (inFlight) return inFlight;
    const pending = this.provisionWithCheckpoint(normalizedOwner, chainId);
    this.provisioningInFlight.set(provisioningKey, pending);
    try {
      return await pending;
    } finally {
      if (this.provisioningInFlight.get(provisioningKey) === pending)
        this.provisioningInFlight.delete(provisioningKey);
    }
  }

  private async provisionWithCheckpoint(
    normalizedOwner: string,
    chainId: number,
  ): Promise<TradingAgent> {
    const existing = this.get(normalizedOwner, chainId);
    if (existing) return existing;
    const idempotencyKey = `aurka-agent-${normalizedOwner}-${chainId}`;
    const operation = this.repository.reserveAgentProvisioning({
      id: randomUUID(),
      ownerAddress: normalizedOwner,
      chainId,
      idempotencyKey,
    });
    const claimed = this.repository.claimAgentProvisioning(
      operation.id,
      this.provisioningLeaseId,
      Math.floor(Date.now() / 1000) + 120,
    );
    if (!claimed) {
      const concurrent = this.get(normalizedOwner, chainId);
      if (concurrent) return concurrent;
      throw new ServiceError(
        "AGENT_PROVISIONING_IN_PROGRESS",
        "This agent is already being provisioned; retry after the current operation finishes",
        409,
      );
    }
    this.repository.updateAgentProvisioning(operation.id, {
      state: "PROVISIONING",
      lastError: null,
    });
    try {
      const client = await this.client();
      let recoveryPolicyId = operation.recoveryPolicyId;
      if (!recoveryPolicyId) {
        const recovery = await client.policies().create({
          name: `AURKA recovery ${normalizedOwner.slice(0, 10)}`,
          version: "1.0",
          chain_type: "ethereum",
          owner_id: this.ownerId,
          rules: recoveryRules({
            chainId,
            inputToken: this.inputToken,
            outputToken: this.outputToken,
            ownerAddress: normalizedOwner,
            maximum: this.maximumRecoveryAmount,
          }),
          "privy-idempotency-key": `aurka-recovery-${normalizedOwner}-${chainId}`,
        });
        if (typeof recovery.id !== "string" && typeof recovery.id !== "number")
          throw new Error("Privy recovery policy has no ID");
        recoveryPolicyId = String(recovery.id);
        this.repository.updateAgentProvisioning(operation.id, {
          recoveryPolicyId,
        });
      }
      let walletId = operation.walletId;
      if (!walletId) {
        const wallet = await client.wallets().create({
          chain_type: "ethereum",
          display_name: `AURKA agent ${normalizedOwner.slice(0, 10)}`,
          external_id:
            `aurka-agent-${normalizedOwner.slice(2)}-${chainId}`.slice(0, 64),
          owner_id: this.ownerId,
          policy_ids: [recoveryPolicyId],
          additional_signers: [
            {
              signer_id: this.signerId,
              override_policy_ids: [this.executionPolicyId],
            },
          ],
          "privy-idempotency-key": idempotencyKey,
        });
        if (typeof wallet.id !== "string" && typeof wallet.id !== "number")
          throw new Error("Privy agent wallet has no ID");
        walletId = String(wallet.id);
        this.repository.updateAgentProvisioning(operation.id, { walletId });
      }
      const readback = await this.readWallet(walletId);
      if (typeof readback.address !== "string")
        throw new Error("Privy agent wallet has no address");
      const walletAddress = address(readback.address, "Privy agent address");
      const executionPolicy = await client
        .policies()
        .get(this.executionPolicyId);
      const recoveryPolicy = await client.policies().get(recoveryPolicyId);
      validateExecutionPolicy(
        readback,
        executionPolicy,
        this.ownerId,
        this.signerId,
        this.executionPolicyId,
        recoveryPolicyId,
        this.chainId,
        this.router,
        this.inputToken,
        this.maximumInputAmount,
        true,
      );
      validateRecoveryPolicy(
        readback,
        recoveryPolicy,
        this.ownerId,
        recoveryPolicyId,
        normalizedOwner,
        this.chainId,
        this.inputToken,
        this.outputToken,
        this.maximumRecoveryAmount,
      );
      this.repository.updateAgentProvisioning(operation.id, {
        walletId,
        walletAddress,
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const agent = tradingAgentSchema.parse({
        id: operation.id,
        ownerAddress: normalizedOwner,
        chainId,
        walletId,
        walletAddress,
        signerId: this.signerId,
        policyId: this.executionPolicyId,
        recoveryPolicyId,
        state: "READY",
        fundingJson: { eth: "0", usdc: "0", weth: "0", transactions: [] },
        mandateJson: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      try {
        this.repository.saveTradingAgent(agent);
      } catch (error) {
        const concurrent = this.get(normalizedOwner, chainId);
        if (concurrent) {
          this.repository.updateAgentProvisioning(operation.id, {
            state: "READY",
            lastError: null,
          });
          return concurrent;
        }
        throw error;
      }
      this.repository.updateAgentProvisioning(operation.id, {
        state: "READY",
        lastError: null,
      });
      return agent;
    } catch (error) {
      // Keep the checkpoint in PROVISIONING. The same policy/wallet IDs and
      // idempotency keys are retried on the next request, allowing a provider
      // timeout or process restart to reconcile instead of duplicating.
      try {
        this.repository.updateAgentProvisioning(operation.id, {
          state: "PROVISIONING",
          lastError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Provider provisioning did not finish",
        });
      } catch {
        // Preserve the original failure if the local checkpoint is unavailable.
      }
      throw new ServiceError(
        "AGENT_RECONCILIATION_REQUIRED",
        "Agent provisioning did not finish; retry to reconcile the same Privy operation",
        409,
      );
    }
  }

  private walletClient(): any {
    const key = value("DEPLOYER_PRIVATE_KEY");
    if (!key || !this.rpcUrl)
      throw new ServiceError(
        "AGENT_FAUCET_UNAVAILABLE",
        "Sepolia faucet funding is not configured",
        503,
      );
    const rawKey = key.trim();
    const chain = defineChain({
      id: this.chainId,
      name: "Ethereum Sepolia",
      nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } },
    });
    return createWalletClient({
      account: privateKeyToAccount(
        (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`,
      ),
      chain,
      transport: http(this.rpcUrl),
    });
  }

  private publicClient(): any {
    if (!this.rpcUrl)
      throw new ServiceError(
        "AGENT_FAUCET_UNAVAILABLE",
        "Sepolia faucet funding is not configured",
        503,
      );
    const chain = defineChain({
      id: this.chainId,
      name: "Ethereum Sepolia",
      nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } },
    });
    return createPublicClient({ chain, transport: http(this.rpcUrl) });
  }

  private async fundInternal(
    ownerAddress: string,
    id: string,
    input: FundAgentRequest,
  ): Promise<TradingAgent> {
    const agent = this.repository.getTradingAgentById(id);
    if (
      !agent ||
      agent.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()
    )
      throw new ServiceError(
        "AGENT_NOT_FOUND",
        "Trading agent was not found",
        404,
      );
    if (agent.chainId !== this.chainId)
      throw new ServiceError(
        "CHAIN_MISMATCH",
        "Trading agent chain mismatch",
        409,
      );
    const requested = {
      eth: decimal(input.eth, "ETH"),
      usdc: decimal(input.usdc, "USDC"),
      weth: decimal(input.weth, "WETH"),
    };
    if (requested.eth === 0n && requested.usdc === 0n && requested.weth === 0n)
      throw new ServiceError(
        "AGENT_FUNDING_INVALID",
        "Request at least one non-zero funding amount",
        400,
      );
    const previous = fundingFrom(agent.fundingJson);
    const cooldown = Number(
      value("AURKA_AGENT_FAUCET_COOLDOWN_SECONDS") ?? "60",
    );
    if (
      previous.lastFundingAt &&
      Math.floor(Date.now() / 1000) < previous.lastFundingAt + cooldown
    )
      throw new ServiceError(
        "AGENT_FAUCET_COOLDOWN",
        "Test funding is temporarily rate limited; try again shortly",
        429,
      );
    const maxEth = decimal(
      value("AURKA_AGENT_FAUCET_MAX_ETH_WEI") ?? "100000000000000000",
      "faucet ETH cap",
    );
    const maxUsdc = decimal(
      value("AURKA_AGENT_FAUCET_MAX_USDC") ?? "1000000000",
      "faucet USDC cap",
    );
    const maxWeth = decimal(
      value("AURKA_AGENT_FAUCET_MAX_WETH_WEI") ?? "1000000000000000000",
      "faucet WETH cap",
    );
    const globalMaxEth = decimal(
      value("AURKA_AGENT_FAUCET_GLOBAL_MAX_ETH_WEI") ?? "1000000000000000000",
      "global faucet ETH cap",
    );
    const globalMaxUsdc = decimal(
      value("AURKA_AGENT_FAUCET_GLOBAL_MAX_USDC") ?? "100000000000",
      "global faucet USDC cap",
    );
    const globalMaxWeth = decimal(
      value("AURKA_AGENT_FAUCET_GLOBAL_MAX_WETH_WEI") ??
        "100000000000000000000",
      "global faucet WETH cap",
    );
    if (
      requested.eth > maxEth ||
      requested.usdc > maxUsdc ||
      requested.weth > maxWeth
    )
      throw new ServiceError(
        "AGENT_FUNDING_LIMIT",
        "Test funding exceeds the faucet limit",
        400,
      );
    const pendingOperation = this.repository.getPendingAgentFunding(id);
    const requestedStrings = {
      eth: requested.eth.toString(),
      usdc: requested.usdc.toString(),
      weth: requested.weth.toString(),
    };
    const reservedRequested = pendingOperation
      ? {
          eth: pendingOperation.ethAmount,
          usdc: pendingOperation.usdcAmount,
          weth: pendingOperation.wethAmount,
        }
      : (previous.pendingRequested ?? previous.pending ?? requestedStrings);
    if (
      pendingOperation &&
      (reservedRequested.eth !== requestedStrings.eth ||
        reservedRequested.usdc !== requestedStrings.usdc ||
        reservedRequested.weth !== requestedStrings.weth)
    )
      throw new ServiceError(
        "AGENT_FUNDING_RECONCILIATION_REQUIRED",
        "A previous faucet operation is still pending; retry it with the original amounts",
        409,
      );
    const reservationAmounts = previous.pending ?? reservedRequested;
    const operationId = pendingOperation?.id ?? randomUUID();
    if (!pendingOperation) {
      const reserved = this.repository.reserveAgentFunding({
        id: operationId,
        agentId: id,
        ownerAddress: ownerAddress,
        chainId: agent.chainId,
        ethAmount: reservedRequested.eth,
        usdcAmount: reservedRequested.usdc,
        wethAmount: reservedRequested.weth,
        maximum: {
          ethAmount: globalMaxEth.toString(),
          usdcAmount: globalMaxUsdc.toString(),
          wethAmount: globalMaxWeth.toString(),
        },
      });
      if (!reserved)
        throw new ServiceError(
          "AGENT_FAUCET_GLOBAL_BUDGET",
          "The shared Sepolia test-funding budget is exhausted; try again later",
          429,
        );
    }
    const amounts = {
      eth: BigInt(reservationAmounts.eth),
      usdc: BigInt(reservationAmounts.usdc),
      weth: BigInt(reservationAmounts.weth),
    };
    const initialFunding = {
      eth: previous.eth,
      usdc: previous.usdc,
      weth: previous.weth,
      transactions: [...(previous.transactions ?? [])],
      pending: {
        eth: amounts.eth.toString(),
        usdc: amounts.usdc.toString(),
        weth: amounts.weth.toString(),
      },
      pendingRequested: reservedRequested,
      pendingOperationId: operationId,
    };
    this.repository.updateTradingAgent(id, {
      state: "FUNDING",
      fundingJson: initialFunding,
      lastError: null,
    });
    const client = this.walletClient();
    const publicClient = this.publicClient();
    const confirm = async (
      kind: "eth" | "usdc" | "weth",
      amount: bigint,
      hash: string,
    ) => {
      await publicClient.waitForTransactionReceipt({
        hash: hash as `0x${string}`,
      });
      const current = fundingFrom(
        this.repository.getTradingAgentById(id)?.fundingJson ?? initialFunding,
      );
      const currentPending = current.pending ?? {
        eth: "0",
        usdc: "0",
        weth: "0",
      };
      const nextFunding = {
        eth:
          kind === "eth"
            ? (BigInt(current.eth) + amount).toString()
            : current.eth,
        usdc:
          kind === "usdc"
            ? (BigInt(current.usdc) + amount).toString()
            : current.usdc,
        weth:
          kind === "weth"
            ? (BigInt(current.weth) + amount).toString()
            : current.weth,
        transactions: [...(current.transactions ?? []), hash],
        pending: {
          eth:
            kind === "eth"
              ? (BigInt(currentPending.eth) - amount).toString()
              : currentPending.eth,
          usdc:
            kind === "usdc"
              ? (BigInt(currentPending.usdc) - amount).toString()
              : currentPending.usdc,
          weth:
            kind === "weth"
              ? (BigInt(currentPending.weth) - amount).toString()
              : currentPending.weth,
        },
        pendingRequested: current.pendingRequested ?? reservedRequested,
        pendingOperationId: current.pendingOperationId ?? operationId,
      };
      this.repository.updateTradingAgent(id, { fundingJson: nextFunding });
    };
    try {
      if (amounts.eth > 0n) {
        const hash = await client.sendTransaction({
          to: agent.walletAddress as `0x${string}`,
          value: amounts.eth,
        });
        await confirm("eth", amounts.eth, hash);
      }
      if (amounts.usdc > 0n) {
        const hash = await client.writeContract({
          address: this.outputToken as `0x${string}`,
          abi: erc20MintAbi,
          functionName: "mint",
          args: [agent.walletAddress as `0x${string}`, amounts.usdc],
        });
        await confirm("usdc", amounts.usdc, hash);
      }
      if (amounts.weth > 0n) {
        const hash = await client.writeContract({
          address: this.inputToken as `0x${string}`,
          abi: erc20MintAbi,
          functionName: "mint",
          args: [agent.walletAddress as `0x${string}`, amounts.weth],
        });
        await confirm("weth", amounts.weth, hash);
      }
    } catch (error) {
      const current = this.repository.getTradingAgentById(id);
      this.repository.updateTradingAgent(id, {
        state: "FAILED",
        fundingJson: current?.fundingJson ?? initialFunding,
        lastError:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Faucet transaction failed",
      });
      throw new ServiceError(
        "AGENT_FUNDING_FAILED",
        "Sepolia test funding failed; inspect the agent and retry after reconciliation",
        409,
      );
    }
    const current = fundingFrom(
      this.repository.getTradingAgentById(id)?.fundingJson ?? initialFunding,
    );
    const completedFunding = {
      eth: current.eth,
      usdc: current.usdc,
      weth: current.weth,
      ...(current.lastFundingAt === undefined
        ? {}
        : { lastFundingAt: current.lastFundingAt }),
      ...(current.transactions === undefined
        ? {}
        : { transactions: current.transactions }),
    };
    this.repository.completeAgentFunding(
      current.pendingOperationId ?? operationId,
    );
    return this.repository.updateTradingAgent(id, {
      state: "READY",
      fundingJson: {
        ...completedFunding,
        lastFundingAt: Math.floor(Date.now() / 1000),
      },
    });
  }

  async fund(
    ownerAddress: string,
    id: string,
    input: FundAgentRequest,
  ): Promise<TradingAgent> {
    // A browser timeout does not cancel work already accepted by the API.
    // Reuse the same in-process operation while its three receipts settle so
    // a user retry cannot submit a second faucet batch concurrently.
    const normalizedOwner = ownerAddress.toLowerCase();
    const existing = this.fundingInFlight.get(id);
    if (existing) {
      if (existing.ownerAddress !== normalizedOwner)
        throw new ServiceError(
          "AGENT_NOT_FOUND",
          "Trading agent was not found",
          404,
        );
      if (
        existing.input.eth !== input.eth ||
        existing.input.usdc !== input.usdc ||
        existing.input.weth !== input.weth
      )
        throw new ServiceError(
          "AGENT_FUNDING_RECONCILIATION_REQUIRED",
          "A previous faucet operation is still pending; retry it with the original amounts",
          409,
        );
      return existing.promise;
    }
    const operation = this.fundInternal(ownerAddress, id, input);
    this.fundingInFlight.set(id, {
      ownerAddress: normalizedOwner,
      input,
      promise: operation,
    });
    try {
      return await operation;
    } finally {
      if (this.fundingInFlight.get(id)?.promise === operation)
        this.fundingInFlight.delete(id);
    }
  }

  setMandate(
    ownerAddress: string,
    id: string,
    input: AgentMandate,
  ): TradingAgent {
    mandateSchema.parse(input);
    const agent = this.repository.getTradingAgentById(id);
    if (
      !agent ||
      agent.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()
    )
      throw new ServiceError(
        "AGENT_NOT_FOUND",
        "Trading agent was not found",
        404,
      );
    const activeSession = this.repository
      .listDelegatedSessions(ownerAddress)
      .find(
        (session) =>
          session.wallet.address?.toLowerCase() ===
            agent.walletAddress.toLowerCase() &&
          [
            "AUTHORIZED",
            "ACTIVE",
            "REVOKE_PENDING",
            "RECONCILIATION_REQUIRED",
          ].includes(session.state),
      );
    if (activeSession)
      throw new ServiceError(
        "AGENT_ACTIVE",
        "Stop the active agent before changing its mandate",
        409,
      );
    return this.repository.updateTradingAgent(id, {
      state: agent.state === "ACTIVE" ? "ACTIVE" : "READY",
      mandateJson: input,
      lastError: null,
    });
  }

  /**
   * Archive the application record and revoke this wallet's execution signer.
   * The Privy wallet is retained for audit/recovery; this is intentionally a
   * reversible product archive rather than destructive remote deletion.
   */
  async archive(ownerAddress: string, id: string): Promise<TradingAgent> {
    const agent = this.repository.getTradingAgentById(id);
    if (
      !agent ||
      agent.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()
    )
      throw new ServiceError(
        "AGENT_NOT_FOUND",
        "Trading agent was not found",
        404,
      );
    if (agent.state === "REVOKED") return agent;
    if (agent.state === "FUNDING")
      throw new ServiceError(
        "AGENT_RECONCILIATION_REQUIRED",
        "Wait for the agent funding operation to settle before archiving it",
        409,
      );
    const sessions = this.repository
      .listDelegatedSessions(ownerAddress)
      .filter(
        (session) =>
          session.wallet.address?.toLowerCase() ===
          agent.walletAddress.toLowerCase(),
      );
    if (
      sessions.some((session) =>
        ["AUTHORIZED", "ACTIVE", "REVOKE_PENDING"].includes(session.state),
      )
    )
      throw new ServiceError(
        "AGENT_ACTIVE",
        "Stop and revoke the active agent before archiving it",
        409,
      );
    if (
      sessions.some((session) =>
        session.trades.some((trade) =>
          [
            "RESERVED",
            "SIGNING",
            "SUBMITTED",
            "RECONCILIATION_REQUIRED",
          ].includes(trade.status),
        ),
      )
    )
      throw new ServiceError(
        "AGENT_RECONCILIATION_REQUIRED",
        "Reconcile pending agent activity before archiving it",
        409,
      );
    const pendingRecovery = sessions.some((session) =>
      this.repository
        .listDelegatedRecoveries(session.id)
        .some((recovery) =>
          ["PENDING", "SUBMITTED", "UNKNOWN"].includes(recovery.status),
        ),
    );
    if (pendingRecovery)
      throw new ServiceError(
        "AGENT_RECONCILIATION_REQUIRED",
        "Reconcile pending recovery activity before archiving the agent",
        409,
      );
    let delegatedWallet: DelegatedWalletAdapter;
    let wallet: DelegatedStatus["wallet"];
    try {
      delegatedWallet = await this.adapter(agent);
      wallet = await delegatedWallet.getStatus();
    } catch (error) {
      throw new ServiceError(
        "AGENT_ARCHIVE_FAILED",
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Agent wallet status could not be verified",
        409,
      );
    }
    if (!wallet.balances)
      throw new ServiceError(
        "AGENT_BALANCE_UNAVAILABLE",
        "Verify the agent wallet balances before archiving it",
        409,
      );
    if (
      BigInt(wallet.balances.inputToken) > 0n ||
      BigInt(wallet.balances.outputToken) > 0n
    )
      throw new ServiceError(
        "AGENT_FUNDS_REMAINING",
        "Recover the agent's WETH and USDC before archiving it",
        409,
      );
    try {
      await delegatedWallet.revoke();
    } catch (error) {
      throw new ServiceError(
        "AGENT_ARCHIVE_FAILED",
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Agent signer revocation failed",
        409,
      );
    }
    return this.repository.updateTradingAgent(id, {
      state: "REVOKED",
      mandateJson: null,
      lastError: null,
    });
  }

  async adapter(agent: TradingAgent): Promise<DelegatedWalletAdapter> {
    const client = createDelegatedPrivyClient(await this.client());
    const rpc = this.rpc;
    const options: DelegatedPrivyAdapterOptions = {
      client,
      policy: async () => {
        const wallet = await this.readWallet(agent.walletId);
        const execution = await (
          await this.client()
        )
          .policies()
          .get(this.executionPolicyId);
        validateExecutionPolicy(
          wallet,
          execution,
          this.ownerId,
          this.signerId,
          this.executionPolicyId,
          agent.recoveryPolicyId,
          this.chainId,
          this.router,
          this.inputToken,
          this.maximumInputAmount,
          false,
        );
        const recovery = await (
          await this.client()
        )
          .policies()
          .get(agent.recoveryPolicyId);
        validateRecoveryPolicy(
          wallet,
          recovery,
          this.ownerId,
          agent.recoveryPolicyId,
          agent.ownerAddress,
          this.chainId,
          this.inputToken,
          this.outputToken,
          this.maximumRecoveryAmount,
        );
        const signers = Array.isArray(wallet.additional_signers)
          ? wallet.additional_signers
          : [];
        return {
          walletId: agent.walletId,
          walletAddress: address(String(wallet.address), "Privy agent address"),
          signerAddress: this.signerAddress,
          policyId: this.executionPolicyId,
          chainId: this.chainId,
          router: this.router,
          inputToken: this.inputToken,
          outputToken: this.outputToken,
          maximumInputAmount: this.maximumInputAmount,
          validUntil: this.validUntil,
          paused: execution.paused === true,
          revoked:
            execution.revoked === true ||
            !signers.some((item: any) => item?.signer_id === this.signerId),
          fingerprint: executionFingerprint(execution),
          allowedMethods: [
            "eth_call",
            "eth_signTypedData_v4",
            transactionMethod(),
          ],
          routerMethod: routerMethod(),
        };
      },
      rpc,
      authorization: async () => ({
        authorization_private_keys: [this.authorizationKey],
      }),
      revokeRemote: async () => {
        const wallet = await this.readWallet(agent.walletId);
        const signers = Array.isArray(wallet.additional_signers)
          ? wallet.additional_signers.filter(
              (item: any) => item?.signer_id !== this.signerId,
            )
          : [];
        await (await this.client()).wallets().update(agent.walletId, {
          additional_signers: signers,
          authorization_context: {
            authorization_private_keys: [this.ownerAuthorizationKey],
          },
        });
        const confirmed = await this.readWallet(agent.walletId);
        if (
          (confirmed.additional_signers ?? []).some(
            (item: any) => item?.signer_id === this.signerId,
          )
        )
          throw new Error("Privy signer revoke was not confirmed");
      },
      restoreRemote: async () => {
        const wallet = await this.readWallet(agent.walletId);
        const signers = Array.isArray(wallet.additional_signers)
          ? wallet.additional_signers
          : [];
        const hasSigner = signers.some(
          (item: any) => item?.signer_id === this.signerId,
        );
        const nextSigners = hasSigner
          ? signers
          : [
              ...signers,
              {
                signer_id: this.signerId,
                override_policy_ids: [this.executionPolicyId],
              },
            ];
        if (!hasSigner)
          await (await this.client()).wallets().update(agent.walletId, {
            additional_signers: nextSigners,
            authorization_context: {
              authorization_private_keys: [this.ownerAuthorizationKey],
            },
          });
        const confirmed = await this.readWallet(agent.walletId);
        if (
          !(confirmed.additional_signers ?? []).some(
            (item: any) => item?.signer_id === this.signerId,
          )
        )
          throw new Error("Privy signer restore was not confirmed");
      },
      recoverRemote: async ({ destination, assets, authorizationHash }) => {
        const asset = assets[0];
        if (!asset) throw new Error("Recovery asset is missing");
        const recoveryWallet = await this.readWallet(agent.walletId);
        const recoveryPolicy = await (
          await this.client()
        )
          .policies()
          .get(agent.recoveryPolicyId);
        validateRecoveryPolicy(
          recoveryWallet,
          recoveryPolicy,
          this.ownerId,
          agent.recoveryPolicyId,
          agent.ownerAddress,
          this.chainId,
          this.inputToken,
          this.outputToken,
          this.maximumRecoveryAmount,
        );
        const data = (await import("viem")).encodeFunctionData({
          abi: erc20TransferAbi,
          functionName: "transfer",
          args: [destination as `0x${string}`, BigInt(asset.amount)],
        });
        const nonce = BigInt(
          String(
            await rpc.request("eth_getTransactionCount", [
              agent.walletAddress,
              "pending",
            ]),
          ),
        ).toString();
        const gas = BigInt(
          String(
            await rpc.request("eth_estimateGas", [
              {
                from: agent.walletAddress,
                to: asset.token,
                data,
                value: "0x0",
              },
            ]),
          ),
        ).toString();
        const gasPrice = BigInt(String(await rpc.request("eth_gasPrice", [])));
        const priorityFee = BigInt(
          String(await rpc.request("eth_maxPriorityFeePerGas", [])),
        );
        const maxFee = gasPrice * 2n + priorityFee;
        const transaction = {
          from: agent.walletAddress,
          to: asset.token,
          data,
          value: "0x0",
          nonce: `0x${BigInt(nonce).toString(16)}`,
          chain_id: `0x${this.chainId.toString(16)}`,
          gas_limit: `0x${BigInt(gas).toString(16)}`,
          max_fee_per_gas: `0x${maxFee.toString(16)}`,
          max_priority_fee_per_gas: `0x${priorityFee.toString(16)}`,
        };
        const authorization = {
          authorization_private_keys: [this.ownerAuthorizationKey],
        };
        const idempotencyKey = `aurka-user-recovery:${authorizationHash}`;
        if (transactionMethod() === "eth_signTransaction") {
          const signed = await (
            await this.client()
          )
            .wallets()
            .ethereum()
            .signTransaction(agent.walletId, {
              params: { transaction },
              authorization_context: authorization,
              idempotency_key: idempotencyKey,
            });
          if (
            signed?.encoding !== "rlp" ||
            typeof signed?.signed_transaction !== "string" ||
            !/^0x[0-9a-fA-F]+$/.test(signed.signed_transaction)
          )
            throw new Error(
              "Privy returned no trustworthy recovery transaction",
            );
          const signer = await recoverTransactionAddress({
            serializedTransaction: signed.signed_transaction,
          });
          const parsed = parseTransaction(signed.signed_transaction);
          if (
            signer.toLowerCase() !== agent.walletAddress.toLowerCase() ||
            parsed.to?.toLowerCase() !== asset.token.toLowerCase() ||
            (parsed.data ?? "0x").toLowerCase() !== data.toLowerCase() ||
            (parsed.value ?? 0n) !== 0n ||
            parsed.nonce !== Number(BigInt(nonce)) ||
            parsed.chainId !== this.chainId ||
            parsed.gas !== BigInt(gas) ||
            (parsed.maxFeePerGas !== undefined &&
              parsed.maxFeePerGas !== maxFee) ||
            (parsed.maxPriorityFeePerGas !== undefined &&
              parsed.maxPriorityFeePerGas !== priorityFee)
          )
            throw new Error("Privy changed the reviewed recovery transaction");
          const hash = await rpc.request("eth_sendRawTransaction", [
            signed.signed_transaction,
          ]);
          if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
            throw new Error("Recovery broadcast returned no trustworthy hash");
          return { transactionHash: hash };
        }
        const result = await (
          await this.client()
        )
          .wallets()
          .ethereum()
          .sendTransaction(agent.walletId, {
            caip2: `eip155:${this.chainId}`,
            params: { transaction },
            authorization_context: authorization,
            idempotency_key: idempotencyKey,
          });
        if (
          result?.caip2 !== `eip155:${this.chainId}` ||
          typeof result?.hash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(result.hash)
        )
          throw new Error(
            "Privy recovery returned no trustworthy transaction hash",
          );
        return { transactionHash: result.hash };
      },
      broadcastMode:
        value("PRIVY_DELEGATED_BROADCAST_MODE") === "sign-and-broadcast"
          ? "sign-and-broadcast"
          : "privy",
    };
    return new PrivyDelegatedExecutionAdapter(options);
  }
}
