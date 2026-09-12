import { useEffect, useMemo, useState } from "react";
import { Bot, Check, ShieldCheck, Sparkles, WalletCards } from "lucide-react";
import { AurkaClient, AurkaError } from "@aurka/sdk";
import {
  delegatedAuthorizationTypedData,
  delegatedControlRequestHash,
  delegatedControlTypedData,
  delegatedRecoveryTypedData,
  type AgentMandate,
  type DelegatedControlAction,
  type DelegatedSession,
  type DelegatedSessionPlan,
  type DelegatedStatus,
  type SpaceRecord,
  type TradingAgent,
  formatTokenAmount,
  parseTokenAmount,
} from "@aurka/shared";
import { agentTestMode, apiBaseUrl, supportedChainId } from "../config";
import { spaceAdapter } from "../domain/spaces";
import { userFacingError, shortAddress } from "../ui";
import { useWallet, WalletStateMessage } from "../wallet";

// Faucet funding waits for three Sepolia receipts and can take longer than
// ordinary API reads. Keep the agent flow open long enough to receive the
// durable result instead of showing a misleading client timeout.
const client = new AurkaClient({ baseUrl: apiBaseUrl, timeout: 120_000 });

type Step = 1 | 2 | 3 | 4;

// These are the deployed mock assets in the Sepolia manifest. Their display
// symbols are intentionally descriptive ("AURKA Demo WETH/USDC"), so symbol
// equality alone cannot identify the pair.
const SEPOLIA_USDC = "0x8228fd953cdf5fac815d09ec5ea27ddd9412a714";
const SEPOLIA_WETH = "0x33dca285758fd19d1f51c7b73d5a5fb8dae4d2c4";

function agentLog(event: string, details: Record<string, unknown> = {}): void {
  if (import.meta.env.DEV) console.info(`[AURKA agent] ${event}`, details);
}

function agentErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof AurkaError) {
    const details = error.details ?? {};
    return {
      code: error.code,
      status: error.statusCode,
      message: error.message,
      ...(typeof details.requestedAddress === "string"
        ? {
            requestedAddress: `${details.requestedAddress.slice(0, 6)}…${details.requestedAddress.slice(-4)}`,
          }
        : {}),
      ...(typeof details.recoveredAddress === "string"
        ? {
            recoveredAddress: `${details.recoveredAddress.slice(0, 6)}…${details.recoveredAddress.slice(-4)}`,
          }
        : {}),
    };
  }
  if (error instanceof Error)
    return { name: error.name, message: error.message.slice(0, 240) };
  return { errorType: typeof error };
}

function shortWalletList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => `${item.slice(0, 6)}…${item.slice(-4)}`);
}

function providerAccountMismatch(
  address: string,
  accounts: unknown,
): Error | null {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const active = accounts.find(
    (item): item is string => typeof item === "string",
  );
  if (active && active.toLowerCase() !== address.toLowerCase())
    return new Error(
      `Browser wallet provider account ${active} differs from the connected app account ${address}`,
    );
  return null;
}

function bytes32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

async function signTypedData(
  provider: {
    request(input: { method: string; params?: unknown[] }): Promise<unknown>;
    readonly isMetaMask?: boolean;
    readonly isRabby?: boolean;
    readonly isCoinbaseWallet?: boolean;
    readonly isPolkadot?: boolean;
    readonly isSubWallet?: boolean;
  },
  address: string,
  typedData: unknown,
  label: string,
): Promise<string> {
  const providerAccounts = await provider
    .request({ method: "eth_accounts" })
    .catch(() => undefined);
  agentLog("wallet.provider.accounts", {
    label,
    accounts: JSON.stringify(shortWalletList(providerAccounts) ?? []),
    isMetaMask: provider.isMetaMask === true,
    isRabby: provider.isRabby === true,
    isCoinbaseWallet: provider.isCoinbaseWallet === true,
    isPolkadot: provider.isPolkadot === true,
    isSubWallet: provider.isSubWallet === true,
  });
  const mismatch = providerAccountMismatch(address, providerAccounts);
  if (mismatch) throw mismatch;
  agentLog("wallet.signature.request", {
    label,
    address: `${address.slice(0, 6)}…${address.slice(-4)}`,
  });
  const result = await provider.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(typedData)],
  });
  if (typeof result !== "string")
    throw new Error(`Wallet returned no ${label} signature`);
  agentLog("wallet.signature.returned", {
    label,
    signatureLength: result.length,
  });
  return result;
}

function activeSpacePair(
  space: Awaited<ReturnType<typeof spaceAdapter.getSpace>>,
) {
  const assets = space.position?.policy.assets ?? [];
  const weth = assets.find(
    (asset) =>
      asset.token.toLowerCase() === SEPOLIA_WETH ||
      asset.symbol.toUpperCase().includes("WETH"),
  );
  const usdc = assets.find(
    (asset) =>
      asset.token.toLowerCase() === SEPOLIA_USDC ||
      asset.symbol.toUpperCase().includes("USDC"),
  );
  if (!weth || !usdc)
    throw new Error(
      "The active Sepolia Space does not expose the WETH/USDC pair",
    );
  return { weth, usdc };
}

function hasConfirmedAgentFunding(agent: TradingAgent): boolean {
  return ["eth", "usdc", "weth"].some(
    (asset) =>
      typeof agent.fundingJson[asset] === "string" &&
      agent.fundingJson[asset] !== "0",
  );
}

type RecoverableBalanceState = "unknown" | "available" | "empty";

