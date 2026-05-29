import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkflowDisplayNode, WorkflowDiffResponse } from 'gas-city-dashboard-shared';
import { WorkflowNodeEvidencePanel } from './WorkflowNodeEvidencePanel';

interface WorkflowRunTabsProps {
  diff: WorkflowDiffResponse;
  selectedNode: WorkflowDisplayNode | null;
}

export function WorkflowRunTabs({ diff, selectedNode }: WorkflowRunTabsProps) {
  const [tab, setTab] = useState<'diff' | 'session'>('diff');
  const activeTabId = `workflow-evidence-tab-${tab}`;

  useEffect(() => {
    if (selectedNode) setTab('session');
  }, [selectedNode]);

  return (
    <section aria-label="Workflow evidence">
      <div className="flex items-baseline gap-2 text-label" role="tablist" aria-label="Workflow evidence views">
        <TabButton
          id="workflow-evidence-tab-diff"
          controls="workflow-evidence-panel"
          active={tab === 'diff'}
          onClick={() => setTab('diff')}
        >
          Diff
        </TabButton>
        <span aria-hidden className="text-fg-faint">
          ·
        </span>
        <TabButton
          id="workflow-evidence-tab-session"
          controls="workflow-evidence-panel"
          active={tab === 'session'}
          onClick={() => setTab('session')}
        >
          Session
        </TabButton>
      </div>
      <div
        id="workflow-evidence-panel"
        role="tabpanel"
        aria-labelledby={activeTabId}
        className="pt-5"
      >
        <WorkflowNodeEvidencePanel tab={tab} diff={diff} selectedNode={selectedNode} />
      </div>
    </section>
  );
}

function TabButton({
  id,
  controls,
  active,
  disabled = false,
  onClick,
  children,
}: {
  id: string;
  controls: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={`focus-mark rounded-sm px-0.5 uppercase tracking-wider ${
        disabled
          ? 'cursor-not-allowed text-fg-faint'
          : active
            ? 'text-fg font-semibold underline decoration-fg underline-offset-4'
            : 'text-fg-muted hover:text-fg'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
