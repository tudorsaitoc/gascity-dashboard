import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AgentsPage } from './routes/Agents';
import { AgentDetailPage } from './routes/AgentDetail';
import { BeadsPage } from './routes/Beads';
import { MailPage } from './routes/Mail';
import { ActivityPage } from './routes/Activity';
import { HealthPage } from './routes/Health';
import { FormulaRunDetailPage } from './routes/FormulaRunDetail';
import { RunsPage } from './routes/Runs';
import { MaintainerPage } from './routes/Maintainer';
import { ViewingAsProvider } from './contexts/ViewingAsContext';

export function App() {
  return (
    <ViewingAsProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/agents" replace />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:slug" element={<AgentDetailPage />} />
          <Route path="/beads" element={<BeadsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:runId" element={<FormulaRunDetailPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/maintainer" element={<MaintainerPage />} />
        </Routes>
      </Layout>
    </ViewingAsProvider>
  );
}
