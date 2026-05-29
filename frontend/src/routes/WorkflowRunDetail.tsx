import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { GC_EVENT_PREFIX, SCOPE_REF_RE } from 'gas-city-dashboard-shared';
import type {
  WorkflowRunDetail as WorkflowRunDetailData,
  WorkflowRunProgress,
  WorkflowNodeStatus,
  WorkflowRunPartialReason,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { RelatedEntities } from '../components/RelatedEntities';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { WorkflowRunDiagram } from '../components/workflow/WorkflowRunDiagram';
import { WorkflowRunTabs } from '../components/workflow/WorkflowRunTabs';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useWorkflowNodeSelection } from '../hooks/useWorkflowNodeSelection';
import { useWorkflowRunDetail } from '../hooks/useWorkflowRunDetail';
import { useEntityLinks } from '../hooks/useEntityLinks';

const WORKFLOW_DETAIL_EVENT_PREFIXES = [
  GC_EVENT_PREFIX.bead,
  GC_EVENT_PREFIX.session,
] as const;
const NO_EVENT_PREFIXES: readonly string[] = [];

export function WorkflowRunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [search] = useSearchParams();
  const parsedScope = parseScope(search);
  const scope = parsedScope.ok ? parsedScope.scope : undefined;
  const routeError = parsedScope.ok ? null : parsedScope.error;
  const initialNodeId = search.get('node');
  const routeSelectionKey = [
    workflowId ?? '',
    scope?.scopeKind ?? '',
    scope?.scopeRef ?? '',
    initialNodeId ?? '',
  ].join('\u0000');
  const runDetail = useWorkflowRunDetail(
    routeError ? undefined : workflowId,
    scope?.scopeKind,
    scope?.scopeRef,
  );
  const readyRun = runDetail.kind === 'ready' ? runDetail : null;
  const detail = readyRun?.detail ?? null;
  const loading =
    runDetail.kind === 'loading' ||
    (readyRun !== null && readyRun.refreshState.kind === 'refreshing');
  const loadError =
    runDetail.kind === 'failed'
      ? runDetail.error
      : readyRun !== null && readyRun.refreshState.kind === 'failed'
        ? readyRun.refreshState.error
        : null;
  useGcEventRefresh(
    routeError ? NO_EVENT_PREFIXES : WORKFLOW_DETAIL_EVENT_PREFIXES,
    () => void runDetail.refresh(),
  );
  const pageError = routeError ?? loadError;
  const { selectedNodeId, selectedNode, toggleNode } = useWorkflowNodeSelection(
    detail,
    initialNodeId,
    routeSelectionKey,
  );

  // Related entities (gascity-dashboard-j4x). Focus on the run's root
  // bead so the index surfaces the molecule members, sessions, and the
  // PR/issue this run is adopting.
  const links = useEntityLinks(detail?.rootBeadId ?? null);
  const [viewingBeadId, setViewingBeadId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    return () => clearInterval(tick);
  }, []);

  const synopsis = detail
    ? `${detail.progress.visibleNodeCount} nodes, ${detail.progress.edgeCount} edges. ${summarizeNodeStatuses(detail.progress)}. Current working tree diff is shown for the run execution folder.`
    : loading && !routeError
      ? 'Loading workflow run.'
      : 'Workflow run unavailable.';

  return (
    <section>
      <PageHeader
        title={detail?.title ?? 'Workflow Run'}
        synopsis={synopsis}
        meta={
          <>
            <Link
              to="/workflows"
              className="focus-mark text-label uppercase tracking-wider text-fg-muted hover:text-fg"
            >
              Workflows
            </Link>
            {pageError && detail && (
              <span
                className="normal-case text-body text-accent"
                role="alert"
              >
                {pageError}
              </span>
            )}
            {detail && (
              <span className="text-label uppercase tracking-wider text-fg-faint tnum">
                {snapshotLabel(detail)}
              </span>
            )}
            <Button size="sm" onClick={() => void runDetail.refresh()} disabled={loading || Boolean(routeError)}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {loading && !routeError && !detail ? (
        <p className="text-body text-fg-muted italic">Loading workflow run.</p>
      ) : pageError && !detail ? (
        <p className="text-body text-accent" role="alert">{pageError}</p>
      ) : readyRun ? (
        <>
          <RunMetadata detail={readyRun.detail} />
          {readyRun.detail.completeness.kind === 'partial' && (
            <p className="mt-5 text-label uppercase tracking-wider text-warn" role="status">
              Partial workflow data: {partialReasonsLabel(readyRun.detail.completeness.reasons)}.
            </p>
          )}
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(22rem,1.05fr)]">
            <WorkflowRunDiagram
              detail={readyRun.detail}
              selectedNodeId={selectedNodeId}
              onToggleNode={toggleNode}
            />
            <WorkflowRunTabs diff={readyRun.diff} selectedNode={selectedNode} />
          </div>
          <RelatedEntities
            view={links.view}
            loading={links.loading}
            error={links.error}
            now={now}
            onOpenBead={setViewingBeadId}
          />
          <BeadDetailModal
            open={viewingBeadId !== null}
            onClose={() => setViewingBeadId(null)}
            beadId={viewingBeadId}
            onOpenBead={setViewingBeadId}
          />
        </>
      ) : null}
    </section>
  );
}

