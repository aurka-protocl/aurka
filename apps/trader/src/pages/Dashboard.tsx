import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { AurkaClient } from "@aurka/sdk";
import { TrendingUp, DollarSign, Activity, Shield } from "lucide-react";

export default function Dashboard() {
  const [health, setHealth] = useState<Awaited<
    ReturnType<AurkaClient["health"]>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const client = new AurkaClient({ baseUrl: "/api" });
    client
      .health()
      .then(setHealth)
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
      name: "Available Liquidity",
      value: "Unavailable",
      icon: DollarSign,
      color: "text-blue-400",
    },
    {
      name: "24h Volume",
      value: "Unavailable",
      icon: TrendingUp,
      color: "text-purple-400",
    },
    {
      name: "Risk Score",
      value: "Unavailable",
      icon: Shield,
      color: "text-yellow-400",
    },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-6">Trader Dashboard</h2>

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
        <h3 className="text-lg font-semibold text-white mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            to="/trade"
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition"
          >
            New Trade
          </Link>
          <Link
            to="/portfolio"
            className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-3 px-4 rounded-lg transition"
          >
            View Portfolio
          </Link>
        </div>
      </div>
    </div>
  );
}
