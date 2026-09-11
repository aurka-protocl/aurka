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
  type TradingAgent,
  parseTokenAmount,
} from "@aurka/shared";
import { apiBaseUrl, supportedChainId } from "../config";
import { spaceAdapter } from "../domain/spaces";
import { userFacingError, shortAddress } from "../ui";
import { useWallet, WalletStateMessage } from "../wallet";

const client = new AurkaClient({ baseUrl: apiBaseUrl });

type Step = 1 | 2 | 3 | 4;

function bytes32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

async function signTypedData(
  provider: {
    request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  },
  address: string,
  typedData: unknown,
  label: string,
): Promise<string> {
  const result = await provider.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(typedData)],
  });
  if (typeof result !== "string")
    throw new Error(`Wallet returned no ${label} signature`);
  return result;
}

function activeSpacePair(
  space: Awaited<ReturnType<typeof spaceAdapter.getSpace>>,
) {
  const assets = space.position?.policy.assets ?? [];
  const weth = assets.find((asset) => asset.symbol.toUpperCase() === "WETH");
  const usdc = assets.find((asset) => asset.symbol.toUpperCase() === "USDC");
  if (!weth || !usdc)
    throw new Error(
      "The active Sepolia Space does not expose the WETH/USDC pair",
    );
  return { weth, usdc };
}

export default function Agent() {
  const wallet = useWallet();
  const [step, setStep] = useState<Step>(1);
  const [agent, setAgent] = useState<TradingAgent | null>(null);
  const [session, setSession] = useState<DelegatedSession | null>(null);
  const [walletStatus, setWalletStatus] = useState<DelegatedStatus | null>(
    null,
  );
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState(
    "Find small, conservative WETH to USDC opportunities in my selected Space.",
  );
  // Sepolia's demo Space uses integer normalized settlement values. At the
  // current 3,200 USDC/WETH price, 0.0025 WETH maps exactly to 8 value units;
  // 0.001 WETH maps to 3.2 and is rejected by the deterministic solver.
  const [perTradeInput, setPerTradeInput] = useState("0.0025");
  const [totalInput, setTotalInput] = useState("0.0075");
  const [maxTradeCount, setMaxTradeCount] = useState("3");
  const [minimumRate, setMinimumRate] = useState("95");
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
    totalInput,
  ]);

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
        if (!active) return;
        setSession(current ?? null);
        setWalletStatus(status);
        setStep(current ? 4 : result.agent.fundingJson.eth === "0" ? 2 : 3);
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
    const challenge = await client.authChallenge({
      address: wallet.address,
      chainId: wallet.chainId,
    });
    const signature = await signTypedData(
      wallet.provider,
      wallet.address,
      challenge.typedData,
      "login",
    );
    await client.authVerify({
      challengeId: challenge.challengeId,
      address: wallet.address,
      chainId: wallet.chainId,
      signature,
    });
  }

  async function createAgent(): Promise<void> {
    setBusy("Creating your private trading wallet…");
    setError(null);
    try {
      await authenticate();
      const result = await client.createTradingAgent({
        chainId: supportedChainId,
      });
      setAgent(result.agent);
      setStep(2);
    } catch (requestError) {
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
    try {
      const result = await client.fundTradingAgent(agent.id, funding);
      setAgent(result.agent);
      setWalletStatus(await client.delegatedStatus());
      setStep(3);
    } catch (requestError) {
      setError(userFacingError(requestError, "The agent could not be funded"));
    } finally {
      setBusy(null);
    }
  }

  async function saveMandateAndStart(): Promise<void> {
    if (!agent || !wallet.address || !wallet.provider) return;
    setBusy("Reviewing the mandate and starting the worker…");
    setError(null);
    try {
      const spaces = await spaceAdapter.listSpaces(50);
      const space = spaces.find(
        (candidate) => candidate.identity.state === "ACTIVE",
      );
      if (!space?.position)
        throw new Error("No active Sepolia Space is available for this agent");
      const selectedPair = activeSpacePair(space);
      setSpaceId(space.identity.id);
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
      const saved = await client.setTradingAgentMandate(agent.id, mandate);
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
      const session = await client.authorizeDelegatedSession({
        plan,
        agentWallet: agent.walletAddress,
        signature: authorizationSignature,
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
      setSession(started);
      setStep(4);
    } catch (requestError) {
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
    if (
      !session ||
      !wallet.address ||
      !wallet.provider ||
      !session.wallet.balances
    )
      return;
    setBusy("Preparing owner-approved recovery…");
    setError(null);
    try {
      const balances = session.wallet.balances;
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
      if (asset.amount === "0")
        throw new Error("The agent has no recoverable test-token balance");
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
      setSession(next);
    } catch (requestError) {
      setError(
        userFacingError(requestError, "The agent funds could not be recovered"),
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
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
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
                onClick={() => void recoverAgent()}
                disabled={!!busy}
                className="rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
              >
                Recover test funds
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void client
                  .delegatedSession(session.id)
                  .then(setSession)
                  .catch((requestError) =>
                    setError(
                      userFacingError(
                        requestError,
                        "The agent status could not be refreshed",
                      ),
                    ),
                  )
              }
              disabled={!!busy}
              className="rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-200 disabled:opacity-50"
            >
              Refresh status
            </button>
          </div>
        </div>
      ) : null}

      {step === 1 && (
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

      {step === 2 && agent && (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
          <Sparkles className="h-8 w-8 text-amber-300" />
          <h2 className="mt-4 text-xl font-semibold text-white">
            Give it test balance
          </h2>
          <p className="mt-2 leading-6 text-slate-300">
            The faucet sends 0.01 Sepolia ETH for gas, 1 WETH, and 1,000 mock
            USDC to the Privy wallet below.
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
          {walletStatus?.wallet.balances ? (
            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Confirmed ETH</dt>
                <dd className="font-mono text-white">
                  {walletStatus.wallet.balances.native}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Confirmed WETH</dt>
                <dd className="font-mono text-white">
                  {walletStatus.wallet.balances.inputToken}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Confirmed USDC</dt>
                <dd className="font-mono text-white">
                  {walletStatus.wallet.balances.outputToken}
                </dd>
              </div>
            </dl>
          ) : null}
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
            disabled={!!busy}
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
                {spaceId ?? "First active Sepolia Space"}
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
