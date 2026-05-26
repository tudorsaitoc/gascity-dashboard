import type { WorkflowDisplayNode, WorkflowRunDetail } from 'gas-city-dashboard-shared';
import { WorkflowRunEdges } from './WorkflowRunEdges';
import { WorkflowRunNode } from './WorkflowRunNode';

interface WorkflowRunDiagramProps {
  detail: WorkflowRunDetail;
  selectedNodeId: string | null;
  onToggleNode: (nodeId: string) => void;
}

export function WorkflowRunDiagram({
  detail,
  selectedNodeId,
  onToggleNode,
}: WorkflowRunDiagramProps) {
  const nodes = orderedNodes(detail);

  if (nodes.length === 0) {
    return <p className="text-body text-fg-muted italic">No graph nodes have materialized for this run.</p>;
  }

  return (
    <section aria-label="Workflow graph">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-title text-fg">Formula Graph</h2>
        <WorkflowRunEdges edges={detail.edges} />
      </div>
      <ol className="mt-5 space-y-3 relative">
        {nodes.map((node, index) => (
          <li key={node.id} className="relative pl-6">
            {index < nodes.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute left-2 top-10 bottom-[-0.75rem] border-l border-rule"
              />
            )}
            <span
              aria-hidden="true"
              className="absolute left-[0.3125rem] top-7 h-2 w-2 rounded-full bg-fg-faint"
            />
            <WorkflowRunNode
              node={node}
              selected={selectedNodeId === node.id}
              onToggle={onToggleNode}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function orderedNodes(detail: WorkflowRunDetail): WorkflowDisplayNode[] {
  return detail.nodes.filter((node) => node.visibleInGraph !== false);
}
