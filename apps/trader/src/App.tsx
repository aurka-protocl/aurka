import ForkSpace from "./pages/ForkSpace";
import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Trade from "./pages/Trade";
import Portfolio from "./pages/Portfolio";
import History from "./pages/History";
import Status from "./pages/Status";

function App() {
  if (import.meta.env.VITE_AURKA_MODE === "fork")
    return (
      <main className="min-h-screen bg-slate-950 p-4 sm:p-8">
        <ForkSpace />
      </main>
    );
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/start" element={<Dashboard />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/swap" element={<Trade />} />
          <Route path="/trade" element={<Trade advanced />} />
          <Route path="/liquidity" element={<Portfolio />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/activity" element={<History />} />
          <Route path="/history" element={<History />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
