import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import Layout from "./components/Layout";
import Spaces from "./pages/Spaces";
import {
  SpaceActivity,
  SpaceHoldings,
  SpaceOverview,
} from "./pages/Space";
import Trade from "./pages/Trade";
import History from "./pages/History";
import Status from "./pages/Status";
import SpaceForm from "./pages/SpaceForm";
import Agent from "./pages/Agent";
import { WalletProvider } from "./wallet";
import { spaceAdapter, spaceUrl } from "./domain/spaces";
import { userFacingError } from "./ui";
import { useEffect, useState } from "react";

function LegacySpaceRedirect({
  section,
}: {
  readonly section: "overview" | "holdings" | "settings";
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    spaceAdapter
      .listSpaces(100)
      .then((spaces) => {
        const space = spaces.find(
          (candidate) => candidate.identity.state === "ACTIVE",
        );
        if (active && space)
          navigate(spaceUrl(space.identity.id, section), { replace: true });
        else if (active) setError("No active Space is available right now.");
      })
      .catch((requestError: unknown) => {
        if (active)
          setError(
            userFacingError(
              requestError,
              "We couldn't load a Space right now.",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [navigate, section]);
  if (error)
    return (
      <section role="alert" className="space-y-3">
        <h1 className="text-3xl font-semibold text-white">Space unavailable</h1>
        <p className="rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-red-200">
          {error}
        </p>
      </section>
    );
  return (
    <p aria-live="polite" className="text-slate-400">
      Opening Space…
    </p>
  );
}

function SpaceSettingsRedirect() {
  const { spaceId } = useParams<{ spaceId: string }>();
  return (
    <Navigate
      to={spaceId ? spaceUrl(spaceId) : "/spaces"}
      replace
    />
  );
}

function AppRoutes() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/spaces" replace />} />
          <Route path="/start" element={<Navigate to="/spaces" replace />} />
          <Route
            path="/dashboard"
            element={<Navigate to="/spaces" replace />}
          />

          <Route path="/spaces" element={<Spaces />} />
          <Route path="/spaces/new" element={<SpaceForm />} />
          <Route path="/spaces/:spaceId" element={<SpaceOverview />} />
          <Route path="/spaces/:spaceId/overview" element={<SpaceOverview />} />
          <Route path="/spaces/:spaceId/holdings" element={<SpaceHoldings />} />
          <Route path="/spaces/:spaceId/activity" element={<SpaceActivity />} />
          <Route
            path="/spaces/:spaceId/settings"
            element={<SpaceSettingsRedirect />}
          />

          <Route path="/trade" element={<Trade />} />
          <Route path="/trade/:spaceId" element={<Trade />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/activity" element={<History />} />
          <Route path="/about" element={<Status />} />

          {/* Legacy URLs remain valid but immediately hand off to canonical concepts. */}
          <Route path="/swap" element={<Navigate to="/trade" replace />} />
          <Route
            path="/history"
            element={<Navigate to="/activity" replace />}
          />
          <Route
            path="/executions"
            element={<Navigate to="/activity" replace />}
          />
          <Route
            path="/portfolio"
            element={<Navigate to="/spaces" replace />}
          />
          <Route
            path="/liquidity"
            element={<Navigate to="/spaces" replace />}
          />
          <Route
            path="/holdings"
            element={<LegacySpaceRedirect section="holdings" />}
          />
          <Route
            path="/positions"
            element={<LegacySpaceRedirect section="holdings" />}
          />
          <Route
            path="/protections"
            element={<LegacySpaceRedirect section="settings" />}
          />
          <Route
            path="/risk"
            element={<LegacySpaceRedirect section="settings" />}
          />
          <Route
            path="/status"
            element={<LegacySpaceRedirect section="settings" />}
          />
          <Route path="*" element={<Navigate to="/spaces" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

function App() {
  return (
    <WalletProvider>
      <AppRoutes />
    </WalletProvider>
  );
}

export default App;
