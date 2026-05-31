import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunDisplayNode, RunDiffResponse } from 'gas-city-dashboard-shared';
import { RunNodeEvidencePanel } from './RunNodeEvidencePanel';

interface FormulaRunTabsProps {
  diff: RunDiffResponse;
  selectedNode: RunDisplayNode | null;
}

export function FormulaRunTabs({ diff, selectedNode }: FormulaRunTabsProps) {
  const [tab, setTab] = useState<'diff' | 'session'>('diff');
  const selectedNodeId = selectedNode?.id ?? null;
  const activeTabId = `run-evidence-tab-${tab}`;

  useEffect(() => {
    if (selectedNodeId !== null) setTab('session');
  }, [selectedNodeId]);

  return (
    <section aria-label="Run evidence">
      <div className="flex items-baseline gap-2 text-label" role="tablist" aria-label="Run evidence views">
        <TabButton
          id="run-evidence-tab-diff"
          controls="run-evidence-panel"
          active={tab === 'diff'}
          onClick={() => setTab('diff')}
        >
          Diff
        </TabButton>
        <span aria-hidden className="text-fg-faint">
          ·
        </span>
        <TabButton
          id="run-evidence-tab-session"
          controls="run-evidence-panel"
          active={tab === 'session'}
          onClick={() => setTab('session')}
        >
          Session
        </TabButton>
      </div>
      <div
        id="run-evidence-panel"
        role="tabpanel"
        aria-labelledby={activeTabId}
        className="pt-5"
      >
        <RunNodeEvidencePanel tab={tab} diff={diff} selectedNode={selectedNode} />
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
