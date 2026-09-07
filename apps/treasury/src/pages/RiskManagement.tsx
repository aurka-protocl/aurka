import type { Position } from "@aurka/shared";
import { useEffect, useState } from "react";
import { AurkaClient } from "@aurka/sdk";

export default function RiskManagement() {
  const [risk, setRisk] = useState<Awaited<
    ReturnType<AurkaClient["getRiskPosition"]>
  > | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    setError(null);
    const client = new AurkaClient({ baseUrl: "/api" });
    client
      .listPositions(20, cursor)
      .then((response) => {
        setPositions(response.items);
        setNextCursor(response.nextCursor);
      })
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : "Request failed"),
      )
      .finally(() => setLoading(false));
  }, [cursor]);

  if (error)
    return (
      <p role="alert" className="text-red-400">
        {error}
      </p>
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading risk data...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-4 mb-4">
        <button disabled={!cursor} onClick={() => setCursor(undefined)}>
          First page
        </button>
        <button
          disabled={!nextCursor}
          onClick={() => setCursor(nextCursor ?? undefined)}
        >
          Next page
        </button>
      </div>
      <h2 className="text-2xl font-bold text-white mb-6">Risk Management</h2>

      {risk && (
        <section aria-live="polite" className="my-4">
          <h3 className="break-all">Risk details for {risk.positionId}</h3>
          <p>Effective mode: {risk.effective.mode ?? "Unavailable"}</p>
          <p>Proposed mode: {risk.proposed?.mode ?? "None"}</p>
          <p>Certificate: {risk.certificateState}</p>
        </section>
      )}
      {positions.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <p className="text-gray-400">No positions to evaluate.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {positions.map((position) => (
            <div
              key={position.id}
              className="bg-gray-800 rounded-lg p-6 border border-gray-700"
            >
              <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-white break-all">
                    {position.id}
                  </h3>
                  <p className="text-sm text-gray-400 break-all">
                    {position.owner}
                  </p>
                </div>
                <button
                  onClick={() => {
                    const client = new AurkaClient({ baseUrl: "/api" });
                    client
                      .getRiskPosition(position.id)
                      .then(setRisk)
                      .catch((error: unknown) =>
                        setError(
                          error instanceof Error
                            ? error.message
                            : "Request failed",
                        ),
                      );
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                >
                  View Risk Details
                </button>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-gray-400">Assets</p>
                  <p className="text-white">{position.policy.assets.length}</p>
                </div>
                <div>
                  <p className="text-gray-400">Status</p>
                  <p className="text-green-400">
                    {position.policy.paused ? "Paused" : "Open"}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Risk Level</p>
                  <p className="text-yellow-400">
                    {position.riskMode} (indexed)
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
