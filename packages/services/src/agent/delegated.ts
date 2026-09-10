import {
  delegatedAuthorizationTypedData,
  delegatedControlAuthorizationSchema,
  delegatedControlRequestHash,
  delegatedControlTypedData,
  delegatedRecoveryRequestSchema,
  delegatedRecoveryTypedData,
  delegatedSessionId,
  delegatedSessionSchema,
  delegatedStatusSchema,
  type AgentProposalResponse,
  type AtomicSettlementIntent,
  type DelegatedSession,
  type DelegatedSessionAuthorization,
  type DelegatedSessionPlan,
  type DelegatedRecoveryAsset,
  type DelegatedRecoveryRequest,
  type DelegatedStatus,
  type DelegatedControlAction,
  type DelegatedControlAuthorization,
} from "@aurka/shared";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { hashTypedData, recoverAddress } from "viem";

import {
  createDelegatedPrivyClient,
  createPrivyNodeClientFromEnv,
  PrivyDelegatedExecutionAdapter,
  delegatedExecutionPolicySchema,
  DelegatedBroadcastUnknownError,
  type DelegatedIntentTypedData,
  type DelegatedChainRpc,
  type DelegatedPrivyAdapterOptions,
  type DelegatedWalletAdapter,
} from "@aurka/wallet";
import { hashBytes } from "../solver/hash.js";
import { ServiceError, type AurkaService } from "../service.js";
import type { SolverSnapshot } from "../solver/types.js";

type WalletAuthorizationContext = Parameters<
  DelegatedWalletAdapter["signIntent"]
>[1];

export interface DelegatedAgentProposalSource {
  propose(input: {
    readonly message: string;
    readonly trader: string;
    readonly chainId: number;
  }): Promise<AgentProposalResponse>;
}

export interface DelegatedSessionServiceOptions {
  readonly now?: () => number;
  readonly authorizationContext?: () => Promise<WalletAuthorizationContext>;
  /** A server-trusted application identity bound to the configured wallet. */
  readonly trustedOwnerAddress?: string;
}

type DelegatedOperatorModule = {
  getDelegatedExecutionPolicy?: (input: {
    readonly walletId: string;
  }) => Promise<unknown>;
  revokeDelegatedSigner?: (input: {
    readonly walletId: string;
    readonly signerId: string;
    readonly policyId: string;
  }) => Promise<void>;
  recoverDelegatedFunds?: (input: {
    readonly walletId: string;
    readonly sessionId: string;
    readonly ownerAddress: string;
    readonly destination: string;
    readonly assets: readonly DelegatedRecoveryAsset[];
    readonly authorizationHash: string;
    readonly rpc: DelegatedChainRpc;
  }) => Promise<{ readonly transactionHash?: string } | void>;
  approveDelegatedToken?: (input: {
    readonly walletId: string;
    readonly token: string;
    readonly spender: string;
    readonly amount: string;
    readonly sessionId: string;
  }) => Promise<{ readonly transactionHash?: string } | void>;
};

type DelegatedAuthorizationModule = {
  getPrivyAuthorizationContext?: (input: {
    readonly operation:
      "signTypedData" | "eth_sendTransaction" | "signTransaction";
    readonly request: Record<string, unknown>;
  }) => Promise<unknown>;
};

/**
 * Load the live adapter only when the wallet identity, owner binding and RPC
 * route are configured. The bundled operator modules can be overridden, but
 * keep Privy owner authorization material outside AURKA's database, logs,
 * prompts, and browser bundle.
 */
