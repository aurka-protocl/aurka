import { useEffect, useRef, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import {
  formatTokenAmount,
  parseTokenAmount,
  type Position,
  type AtomicSettlementIntent,
} from "@aurka/shared";
import { activateForkSpace } from "../domain/space-setup";
import { apiBaseUrl } from "../config";
import { useWallet } from "../wallet";

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
  integrationMode?: "real" | "fixture";
  aquaKind?: string;
  oracleKind?: string;
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
const client = new AurkaClient({ baseUrl: apiBaseUrl });
const apiPath = (path: string) => `${apiBaseUrl.replace(/\/$/, "")}${path}`;
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
const hex = (value: bigint) => `0x${value.toString(16)}`;
const addressWord = (address: string) => address.slice(2).padStart(64, "0");
const amountWord = (amount: bigint) => amount.toString(16).padStart(64, "0");
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Wallet request failed";

export default function ForkSpace({
  owner = false,
  spaceId,
  embedded = false,
}: {
  readonly owner?: boolean;
  readonly spaceId?: string;
  readonly embedded?: boolean;
}) {
  const wallet = useWallet();
  const [state, setState] = useState<ForkState>();
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
  const account = wallet.address ?? "";
  async function refresh() {
    const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : "";
    const next = await getJson<ForkState>(apiPath(`/fork${query}`));
    if (spaceId && next.position.id !== spaceId)
      throw new Error("This Space is not available in the current fork.");
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
    setError("");
    const tick = async () => {
      try {
        const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : "";
        const next = await getJson<ForkState>(apiPath(`/fork${query}`));
        if (active) {
          if (spaceId && next.position.id !== spaceId) {
            setState(undefined);
            setError("This Space is not available in the current fork.");
            return;
          }
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
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [spaceId]);
  useEffect(() => {
    invalidate();
    if (wallet.status === "connected") setStatus("Wallet connected");
    else if (wallet.status === "wrong-network")
      setStatus("Switch to AURKA fork in the wallet before continuing.");
    else if (wallet.status === "error")
      setStatus(wallet.error ?? "Wallet connection failed");
    else setStatus("Connect your wallet from the header when ready");
  }, [wallet.error, wallet.revision, wallet.status]);
  useEffect(() => {
    if (state) setLimit(state.position.policy.maximumTransactionValue);
  }, [state?.position.id, state?.position.policy.maximumTransactionValue]);
  const stale =
    !!quote &&
    (!state ||
      quote.quote.expiresAt <= Math.max(now, state.timestamp) ||
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
    const provider = wallet.provider;
    if (!provider) throw new Error("Connect an Ethereum wallet first.");
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
    setConfirmed(undefined);
    setHash("");
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
    if (account.toLowerCase() !== state?.position.owner.toLowerCase())
      throw new Error("Connect the recorded Space governance owner.");
    invalidate();
    if (
      action === "pause" ||
      action === "resume" ||
      action === "reactivate" ||
      action === "limit"
    ) {
      const provider = await validateWallet(account);
      if (action === "limit") {
        const space = await client.getSpace(spaceId!);
        const draft = {
          id: space.identity.id,
          name: space.identity.name,
          ownerAddress: account,
          chainId: space.identity.chainId,
          assets: space.position!.policy.assets,
          maximumTransactionValue: limit,
        };
        const prepared = await client.prepareSpaceMutation({
          operation: "UPDATE",
          spaceId: space.identity.id,
          ownerAddress: account,
          draft,
        });
        const signature = (await provider.request({
          method: "eth_signTypedData_v4",
          params: [account, JSON.stringify(prepared.typedData)],
        })) as string;
        await client.confirmSpaceMutation({
          operation: "UPDATE",
          spaceId: space.identity.id,
          ownerAddress: account,
          draft,
          authorization: { ...prepared.authorization, signature },
        });
      }
      await activateForkSpace(
        spaceId!,
        account,
        provider,
        setStatus,
        action === "limit" ? "UPDATE" : action.toUpperCase(),
      );
      setStatus(`${action}: confirmed`);
      await refresh();
      return;
    }
    const transaction = await getJson<Transaction>(
      apiPath(
        `/fork/owner?spaceId=${encodeURIComponent(spaceId ?? "")}&action=${action}&value=${encodeURIComponent(limit)}`,
      ),
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
    const inputAsset = latest.position.currentPortfolio?.assets.find(
      (asset) => asset.token.toLowerCase() === latest.weth.toLowerCase(),
    );
    if (!inputAsset) throw new Error("Fork input price is unavailable");
    const value =
      (raw * BigInt(inputAsset.price)) /
      10n ** BigInt(inputAsset.decimals + inputAsset.priceDecimals);
    if (value === 0n)
      throw new Error(
        "Enter at least 1 reference unit of WETH at the displayed snapshot price.",
      );
    let intent = await client.prepareIntent({
      positionId: latest.position.id,
      trader: account,
      traderInputToken: latest.weth,
      traderOutputToken: latest.usdc,
      requestedValue: value.toString(),
      minimumTraderOutputValue: "0",
      nonce: Date.now().toString(),
      deadline: latest.timestamp + 300,
    });
    const preview = await client.solve(intent);
    // Bind wallet authorization to the reviewed net output, including partial fills.
    intent = await client.prepareIntent({
      positionId: latest.position.id,
      trader: account,
      traderInputToken: latest.weth,
      traderOutputToken: latest.usdc,
      requestedValue: intent.requestedValue,
      minimumTraderOutputValue: preview.proposal.traderOutputValue,
      nonce: intent.nonce,
      deadline: intent.deadline,
    });
    await client.submitIntent(intent);
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
          Block {state?.forkBlock ?? "—"} · local chain 31337.
          {state?.aquaKind === "REAL_AQUA"
            ? " Real Aqua + Chainlink prices."
            : " Fixture Aqua + prices."}
        </p>
      </div>
      {!embedded && (
        <h1 className="text-3xl font-semibold text-white">
          {owner ? "Team inventory" : "Swap WETH for USDC"}
        </h1>
      )}
      <p className="text-sm text-slate-400">
        {owner
          ? "Owner controls are available only to the recorded governance owner."
          : "Connect the counterparty wallet to review and submit this trade."}
      </p>
      <div className="space-y-3 rounded-xl border border-slate-700 p-4">
        <p className="text-sm">
          {account
            ? `Connected: ${account.slice(0, 6)}…${account.slice(-4)}`
            : "No wallet connected — use Connect wallet in the header"}
        </p>
        <details className="text-sm text-slate-400">
          <summary>Wallet and network details</summary>
          <p className="mt-2 break-all">{account}</p>
          <p>Wallet network: AURKA fork · RPC http://127.0.0.1:8545 · ETH</p>
        </details>
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
                state.balances[owner ? "treasury" : "bob"].usdc,
                6,
              )}{" "}
              USDC ·{" "}
              {formatTokenAmount(
                state.balances[owner ? "treasury" : "bob"].weth,
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
                  Treasury account: {state.position.policy.treasury}
                </p>
                <p className="break-all text-sm">
                  Policy governance: {state.position.policy.governance}
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
                    : "Awaiting owner authorization"}
                </p>
                <p className="text-sm">
                  Governance controls limits and pause. The treasury account
                  holds this Space’s funds; its owner can also revoke settlement
                  allowances.
                </p>
              </div>
            )}
          </div>
          {owner ? (
            <div className="space-y-4 rounded-xl border border-slate-700 p-4">
              <div>
                <h2 className="text-xl font-semibold text-white">Edit Space</h2>
                <p className="mt-1 text-sm text-slate-400">
                  These controls submit real owner transactions to the fork.
                </p>
              </div>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-400">Trading status</dt>
                  <dd className="font-medium text-white">
                    {state.position.policy.paused
                      ? "Paused"
                      : state.capacity.authorized
                        ? "Ready"
                        : "Reactivate trading"}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Maximum trade value</dt>
                  <dd className="font-medium text-white">
                    {state.position.policy.maximumTransactionValue} reference
                    units
                  </dd>
                </div>
              </dl>
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
                  busy ||
                  account.toLowerCase() !== state.position.owner.toLowerCase()
                }
                onClick={() => void run(() => ownerAction("limit"))}
              >
                Save changes
              </button>
              <button
                className={button}
                disabled={
                  busy ||
                  account.toLowerCase() !== state.position.owner.toLowerCase()
                }
                onClick={() =>
                  void run(() =>
                    ownerAction(
                      state.position.policy.paused ? "resume" : "pause",
                    ),
                  )
                }
              >
                {state.position.policy.paused
                  ? "Resume trading"
                  : "Pause trading"}
              </button>
              {!state.position.policy.paused && !state.capacity.authorized && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void run(() => ownerAction("reactivate"))}
                >
                  Reactivate trading
                </button>
              )}
              <p className="text-sm">
                Saving rules or resuming may require fresh trading
                authorization. Low-level token permissions remain isolated to
                this Space and are available only in Advanced controls.
              </p>
              <details className="text-sm text-slate-400">
                <summary>Advanced controls</summary>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void run(() => ownerAction("allowance"))}
                  >
                    Grant token permission
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void run(() => ownerAction("revoke"))}
                  >
                    Revoke token permission
                  </button>
                </div>
              </details>
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
              {state.aquaKind === "REAL_AQUA"
                ? "Chainlink rounds are read from the pinned mainnet fork and normalized to whole settlement units; the raw round is retained in the price snapshot."
                : "The fixture uses fixed reference prices. It is a seeded mechanism demonstration, not a market quote."}
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
