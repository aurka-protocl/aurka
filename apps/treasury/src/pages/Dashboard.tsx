import { useEffect, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import { Activity, TrendingUp, Shield, DollarSign } from "lucide-react";

export default function Dashboard() {
  const [health, setHealth] = useState<Awaited<
    ReturnType<AurkaClient["health"]>
  > | null>(null);
  const [readiness, setReadiness] = useState<Awaited<
    ReturnType<AurkaClient["readiness"]>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const client = new AurkaClient({ baseUrl: "/api" });
    Promise.all([client.health(), client.readiness()])
      .then(([healthData, readinessData]) => {
        setHealth(healthData);
        setReadiness(readinessData);
      })
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : "Request failed"),
      )
      .finally(() => setLoading(false));
  }, []);

  if (error)
    return (
      <p role="alert" className="text-red-400">
        {error}
      </p>
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  const stats = [
    {
      name: "Service Status",
      value: health?.status || "unknown",
      icon: Activity,
      color: "text-green-400",
    },
    {
      name: "Database",
      value: readiness?.database || "unknown",
      icon: DollarSign,
      color: "text-blue-400",
    },
    {
      name: "RPC Status",
      value: readiness?.rpc || "unknown",
      icon: TrendingUp,
      color: "text-purple-400",
    },
    {
      name: "Indexer Lag",
      value:
        readiness?.indexerLagBlocks == null
          ? "Unavailable"
          : `${readiness.indexerLagBlocks} blocks`,
      icon: Shield,
      color: "text-yellow-400",
    },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-6">Dashboard</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.name}
            className="bg-gray-800 rounded-lg p-6 border border-gray-700"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">{stat.name}</p>
                <p className={`text-2xl font-bold ${stat.color} mt-1`}>
                  {stat.value}
                </p>
              </div>
              <stat.icon className="h-8 w-8 text-gray-600" />
            </div>
          </div>
        ))}
      </div>

      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold text-white mb-4">
          System Information
        </h3>
        <div className="space-y-2">
          <div className="flex justify-between text-gray-300">
            <span>Service:</span>
            <span>{health?.service || "N/A"}</span>
          </div>
          <div className="flex justify-between text-gray-300">
            <span>Version:</span>
            <span>{health?.version || "N/A"}</span>
          </div>
          <div className="flex justify-between text-gray-300">
            <span>Readiness:</span>
            <span
              className={
                readiness?.status === "ready"
                  ? "text-green-400"
                  : "text-red-400"
              }
            >
              {readiness?.status || "N/A"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