export async function createDelegatedSessionServiceFromEnv(
  service: AurkaService,
  agent: DelegatedAgentProposalSource,
): Promise<DelegatedSessionService> {
  const walletId = process.env.PRIVY_DELEGATED_WALLET_ID?.trim();
  const signerId = process.env.PRIVY_DELEGATED_SIGNER_ID?.trim();
  const policyId = process.env.PRIVY_DELEGATED_POLICY_ID?.trim();
  const recoveryPolicyId =
    process.env.PRIVY_DELEGATED_RECOVERY_POLICY_ID?.trim();
  const maximumRecoveryAmount =
    process.env.PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT?.trim();
  const policyModulePath =
    process.env.PRIVY_DELEGATED_POLICY_MODULE?.trim() ??
    new URL(
      "../../../wallet/scripts/privy-delegated-operator.mjs",
      import.meta.url,
    ).pathname;
  const trustedOwnerAddress = process.env.PRIVY_DELEGATED_OWNER_ADDRESS?.trim();
  const authorizationModulePath =
    process.env.PRIVY_DELEGATED_AUTHORIZATION_MODULE?.trim() ??
    new URL(
      "../../../wallet/scripts/privy-delegated-authorization.mjs",
      import.meta.url,
    ).pathname;
  const broadcastMode =
    process.env.PRIVY_DELEGATED_BROADCAST_MODE === "sign-and-broadcast"
      ? "sign-and-broadcast"
      : "privy";
  if (
    !walletId ||
    !signerId ||
    !policyId ||
    !recoveryPolicyId ||
    !maximumRecoveryAmount ||
    !policyModulePath ||
    !authorizationModulePath ||
    !trustedOwnerAddress ||
    !service.rpcTransport
  )
    return new DelegatedSessionService(
      service,
      agent,
      new UnavailableDelegatedWallet(),
    );
  const operator = (await import(
    pathToFileURL(resolve(policyModulePath)).href
  )) as DelegatedOperatorModule;
  const authorization = (await import(
    pathToFileURL(resolve(authorizationModulePath)).href
  )) as DelegatedAuthorizationModule;
  if (
    typeof operator.getDelegatedExecutionPolicy !== "function" ||
    typeof operator.revokeDelegatedSigner !== "function" ||
    typeof operator.recoverDelegatedFunds !== "function"
  )
    throw new Error(
      "PRIVY_DELEGATED_POLICY_MODULE must export getDelegatedExecutionPolicy, revokeDelegatedSigner, and recoverDelegatedFunds",
    );
  if (typeof authorization.getPrivyAuthorizationContext !== "function")
    throw new Error(
      "PRIVY_DELEGATED_AUTHORIZATION_MODULE must export getPrivyAuthorizationContext",
    );
  const client = createDelegatedPrivyClient(
    await createPrivyNodeClientFromEnv(),
  );
  const adapterOptions: DelegatedPrivyAdapterOptions = {
    client,
    policy: async () =>
      delegatedExecutionPolicySchema.parse(
        await operator.getDelegatedExecutionPolicy!({ walletId }),
      ),
    rpc: {
      request: (method, params) =>
        service.rpcTransport!.request({ method, params }),
    },
    authorization: async (operation, request) =>
      (await authorization.getPrivyAuthorizationContext!({
        operation,
        request,
      })) as never,
    revokeRemote: () =>
      operator.revokeDelegatedSigner!({ walletId, signerId, policyId }),
    recoverRemote: (input) =>
      operator.recoverDelegatedFunds!({
        walletId,
        ...input,
        assets: input.assets,
        authorizationHash: input.authorizationHash,
        rpc: {
          request: (method, params) =>
            service.rpcTransport!.request({ method, params }),
        },
      }),
    broadcastMode,
  };
  return new DelegatedSessionService(
    service,
    agent,
    new PrivyDelegatedExecutionAdapter(adapterOptions),
    { trustedOwnerAddress },
  );
}

/** A safe default: the API exposes the unavailable state until the dedicated
 * Privy identity, owner binding and server-only authorization route exist. */
export class UnavailableDelegatedWallet implements DelegatedWalletAdapter {
  async getStatus() {
    return delegatedStatusWallet("Delegated Privy wallet is not configured");
  }
  async signIntent(): Promise<string> {
    throw new ServiceError(
      "DELEGATED_UNAVAILABLE",
      "Delegated Privy wallet is not configured",
      503,
    );
  }
  async simulateAndSend(): Promise<{
    readonly transactionHash: string;
    readonly policyFingerprint: string;
  }> {
    throw new ServiceError(
      "DELEGATED_UNAVAILABLE",
      "Delegated Privy wallet is not configured",
      503,
    );
  }
  async getReceipt(): Promise<null> {
    return null;
  }
  async revoke(): Promise<void> {
    throw new ServiceError(
      "DELEGATED_UNAVAILABLE",
      "Delegated Privy wallet is not configured",
      503,
    );
  }
}

