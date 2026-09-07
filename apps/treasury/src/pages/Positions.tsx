import { useEffect, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import type { Position } from "@aurka/shared";

export default function Positions() {
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
        <div className="text-gray-400">Loading positions...</div>
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
      <h2 className="text-2xl font-bold text-white mb-6">Positions</h2>

      {positions.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <p className="text-gray-400">No positions found.</p>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-700">
            <thead className="bg-gray-900">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Trader
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Assets
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {positions.map((position) => (
                <tr key={position.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                    {position.id}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                    {position.owner}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                    {position.policy.assets.length} assets
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-green-400">
                    Active
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
