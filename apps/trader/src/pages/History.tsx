import { useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import type { Execution } from "@aurka/shared";
export default function History() {
  const [hash, setHash] = useState("");
  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function lookup() {
    setLoading(true);
    setError(null);
    setExecution(null);
    try {
      setExecution(
        await new AurkaClient({ baseUrl: "/api" }).getExecution(hash),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="space-y-4 text-gray-200">
      <h2 className="text-2xl font-bold">Execution lookup</h2>
      <p>
        Look up a known execution hash. A complete history feed is not
        available.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <label>
          Execution hash
          <input
            required
            pattern="0x[0-9a-fA-F]{64}"
            className="block w-full bg-gray-700 p-2"
            value={hash}
            onChange={(event) => setHash(event.target.value)}
          />
        </label>
        <button disabled={loading} className="mt-3 bg-blue-600 p-2">
          {loading ? "Loading…" : "Look up"}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {execution && (
        <dl>
          <dt>Status</dt>
          <dd>{execution.status}</dd>
          <dt>Input amount</dt>
          <dd>{execution.executedTraderInputAmount} token base units</dd>
          <dt>Submitted</dt>
          <dd>{new Date(execution.submittedAt * 1000).toLocaleString()}</dd>
          {execution.revertReason && (
            <>
              <dt>Revert reason</dt>
              <dd>{execution.revertReason}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
