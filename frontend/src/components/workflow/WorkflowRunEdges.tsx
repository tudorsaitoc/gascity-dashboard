import type { WorkflowDisplayEdge } from 'gas-city-dashboard-shared';

interface WorkflowRunEdgesProps {
  edges: WorkflowDisplayEdge[];
}

export function WorkflowRunEdges({ edges }: WorkflowRunEdgesProps) {
  if (edges.length === 0) return null;
  return (
    <p className="text-label uppercase tracking-wider text-fg-faint tnum">
      {edges.length} dependency edge{edges.length === 1 ? '' : 's'}
    </p>
  );
}
