import type {
  WorkflowDiffResponse,
  WorkflowRunDetail,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { useCachedData } from './useCachedData';

interface WorkflowRunDetailState {
  detail: WorkflowRunDetail | null;
  diff: WorkflowDiffResponse | null;
  loading: boolean;
  error: string | null;
}

export function useWorkflowRunDetail(
  workflowId: string | undefined,
  scopeKind?: WorkflowScopeKind,
  scopeRef?: string,
): WorkflowRunDetailState & { refresh: () => Promise<void> } {
  const key = workflowRunDetailCacheKey(workflowId, scopeKind, scopeRef);
  const { data, loading, error, refresh } = useCachedData(key, () =>
    loadWorkflowRunDetail(workflowId, scopeKind, scopeRef),
  );

  return {
    detail: workflowId ? data?.detail ?? null : null,
    diff: workflowId ? data?.diff ?? null : null,
    loading: workflowId ? loading : false,
    error: workflowId ? error : null,
    refresh: workflowId ? refresh : noopRefresh,
  };
}

async function loadWorkflowRunDetail(
  workflowId: string | undefined,
  scopeKind?: WorkflowScopeKind,
  scopeRef?: string,
): Promise<Pick<WorkflowRunDetailState, 'detail' | 'diff'>> {
  if (!workflowId) throw new Error('Missing workflow id.');
  const params = { scopeKind, scopeRef };
  const [detail, diff] = await Promise.all([
    api.workflowRun(workflowId, params),
    api.workflowDiff(workflowId, params).catch((err: unknown) => ({
      kind: 'error',
      rootPath: null,
      status: [],
      changedFiles: [],
      unstagedDiff: '',
      stagedDiff: '',
      truncated: false,
      error: err instanceof Error ? err.message : 'Failed to load diff.',
    } satisfies WorkflowDiffResponse)),
  ]);
  return { detail, diff };
}

async function noopRefresh(): Promise<void> {}

function workflowRunDetailCacheKey(
  workflowId: string | undefined,
  scopeKind?: WorkflowScopeKind,
  scopeRef?: string,
): string {
  const parts = [
    'workflow-run',
    workflowId ?? 'missing',
    scopeKind ?? 'default',
    scopeRef ?? 'default',
  ];
  return parts.join(':');
}