function recoverableBalanceState(
  status: DelegatedStatus | null,
): RecoverableBalanceState {
  const balances = status?.wallet.balances;
  if (!balances) return "unknown";
  return BigInt(balances.inputToken) > 0n || BigInt(balances.outputToken) > 0n
    ? "available"
    : "empty";
}

function displayTokenBalance(raw: string, decimals: number): string {
  try {
    return formatTokenAmount(raw, decimals);
  } catch {
    return "Unavailable";
  }
}

function AgentBalanceCard({
  status,
  busy,
  onRefresh,
}: {
  readonly status: DelegatedStatus | null;
  readonly busy: boolean;
  readonly onRefresh: () => void;
}) {
  const balances = status?.wallet.balances;
  return (
    <div className="mt-5 rounded-xl border border-cyan-900/70 bg-cyan-950/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-300">
            Agent wallet balance
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Live Sepolia balance · not the mandate budget
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="rounded-lg border border-cyan-800 px-3 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-50"
        >
          Refresh balance
        </button>
      </div>
      {balances ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">ETH for gas</dt>
            <dd className="font-mono text-lg text-white">
              {displayTokenBalance(balances.native, 18)} ETH
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Mock WETH</dt>
            <dd className="font-mono text-lg text-white">
              {displayTokenBalance(balances.inputToken, 18)} WETH
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Mock USDC</dt>
            <dd className="font-mono text-lg text-white">
              {displayTokenBalance(balances.outputToken, 6)} USDC
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-4 text-sm text-amber-200">
          {status
            ? "The wallet is available, but its live balances could not be read yet. Click Refresh balance."
            : "Live balances have not loaded yet. Click Refresh balance."}
        </p>
      )}
    </div>
  );
}

function agentMandateSpaceId(agent: TradingAgent | null): string | undefined {
  const value = agent?.mandateJson?.spaceIds;
  return Array.isArray(value) && typeof value[0] === "string"
    ? value[0]
    : undefined;
}

function supportsAgentSpace(space: SpaceRecord): boolean {
  if (
    space.identity.state !== "ACTIVE" ||
    space.identity.chainId !== supportedChainId ||
    !space.position
  )
    return false;
  try {
    activeSpacePair(space);
    return true;
  } catch {
    return false;
  }
}

