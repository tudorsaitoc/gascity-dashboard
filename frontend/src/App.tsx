import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AgentsPage } from './routes/Agents';
import { AgentDetailPage } from './routes/AgentDetail';
import { BeadsPage } from './routes/Beads';
import { MailPage } from './routes/Mail';
import { ActivityPage } from './routes/Activity';
import { HealthPage } from './routes/Health';
import { WorkflowsPage } from './routes/Workflows';
import { WorkflowRunDetailPage } from './routes/WorkflowRunDetail';
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
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/:workflowId" element={<WorkflowRunDetailPage />} />
          {/* /kanban superseded by /workflows (gascity-dashboard-0t6 + dkb Q3);
              redirect preserved so bookmarks keep working. */}
          <Route
            path="/kanban"
            element={<Navigate to="/workflows" replace />}
          />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/maintainer" element={<MaintainerPage />} />
        </Routes>
      </Layout>
    </ViewingAsProvider>
  );
}
