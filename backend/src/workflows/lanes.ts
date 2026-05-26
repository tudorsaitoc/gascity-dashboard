import type {
  WorkflowDisplayLane,
  WorkflowDisplayNode,
} from 'gas-city-dashboard-shared';

const WORKFLOW_SCOPE = '__workflow';

export function buildWorkflowDisplayLanes(
  nodes: WorkflowDisplayNode[],
): WorkflowDisplayLane[] {
  const byScope = new Map<string, WorkflowDisplayLane>();
  for (const node of nodes) {
    const scope = node.scopeRef ?? WORKFLOW_SCOPE;
    const existing =
      byScope.get(scope) ??
      {
        id: scope,
        label: scope === WORKFLOW_SCOPE ? 'Workflow' : scope,
        nodeIds: [],
      };
    existing.nodeIds.push(node.id);
    byScope.set(scope, existing);
  }
  return [...byScope.values()];
}
