import { useEffect, useRef, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import {
  formatTokenAmount,
  parseTokenAmount,
  type Position,
  type AtomicSettlementIntent,
} from "@aurka/shared";

interface Provider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
}
interface Transaction {
  to: string;
  data: string;
  value: string;
}
interface ForkState {
  name: string;
  chainId: number;
  rpcUrl: string;
  forkBlock: number;
  alice: string;
  bob: string;
  router: string;
  aqua: string;
  usdc: string;
  weth: string;
  mocks: string[];
  position: Position;
  block: string;
  timestamp: number;
  balances: Record<string, { usdc: string; weth: string }>;
  capacity: { authorized: boolean; baseline: string; consumed: string };
}
const client = new AurkaClient({ baseUrl: "/api" });
const button =
  "rounded-lg bg-cyan-700 px-4 py-3 text-white disabled:opacity-40";
const inputStyle = "w-full rounded-lg border border-slate-600 bg-slate-900 p-3";
const fieldTypes =
  "bytes32 intentId,bytes32 policyId,bytes32 positionIdHash,address trader,address traderInputToken,address traderOutputToken,uint256 requestedValue,uint256 minimumTraderOutputValue,bool exactInput,bool allowPartialFill,uint256 deadline,uint256 nonce,bytes32 balanceSnapshot,bytes32 priceSnapshot,bytes32 aquaStrategyHash";
function typedIntent(intent: AtomicSettlementIntent, state: ForkState) {
  return {
    domain: {
      name: "AURKA Direct Settlement",
      version: "1",
      chainId: state.chainId,
      verifyingContract: state.router,
    },
    primaryType: "Intent",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Intent: fieldTypes.split(",").map((field) => {
        const [type, name] = field.split(" ");
        return { type, name };
      }),
    },
    message: intent,
  };
}
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body.error === "string" ? body.error : "Fork request failed",
    );
  return body;
}
function walletProvider(): Provider {
  const provider = (window as unknown as { ethereum?: Provider }).ethereum;
  if (!provider)
    throw new Error(
      "Open this page with an Ethereum browser wallet installed.",
    );
  return provider;
}
const hex = (value: bigint) => `0x${value.toString(16)}`;
const addressWord = (address: string) => address.slice(2).padStart(64, "0");
const amountWord = (amount: bigint) => amount.toString(16).padStart(64, "0");
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Wallet request failed";

