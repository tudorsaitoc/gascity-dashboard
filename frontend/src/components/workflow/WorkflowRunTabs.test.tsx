import { cleanup, render, screen } from '@testing-library/react';
import type { WorkflowDiffResponse, WorkflowDisplayNode } from 'gas-city-dashboard-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowRunTabs } from './WorkflowRunTabs';

afterEach(() => cleanup());

describe('WorkflowRunTabs', () => {
  it('keeps the Session tab available so selected nodes can explain unresolved sessions', () => {
    render(<WorkflowRunTabs diff={emptyDiff()} selectedNode={nodeWithoutSession()} />);

    const sessionTab = screen.getByRole('tab', { name: 'Session' });
    expect(sessionTab.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Session unresolved for the current running node.')).toBeTruthy();
  });

  it('keeps Session available before selection so the panel can prompt for a node', () => {
    render(<WorkflowRunTabs diff={emptyDiff()} selectedNode={null} />);

    const sessionTab = screen.getByRole('tab', { name: 'Session' });
    expect(sessionTab.hasAttribute('disabled')).toBe(false);
  });
});

function nodeWithoutSession(): WorkflowDisplayNode {
  return {
    id: 'review',
    semanticNodeId: 'review',
    title: 'Review',
    kind: 'step',
    constructKind: 'step',
    status: 'active',
    currentBeadId: 'review',
    scope: { kind: 'workflow' },
    visibleInGraph: true,
    historicalOnly: false,
    iterationSummary: { kind: 'single' },
    attemptSummary: { kind: 'none' },
    visibleExecutionInstanceId: 'review',
    executionInstances: [
      {
        id: 'review',
        semanticNodeId: 'review',
        beadId: 'review',
        iteration: { kind: 'base' },
        attempt: { kind: 'untracked' },
        label: 'base',
        status: 'active',
        session: { kind: 'none', reason: 'session_unresolved' },
        currentIteration: true,
        historical: false,
      },
    ],
    controlBadges: [],
  };
}

function emptyDiff(): WorkflowDiffResponse {
  return {
    kind: 'ok',
    rootPath: { kind: 'known', path: '/tmp/run' },
    status: [],
    changedFiles: [],
    unstagedDiff: '',
    stagedDiff: '',
    truncated: false,
  };
}
