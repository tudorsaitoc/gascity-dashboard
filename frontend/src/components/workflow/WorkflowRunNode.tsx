import type {
  WorkflowConstructKind,
  WorkflowDisplayNode,
  WorkflowNodeStatus,
} from 'gas-city-dashboard-shared';

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
  const shapeClass = shapeClassFor(node.constructKind);
  const statusClass = statusClassFor(node.status);
  const history =
    node.iterationSummary.kind === 'stacked'
      ? `${node.iterationSummary.iterationCount} iterations, showing ${node.iterationSummary.visibleIteration}`
      : null;
  const attemptLabel =
    node.attemptSummary.kind === 'tracked' && node.attemptSummary.badge.kind === 'bounded'
      ? ` · attempt ${node.attemptSummary.badge.label}`
      : '';

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
            {attemptLabel}
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
      {node.controlBadges.length > 0 && (
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

function shapeClassFor(constructKind: WorkflowConstructKind): string {
  switch (constructKind) {
    case 'workflow-root':
      return 'workflow-node-shape-root';
    case 'step':
    case 'unknown':
      return 'workflow-node-shape-step';
    case 'retry':
      return 'workflow-node-shape-retry';
    case 'check-loop':
      return 'workflow-node-shape-check-loop';
    case 'scope':
      return 'workflow-node-shape-scope';
    case 'condition':
      return 'workflow-node-shape-condition';
    case 'fanout':
      return 'workflow-node-shape-fanout';
    case 'expansion':
      return 'workflow-node-shape-expansion';
    case 'scope-check':
    case 'workflow-finalize':
    case 'spec':
    case 'control':
      return 'workflow-node-shape-control';
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
    case 'pending':
    case 'skipped':
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
    case 'pending':
    case 'ready':
      return '·';
  }
}