export default function ForkSpace({ owner = false }: { owner?: boolean }) {
  const [state, setState] = useState<ForkState>();
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("2");
  const [limit, setLimit] = useState("5000");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Connect your test wallet");
  const [hash, setHash] = useState("");
  const [confirmed, setConfirmed] = useState<{
    hash: string;
    block: string;
    gas: string;
  }>();
  const [quote, setQuote] = useState<{
    intent: AtomicSettlementIntent;
    solved: Awaited<ReturnType<AurkaClient["solve"]>>;
    quote: Awaited<ReturnType<AurkaClient["quote"]>>;
  }>();
  const [prepared, setPrepared] = useState<Transaction>();
  const [reviewed, setReviewed] = useState(false);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const generation = useRef(0);
  const currentAccount = useRef("");
  async function refresh() {
    const next = await getJson<ForkState>("/api/fork");
    setState(next);
    return next;
  }
  function invalidate() {
    generation.current++;
    setQuote(undefined);
    setPrepared(undefined);
    setReviewed(false);
  }
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await getJson<ForkState>("/api/fork");
        if (active) {
          setState(next);
          setNow(Math.floor(Date.now() / 1000));
        }
      } catch (error) {
        if (active) {
          setState(undefined);
          setError(message(error));
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    const changed = () => {
      invalidate();
      currentAccount.current = "";
      setAccount("");
      setStatus(
        "Account or network changed. Reconnect and request a new quote.",
      );
    };
    const provider = (window as unknown as { ethereum?: Provider }).ethereum;
    provider?.on?.("accountsChanged", changed);
    provider?.on?.("chainChanged", changed);
    return () => {
      active = false;
      window.clearInterval(timer);
      provider?.removeListener?.("accountsChanged", changed);
      provider?.removeListener?.("chainChanged", changed);
    };
  }, []);
  const stale =
    !!quote &&
    (!state ||
      quote.quote.expiresAt <= now ||
      state.position.policy.paused ||
      quote.quote.policyNonce !== state.position.policy.nonce ||
      quote.quote.currentPortfolio.assets.some(
        (asset) =>
          state.position.currentPortfolio?.assets.find(
            (next) => next.token === asset.token,
          )?.balance !== asset.balance,
      ));
  async function validateWallet(expected: string) {
    if (!state) throw new Error("Fork state unavailable");
    const provider = walletProvider();
    const chainId = await provider.request({ method: "eth_chainId" });
    const accounts = (await provider.request({
      method: "eth_accounts",
    })) as string[];
    if (BigInt(chainId as string) !== BigInt(state.chainId))
      throw new Error("Select AURKA fork network (31337) in your wallet.");
    if (!accounts[0] || accounts[0].toLowerCase() !== expected.toLowerCase())
      throw new Error("Wallet account changed. Reconnect before continuing.");
    return provider;
  }
  async function connect() {
    const provider = walletProvider();
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    if (!accounts[0]) throw new Error("No wallet account selected");
    await validateWallet(accounts[0]);
    invalidate();
    currentAccount.current = accounts[0];
    setAccount(accounts[0]);
    setStatus("Wallet connected");
  }
  async function receipt(transactionHash: string) {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      // Read from the fixed local node even if the wallet network changes mid-flight.
      const response = await fetch(state!.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [transactionHash],
        }),
      });
      const body = await response.json();
      if (body.error) throw new Error("Receipt lookup failed on the fork RPC");
      if (body.result) {
        if (body.result.status !== "0x1")
          throw new Error(`Transaction reverted: ${transactionHash}`);
        return {
          hash: transactionHash,
          block: BigInt(body.result.blockNumber).toString(),
          gas: BigInt(body.result.gasUsed).toString(),
        };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error(
      `Receipt still pending for ${transactionHash}. Inspect the local RPC before retrying.`,
    );
  }
  async function send(
    transaction: Transaction,
    expected: string,
    label: string,
  ) {
    const provider = await validateWallet(expected);
    setStatus(`${label}: awaiting wallet approval`);
    const sent = (await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          ...transaction,
          value: hex(BigInt(transaction.value)),
          from: expected,
        },
      ],
    })) as string;
    setHash(sent);
    localStorage.setItem("aurka:fork:lastTransaction", sent);
    setStatus(`${label}: submitted, waiting for receipt`);
    const confirmed = await receipt(sent);
    setConfirmed(confirmed);
    setStatus(`${label}: confirmed`);
    await refresh();
    return confirmed;
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(message(error));
      setStatus("Failed or rejected — no success claimed");
      setPrepared(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function ownerAction(action: string) {
    if (account.toLowerCase() !== state?.alice.toLowerCase())
      throw new Error(
        "Connect Alice, the actual treasury and governance account.",
      );
    invalidate();
    const transaction = await getJson<Transaction>(
      `/api/fork/owner?action=${action}&value=${encodeURIComponent(limit)}`,
    );
    await send(transaction, account, action);
  }
  async function getQuote() {
    if (!state) return;
    await validateWallet(account);
    invalidate();
    const version = generation.current;
    setConfirmed(undefined);
    setHash("");
    const latest = await refresh();
    const raw = parseTokenAmount(amount, 18);
    const value = (raw * 3000n) / 10n ** 18n;
    if (value === 0n)
      throw new Error(
        "Enter at least 1 reference unit of WETH (about 0.000334 WETH).",
      );
    const intent = await client.prepareIntent({
      positionId: latest.position.id,
      trader: account,
      traderInputToken: latest.weth,
      traderOutputToken: latest.usdc,
      requestedValue: value.toString(),
      minimumTraderOutputValue: "0",
      nonce: Date.now().toString(),
      deadline: latest.timestamp + 300,
    });
    const quoted = await client.quote(intent);
    const solved = await client.solve(intent);
    if (version !== generation.current)
      throw new Error(
        "Wallet or input changed during quotation. Request another quote.",
      );
    setQuote({ intent, quote: quoted, solved });
    setStatus("Quote ready — review exact amounts");
  }
  async function prepare() {
    if (!quote || !state || stale || !reviewed)
      throw new Error("Review a fresh quote first.");
    const version = generation.current;
    const expected = account;
    const provider = await validateWallet(expected);
    const input = BigInt(quote.solved.proposal.traderInputAmount);
    const balance = (await provider.request({
      method: "eth_call",
      params: [
        { to: state.weth, data: `0x70a08231${addressWord(expected)}` },
        "latest",
      ],
    })) as string;
    if (BigInt(balance) < input)
      throw new Error("Insufficient WETH balance for the executable fill.");
    const allowance = (await provider.request({
      method: "eth_call",
      params: [
        {
          to: state.weth,
          data: `0xdd62ed3e${addressWord(expected)}${addressWord(state.router)}`,
        },
        "latest",
      ],
    })) as string;
    if (BigInt(allowance) < input)
      await send(
        {
          to: state.weth,
          data: `0x095ea7b3${addressWord(state.router)}${amountWord(input)}`,
          value: "0",
        },
        expected,
        "WETH allowance",
      );
    if (version !== generation.current)
      throw new Error("Account or input changed; request a new quote.");
    await validateWallet(expected);
    setStatus("Authorize the exact intent in your wallet");
    const signature = (await provider.request({
      method: "eth_signTypedData_v4",
      params: [expected, JSON.stringify(typedIntent(quote.intent, state))],
    })) as string;
    if (version !== generation.current)
      throw new Error("Wallet changed during signing; request a new quote.");
    await validateWallet(expected);
    const result = await client.execute(
      quote.quote.intentHash,
      quote.solved.proposalHash,
      signature,
    );
    if (version !== generation.current)
      throw new Error("Wallet changed during preparation.");
    if (
      result.transactionRequest.to.toLowerCase() !== state.router.toLowerCase()
    )
      throw new Error("Unexpected settlement target");
    setPrepared(result.transactionRequest);
    setStatus("Prepared — signed and simulated; ready to submit");
  }
  async function submit() {
    if (!prepared || stale || !quote)
      throw new Error("Prepared quote is stale. Request a new quote.");
    const transaction = prepared;
    setPrepared(undefined);
    await send(transaction, account, "Trade");
    invalidate();
  }
  return (
    <section className="mx-auto max-w-3xl space-y-5 break-words text-slate-200">
      <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4">
        <strong>Ethereum fork · test funds only</strong>
        <p>
          Block {state?.forkBlock ?? "22400000"} · local chain 31337. Aqua and
          prices are mocked.
        </p>
      </div>
      <h1 className="text-3xl font-semibold text-white">
        {owner ? "Team inventory" : "Swap WETH for USDC"}
      </h1>
      <nav className="flex gap-4">
        <a className="text-cyan-300 underline" href="http://127.0.0.1:3001/">
          Alice’s Space
        </a>
        <a
          className="text-cyan-300 underline"
          href="http://127.0.0.1:3002/swap"
        >
          Bob’s swap
        </a>
      </nav>
      <div className="space-y-3 rounded-xl border border-slate-700 p-4">
        <button
          className={button}
          disabled={busy || !state}
          onClick={() => void run(connect)}
        >
          Connect wallet
        </button>
        <p className="text-sm break-all">{account || "No wallet connected"}</p>
        <p className="text-sm">
          Wallet network: AURKA fork · RPC http://127.0.0.1:8545 · ETH
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-700 p-4 text-red-200"
        >
          {error}
        </p>
      )}
      <p role="status" aria-live="polite">
        {status}
      </p>
      {state && (
        <>
          <div className="rounded-xl border border-slate-700 p-4">
            <h2 className="mb-3 text-xl">
              {owner ? "Holdings and trading rules" : "Your test balances"}
            </h2>
            <p>
              {formatTokenAmount(
                state.balances[owner ? "alice" : "bob"].usdc,
                6,
              )}{" "}
              USDC ·{" "}
              {formatTokenAmount(
                state.balances[owner ? "alice" : "bob"].weth,
                18,
              )}{" "}
              WETH
            </p>
            <p className="mt-2 text-sm">
              Confirmed chain snapshot: block {state.block}
            </p>
            {owner && (
              <div className="mt-3 space-y-2">
                <p className="break-all text-sm">
                  Controlling account (treasury and governance): {state.alice}
                </p>
                <p>
                  Buys WETH with USDC. Maximum WETH allocation:{" "}
                  {state.position.policy.assets.find(
                    (asset) => asset.symbol === "WETH",
                  )!.maximumWeightBps / 100}
                  %. Per-transaction limit:{" "}
                  {state.position.policy.maximumTransactionValue} reference
                  units.
                </p>
                <p>
                  Policy: {state.position.policy.paused ? "Paused" : "Open"} ·
                  Capacity:{" "}
                  {state.capacity.authorized
                    ? `${state.capacity.consumed} / ${state.capacity.baseline} consumed`
                    : "Awaiting Alice’s authorization"}
                </p>
                <p className="text-sm">
                  Governance controls limits and pause. Alice holds this role.
                  Token allowance can also be revoked. This Space is her
                  account, not a separate vault.
                </p>
              </div>
            )}
          </div>
          {owner ? (
            <div className="space-y-4 rounded-xl border border-slate-700 p-4">
              <p>
                Start: grant USDC allowance, then authorize capacity. Neither
                step moves a trade by itself.
              </p>
              <div className="flex flex-wrap gap-3">
                {[
                  ["allowance", "Grant USDC allowance"],
                  ["authorize", "Authorize trading capacity"],
                  [
                    state.position.policy.paused ? "resume" : "pause",
                    state.position.policy.paused
                      ? "Resume trading"
                      : "Pause trading",
                  ],
                  ["revoke", "Revoke USDC allowance"],
                ].map(([action, label]) => (
                  <button
                    key={action}
                    className={button}
                    disabled={
                      busy ||
                      account.toLowerCase() !== state.alice.toLowerCase()
                    }
                    onClick={() => void run(() => ownerAction(action))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="block">
                Maximum transaction value (1–5000 reference units)
                <input
                  className={inputStyle}
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  inputMode="numeric"
                />
              </label>
              <button
                className={button}
                disabled={
                  busy || account.toLowerCase() !== state.alice.toLowerCase()
                }
                onClick={() => void run(() => ownerAction("limit"))}
              >
                Save transaction limit
              </button>
              <p className="text-sm">
                Changing limits or pause invalidates earlier authorization.
                Re-authorize capacity after reviewing the current holdings.
                Capacity cannot be silently reset after a fill.
              </p>
            </div>
          ) : (
            <div className="space-y-4 rounded-xl border border-slate-700 p-4">
              <label className="block">
                WETH to pay
                <input
                  aria-label="WETH to pay"
                  className={inputStyle}
                  value={amount}
                  disabled={busy}
                  onChange={(event) => {
                    invalidate();
                    setAmount(event.target.value);
                  }}
                  inputMode="decimal"
                />
              </label>
              <button
                className={button}
                disabled={busy || !account}
                onClick={() => void run(getQuote)}
              >
                Get quote
              </button>
              {quote && (
                <div className="space-y-3 border-t border-slate-700 pt-4">
                  <h2 className="text-xl">Review executable trade</h2>
                  <p>
                    Pay exactly{" "}
                    {formatTokenAmount(
                      quote.solved.proposal.traderInputAmount,
                      18,
                    )}{" "}
                    WETH
                  </p>
                  <p>
                    Receive exactly{" "}
                    {formatTokenAmount(
                      quote.solved.proposal.traderOutputAmount,
                      6,
                    )}{" "}
                    USDC
                  </p>
                  <p>
                    {BigInt(quote.solved.proposal.traderInputAmount) <
                    parseTokenAmount(amount, 18)
                      ? "Partial fill: only the amount above will be spent. "
                      : "Full fill. "}
                    Limiting rule:{" "}
                    {quote.quote.bindingConstraint.replace(/_/g, " ")}
                  </p>
                  <p>
                    Fee: {quote.quote.fees.totalFeeAmount} reference units.
                    Solver:{" "}
                    {formatTokenAmount(
                      quote.solved.proposal.solverFeeAmount,
                      6,
                    )}{" "}
                    USDC · protocol:{" "}
                    {formatTokenAmount(
                      quote.solved.proposal.protocolFeeAmount,
                      6,
                    )}{" "}
                    USDC. The treasury retains {quote.quote.fees.treasuryAmount}{" "}
                    reference units.
                  </p>
                  <p>
                    Expires{" "}
                    {new Date(
                      quote.quote.expiresAt * 1000,
                    ).toLocaleTimeString()}
                    . Gas is paid separately in test ETH.
                  </p>
                  {stale ? (
                    <p className="text-amber-300">
                      Quote expired or chain state changed. Get a new quote.
                    </p>
                  ) : (
                    <>
                      <label className="flex gap-3">
                        <input
                          type="checkbox"
                          checked={reviewed}
                          disabled={busy}
                          onChange={(event) =>
                            setReviewed(event.target.checked)
                          }
                        />
                        I accept these exact executable amounts and any partial
                        fill.
                      </label>
                      <button
                        className={button}
                        disabled={busy || !reviewed || !!prepared}
                        onClick={() => void run(prepare)}
                      >
                        Approve and sign
                      </button>
                      {prepared && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() => void run(submit)}
                        >
                          Submit trade
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <details className="rounded-xl border border-slate-700 p-4">
            <summary>Test environment and price details</summary>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              {state.mocks.map((mock) => (
                <li key={mock}>{mock}</li>
              ))}
            </ul>
            <p className="mt-3">
              The fixed reference price is 3000 USDC units per WETH. This is a
              seeded mechanism demonstration, not a market quote. Amounts are
              rounded to whole reference units before sizing.
            </p>
          </details>
        </>
      )}
      {(hash || confirmed) && (
        <div className="rounded-xl border border-cyan-700 p-4">
          <h2>Local receipt</h2>
          <p className="break-all text-sm">
            Transaction: {hash || confirmed?.hash}
          </p>
          {confirmed && (
            <p>
              Confirmed in block {confirmed.block} · gas used {confirmed.gas}
            </p>
          )}
        </div>
      )}
      <button
        className="text-cyan-300 underline"
        disabled={busy || !state}
        onClick={() =>
          void run(async () => {
            const last = localStorage.getItem("aurka:fork:lastTransaction");
            if (!last)
              throw new Error(
                "No saved wallet transaction on this browser origin.",
              );
            setHash(last);
            setConfirmed(await receipt(last));
            await refresh();
            setStatus("Saved transaction confirmed on this fork");
          })
        }
      >
        Check last local receipt
      </button>
    </section>
  );
}