export default function Agent() {
  const wallet = useWallet();
  const [step, setStep] = useState<Step>(1);
  const [agent, setAgent] = useState<TradingAgent | null>(null);
  const [session, setSession] = useState<DelegatedSession | null>(null);
  const [walletStatus, setWalletStatus] = useState<DelegatedStatus | null>(
    null,
  );
  const [eligibleSpaces, setEligibleSpaces] = useState<readonly SpaceRecord[]>(
    [],
  );
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState(
    "Find small, conservative WETH to USDC opportunities in my selected Space.",
  );
  // Sepolia's demo Space uses integer normalized settlement values. At the
  // current 3,200 USDC/WETH price, 0.0025 WETH maps exactly to 8 value units;
  // 0.001 WETH maps to 3.2 and is rejected by the deterministic solver.
  const [perTradeInput, setPerTradeInput] = useState("0.0025");
  const [totalInput, setTotalInput] = useState("0.0075");
  const [maxTradeCount, setMaxTradeCount] = useState("3");
  const [minimumRate, setMinimumRate] = useState(agentTestMode ? "0" : "95");
  const [slippage, setSlippage] = useState("1");
  const [draftReadyOwner, setDraftReadyOwner] = useState<string | null>(null);

  const draftOwner =
    wallet.status === "connected" && wallet.address
      ? wallet.address.toLowerCase()
      : null;

  useEffect(() => {
    if (!draftOwner) {
      setDraftReadyOwner(null);
      return;
    }
    const key = `aurka:agent-draft:${draftOwner}`;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const draft = JSON.parse(raw) as Record<string, unknown>;
        if (typeof draft.message === "string") setMessage(draft.message);
        if (typeof draft.perTradeInput === "string")
          setPerTradeInput(draft.perTradeInput);
        if (typeof draft.totalInput === "string")
          setTotalInput(draft.totalInput);
        if (typeof draft.maxTradeCount === "string")
          setMaxTradeCount(draft.maxTradeCount);
        if (typeof draft.minimumRate === "string")
          setMinimumRate(draft.minimumRate);
        if (typeof draft.slippage === "string") setSlippage(draft.slippage);
        if (typeof draft.spaceId === "string")
          setSelectedSpaceId(draft.spaceId);
      }
    } catch {
      // A browser storage failure must not prevent wallet-agent use.
    }
    setDraftReadyOwner(draftOwner);
  }, [draftOwner]);

  useEffect(() => {
    if (!draftOwner || draftReadyOwner !== draftOwner) return;
    try {
      window.localStorage.setItem(
        `aurka:agent-draft:${draftOwner}`,
        JSON.stringify({
          message,
          perTradeInput,
          totalInput,
          maxTradeCount,
          minimumRate,
          slippage,
          spaceId: selectedSpaceId,
        }),
      );
    } catch {
      // A browser storage failure must not prevent wallet-agent use.
    }
  }, [
    draftOwner,
    draftReadyOwner,
    maxTradeCount,
    message,
    minimumRate,
    perTradeInput,
    slippage,
    selectedSpaceId,
    totalInput,
  ]);

  useEffect(() => {
    if (step !== 3 || !agent) return;
    let active = true;
    setSpacesLoading(true);
    void spaceAdapter
      .listSpaces(50)
      .then((spaces) => {
        if (!active) return;
        const eligible = spaces.filter(supportsAgentSpace);
        setEligibleSpaces(eligible);
        setSelectedSpaceId((current) => {
          if (
            current &&
            eligible.some((space) => space.identity.id === current)
          )
            return current;
          return (
            session?.plan.allowedSpaceIds[0] ??
            agentMandateSpaceId(agent) ??
            eligible[0]?.identity.id ??
            ""
          );
        });
      })
      .catch((requestError) => {
        if (active)
          setError(
            userFacingError(
              requestError,
              "The available agent Spaces could not be loaded",
            ),
          );
      })
      .finally(() => {
        if (active) setSpacesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agent, session, step]);

  useEffect(() => {
    if (
      wallet.status !== "connected" ||
      !wallet.address ||
      wallet.chainId !== supportedChainId
    ) {
      setAgent(null);
      setSession(null);
      setWalletStatus(null);
      setStep(1);
      return;
    }
    setAgent(null);
    setSession(null);
    setWalletStatus(null);
    setStep(1);
    const connectedAddress = wallet.address;
    const connectedChainId = wallet.chainId;
    let active = true;
    (async () => {
      try {
        const authenticated = await client.authSession();
        if (
          authenticated.address.toLowerCase() !==
            connectedAddress.toLowerCase() ||
          authenticated.chainId !== connectedChainId
        ) {
          await client.authLogout().catch(() => undefined);
          return;
        }
        const result = await client.myTradingAgent();
        if (!active) return;
        setAgent(result.agent);
        if (!result.agent) {
          setSession(null);
          setStep(1);
          return;
        }
        if (result.agent.state === "REVOKED") {
          setSession(null);
          setStep(1);
          return;
        }
        const [sessions, status] = await Promise.all([
          client
            .delegatedSessions()
            .catch(() => ({ sessions: [] as readonly DelegatedSession[] })),
          client.delegatedStatus().catch(() => null),
        ]);
        const current = sessions.sessions.find(
          (candidate) =>
            candidate.wallet.address?.toLowerCase() ===
            result.agent?.walletAddress.toLowerCase(),
        );
        // The list endpoint is deliberately durable and cheap. Refresh the
        // selected session once so a recovery receipt that settled after the
        // list read is reflected immediately in the status card.
        const refreshed = current
          ? await client.delegatedSession(current.id).catch(() => current)
          : null;
        if (!active) return;
        setSession(refreshed);
        setWalletStatus(status);
        setSelectedSpaceId(
          refreshed?.plan.allowedSpaceIds[0] ??
            agentMandateSpaceId(result.agent) ??
            "",
        );
        setSpaceId(
          refreshed?.plan.allowedSpaceIds[0] ??
            agentMandateSpaceId(result.agent) ??
            null,
        );
        setStep(refreshed ? 4 : result.agent.fundingJson.eth === "0" ? 2 : 3);
      } catch {
        // A missing auth cookie is expected until the user starts the wizard.
      }
    })();
    return () => {
      active = false;
    };
  }, [wallet.address, wallet.chainId, wallet.status]);

  const funding = useMemo(
    () => ({
      eth: "10000000000000000",
      usdc: "1000000000",
      weth: "1000000000000000000",
    }),
    [],
  );

  async function authenticate(): Promise<void> {
    if (
      !wallet.address ||
      !wallet.provider ||
      wallet.chainId !== supportedChainId
    )
      throw new Error(
        `Connect the browser wallet to Sepolia (chain ${supportedChainId}) first`,
      );
    agentLog("auth.start", {
      address: `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
      chainId: wallet.chainId,
    });
    try {
      const existing = await client.authSession();
      if (
        existing.address.toLowerCase() === wallet.address.toLowerCase() &&
        existing.chainId === wallet.chainId
      ) {
        agentLog("auth.session.reused", {
          address: `${existing.address.slice(0, 6)}…${existing.address.slice(-4)}`,
          chainId: existing.chainId,
        });
        return;
      }
      agentLog("auth.session.ignored", {
        reason: "address-or-chain-mismatch",
        sessionAddress: `${existing.address.slice(0, 6)}…${existing.address.slice(-4)}`,
        sessionChainId: existing.chainId,
      });
    } catch {
      // A new wallet session is expected on the first visit or after expiry.
      agentLog("auth.session.missing", { reason: "no-valid-session" });
    }
    const attempt = async (attemptNumber: number): Promise<void> => {
      agentLog("auth.challenge.request", { attempt: attemptNumber });
      const challenge = await client.authChallenge({
        address: wallet.address!,
        chainId: wallet.chainId!,
      });
      agentLog("auth.challenge.received", {
        attempt: attemptNumber,
        origin: challenge.origin,
        chainId: challenge.chainId,
        challengeId: challenge.challengeId.slice(0, 8),
        expiresAt: challenge.expiresAt,
      });
      const signature = await signTypedData(
        wallet.provider!,
        wallet.address!,
        challenge.typedData,
        "login",
      );
      await client.authVerify({
        challengeId: challenge.challengeId,
        address: wallet.address!,
        chainId: wallet.chainId!,
        signature,
      });
      agentLog("auth.verify.succeeded", { attempt: attemptNumber });
    };
    try {
      await attempt(1);
    } catch (requestError) {
      agentLog("auth.verify.failed", agentErrorDetails(requestError));
      // A stale/duplicate browser request can consume a challenge before the
      // wallet popup finishes. Give the user one fresh challenge instead of
      // forcing a page reload; signature and origin failures still surface.
      if (
        requestError instanceof AurkaError &&
        requestError.code === "AUTH_CHALLENGE_INVALID"
      ) {
        agentLog("auth.retry", { reason: "challenge-invalid" });
        await attempt(2);
        return;
      }
      throw requestError;
    }
  }

  async function createAgent(): Promise<void> {
    setBusy("Creating your private trading wallet…");
    setError(null);
    setNotice(null);
    let stage = "starting";
    agentLog("create.started", {
      address: wallet.address
        ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
        : null,
      chainId: wallet.chainId,
    });
    try {
      stage = "authentication";
      await authenticate();
      stage = "provisioning";
      agentLog("agent.provision.request", { chainId: supportedChainId });
      const result = await client.createTradingAgent({
        chainId: supportedChainId,
      });
      agentLog("agent.provision.succeeded", {
        agentId: result.agent.id,
        walletAddress: `${result.agent.walletAddress.slice(0, 6)}…${result.agent.walletAddress.slice(-4)}`,
      });
      setAgent(result.agent);
      setStep(2);
    } catch (requestError) {
      agentLog("create.failed", { stage, ...agentErrorDetails(requestError) });
      setError(
        userFacingError(
          requestError,
          "Your trading agent could not be created",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function fundAgent(): Promise<void> {
    if (!agent) return;
    setBusy("Funding your agent with Sepolia test assets…");
    setError(null);
    setNotice(null);
    try {
      const result = await client.fundTradingAgent(agent.id, funding);
      setAgent(result.agent);
      setWalletStatus(await client.delegatedStatus());
      setStep(3);
    } catch (requestError) {
      // The server may still be confirming the three faucet receipts when a
      // network/proxy timeout reaches the browser. Read the durable agent
      // record before showing a failure so a completed operation advances the
      // wizard instead of making the user fund the same wallet again.
      if (
        requestError instanceof AurkaError &&
        requestError.code === "TIMEOUT"
      ) {
        const latest = await client.myTradingAgent().catch(() => null);
        if (latest?.agent?.id === agent.id) {
          setAgent(latest.agent);
          if (
            latest.agent.state === "READY" &&
            hasConfirmedAgentFunding(latest.agent)
          ) {
            setError(null);
            setStep(3);
            return;
          }
          if (latest.agent.state === "FUNDING") {
            setError(
              "Funding is still confirming on Sepolia. Wait a moment, then refresh this page; do not start a second funding request.",
            );
            return;
          }
        }
      }
      setError(userFacingError(requestError, "The agent could not be funded"));
    } finally {
      setBusy(null);
    }
  }

  async function saveMandateAndStart(): Promise<void> {
    if (!agent || !wallet.address || !wallet.provider) return;
    setBusy("Reviewing the mandate and starting the worker…");
    setError(null);
    setNotice(null);
    let stage = "loading-space";
    agentLog("mandate.start", {
      agentId: agent.id,
      agentWallet: shortAddress(agent.walletAddress),
      chainId: supportedChainId,
    });
    try {
      const spaces = await spaceAdapter.listSpaces(50);
      const availableSpaces = spaces.filter(supportsAgentSpace);
      const space =
        availableSpaces.find(
          (candidate) => candidate.identity.id === selectedSpaceId,
        ) ?? availableSpaces[0];
      if (!space?.position)
        throw new AurkaError(
          "DELEGATED_SPACE_INELIGIBLE",
          "No active Sepolia WETH/USDC Space is available for this agent",
          409,
        );
      agentLog("mandate.space.loaded", {
        spaceId: space.identity.id,
        state: space.identity.state,
      });
      stage = "selecting-assets";
      const selectedPair = activeSpacePair(space);
      setSpaceId(space.identity.id);
      setSelectedSpaceId(space.identity.id);
      const parsedPerTradeInput = parseTokenAmount(
        perTradeInput.trim(),
        selectedPair.weth.decimals,
      ).toString();
      const parsedTotalInput = parseTokenAmount(
        totalInput.trim(),
        selectedPair.weth.decimals,
      ).toString();
      const parsedMinimumRate = Math.round(Number(minimumRate) * 100);
      const parsedSlippage = Math.round(Number(slippage));
      if (
        !Number.isFinite(parsedMinimumRate) ||
        parsedMinimumRate < 0 ||
        parsedMinimumRate > 10_000
      )
        throw new Error(
          "Minimum output/input rate must be between 0% and 100%",
        );
      if (
        !Number.isFinite(parsedSlippage) ||
        parsedSlippage < 0 ||
        parsedSlippage > 1_000
      )
        throw new Error("Slippage must be between 0 and 1000 basis points");
      const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
      const mandate: AgentMandate = {
        spaceIds: [space.identity.id],
        traderInputToken: selectedPair.weth.token,
        traderOutputToken: selectedPair.usdc.token,
        perTradeInputAmount: parsedPerTradeInput,
        cumulativeInputBudget: parsedTotalInput,
        maxTradeCount: Number(maxTradeCount),
        minimumOutputPerInputBps: parsedMinimumRate,
        slippageBps: parsedSlippage,
        expiresAt,
      };
      stage = "saving-mandate";
      agentLog("mandate.save.request", {
        spaceId: space.identity.id,
        expiresAt,
        perTradeInputAmount: parsedPerTradeInput,
        cumulativeInputBudget: parsedTotalInput,
        maxTradeCount: mandate.maxTradeCount,
      });
      const saved = await client.setTradingAgentMandate(agent.id, mandate);
      agentLog("mandate.save.succeeded", { agentId: saved.agent.id });
      setAgent(saved.agent);
      const { spaceIds, ...mandatePlan } = mandate;
      const plan: DelegatedSessionPlan = {
        ...mandatePlan,
        allowedSpaceIds: spaceIds,
        sessionNonce: bytes32(),
        ownerAddress: wallet.address,
        chainId: supportedChainId,
      };
      const authorizationSignature = await signTypedData(
        wallet.provider,
        wallet.address,
        delegatedAuthorizationTypedData(plan, agent.walletAddress),
        "agent authorization",
      );
      stage = "authorizing-session";
      agentLog("delegated.authorize.request", {
        sessionExpiresAt: plan.expiresAt,
        spaceId: space.identity.id,
      });
      const session = await client.authorizeDelegatedSession({
        plan,
        agentWallet: agent.walletAddress,
        signature: authorizationSignature,
      });
      agentLog("delegated.authorize.succeeded", {
        sessionId: shortAddress(session.id),
        state: session.state,
      });
      setSession(session);
      const controlMessage =
        message.trim() || "Run the reviewed trading mandate";
      const controlExpiresAt = Math.floor(Date.now() / 1000) + 300;
      const requestHash = delegatedControlRequestHash(controlMessage);
      const nonce = bytes32();
      const controlSignature = await signTypedData(
        wallet.provider,
        wallet.address,
        delegatedControlTypedData(
          session.plan,
          session.id,
          agent.walletAddress,
          "START",
          requestHash,
          nonce,
          controlExpiresAt,
        ),
        "start authorization",
      );
      stage = "starting-session";
      agentLog("delegated.start.request", {
        sessionId: shortAddress(session.id),
        messageLength: controlMessage.length,
      });
      const started = await client.startDelegatedSession(session.id, {
        message: controlMessage,
        authorization: {
          sessionId: session.id,
          ownerAddress: wallet.address,
          agentWallet: agent.walletAddress,
          chainId: supportedChainId,
          action: "START",
          requestHash,
          nonce,
          expiresAt: controlExpiresAt,
          signature: controlSignature,
        },
      });
      agentLog("delegated.start.succeeded", {
        sessionId: shortAddress(started.id),
        state: started.state,
        lastResult: started.lastResult ?? null,
      });
      setSession(started);
      setStep(4);
      setNotice(
        started.state === "ACTIVE"
          ? "Your Privy trading agent is running within the reviewed mandate."
          : (started.lastResult ??
              "The mandate was saved for the background worker."),
      );
    } catch (requestError) {
      agentLog("mandate.start.failed", {
        stage,
        ...agentErrorDetails(requestError),
      });
      if (
        requestError instanceof AurkaError &&
        requestError.code === "DELEGATED_EXECUTION_FAILED"
      ) {
        setError(
          "The mandate was approved, but the first trade was not submitted. Open Activity to inspect the bounded session.",
        );
      } else {
        setError(
          userFacingError(
            requestError,
            "The agent mandate could not be started",
          ),
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function controlAgent(action: DelegatedControlAction): Promise<void> {
    if (!session || !wallet.address || !wallet.provider) return;
    setBusy(
      action === "STOP"
        ? "Stopping the agent and revoking its Privy signer…"
        : "Refreshing agent status…",
    );
    setError(null);
    setNotice(null);
    try {
      const controlMessage = "";
      const expiresAt = Math.min(
        session.plan.expiresAt,
        Math.floor(Date.now() / 1000) + 300,
      );
      const controlNonce = bytes32();
      const requestHash = delegatedControlRequestHash(controlMessage);
      const signature = await signTypedData(
        wallet.provider,
        wallet.address,
        delegatedControlTypedData(
          session.plan,
          session.id,
          session.wallet.address!,
          action,
          requestHash,
          controlNonce,
          expiresAt,
        ),
        `${action.toLowerCase()} authorization`,
      );
      const authorization = {
        sessionId: session.id,
        ownerAddress: wallet.address,
        agentWallet: session.wallet.address!,
        chainId: session.plan.chainId,
        action,
        requestHash,
        nonce: controlNonce,
        expiresAt,
        signature,
      };
      const next =
        action === "STOP"
          ? await client.stopDelegatedSession(session.id, { authorization })
          : session;
      setSession(next);
    } catch (requestError) {
      setError(
        userFacingError(requestError, "The agent control request failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function recoverAgent(): Promise<void> {
    if (!session || !wallet.address || !wallet.provider) return;
    setBusy("Preparing owner-approved recovery…");
    setError(null);
    setNotice(null);
    try {
      // The session record contains a snapshot. Recovery must use the live
      // Privy balances because a previous receipt may have settled after the
      // last session read.
      const liveStatus = await client.delegatedStatus();
      setWalletStatus(liveStatus);
      const balances = liveStatus.wallet.balances ?? session.wallet.balances;
      if (!balances)
        throw new AurkaError(
          "DELEGATED_RECOVERY_ASSET",
          "The agent balance is not available yet",
          409,
        );
      const asset =
        BigInt(balances.inputToken) > 0n
          ? {
              token: session.plan.traderInputToken,
              amount: balances.inputToken,
            }
          : {
              token: session.plan.traderOutputToken,
              amount: balances.outputToken,
            };
      agentLog("recovery.request", {
        sessionId: shortAddress(session.id),
        token: shortAddress(asset.token),
        amount: asset.amount,
      });
      if (asset.amount === "0")
        throw new AurkaError(
          "DELEGATED_RECOVERY_ASSET",
          "The agent has no recoverable test-token balance",
          409,
        );
      const recoveryNonce = bytes32();
      const signature = await signTypedData(
        wallet.provider,
        wallet.address,
        delegatedRecoveryTypedData(
          session.plan,
          session.id,
          session.wallet.address!,
          wallet.address,
          [asset],
          recoveryNonce,
        ),
        "recovery authorization",
      );
      const next = await client.recoverDelegatedSession(session.id, {
        destination: wallet.address,
        assets: [asset],
        recoveryNonce,
        signature,
      });
      agentLog("recovery.response", {
        sessionId: shortAddress(next.id),
        state: next.state,
        lastResult: next.lastResult ?? null,
      });
      setSession(next);
      const refreshedStatus = await client.delegatedStatus().catch(() => null);
      if (refreshedStatus) setWalletStatus(refreshedStatus);
      setNotice(
        next.lastResult?.startsWith("Recovered") ||
          next.lastResult?.startsWith("Confirmed recovery")
          ? "Test funds recovered to your connected owner wallet."
          : "Recovery was submitted to Sepolia. Refresh status in a few seconds to confirm the receipt.",
      );
    } catch (requestError) {
      agentLog("recovery.failed", agentErrorDetails(requestError));
      // A provider or gateway timeout may happen after Privy has already
      // broadcast the transfer. Re-read the durable session before showing a
      // failure, so the owner never retries an unknown recovery blindly.
      if (
        requestError instanceof AurkaError &&
        requestError.code === "TIMEOUT"
      ) {
        const latest = await client
          .delegatedSession(session.id)
          .catch(() => null);
        if (latest) {
          setSession(latest);
          const latestStatus = await client.delegatedStatus().catch(() => null);
          if (latestStatus) setWalletStatus(latestStatus);
          setError(null);
          setNotice(
            latest.lastResult && /recovery/i.test(latest.lastResult)
              ? "The recovery request was accepted. The status was reconciled; do not submit it again."
              : "The recovery request timed out before the result arrived. Refresh status before trying again.",
          );
          return;
        }
      }
      setError(
        userFacingError(requestError, "The agent funds could not be recovered"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function refreshAgentStatus(): Promise<void> {
    if (!session) return;
    setBusy("Refreshing the agent and Privy wallet status…");
    setError(null);
    setNotice(null);
    try {
      const [next, status] = await Promise.all([
        client.delegatedSession(session.id),
        client.delegatedStatus(),
      ]);
      setSession(next);
      setWalletStatus(status);
      setNotice(next.lastResult ?? "Agent status refreshed.");
    } catch (requestError) {
      setError(
        userFacingError(
          requestError,
          "The agent status could not be refreshed",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function refreshWalletStatus(): Promise<void> {
    setBusy("Refreshing the agent wallet balance…");
    setError(null);
    setNotice(null);
    try {
      setWalletStatus(await client.delegatedStatus());
      setNotice("Agent wallet balance refreshed.");
    } catch (requestError) {
      setError(
        userFacingError(
          requestError,
          "The agent wallet balance could not be refreshed",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  function beginMandateEdit(): void {
    if (session && ["AUTHORIZED", "ACTIVE"].includes(session.state)) {
      setError("Stop the agent before editing its mandate.");
      return;
    }
    setSelectedSpaceId(
      session?.plan.allowedSpaceIds[0] ??
        agentMandateSpaceId(agent) ??
        selectedSpaceId,
    );
    setError(null);
    setNotice(
      "Edit the mandate below, then review and approve a fresh session.",
    );
    setStep(3);
  }

  async function archiveAgent(): Promise<void> {
    if (!agent) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Archive this agent? It must be stopped, empty of WETH/USDC, and will need a new mandate before it can run again.",
      )
    )
      return;
    setBusy("Revoking the Privy signer and archiving the agent…");
    setError(null);
    setNotice(null);
    try {
      const result = await client.archiveTradingAgent(agent.id);
      setAgent(result.agent);
      setSession(null);
      setSpaceId(null);
      setStep(1);
      setNotice(
        "Agent archived. Its Privy wallet record is retained for audit; configure a new mandate to use it again.",
      );
    } catch (requestError) {
      setError(
        userFacingError(requestError, "The agent could not be archived"),
      );
    } finally {
      setBusy(null);
    }
  }

  const stepLabels = [
    "Your agent",
    "Test balance",
    "Trading instruction",
    "Review and start",
  ];
  const selectedSpace = eligibleSpaces.find(
    (space) => space.identity.id === selectedSpaceId,
  );
  const recoveryBalanceState = recoverableBalanceState(walletStatus);

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Per-user trading agent
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          Create an agent that trades within your rules
        </h1>
        <p className="mt-3 max-w-3xl leading-7 text-slate-300">
          AURKA creates one dedicated Privy wallet for this connected wallet on
          Sepolia. The wallet receives only test assets and the worker can
          continue after this browser is closed.
        </p>
      </div>

      <div
        className="grid gap-2 sm:grid-cols-4"
        aria-label="Trading agent setup steps"
      >
        {stepLabels.map((label, index) => {
          const number = (index + 1) as Step;
          return (
            <div
              key={label}
              className={`rounded-xl border p-3 text-sm ${step === number ? "border-cyan-500 bg-cyan-950/40 text-white" : step > number ? "border-emerald-800 bg-emerald-950/20 text-emerald-200" : "border-slate-800 bg-slate-900/60 text-slate-500"}`}
            >
              <span className="mr-2">
                {step > number ? <Check className="inline h-4 w-4" /> : number}
              </span>
              {label}
            </div>
          );
        })}
      </div>

      {wallet.status !== "connected" || wallet.chainId !== supportedChainId ? (
        <WalletStateMessage />
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-red-800/70 bg-red-950/30 p-4 text-red-200"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl border border-emerald-800/70 bg-emerald-950/30 p-4 text-emerald-200"
        >
          {notice}
        </p>
      ) : null}
      {busy ? (
        <p
          aria-live="polite"
          className="rounded-xl border border-cyan-800/70 bg-cyan-950/30 p-4 text-cyan-100"
        >
          {busy}
        </p>
      ) : null}

      {session ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
                Agent status
              </p>
              <h2 className="mt-2 text-xl font-semibold text-white">
                {session.state}
              </h2>
            </div>
            <span className="font-mono text-xs text-slate-400">
              {shortAddress(session.wallet.address ?? "")}
            </span>
          </div>
          <AgentBalanceCard
            status={walletStatus}
            busy={!!busy}
            onRefresh={() => void refreshAgentStatus()}
          />
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">Remaining budget</dt>
              <dd className="text-white">
                {session.remainingInputBudget} raw input units
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Confirmed trades</dt>
              <dd className="text-white">
                {session.tradeCount} / {session.plan.maxTradeCount}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Last decision</dt>
              <dd className="text-white">
                {session.lastResult ?? "No decision recorded yet"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Allowed Space</dt>
              <dd className="break-all text-white">
                {session.plan.allowedSpaceIds.join(", ")}
              </dd>
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-3">
            {["AUTHORIZED", "ACTIVE"].includes(session.state) ? (
              <button
                type="button"
                onClick={() => void controlAgent("STOP")}
                disabled={!!busy}
                className="rounded-lg border border-red-700 px-4 py-2 font-semibold text-red-200 disabled:opacity-50"
              >
                Stop agent
              </button>
            ) : null}
            {["STOPPED", "EXPIRED", "EXHAUSTED"].includes(session.state) ? (
              <button
                type="button"
                onClick={() =>
                  void (recoveryBalanceState === "unknown"
                    ? refreshWalletStatus()
                    : recoverAgent())
                }
                disabled={!!busy || recoveryBalanceState === "empty"}
                title={
                  recoveryBalanceState === "empty"
                    ? "The agent has no WETH or USDC to recover"
                    : undefined
                }
                className="rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {recoveryBalanceState === "available"
                  ? "Recover test funds"
                  : recoveryBalanceState === "empty"
                    ? "No WETH/USDC to recover"
                    : "Check balance before recovery"}
              </button>
            ) : null}
            {["STOPPED", "EXPIRED", "EXHAUSTED"].includes(session.state) ? (
              <>
                <button
                  type="button"
                  onClick={beginMandateEdit}
                  disabled={!!busy}
                  className="rounded-lg border border-cyan-700 px-4 py-2 font-semibold text-cyan-200 disabled:opacity-50"
                >
                  Edit mandate
                </button>
                <button
                  type="button"
                  onClick={() => void archiveAgent()}
                  disabled={!!busy}
                  className="rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-300 disabled:opacity-50"
                >
                  Archive agent
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => void refreshAgentStatus()}
              disabled={!!busy}
              className="rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-200 disabled:opacity-50"
            >
              Refresh status
            </button>
          </div>
        </div>
      ) : null}

      {agent && !session && agent.state !== "REVOKED" ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
                Agent record
              </p>
              <h2 className="mt-2 text-xl font-semibold text-white">
                {agent.state}
              </h2>
            </div>
            <span className="font-mono text-xs text-slate-400">
              {shortAddress(agent.walletAddress)}
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            This is your persistent Privy wallet. You can finish the setup
            wizard, or archive the application record once the wallet has no
            WETH/USDC left. Archiving revokes its execution signer and keeps the
            wallet history; it does not delete the remote Privy wallet.
          </p>
          <AgentBalanceCard
            status={walletStatus}
            busy={!!busy}
            onRefresh={() => void refreshWalletStatus()}
          />
          <button
            type="button"
            onClick={() => void archiveAgent()}
            disabled={!!busy}
            className="mt-5 rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-300 disabled:opacity-50"
          >
            Archive agent
          </button>
        </div>
      ) : null}

      {step === 1 && !agent && (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <WalletCards className="h-8 w-8 text-cyan-300" />
          <h2 className="mt-4 text-xl font-semibold text-white">
            Your dedicated agent wallet
          </h2>
          <p className="mt-2 leading-6 text-slate-300">
            Sign one short wallet login challenge, then the server provisions a
            separate Privy wallet. Your connected wallet remains the owner and
            recovery destination; it never signs trades for the agent.
          </p>
          <button
            type="button"
            onClick={() => void createAgent()}
            disabled={
              !!busy ||
              wallet.status !== "connected" ||
              wallet.chainId !== supportedChainId
            }
            className="mt-6 rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create my Sepolia agent
          </button>
        </div>
      )}

      {step === 1 && agent?.state === "REVOKED" ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <WalletCards className="h-8 w-8 text-slate-400" />
          <h2 className="mt-4 text-xl font-semibold text-white">
            Agent archived
          </h2>
          <p className="mt-2 leading-6 text-slate-300">
            The execution signer is revoked and this agent cannot trade. The
            Privy wallet and history are retained. Configure a new mandate to
            restore the signer only after you approve the new limits.
          </p>
          <button
            type="button"
            onClick={beginMandateEdit}
            disabled={!!busy}
            className="mt-6 rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50"
          >
            Configure a new mandate
          </button>
        </div>
      ) : null}

      {step === 2 && agent && (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <Sparkles className="h-8 w-8 text-amber-300" />
          <h2 className="mt-4 text-xl font-semibold text-white">
            Give it test balance
          </h2>
          <p className="mt-2 leading-6 text-slate-300">
            The faucet sends 0.01 Sepolia ETH for gas, 1 WETH, and 1,000 mock
            USDC to the Privy wallet below. Sepolia may take up to two minutes
            to confirm all three transactions.
          </p>
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Agent wallet</dt>
              <dd className="font-mono text-cyan-200">
                {shortAddress(agent.walletAddress)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Network</dt>
              <dd className="text-white">
                Ethereum Sepolia · {supportedChainId}
              </dd>
            </div>
          </dl>
          <AgentBalanceCard
            status={walletStatus}
            busy={!!busy}
            onRefresh={() => void refreshWalletStatus()}
          />
          <button
            type="button"
            onClick={() => void fundAgent()}
            disabled={!!busy}
            className="mt-6 rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50"
          >
            Fund agent with test assets
          </button>
        </div>
      )}

      {step === 3 && agent && (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <Bot className="h-8 w-8 text-cyan-300" />
          <h2 className="mt-4 text-xl font-semibold text-white">
            Trading instruction
          </h2>
          <p className="mt-2 leading-6 text-slate-300">
            The instruction guides the proposal engine. The hard limits below
            are enforced independently by AURKA and Privy.
          </p>
          <label className="mt-5 block text-sm text-slate-300">
            Space the agent may use
            <select
              value={selectedSpaceId}
              onChange={(event) => {
                setSelectedSpaceId(event.target.value);
                setSpaceId(event.target.value || null);
              }}
              disabled={!!busy || spacesLoading || eligibleSpaces.length === 0}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white disabled:opacity-50"
            >
              <option value="">
                {spacesLoading
                  ? "Loading eligible Spaces…"
                  : eligibleSpaces.length === 0
                    ? "No eligible Sepolia Spaces"
                    : "Choose an active Space"}
              </option>
              {eligibleSpaces.map((space) => (
                <option key={space.identity.id} value={space.identity.id}>
                  {space.identity.name} · {space.identity.id}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              The agent is restricted to this Space and its WETH → USDC pair; it
              cannot choose another Space at runtime.
            </span>
          </label>
          <label className="mt-5 block text-sm text-slate-300">
            What should the agent look for?
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              maxLength={500}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white outline-none focus:border-cyan-500"
            />
          </label>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-slate-300">
              Maximum input per trade (WETH)
              <input
                value={perTradeInput}
                onChange={(event) => setPerTradeInput(event.target.value)}
                inputMode="decimal"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white"
              />
            </label>
            <label className="text-sm text-slate-300">
              Total input budget (WETH)
              <input
                value={totalInput}
                onChange={(event) => setTotalInput(event.target.value)}
                inputMode="decimal"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white"
              />
            </label>
            <label className="text-sm text-slate-300">
              Maximum number of trades
              <input
                value={maxTradeCount}
                onChange={(event) => setMaxTradeCount(event.target.value)}
                inputMode="numeric"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white"
              />
            </label>
            <label className="text-sm text-slate-300">
              Minimum output / input rate (%)
              <input
                value={minimumRate}
                onChange={(event) => setMinimumRate(event.target.value)}
                inputMode="decimal"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white"
              />
              <span className="mt-1 block text-xs text-slate-500">
                99% means the normalized USDC output value must be at least 99%
                of the WETH input value.
              </span>
            </label>
            <label className="text-sm text-slate-300">
              Slippage tolerance (basis points)
              <input
                value={slippage}
                onChange={(event) => setSlippage(event.target.value)}
                inputMode="numeric"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => setStep(4)}
            disabled={!!busy || !selectedSpace}
            className="mt-6 rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950"
          >
            Review mandate
          </button>
        </div>
      )}

      {step === 4 && agent && (
        <div className="rounded-2xl border border-cyan-800/70 bg-cyan-950/20 p-6">
          <ShieldCheck className="h-8 w-8 text-emerald-300" />
          <h2 className="mt-4 text-xl font-semibold text-white">
            Review and start
          </h2>
          <p className="mt-2 leading-6 text-slate-300">
            You will sign the exact mandate and start request. These signatures
            authorize only this agent wallet, this Space, this WETH → USDC
            direction, and the displayed budget.
          </p>
          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-4 border-b border-slate-800 pb-3">
              <dt className="text-slate-500">Agent</dt>
              <dd className="font-mono text-cyan-200">
                {shortAddress(agent.walletAddress)}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-slate-800 pb-3">
              <dt className="text-slate-500">Space</dt>
              <dd className="text-white">
                {selectedSpace?.identity.name ??
                  spaceId ??
                  selectedSpaceId ??
                  "Choose an active Sepolia Space"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-slate-800 pb-3">
              <dt className="text-slate-500">Guardrails</dt>
              <dd className="text-right text-white">
                {perTradeInput} WETH / trade
                <br />
                {totalInput} WETH total · max {maxTradeCount} trades
                <br />
                Minimum rate {minimumRate}% · {slippage} bps slippage
              </dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => void saveMandateAndStart()}
            disabled={!!busy}
            className="mt-6 rounded-lg bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50"
          >
            Approve and start agent
          </button>
          {session &&
          ["STOPPED", "EXPIRED", "EXHAUSTED"].includes(session.state) ? (
            <button
              type="button"
              onClick={beginMandateEdit}
              disabled={!!busy}
              className="mt-3 ml-3 rounded-lg border border-slate-600 px-4 py-3 font-semibold text-slate-200 disabled:opacity-50"
            >
              Edit mandate
            </button>
          ) : null}
        </div>
      )}

      {step === 4 && agent?.mandateJson ? (
        <p className="text-sm text-emerald-300">
          Agent mandate saved. The background service owns execution after the
          start request.
        </p>
      ) : null}
    </section>
  );
}