function delegatedStatusWallet(reason: string) {
  return {
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
    reason,
  } as const;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function settlementIntentTypedData(
  intent: AtomicSettlementIntent,
  snapshot: SolverSnapshot,
): DelegatedIntentTypedData {
  return {
    domain: {
      name: "AURKA Direct Settlement",
      version: "1",
      chainId: snapshot.chainId,
      verifyingContract: snapshot.verifyingContract,
    },
    primaryType: "Intent",
    types: {
      Intent: [
        { name: "intentId", type: "bytes32" },
        { name: "policyId", type: "bytes32" },
        { name: "positionIdHash", type: "bytes32" },
        { name: "trader", type: "address" },
        { name: "traderInputToken", type: "address" },
        { name: "traderOutputToken", type: "address" },
        { name: "requestedValue", type: "uint256" },
        { name: "minimumTraderOutputValue", type: "uint256" },
        { name: "exactInput", type: "bool" },
        { name: "allowPartialFill", type: "bool" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "balanceSnapshot", type: "bytes32" },
        { name: "priceSnapshot", type: "bytes32" },
        { name: "aquaStrategyHash", type: "bytes32" },
      ],
    },
    message: {
      intentId: intent.intentId,
      policyId: intent.policyId,
      positionIdHash: intent.positionIdHash,
      trader: intent.trader,
      traderInputToken: intent.traderInputToken,
      traderOutputToken: intent.traderOutputToken,
      requestedValue: intent.requestedValue,
      minimumTraderOutputValue: intent.minimumTraderOutputValue,
      exactInput: intent.exactInput,
      allowPartialFill: intent.allowPartialFill,
      deadline: intent.deadline.toString(),
      nonce: intent.nonce,
      balanceSnapshot: intent.balanceSnapshot,
      priceSnapshot: intent.priceSnapshot,
      aquaStrategyHash: intent.aquaStrategyHash,
    },
  } as unknown as DelegatedIntentTypedData;
}

function validateAuthorization(
  value: DelegatedSessionAuthorization,
  agentAddress: string,
  chainId: number,
  now: number,
): DelegatedSessionPlan {
  const authorization = value;
  if (!sameAddress(authorization.agentWallet, agentAddress))
    throw new ServiceError(
      "DELEGATED_WALLET_MISMATCH",
      "Authorization is bound to a different agent wallet",
    );
  if (authorization.plan.chainId !== chainId)
    throw new ServiceError(
      "CHAIN_MISMATCH",
      "Delegation authorization is for a different chain",
    );
  if (authorization.plan.expiresAt <= now + 60)
    throw new ServiceError(
      "DELEGATED_EXPIRY_INVALID",
      "Delegation expiry must leave at least one minute",
    );
  if (authorization.plan.expiresAt > now + 3_600)
    throw new ServiceError(
      "DELEGATED_EXPIRY_INVALID",
      "Delegation sessions are limited to one hour",
    );
  return authorization.plan;
}

function checkSpaceEligibility(
  service: AurkaService,
  plan: DelegatedSessionPlan,
): void {
  for (const spaceId of plan.allowedSpaceIds) {
    const space = service.getSpace(spaceId);
    if (space.identity.state !== "ACTIVE" || !space.position)
      throw new ServiceError(
        "DELEGATED_SPACE_INELIGIBLE",
        `Space ${spaceId} is not active`,
      );
    if (space.position.chainId !== plan.chainId)
      throw new ServiceError(
        "CHAIN_MISMATCH",
        `Space ${spaceId} is on a different chain`,
      );
    const assets = space.position.policy.assets.map((asset) =>
      asset.token.toLowerCase(),
    );
    if (
      !assets.includes(plan.traderInputToken.toLowerCase()) ||
      !assets.includes(plan.traderOutputToken.toLowerCase())
    )
      throw new ServiceError(
        "DELEGATED_SPACE_INELIGIBLE",
        `Space ${spaceId} does not manage the reviewed token pair`,
      );
  }
}

function sessionWithWallet(
  plan: DelegatedSessionPlan,
  id: string,
  wallet: DelegatedSession["wallet"],
  now: number,
): DelegatedSession {
  return delegatedSessionSchema.parse({
    id,
    plan,
    wallet,
    state: "AUTHORIZED",
    authorizedAt: now,
    consumedInputAmount: "0",
    tradeCount: 0,
    remainingInputBudget: plan.cumulativeInputBudget,
    updatedAt: now,
    authorityGeneration: 0,
    trades: [],
  });
}

export class DelegatedSessionService {
  private readonly now: () => number;
  private readonly authorizationContext: () => Promise<WalletAuthorizationContext>;
  private readonly trustedOwnerAddress: string | undefined;
  private walletOperation: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: AurkaService,
    private readonly agent: DelegatedAgentProposalSource,
    private readonly wallet: DelegatedWalletAdapter,
    options: DelegatedSessionServiceOptions = {},
  ) {
    this.now = options.now ?? nowSeconds;
    this.authorizationContext =
      options.authorizationContext ??
      (async () => ({}) as WalletAuthorizationContext);
    this.trustedOwnerAddress = options.trustedOwnerAddress;
  }

  private async withWalletOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.walletOperation;
    let release!: () => void;
    this.walletOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private isAuthorityCurrent(id: string, authorityGeneration: number): boolean {
    const session = this.get(id);
    return (
      session.state === "ACTIVE" &&
      session.authorityGeneration === authorityGeneration
    );
  }

  private assertTrustedOwner(ownerAddress: string): void {
    if (this.trustedOwnerAddress === undefined)
      throw new ServiceError(
        "DELEGATED_OWNER_BINDING_MISSING",
        "The delegated wallet has no server-trusted owner binding",
        503,
      );
    if (!sameAddress(ownerAddress, this.trustedOwnerAddress))
      throw new ServiceError(
        "DELEGATED_OWNER_UNAUTHORIZED",
        "This wallet is bound to a different authorized owner",
        403,
      );
  }

  private async consumeControlAuthorization(
    id: string,
    action: DelegatedControlAction,
    message: string,
    authorization: DelegatedControlAuthorization,
  ): Promise<void> {
    const session = this.get(id);
    const value = delegatedControlAuthorizationSchema.parse(authorization);
    this.assertTrustedOwner(session.plan.ownerAddress);
    if (
      value.sessionId !== id ||
      !sameAddress(value.ownerAddress, session.plan.ownerAddress) ||
      !sameAddress(value.agentWallet, session.wallet.address!) ||
      value.chainId !== session.plan.chainId ||
      value.action !== action
    )
      throw new ServiceError(
        "DELEGATED_CONTROL_MISMATCH",
        "Control authorization is not bound to this delegated session",
        403,
      );
    const now = this.now();
    if (value.expiresAt <= now)
      throw new ServiceError(
        "DELEGATED_CONTROL_EXPIRED",
        "Control authorization has expired",
        403,
      );
    if (value.expiresAt > now + 300)
      throw new ServiceError(
        "DELEGATED_CONTROL_EXPIRED",
        "Control authorization is valid for at most five minutes",
        403,
      );
    if (
      value.requestHash.toLowerCase() !==
      delegatedControlRequestHash(message).toLowerCase()
    )
      throw new ServiceError(
        "DELEGATED_CONTROL_MISMATCH",
        "Control authorization does not cover this request",
        403,
      );
    let signer: string;
    try {
      signer = await recoverAddress({
        hash: hashTypedData(
          delegatedControlTypedData(
            session.plan,
            id,
            session.wallet.address!,
            action,
            value.requestHash,
            value.nonce,
            value.expiresAt,
          ) as never,
        ),
        signature: value.signature as `0x${string}`,
      });
    } catch {
      throw new ServiceError(
        "INVALID_SIGNATURE",
        "Control authorization signature is invalid",
        403,
      );
    }
    if (!sameAddress(signer, session.plan.ownerAddress))
      throw new ServiceError(
        "INVALID_SIGNATURE",
        "Control authorization is not signed by the owner",
        403,
      );
    const consumed =
      this.service.repository.consumeDelegatedControlAuthorization({
        authorizationHash: hashTypedData(
          delegatedControlTypedData(
            session.plan,
            id,
            session.wallet.address!,
            action,
            value.requestHash,
            value.nonce,
            value.expiresAt,
          ) as never,
        ),
        sessionId: id,
        ownerAddress: session.plan.ownerAddress,
        action,
        nonce: value.nonce,
        expiresAt: value.expiresAt,
      });
    if (!consumed)
      throw new ServiceError(
        "DELEGATED_AUTHORIZATION_REPLAYED",
        "This delegated control authorization has already been used",
        409,
      );
  }

  async status(): Promise<DelegatedStatus> {
    const wallet = await this.wallet.getStatus();
    return delegatedStatusSchema.parse({
      wallet,
      activeSessions: this.service.repository.activeDelegatedSessionCount(),
    });
  }

  async authorize(
    raw: DelegatedSessionAuthorization,
  ): Promise<DelegatedSession> {
    const value = raw;
    const wallet = await this.wallet.getStatus();
    if (
      !wallet.configured ||
      !wallet.address ||
      !wallet.chainId ||
      !wallet.policyFingerprint
    )
      throw new ServiceError(
        "DELEGATED_UNAVAILABLE",
        wallet.reason ?? "Delegated Privy wallet is not configured",
        503,
      );
    const plan = validateAuthorization(
      value,
      wallet.address,
      this.service.runtime.chainId,
      this.now(),
    );
    this.assertTrustedOwner(plan.ownerAddress);
    if (!wallet.enabled || wallet.revoked)
      throw new ServiceError(
        "DELEGATED_REVOKED",
        "Delegated Privy wallet is not enabled",
      );
    checkSpaceEligibility(this.service, plan);
    let signer: string;
    try {
      signer = await recoverAddress({
        hash: hashTypedData(
          delegatedAuthorizationTypedData(plan, wallet.address) as never,
        ),
        signature: value.signature as `0x${string}`,
      });
    } catch {
      throw new ServiceError(
        "INVALID_SIGNATURE",
        "Delegation authorization signature is invalid",
      );
    }
    if (!sameAddress(signer, plan.ownerAddress))
      throw new ServiceError(
        "INVALID_SIGNATURE",
        "Delegation authorization is not signed by the owner",
      );
    const id = delegatedSessionId(plan, wallet.address);
    const existing = this.service.repository.getDelegatedSession(id);
    if (existing) return existing;
    const session = sessionWithWallet(plan, id, wallet, this.now());
    this.service.repository.saveDelegatedSession(session);
    return session;
  }

  get(id: string): DelegatedSession {
    const session = this.service.repository.getDelegatedSession(id);
    if (!session)
      throw new ServiceError(
        "DELEGATED_SESSION_NOT_FOUND",
        "Delegated session was not found",
        404,
      );
    return session;
  }

  async start(
    id: string,
    message: string,
    authorization: DelegatedControlAuthorization,
  ): Promise<DelegatedSession> {
    await this.consumeControlAuthorization(id, "START", message, authorization);
    await this.reconcileInternal(id);
    let session = this.get(id);
    const now = this.now();
    if (session.plan.expiresAt <= now) {
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        { state: "EXPIRED" },
      );
      throw new ServiceError(
        "DELEGATED_EXPIRED",
        "Delegated session has expired",
      );
    }
    if (session.state === "AUTHORIZED") {
      if (
        !this.service.repository.updateDelegatedSessionIfGeneration(
          id,
          session.authorityGeneration,
          { state: "ACTIVE" },
        )
      )
        throw new ServiceError(
          "DELEGATED_STOPPED",
          "Delegated session was stopped before activation",
          409,
        );
      session = this.get(id);
    }
    if (session.state !== "ACTIVE")
      throw new ServiceError(
        "DELEGATED_NOT_ACTIVE",
        `Delegated session is ${session.state}`,
      );
    const pendingTrade = session.trades.find((trade) =>
      ["RESERVED", "SIGNING", "SUBMITTED", "RECONCILIATION_REQUIRED"].includes(
        trade.status,
      ),
    );
    if (pendingTrade) {
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        {
          state: "RECONCILIATION_REQUIRED",
          lastResult: `Trade ${pendingTrade.id} is pending reconciliation`,
        },
      );
      throw new ServiceError(
        "DELEGATED_RECONCILIATION_REQUIRED",
        "A delegated trade is pending; reconcile before starting another tick",
        409,
      );
    }
    if (
      session.tradeCount >= session.plan.maxTradeCount ||
      BigInt(session.consumedInputAmount) >=
        BigInt(session.plan.cumulativeInputBudget)
    ) {
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        { state: "EXHAUSTED" },
      );
      throw new ServiceError(
        "DELEGATED_EXHAUSTED",
        "Delegated session budget or trade count exhausted",
      );
    }
    const wallet = await this.wallet.getStatus();
    if (!wallet.enabled || wallet.revoked || wallet.address === null) {
      this.service.repository.stopDelegatedSession(
        id,
        "Delegated wallet permission is revoked or unavailable",
      );
      throw new ServiceError(
        "DELEGATED_REVOKED",
        "Delegated wallet permission is revoked or unavailable",
      );
    }
    if (!sameAddress(wallet.address, session.wallet.address!))
      throw new ServiceError(
        "DELEGATED_WALLET_MISMATCH",
        "Delegated wallet identity changed",
      );
    if (
      wallet.chainId !== session.plan.chainId ||
      wallet.policyFingerprint?.toLowerCase() !==
        session.wallet.policyFingerprint?.toLowerCase()
    ) {
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        {
          state: "RECONCILIATION_REQUIRED",
          lastResult: "Delegated wallet policy or chain changed",
        },
      );
      throw new ServiceError(
        "DELEGATED_POLICY_CHANGED",
        "Delegated wallet policy or chain changed; reconcile before signing",
        409,
      );
    }
    checkSpaceEligibility(this.service, session.plan);
    const proposal = await this.agent.propose({
      message,
      trader: wallet.address,
      chainId: session.plan.chainId,
    });
    if (proposal.status !== "READY") {
      const resultMessage =
        "reason" in proposal ? proposal.reason : proposal.answer;
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        { lastResult: resultMessage },
      );
      return this.get(id);
    }
    if (!session.plan.allowedSpaceIds.includes(proposal.selectedSpace.id))
      throw new ServiceError(
        "DELEGATED_SPACE_INELIGIBLE",
        "Agent proposal selected a Space outside the reviewed session",
      );
    const inputAmount = BigInt(proposal.proposal.traderInputAmount);
    if (inputAmount > BigInt(session.plan.perTradeInputAmount))
      throw new ServiceError(
        "DELEGATED_TRADE_CAP",
        "Agent proposal exceeds the per-trade input cap",
      );
    if (
      !sameAddress(
        proposal.proposal.traderInputToken,
        session.plan.traderInputToken,
      ) ||
      !sameAddress(
        proposal.proposal.traderOutputToken,
        session.plan.traderOutputToken,
      )
    )
      throw new ServiceError(
        "DELEGATED_DIRECTION",
        "Agent proposal direction differs from the reviewed session",
      );
    if (
      BigInt(proposal.proposal.traderOutputValue) * 10_000n <
      BigInt(proposal.proposal.traderInputValue) *
        BigInt(10_000 - session.plan.slippageBps)
    )
      throw new ServiceError(
        "DELEGATED_SLIPPAGE",
        "Agent proposal exceeds the reviewed slippage limit",
      );
    const intent = this.service.repository.getIntent(
      proposal.proposal.intentHash,
    );
    if (!intent)
      throw new ServiceError(
        "INTENT_NOT_FOUND",
        "Agent proposal intent was not persisted",
      );
    if (
      !sameAddress(intent.trader, wallet.address) ||
      intent.deadline < now ||
      intent.deadline > session.plan.expiresAt
    )
      throw new ServiceError(
        "DELEGATED_INTENT_MISMATCH",
        "Agent intent is not bound to the active delegated session",
      );
    const tradeId = hashBytes(`delegated-trade:${id}:${proposal.proposalHash}`);
    const idempotencyKey = `aurka-d:${hashBytes(`${id}:${proposal.proposalHash}`)}`;
    const trade = this.service.repository.reserveDelegatedTrade({
      id: tradeId,
      sessionId: id,
      intentHash: proposal.proposal.intentHash,
      proposalHash: proposal.proposalHash,
      inputAmount: inputAmount.toString(),
      idempotencyKey,
    });
    if (trade.status !== "RESERVED") return this.get(id);
    if (!this.service.repository.claimDelegatedTradeForSigning(trade.id))
      return this.get(id);
    const authorityGeneration = session.authorityGeneration;
    try {
      if (
        !this.service.repository.updateDelegatedSessionIfGeneration(
          id,
          authorityGeneration,
          { lastProposalHash: proposal.proposalHash },
        )
      )
        throw new ServiceError(
          "DELEGATED_STOPPED",
          "Delegated session was stopped before signing",
          409,
        );
      const snapshot = await this.service.provider.getSnapshot(intent);
      await this.wallet.preflight?.({
        chainId: snapshot.chainId,
        inputToken: intent.traderInputToken,
        inputAmount: proposal.proposal.traderInputAmount,
        expiresAt: Math.min(
          intent.deadline,
          proposal.proposal.deadline,
          session.plan.expiresAt,
        ),
        policyFingerprint: wallet.policyFingerprint!,
      });
      if (!this.isAuthorityCurrent(id, authorityGeneration)) {
        throw new ServiceError(
          "DELEGATED_STOPPED",
          "Delegated session was stopped before signing",
          409,
        );
      }
      const typedData = settlementIntentTypedData(intent, snapshot);
      const intentSignature = await this.withWalletOperation(async () => {
        if (!this.isAuthorityCurrent(id, authorityGeneration))
          throw new ServiceError(
            "DELEGATED_STOPPED",
            "Delegated session was stopped before signing",
            409,
          );
        return this.wallet.signIntent(
          typedData,
          await this.authorizationContext(),
        );
      });
      const executed = await this.service.execute(
        proposal.proposal.intentHash,
        proposal.proposalHash,
        intentSignature,
      );
      const action = {
        chainId: executed.transactionRequest.chainId,
        to: executed.transactionRequest.to,
        data: executed.transactionRequest.data,
        value: executed.transactionRequest.value,
        trader: wallet.address,
        inputToken: intent.traderInputToken,
        outputToken: intent.traderOutputToken,
        inputAmount: proposal.proposal.traderInputAmount,
        intentHash: proposal.proposal.intentHash,
        proposalHash: proposal.proposalHash,
        expiresAt: Math.min(
          intent.deadline,
          proposal.proposal.deadline,
          session.plan.expiresAt,
        ),
        policyFingerprint: wallet.policyFingerprint!,
      } as const;
      const sent = await this.withWalletOperation(async () => {
        if (!this.isAuthorityCurrent(id, authorityGeneration))
          throw new ServiceError(
            "DELEGATED_STOPPED",
            "Delegated session was stopped before broadcast",
            409,
          );
        return this.wallet.simulateAndSend(
          action,
          await this.authorizationContext(),
        );
      });
      this.service.repository.promoteExecution(
        proposal.proposal.intentHash,
        proposal.proposalHash,
        sent.transactionHash,
      );
      this.service.repository.updateDelegatedTrade(trade.id, {
        status: "SUBMITTED",
        transactionHash: sent.transactionHash,
      });
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        authorityGeneration,
        {
          lastTransactionHash: sent.transactionHash,
          lastResult: "Submitted to Privy; awaiting chain receipt",
        },
      );
      const receipt = await this.wallet.getReceipt(sent.transactionHash);
      if (receipt) {
        const status = receipt.status === "0x1" ? "CONFIRMED" : "REVERTED";
        this.service.repository.updateDelegatedTrade(trade.id, {
          status,
          transactionHash: sent.transactionHash,
        });
        this.service.repository.updateDelegatedSessionIfGeneration(
          id,
          authorityGeneration,
          {
            state:
              status === "CONFIRMED" &&
              (session.tradeCount + 1 >= session.plan.maxTradeCount ||
                BigInt(session.consumedInputAmount) + inputAmount >=
                  BigInt(session.plan.cumulativeInputBudget))
                ? "EXHAUSTED"
                : "ACTIVE",
            lastResult:
              status === "CONFIRMED"
                ? `Confirmed ${sent.transactionHash}`
                : `Reverted ${sent.transactionHash}`,
          },
        );
      }
    } catch (error) {
      if (error instanceof DelegatedBroadcastUnknownError) {
        this.service.repository.updateDelegatedTrade(trade.id, {
          status: "RECONCILIATION_REQUIRED",
          error: error.message,
        });
        this.service.repository.updateDelegatedSessionIfGeneration(
          id,
          authorityGeneration,
          { state: "RECONCILIATION_REQUIRED", lastResult: error.message },
        );
      } else {
        this.service.repository.releaseDelegatedTrade(
          trade.id,
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Delegated execution failed",
        );
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "DELEGATED_EXECUTION_FAILED",
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Delegated execution failed",
        409,
      );
    }
    return this.get(id);
  }

  /** Approve only the reviewed input amount from the delegated wallet itself.
   * Bob's browser wallet is never the sender of this transaction. */
  async approve(
    id: string,
    authorization: DelegatedControlAuthorization,
  ): Promise<DelegatedSession> {
    await this.consumeControlAuthorization(id, "APPROVE", "", authorization);
    const session = this.get(id);
    if (session.state !== "AUTHORIZED" && session.state !== "ACTIVE")
      throw new ServiceError(
        "DELEGATED_NOT_ACTIVE",
        `Delegated session is ${session.state}`,
        409,
      );
    const wallet = await this.wallet.getStatus();
    if (
      !wallet.address ||
      !sameAddress(wallet.address, session.wallet.address!) ||
      wallet.chainId !== session.plan.chainId ||
      !wallet.policyFingerprint ||
      wallet.policyFingerprint.toLowerCase() !==
        session.wallet.policyFingerprint?.toLowerCase()
    )
      throw new ServiceError(
        "DELEGATED_WALLET_MISMATCH",
        "Delegated wallet identity or policy changed",
        409,
      );
    const allowance = wallet.balances?.inputAllowance;
    if (
      allowance !== undefined &&
      BigInt(allowance) >= BigInt(session.plan.perTradeInputAmount)
    ) {
      const current = this.get(id);
      if (
        current.authorityGeneration !== session.authorityGeneration ||
        (current.state !== "AUTHORIZED" && current.state !== "ACTIVE")
      )
        throw new ServiceError(
          "DELEGATED_STOPPED",
          "Delegated session was stopped during allowance approval",
          409,
        );
      return current;
    }
    if (!this.wallet.approveToken)
      throw new ServiceError(
        "DELEGATED_APPROVAL_UNAVAILABLE",
        "The configured delegated wallet cannot approve its own token allowance",
        503,
      );
    if (!this.service.runtime.settlementContract)
      throw new ServiceError(
        "DELEGATED_APPROVAL_UNAVAILABLE",
        "A settlement router is required for delegated token approval",
        503,
      );
    const authorityGeneration = session.authorityGeneration;
    try {
      const result = await this.withWalletOperation(async () => {
        const current = this.get(id);
        if (
          current.authorityGeneration !== authorityGeneration ||
          (current.state !== "AUTHORIZED" && current.state !== "ACTIVE")
        )
          throw new ServiceError(
            "DELEGATED_STOPPED",
            "Delegated session was stopped before allowance approval",
            409,
          );
        return this.wallet.approveToken!(
          {
            chainId: current.plan.chainId,
            token: current.plan.traderInputToken,
            spender: this.service.runtime.settlementContract!,
            amount: current.plan.perTradeInputAmount,
            expiresAt: current.plan.expiresAt,
            policyFingerprint: current.wallet.policyFingerprint!,
          },
          await this.authorizationContext(),
        );
      });
      if (
        !this.service.repository.updateDelegatedSessionIfGeneration(
          id,
          authorityGeneration,
          {
            lastTransactionHash: result.transactionHash,
            lastResult: `Agent allowance submitted ${result.transactionHash}`,
          },
        )
      )
        throw new ServiceError(
          "DELEGATED_STOPPED",
          "Delegated session was stopped during allowance approval",
          409,
        );
      return this.get(id);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "DELEGATED_APPROVAL_FAILED",
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Agent allowance approval failed",
        409,
      );
    }
  }

  async stop(
    id: string,
    authorization: DelegatedControlAuthorization,
  ): Promise<DelegatedSession> {
    await this.consumeControlAuthorization(id, "STOP", "", authorization);
    const session = this.get(id);
    if (session.state === "STOPPED") return session;
    this.service.repository.stopDelegatedSession(
      id,
      "Local signing disabled; revoking Privy permission",
    );
    try {
      await this.withWalletOperation(() => this.wallet.revoke());
    } catch (error) {
      this.service.repository.updateDelegatedSession(id, {
        state: "REVOKE_PENDING",
        lastResult: "Local signing disabled; Privy revoke is pending",
      });
      throw new ServiceError(
        "DELEGATED_REVOKE_PENDING",
        error instanceof Error ? error.message : "Privy revoke is pending",
        409,
      );
    }
    return this.get(id);
  }

  /**
   * Recover only owner-approved test assets after the delegated worker has
   * stopped. This never uses the additional signer: the configured operator
   * module must execute this separate owner/recovery flow.
   */
  async recover(
    id: string,
    raw: DelegatedRecoveryRequest,
  ): Promise<DelegatedSession> {
    const request = delegatedRecoveryRequestSchema.parse(raw);
    const session = await this.reconcileInternal(id);
    this.assertTrustedOwner(session.plan.ownerAddress);
    if (session.state === "AUTHORIZED" || session.state === "ACTIVE")
      throw new ServiceError(
        "DELEGATED_NOT_STOPPED",
        "Stop and revoke the delegated session before recovering funds",
        409,
      );
    if (session.state === "RECONCILIATION_REQUIRED")
      throw new ServiceError(
        "DELEGATED_RECONCILIATION_REQUIRED",
        "Reconcile the delegated session before recovering funds",
        409,
      );
    if (
      session.trades.some((trade) =>
        [
          "RESERVED",
          "SIGNING",
          "SUBMITTED",
          "RECONCILIATION_REQUIRED",
        ].includes(trade.status),
      )
    )
      throw new ServiceError(
        "DELEGATED_RECONCILIATION_REQUIRED",
        "A delegated trade is still pending; recovery is paused until its receipt is known",
        409,
      );
    if (!sameAddress(request.destination, session.plan.ownerAddress))
      throw new ServiceError(
        "DELEGATED_RECOVERY_DESTINATION",
        "Recovery destination must be Bob's authorized owner address",
      );
    const allowedTokens = new Set([
      session.plan.traderInputToken.toLowerCase(),
      session.plan.traderOutputToken.toLowerCase(),
    ]);
    const tokens = new Set<string>();
    for (const asset of request.assets) {
      const token = asset.token.toLowerCase();
      if (!allowedTokens.has(token) || tokens.has(token))
        throw new ServiceError(
          "DELEGATED_RECOVERY_ASSET",
          "Recovery is limited to one reviewed input/output token per authorization",
        );
      tokens.add(token);
    }
    const wallet = await this.wallet.getStatus();
    if (
      !wallet.address ||
      !sameAddress(wallet.address, session.wallet.address!)
    )
      throw new ServiceError(
        "DELEGATED_WALLET_MISMATCH",
        "The configured delegated wallet identity changed",
      );
    const recoveryTypedData = delegatedRecoveryTypedData(
      session.plan,
      session.id,
      session.wallet.address!,
      request.destination,
      request.assets,
      request.recoveryNonce,
    );
    let signer: string;
    try {
      signer = await recoverAddress({
        hash: hashTypedData(recoveryTypedData as never),
        signature: request.signature as `0x${string}`,
      });
    } catch {
      throw new ServiceError(
        "INVALID_SIGNATURE",
        "Recovery authorization signature is invalid",
      );
    }
    if (!sameAddress(signer, session.plan.ownerAddress))
      throw new ServiceError(
        "INVALID_SIGNATURE",
        "Recovery authorization is not signed by the owner",
      );
    if (typeof this.wallet.recover !== "function")
      throw new ServiceError(
        "DELEGATED_RECOVERY_UNAVAILABLE",
        "Owner recovery is not configured for this delegated wallet",
        503,
      );
    const authorizationHash = hashTypedData(recoveryTypedData as never);
    const recovery = this.service.repository.reserveDelegatedRecovery({
      authorizationHash,
      sessionId: session.id,
      ownerAddress: session.plan.ownerAddress,
      destination: request.destination,
      assetsJson: JSON.stringify(request.assets),
    });
    if (recovery.status !== "PENDING") {
      if (recovery.status === "UNKNOWN" || recovery.status === "SUBMITTED")
        throw new ServiceError(
          "DELEGATED_RECOVERY_RECONCILIATION_REQUIRED",
          "This recovery authorization is already in flight; reconcile before retrying",
          409,
        );
      throw new ServiceError(
        "DELEGATED_RECOVERY_REPLAYED",
        "This recovery authorization has already been consumed",
        409,
      );
    }
    if (!this.service.repository.claimDelegatedRecovery(authorizationHash))
      throw new ServiceError(
        "DELEGATED_RECOVERY_RECONCILIATION_REQUIRED",
        "This recovery authorization is already in flight; reconcile before retrying",
        409,
      );
    try {
      const result = await this.wallet.recover({
        sessionId: session.id,
        ownerAddress: session.plan.ownerAddress,
        destination: request.destination,
        assets: request.assets,
        authorizationHash,
      });
      if (!result.transactionHash) {
        this.service.repository.updateDelegatedRecovery(authorizationHash, {
          status: "UNKNOWN",
          error: "Owner recovery returned no transaction hash",
        });
        throw new ServiceError(
          "DELEGATED_RECOVERY_RECONCILIATION_REQUIRED",
          "Owner recovery was accepted without a transaction hash; reconcile before retrying",
          409,
        );
      }
      const receipt = await this.wallet.getReceipt(result.transactionHash);
      this.service.repository.updateDelegatedRecovery(authorizationHash, {
        status:
          receipt?.status === "0x1"
            ? "CONFIRMED"
            : receipt?.status === "0x0"
              ? "REVERTED"
              : "SUBMITTED",
        transactionHash: result.transactionHash,
      });
      this.service.repository.updateDelegatedSession(id, {
        lastRecoveryTransactionHash: result.transactionHash,
        lastResult:
          receipt?.status === "0x1"
            ? `Recovered reviewed test funds ${result.transactionHash}`
            : `Recovery submitted ${result.transactionHash}; awaiting receipt`,
      });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      this.service.repository.updateDelegatedRecovery(authorizationHash, {
        status: "UNKNOWN",
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Owner recovery status is unknown",
      });
      throw new ServiceError(
        "DELEGATED_RECOVERY_RECONCILIATION_REQUIRED",
        "Owner recovery status is unknown; reconcile before retrying",
        409,
      );
    }
    return this.get(id);
  }

  async reconcile(
    id: string,
    authorization: DelegatedControlAuthorization,
  ): Promise<DelegatedSession> {
    await this.consumeControlAuthorization(id, "RECONCILE", "", authorization);
    return this.reconcileInternal(id);
  }

  private async reconcileInternal(id: string): Promise<DelegatedSession> {
    const session = this.get(id);
    for (const trade of session.trades) {
      if (
        (trade.status !== "SUBMITTED" &&
          trade.status !== "RECONCILIATION_REQUIRED") ||
        !trade.transactionHash
      )
        continue;
      const receipt = await this.wallet.getReceipt(trade.transactionHash);
      if (!receipt) continue;
      const status = receipt.status === "0x1" ? "CONFIRMED" : "REVERTED";
      this.service.repository.updateDelegatedTrade(trade.id, {
        status,
        transactionHash: trade.transactionHash,
      });
      const keepStopped =
        session.state === "STOPPED" || session.state === "REVOKE_PENDING";
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        {
          state: keepStopped
            ? session.state
            : status === "CONFIRMED" &&
                (session.tradeCount >= session.plan.maxTradeCount ||
                  BigInt(session.consumedInputAmount) >=
                    BigInt(session.plan.cumulativeInputBudget))
              ? "EXHAUSTED"
              : "ACTIVE",
          lastResult:
            status === "CONFIRMED"
              ? `Confirmed ${trade.transactionHash}`
              : `Reverted ${trade.transactionHash}`,
        },
      );
    }
    for (const recovery of this.service.repository.listDelegatedRecoveries(
      id,
    )) {
      if (recovery.status !== "SUBMITTED" || !recovery.transactionHash)
        continue;
      const receipt = await this.wallet.getReceipt(recovery.transactionHash);
      if (!receipt) continue;
      const status = receipt.status === "0x1" ? "CONFIRMED" : "REVERTED";
      this.service.repository.updateDelegatedRecovery(
        recovery.authorizationHash,
        { status, transactionHash: recovery.transactionHash },
      );
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        {
          lastRecoveryTransactionHash: recovery.transactionHash,
          lastResult:
            status === "CONFIRMED"
              ? `Confirmed recovery ${recovery.transactionHash}`
              : `Recovery reverted ${recovery.transactionHash}`,
        },
      );
    }
    if (this.now() >= session.plan.expiresAt && session.state === "ACTIVE")
      this.service.repository.updateDelegatedSessionIfGeneration(
        id,
        session.authorityGeneration,
        { state: "EXPIRED" },
      );
    return this.get(id);
  }
}
