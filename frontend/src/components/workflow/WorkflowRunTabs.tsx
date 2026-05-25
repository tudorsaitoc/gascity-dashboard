import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkflowDisplayNode, WorkflowDiffResponse } from 'gas-city-dashboard-shared';
import { WorkflowNodeEvidencePanel } from './WorkflowNodeEvidencePanel';

interface WorkflowRunTabsProps {
  diff: WorkflowDiffResponse | null;
  selectedNode: WorkflowDisplayNode | null;
}

export function WorkflowRunTabs({ diff, selectedNode }: WorkflowRunTabsProps) {
  const [tab, setTab] = useState<'diff' | 'session'>('diff');

  useEffect(() => {
    if (selectedNode) setTab('session');
  }, [selectedNode]);

  return (
    <section aria-label="Workflow evidence">
      <div className="flex items-baseline gap-2 text-label" role="tablist" aria-label="Workflow evidence views">
        <TabButton active={tab === 'diff'} onClick={() => setTab('diff')}>
          Diff
        </TabButton>
        <span aria-hidden className="text-fg-faint">
          ·
        </span>
        <TabButton active={tab === 'session'} onClick={() => setTab('session')}>
          Session
        </TabButton>
      </div>
      <div className="pt-5">
        <WorkflowNodeEvidencePanel tab={tab} diff={diff} selectedNode={selectedNode} />
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`focus-mark rounded-sm px-0.5 uppercase tracking-wider ${
        active
          ? 'text-fg font-semibold underline decoration-fg underline-offset-4'
          : 'text-fg-muted hover:text-fg'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
