import type {
  WorkflowDiffResponse,
  WorkflowRunDetail,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { errorMessage } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { reportClientError } from '../lib/clientErrorReporting';
import { useCachedData } from './useCachedData';

interface WorkflowRunDetailState {
  kind: 'idle' | 'loading' | 'ready' | 'failed';
  refresh: () => Promise<void>;
}

type WorkflowRunRefreshState =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'failed'; error: string };

type WorkflowRunDetailPayload =
  | { kind: 'unrequested' }
  | {
      kind: 'loaded';
      detail: WorkflowRunDetail;
      diff: WorkflowDiffResponse;
    };

export type WorkflowRunDetailLoadState =
  | (WorkflowRunDetailState & { kind: 'idle' })
  | (WorkflowRunDetailState & { kind: 'loading' })
  | (WorkflowRunDetailState & {
      kind: 'ready';
      detail: WorkflowRunDetail;
      diff: WorkflowDiffResponse;
      refreshState: WorkflowRunRefreshState;
    })
  | (WorkflowRunDetailState & { kind: 'failed'; error: string });

export function useWorkflowRunDetail(
  workflowId: string | undefined,
  scopeKind?: WorkflowScopeKind,
  scopeRef?: string,
): WorkflowRunDetailLoadState {
  const key = workflowRunDetailCacheKey(workflowId, scopeKind, scopeRef);
  const { data, loading, error, refresh } = useCachedData(
    key,
    () => loadWorkflowRunDetail(workflowId, scopeKind, scopeRef),
    {
      onError: (err) => {
        if (workflowId !== undefined) reportWorkflowDetailError('load detail', workflowId, err);
      },
    },
  );

  if (workflowId === undefined) return { kind: 'idle', refresh: noopRefresh };
  if (data?.kind === 'loaded') {
    return {
      kind: 'ready',
      detail: data.detail,
      diff: data.diff,
      refresh,
      refreshState: refreshState(loading, error),
    };
  }
  if (error !== null) return { kind: 'failed', error, refresh };
  return { kind: 'loading', refresh };
}

async function loadWorkflowRunDetail(
  workflowId: string | undefined,
  scopeKind?: WorkflowScopeKind,
  scopeRef?: string,
): Promise<WorkflowRunDetailPayload> {
  if (!workflowId) return { kind: 'unrequested' };
  const params: { scopeKind?: WorkflowScopeKind; scopeRef?: string } = {};
  if (scopeKind !== undefined) params.scopeKind = scopeKind;
  if (scopeRef !== undefined) params.scopeRef = scopeRef;
  const [detail, diff] = await Promise.all([
    api.workflowRun(workflowId, params),
    api.workflowDiff(workflowId, params).catch((err: unknown) => {
      reportWorkflowDetailError('load diff', workflowId, err);
      return {
        kind: 'error',
        rootPath: { kind: 'unavailable', reason: 'error' },
        status: [],
        changedFiles: [],
        unstagedDiff: '',
        stagedDiff: '',
        truncated: false,
        error: errorMessage(err) || 'Failed to load diff.',
      } satisfies WorkflowDiffResponse;
    }),
  ]);
  return { kind: 'loaded', detail, diff };
}

async function noopRefresh(): Promise<void> {}

function refreshState(
  loading: boolean,
  error: string | null,
): WorkflowRunRefreshState {
  if (error !== null) return { kind: 'failed', error };
  return loading ? { kind: 'refreshing' } : { kind: 'idle' };
}

function reportWorkflowDetailError(
  operation: string,
  workflowId: string,
  err: unknown,
): void {
  void reportClientError({
    component: 'workflow-run-detail',
    operation,
    message: `${workflowId}: ${errorMessage(err)}`,
  });
}

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
