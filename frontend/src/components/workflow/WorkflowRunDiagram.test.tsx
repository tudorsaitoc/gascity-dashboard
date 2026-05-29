import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunDetail } from 'gas-city-dashboard-shared';
import { WorkflowRunDiagram } from './WorkflowRunDiagram';

afterEach(() => cleanup());

describe('WorkflowRunDiagram', () => {
  it('keeps the supervisor node order even when lanes group later nodes together', () => {
    render(
      <WorkflowRunDiagram
        detail={detailWithInterleavedLaneNodes()}
        selectedNodeId={null}
        onToggleNode={vi.fn()}
      />,
    );

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');

    expect(labels[0]).toContain('Root');
    expect(labels[1]).toContain('Rig A setup');
    expect(labels[2]).toContain('Rig B review');
    expect(labels[3]).toContain('Rig A finalize');
  });

  it('omits historical-only loop nodes from the left graph', () => {
    render(
      <WorkflowRunDiagram
        detail={detailWithHistoricalOnlyNode()}
        selectedNodeId={null}
        onToggleNode={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /old-only review/i })).toBeNull();
    expect(screen.getByRole('button', { name: /current review/i })).toBeTruthy();
  });
});

function detailWithInterleavedLaneNodes(): WorkflowRunDetail {
  return {
    workflowId: 'gc-root',
    rootBeadId: 'gc-root',
    rootStoreRef: 'city:racoon-city',
    resolvedRootStore: 'city:racoon-city',
    scopeKind: 'city',
    scopeRef: 'racoon-city',
    title: 'Interleaved workflow',
    formula: { kind: 'known', name: 'mol-test' },
    executionPath: { kind: 'unavailable', reason: 'missing_cwd_and_rig_root' },
    snapshotVersion: 1,
    snapshotEventSeq: { kind: 'known', seq: 1 },
    completeness: { kind: 'complete' },
    progress: progress(4, 4, { ready: 4 }),
    nodes: [
      node('root', 'Root'),
      node('rig-a-setup', 'Rig A setup', 'rig-a'),
      node('rig-b-review', 'Rig B review', 'rig-b'),
      node('rig-a-finalize', 'Rig A finalize', 'rig-a'),
    ],
    edges: [],
    lanes: [
      { id: '__workflow', label: 'Workflow', nodeIds: ['root'] },
      { id: 'rig-a', label: 'rig-a', nodeIds: ['rig-a-setup', 'rig-a-finalize'] },
      { id: 'rig-b', label: 'rig-b', nodeIds: ['rig-b-review'] },
    ],
  };
}

function detailWithHistoricalOnlyNode(): WorkflowRunDetail {
  return {
    workflowId: 'gc-root',
    rootBeadId: 'gc-root',
    rootStoreRef: 'city:racoon-city',
    resolvedRootStore: 'city:racoon-city',
    scopeKind: 'city',
    scopeRef: 'racoon-city',
    title: 'Historical loop workflow',
    formula: { kind: 'known', name: 'mol-test' },
    executionPath: { kind: 'unavailable', reason: 'missing_cwd_and_rig_root' },
    snapshotVersion: 1,
    snapshotEventSeq: { kind: 'known', seq: 1 },
    completeness: { kind: 'complete' },
    progress: progress(2, 1, { active: 1 }, { active: 1, completed: 1 }, 2),
    nodes: [
      {
        id: 'old-only-review',
        semanticNodeId: 'old-only-review',
        title: 'Old-only review',
        kind: 'task',
        constructKind: 'step',
        status: 'completed',
        currentBeadId: 'gc-old-only-review-i1',
        scope: { kind: 'workflow' },
        historicalOnly: true,
        visibleInGraph: false,
        iterationSummary: {
          kind: 'stacked',
          visibleIteration: 1,
          iterationCount: 2,
          control: { kind: 'unknown' },
        },
        attemptSummary: { kind: 'none' },
        visibleExecutionInstanceId: 'gc-old-only-review-i1',
        executionInstances: [
          {
            id: 'gc-old-only-review-i1',
            semanticNodeId: 'old-only-review',
            beadId: 'gc-old-only-review-i1',
            iteration: { kind: 'loop', value: 1 },
            attempt: { kind: 'untracked' },
            label: 'iteration 1',
            status: 'completed',
            session: { kind: 'none', reason: 'session_unresolved' },
            historical: true,
            currentIteration: false,
          },
        ],
        controlBadges: [],
      },
      {
        id: 'current-review',
        semanticNodeId: 'current-review',
        title: 'Current review',
        kind: 'task',
        constructKind: 'step',
        status: 'active',
        currentBeadId: 'gc-current-review-i2',
        scope: { kind: 'workflow' },
        historicalOnly: false,
        visibleInGraph: true,
        iterationSummary: {
          kind: 'stacked',
          visibleIteration: 2,
          iterationCount: 2,
          control: { kind: 'unknown' },
        },
        attemptSummary: { kind: 'none' },
        visibleExecutionInstanceId: 'gc-current-review-i2',
        executionInstances: [
          {
            id: 'gc-current-review-i2',
            semanticNodeId: 'current-review',
            beadId: 'gc-current-review-i2',
            iteration: { kind: 'loop', value: 2 },
            attempt: { kind: 'untracked' },
            label: 'iteration 2',
            status: 'active',
            session: { kind: 'none', reason: 'session_unresolved' },
            historical: false,
            currentIteration: true,
          },
        ],
        controlBadges: [],
      },
    ],
    edges: [],
    lanes: [
      {
        id: '__workflow',
        label: 'Workflow',
        nodeIds: ['old-only-review', 'current-review'],
      },
    ],
  };
}

function progress(
  totalNodeCount: number,
  visibleNodeCount: number,
  statusCounts: WorkflowRunDetail['progress']['statusCounts'],
  allStatusCounts = statusCounts,
  executionInstanceCount = totalNodeCount,
): WorkflowRunDetail['progress'] {
  return {
    snapshotVersion: 1,
    snapshotEventSeq: { kind: 'known', seq: 1 },
    snapshotPartial: false,
    totalNodeCount,
    visibleNodeCount,
    edgeCount: 0,
    executionInstanceCount,
    sessionLinkCount: 0,
    streamableSessionCount: 0,
    streamableSessionIds: [],
    statusCounts,
    allStatusCounts,
  };
}

function node(id: string, title: string, scopeRef?: string): WorkflowRunDetail['nodes'][number] {
  const displayNode: WorkflowRunDetail['nodes'][number] = {
    id,
    semanticNodeId: id,
    title,
    kind: 'step',
    constructKind: 'step',
    status: 'ready',
    currentBeadId: id,
    scope: scopeRef === undefined ? { kind: 'workflow' } : { kind: 'scoped', ref: scopeRef },
    visibleInGraph: true,
    historicalOnly: false,
    iterationSummary: { kind: 'single' },
    attemptSummary: { kind: 'none' },
    visibleExecutionInstanceId: id,
    executionInstances: [
      {
        id,
        semanticNodeId: id,
        beadId: id,
        iteration: { kind: 'base' },
        attempt: { kind: 'untracked' },
        label: 'base',
        status: 'ready',
        session: { kind: 'none', reason: 'not_started' },
        currentIteration: true,
        historical: false,
      },
    ],
    controlBadges: [],
  };
  return displayNode;
}
