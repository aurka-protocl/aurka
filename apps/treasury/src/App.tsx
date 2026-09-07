import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Positions from "./pages/Positions";
import RiskManagement from "./pages/RiskManagement";
import Executions from "./pages/Executions";

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/risk" element={<RiskManagement />} />
          <Route path="/executions" element={<Executions />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