function RunMetadata({
  detail,
}: {
  detail: WorkflowRunDetailData;
}) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      <Meta label="Formula" value={formulaLabel(detail.formula)} />
      <Meta label="Root" value={detail.rootBeadId} />
      <Meta label="Scope" value={`${detail.scopeKind}:${detail.scopeRef}`} />
      <Meta label="Store" value={detail.resolvedRootStore || detail.rootStoreRef || 'unknown'} />
    </dl>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-label uppercase tracking-wider text-fg-faint">{label}</dt>
      <dd className="text-body text-fg break-all tnum">{value}</dd>
    </div>
  );
}

function snapshotLabel(
  detail: WorkflowRunDetailData,
): string {
  return detail.snapshotEventSeq.kind === 'known'
    ? `v${detail.snapshotVersion} · seq ${detail.snapshotEventSeq.seq}`
    : `v${detail.snapshotVersion}`;
}

function formulaLabel(formula: WorkflowRunDetailData['formula']): string {
  return formula.kind === 'known' ? formula.name : `unavailable (${formula.reason})`;
}

function partialReasonsLabel(reasons: readonly WorkflowRunPartialReason[]): string {
  return reasons.map(partialReasonLabel).join(', ');
}

function partialReasonLabel(reason: WorkflowRunPartialReason): string {
  switch (reason) {
    case 'supervisor_snapshot_partial':
      return 'supervisor snapshot is partial';
    case 'runtime_bead_read_failed':
      return 'runtime bead refresh failed';
    case 'session_list_failed':
      return 'session list failed';
    case 'formula_detail_unavailable':
      return 'formula detail is unavailable';
  }
}

type ScopeParseResult =
  | { ok: true; scope?: { scopeKind: WorkflowScopeKind; scopeRef: string } }
  | { ok: false; error: string };

function parseScope(search: URLSearchParams): ScopeParseResult {
  const rawKinds = search.getAll('scope_kind');
  const rawRefs = search.getAll('scope_ref');
  if (rawKinds.length > 1 || rawRefs.length > 1) {
    return { ok: false, error: 'Invalid workflow scope query.' };
  }

  const rawKind = rawKinds[0];
  const rawRef = rawRefs[0];
  if (rawKind === undefined && rawRef === undefined) return { ok: true };

  // Reject a half-specified scope (one of kind/ref present) rather than
  // silently dropping it — the backend rejects the same input as a 400, so
  // failing closed here keeps a truncated deep link from loading the WRONG
  // (default city) run instead of erroring.
  if (rawKind === undefined || rawRef === undefined) {
    return { ok: false, error: 'Invalid workflow scope query.' };
  }

  if (rawKind !== 'city' && rawKind !== 'rig') {
    return { ok: false, error: 'Invalid workflow scope query.' };
  }
  if (!SCOPE_REF_RE.test(rawRef)) {
    return { ok: false, error: 'Invalid workflow scope query.' };
  }

  return { ok: true, scope: { scopeKind: rawKind, scopeRef: rawRef } };
}

function summarizeNodeStatuses(progress: WorkflowRunProgress): string {
  const parts = [
    statusSummaryPart(progress, ['active', 'running'], 'running'),
    statusSummaryPart(progress, ['completed', 'done'], 'done'),
    statusSummaryPart(progress, 'ready', 'ready'),
    statusSummaryPart(progress, 'blocked', 'blocked'),
    statusSummaryPart(progress, 'failed', 'failed'),
    statusSummaryPart(progress, 'skipped', 'skipped'),
    statusSummaryPart(progress, 'pending', 'pending'),
  ]
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : 'No node status yet';
}

function statusSummaryPart(
  progress: WorkflowRunProgress,
  statuses: WorkflowNodeStatus | readonly WorkflowNodeStatus[],
  label: string,
): string | null {
  const keys: readonly WorkflowNodeStatus[] =
    typeof statuses === 'string' ? [statuses] : statuses;
  const count = keys.reduce((sum, status) => sum + (progress.statusCounts[status] ?? 0), 0);
  return count > 0 ? `${count} ${label}` : null;
}
