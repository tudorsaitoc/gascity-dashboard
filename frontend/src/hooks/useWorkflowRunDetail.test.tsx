import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { WorkflowRunDetail } from 'gas-city-dashboard-shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { invalidate } from '../api/cache';
import { api } from '../api/client';
import { reportClientError } from '../lib/clientErrorReporting';
import { useWorkflowRunDetail } from './useWorkflowRunDetail';

vi.mock('../api/client', () => ({
  api: {
    workflowRun: vi.fn(),
    workflowDiff: vi.fn(),
  },
}));

vi.mock('../lib/clientErrorReporting', () => ({
  reportClientError: vi.fn(() => Promise.resolve({ status: 'reported' })),
}));

const mockWorkflowRun = api.workflowRun as Mock;
const mockWorkflowDiff = api.workflowDiff as Mock;
const mockReportClientError = reportClientError as Mock;

afterEach(() => {
  cleanup();
  invalidate('');
  vi.clearAllMocks();
});

describe('useWorkflowRunDetail', () => {
  it('does not fetch or report when no workflow id is available', async () => {
    const { result } = renderHook(() => useWorkflowRunDetail(undefined));

    await waitFor(() => expect(result.current.kind).toBe('idle'));

    expect(mockWorkflowRun).not.toHaveBeenCalled();
    expect(mockWorkflowDiff).not.toHaveBeenCalled();
    expect(mockReportClientError).not.toHaveBeenCalled();
  });

  it('reports workflow detail load failures to the centralized client log', async () => {
    mockWorkflowRun.mockRejectedValue(new Error('detail unavailable'));
    mockWorkflowDiff.mockResolvedValue({ kind: 'ok' });

    const { result } = renderHook(() => useWorkflowRunDetail('wf-1'));

    await waitFor(() => expect(result.current).toMatchObject({
      kind: 'failed',
      error: 'detail unavailable',
    }));

    expect(mockReportClientError).toHaveBeenCalledWith({
      component: 'workflow-run-detail',
      operation: 'load detail',
      message: 'wf-1: detail unavailable',
    });
  });

  it('keeps the detail visible and reports diff load failures', async () => {
    mockWorkflowRun.mockResolvedValue(detail());
    mockWorkflowDiff.mockRejectedValue(new Error('git unavailable'));

    const { result } = renderHook(() => useWorkflowRunDetail('wf-1'));

    await waitFor(() => expect(result.current.kind).toBe('ready'));

    if (result.current.kind !== 'ready') throw new Error('workflow detail did not load');
    expect(result.current.detail.workflowId).toBe('wf-1');
    expect(result.current.refreshState).toEqual({ kind: 'idle' });
    expect(result.current.diff).toMatchObject({ kind: 'error', error: 'git unavailable' });
    expect(mockReportClientError).toHaveBeenCalledWith({
      component: 'workflow-run-detail',
      operation: 'load diff',
      message: 'wf-1: git unavailable',
    });
  });
});

function detail(): WorkflowRunDetail {
  return {
    workflowId: 'wf-1',
    rootBeadId: 'wf-1',
    rootStoreRef: 'city:racoon-city',
    resolvedRootStore: 'city:racoon-city',
    scopeKind: 'city',
    scopeRef: 'racoon-city',
    title: 'Workflow',
    formula: { kind: 'known', name: 'mol-test' },
    executionPath: { kind: 'unavailable', reason: 'missing_cwd_and_rig_root' },
    snapshotVersion: 1,
    snapshotEventSeq: { kind: 'known', seq: 1 },
    completeness: { kind: 'complete' },
    progress: {
      snapshotVersion: 1,
      snapshotEventSeq: { kind: 'known', seq: 1 },
      snapshotPartial: false,
      totalNodeCount: 0,
      visibleNodeCount: 0,
      edgeCount: 0,
      executionInstanceCount: 0,
      sessionLinkCount: 0,
      streamableSessionCount: 0,
      streamableSessionIds: [],
      statusCounts: {},
      allStatusCounts: {},
    },
    nodes: [],
    edges: [],
    lanes: [],
  };
}
