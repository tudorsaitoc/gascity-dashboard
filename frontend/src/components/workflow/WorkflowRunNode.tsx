import type { WorkflowDisplayNode, WorkflowNodeStatus } from 'gas-city-dashboard-shared';

interface WorkflowRunNodeProps {
  node: WorkflowDisplayNode;
  selected: boolean;
  onToggle: (nodeId: string) => void;
}

const STATUS_LABEL: Record<WorkflowNodeStatus, string> = {
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  active: 'running',
  done: 'done',
  completed: 'done',
  failed: 'failed',
  blocked: 'blocked',
  skipped: 'skipped',
};

export function WorkflowRunNode({ node, selected, onToggle }: WorkflowRunNodeProps) {
  const shapeClass = shapeClassFor(node);
  const statusClass = statusClassFor(node.status);
  const history = node.hasHistoricalIterations && node.visibleIteration !== undefined
    ? `${node.iterationCount ?? 1} iterations, showing ${node.visibleIteration}`
    : null;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onToggle(node.id)}
      className={`focus-mark w-full text-left px-4 py-3 bg-transparent transition-colors duration-150 ease-out-quart ${shapeClass} ${
        selected
          ? 'text-fg border-accent bg-surface-tint'
          : 'text-fg border-rule hover:border-fg-faint hover:bg-surface-tint'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-body text-fg leading-snug">{node.title}</p>
          <p className="mt-1 text-label uppercase tracking-wider text-fg-faint">
            {node.constructKind.replace(/-/g, ' ')}
            {node.attemptBadge ? ` · attempt ${node.attemptBadge}` : ''}
          </p>
        </div>
        <span className={`text-label uppercase tracking-wider shrink-0 ${statusClass}`}>
          {statusGlyph(node.status)} {STATUS_LABEL[node.status]}
        </span>
      </div>
      {selected && (
        <p className="mt-2 text-label uppercase tracking-wider text-accent">
          selected
        </p>
      )}
      {history && (
        <p className="mt-2 text-label uppercase tracking-wider text-fg-faint tnum">
          stacked history: {history}
        </p>
      )}
      {node.controlBadges && node.controlBadges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {node.controlBadges.map((badge) => (
            <span
              key={badge.id}
              className="text-label uppercase tracking-wider text-fg-muted border border-rule px-1.5 py-0.5"
            >
              {badge.label}: {STATUS_LABEL[badge.status]}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function shapeClassFor(node: WorkflowDisplayNode): string {
  switch (node.constructKind) {
    case 'workflow-root':
      return 'rounded-[3px] border-2';
    case 'retry':
      return 'rounded-full border-2 border-double';
    case 'check-loop':
      return 'rounded-l-full rounded-r-[4px] border-2 border-double';
    case 'scope':
      return 'rounded-md border border-dashed';
    case 'condition':
      return 'rounded-[18px_4px] border border-dashed';
    case 'fanout':
    case 'expansion':
      return 'rounded-md border border-dashed';
    default:
      return 'rounded-[3px] border';
  }
}

function statusClassFor(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'failed':
    case 'blocked':
      return 'text-accent';
    case 'active':
    case 'running':
    case 'ready':
      return 'text-fg';
    case 'completed':
    case 'done':
      return 'text-fg-muted';
    default:
      return 'text-fg-faint';
  }
}

function statusGlyph(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'completed':
    case 'done':
      return '✓';
    case 'active':
    case 'running':
      return '●';
    case 'failed':
    case 'blocked':
      return '!';
    case 'skipped':
      return '∅';
    default:
      return '·';
  }
}
