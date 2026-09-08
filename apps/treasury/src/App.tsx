import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Positions from "./pages/Positions";
import RiskManagement from "./pages/RiskManagement";
import Executions from "./pages/Executions";
import Status from "./pages/Status";

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/start" element={<Dashboard />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/holdings" element={<Positions />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/protections" element={<RiskManagement />} />
          <Route path="/risk" element={<RiskManagement />} />
          <Route path="/activity" element={<Executions />} />
          <Route path="/executions" element={<Executions />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
