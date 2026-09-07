import { useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import type { AtomicSettlementIntent, Quote } from "@aurka/shared";

const client = new AurkaClient({ baseUrl: "/api" });
export default function Trade() {
  const [form, setForm] = useState({
    positionId: "",
    trader: "",
    traderInputToken: "",
    traderOutputToken: "",
    requestedValue: "",
    minimumTraderOutputValue: "0",
    nonce: "0",
  });
  const [result, setResult] = useState<{
    intent: AtomicSettlementIntent;
    quote: Quote;
    solved: Awaited<ReturnType<AurkaClient["solve"]>>;
  } | null>(null);
  const [transaction, setTransaction] = useState<Awaited<
    ReturnType<AurkaClient["execute"]>
  > | null>(null);
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const labels: Record<keyof typeof form, string> = {
    positionId: "Position ID",
    trader: "Trader address",
    traderInputToken: "Input token address",
    traderOutputToken: "Output token address",
    requestedValue: "Requested value (settlement units)",
    minimumTraderOutputValue: "Minimum output value (settlement units)",
    nonce: "Intent nonce",
  };
  async function getQuote() {
    setLoading(true);
    setError(null);
    setResult(null);
    setTransaction(null);
    try {
      const intent = await client.prepareIntent({
        ...form,
        deadline: Math.floor(Date.now() / 1000) + 300,
      });
      const quote = await client.quote(intent);
      const solved = await client.solve(intent);
      setResult({ intent, quote, solved });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Quote failed");
    } finally {
      setLoading(false);
    }
  }
  async function prepareTransaction() {
    if (!result) return;
    setLoading(true);
    setError(null);
    try {
      setTransaction(
        await client.execute(
          result.quote.intentHash,
          result.solved.proposalHash,
          signature || undefined,
          crypto.randomUUID(),
        ),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Transaction preparation failed",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="max-w-2xl space-y-4 text-gray-200">
      <h2 className="text-2xl font-bold">Trade</h2>
      <p>
        Request a quote for an existing position. Partial fills are allowed.
        Wallet submission is not connected.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void getQuote();
        }}
      >
        {(Object.keys(form) as (keyof typeof form)[]).map((key) => (
          <label className="block" key={key}>
            {labels[key]}
            <input
              required
              className="block w-full bg-gray-700 p-2 rounded"
              value={form[key]}
              onChange={(event) => {
                setForm({ ...form, [key]: event.target.value });
                setResult(null);
                setTransaction(null);
              }}
            />
          </label>
        ))}
        <button disabled={loading} className="bg-blue-600 rounded p-3">
          {loading ? "Working…" : "Get quote"}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {result && (
        <section aria-live="polite" className="space-y-3">
          <p>
            Input: {result.solved.proposal.traderInputAmount} token base units
          </p>
          <p>
            Expected output: {result.solved.proposal.traderOutputAmount} token
            base units
          </p>
          <p>
            Total fee: {result.quote.fees.totalFeeAmount} settlement value units
          </p>
          <p>Simulation: {result.solved.simulation.status}</p>
          <p>
            Expires: {new Date(result.quote.expiresAt * 1000).toLocaleString()}
          </p>
          <details>
            <summary>Intent to authorize</summary>
            <pre className="overflow-auto">
              {JSON.stringify(result.intent, null, 2)}
            </pre>
          </details>
          <label className="block">
            Trader intent signature
            <input
              className="block w-full bg-gray-700 p-2 rounded"
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              placeholder="0x…"
            />
          </label>
          <button
            disabled={
              loading ||
              !signature ||
              result.quote.expiresAt <= Math.floor(Date.now() / 1000)
            }
            onClick={() => void prepareTransaction()}
            className="bg-blue-600 rounded p-3"
          >
            Prepare transaction
          </button>
        </section>
      )}
      {transaction && (
        <section>
          <h3>Unsigned transaction — not broadcast</h3>
          <pre className="overflow-auto">
            {JSON.stringify(transaction.transactionRequest, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
