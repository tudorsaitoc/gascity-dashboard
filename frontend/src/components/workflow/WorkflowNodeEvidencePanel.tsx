import type { WorkflowDisplayNode, WorkflowDiffResponse } from 'gas-city-dashboard-shared';
import { WorkflowDiffPanel } from './WorkflowDiffPanel';
import { WorkflowNodeSessionPanel } from './WorkflowNodeSessionPanel';

interface WorkflowNodeEvidencePanelProps {
  tab: 'diff' | 'session';
  diff: WorkflowDiffResponse;
  selectedNode: WorkflowDisplayNode | null;
}

export function WorkflowNodeEvidencePanel({
  tab,
  diff,
  selectedNode,
}: WorkflowNodeEvidencePanelProps) {
  if (tab === 'session') {
    return <WorkflowNodeSessionPanel node={selectedNode} visible />;
  }
  return <WorkflowDiffPanel diff={diff} />;
}
