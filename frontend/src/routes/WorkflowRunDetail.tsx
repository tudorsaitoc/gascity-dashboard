import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { SCOPE_REF_RE } from 'gas-city-dashboard-shared';
import type {
  WorkflowRunDetail as WorkflowRunDetailData,
  WorkflowRunProgress,
  WorkflowNodeStatus,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { RelatedEntities } from '../components/RelatedEntities';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { WorkflowRunDiagram } from '../components/workflow/WorkflowRunDiagram';
import { WorkflowRunTabs } from '../components/workflow/WorkflowRunTabs';
import { useWorkflowNodeSelection } from '../hooks/useWorkflowNodeSelection';
import { useWorkflowRunDetail } from '../hooks/useWorkflowRunDetail';
import { useEntityLinks } from '../hooks/useEntityLinks';

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
  const { detail, diff, loading, error, refresh } = useWorkflowRunDetail(
    routeError ? undefined : workflowId,
    scope?.scopeKind,
    scope?.scopeRef,
  );
  const pageError = routeError ?? error;
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
            <Button size="sm" onClick={() => void refresh()} disabled={loading || Boolean(routeError)}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {loading && !routeError && !detail ? (
        <p className="text-body text-fg-muted italic">Loading workflow run.</p>
      ) : pageError && !detail ? (
        <p className="text-body text-accent" role="alert">{pageError}</p>
      ) : detail ? (
        <>
          <RunMetadata detail={detail} />
          {detail.partial && (
            <p className="mt-5 text-label uppercase tracking-wider text-warn" role="status">
              Partial snapshot. Some workflow nodes or sessions may still be loading from the supervisor.
            </p>
          )}
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(22rem,1.05fr)]">
            <WorkflowRunDiagram
              detail={detail}
              selectedNodeId={selectedNodeId}
              onToggleNode={toggleNode}
            />
            <WorkflowRunTabs diff={diff} selectedNode={selectedNode} />
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
      <FormulaMeta formula={detail.formula} />
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

const TITLE_FALLBACK_TOOLTIP =
  'name inferred from bead title — supervisor did not set gc.formula on this graph.v2 root';

/**
 * Render the formula metadata cell with provenance.
 *
 * gascity-dashboard-e7hj: when the backend resolved the formula name via
 * the gated title fallback (source === 'title_fallback') we surface that
 * in a warn tone with an explanatory aside, matching the Health.tsx
 * "not reported by supervisor" precedent (PR #36). Per DESIGN.md's
 * "States have words" rule the warn tone is paired with a short textual
 * correlate ("inferred from bead title") and the longer explanation
 * lives in the native tooltip so the cell stays legible in greyscale.
 */
function FormulaMeta({ formula }: { formula: WorkflowRunDetailData['formula'] }) {
  if (formula.kind !== 'known') {
    return <Meta label="Formula" value={`unavailable (${formula.reason})`} />;
  }
  switch (formula.source) {
    case 'metadata':
      return <Meta label="Formula" value={formula.name} />;
    case 'title_fallback':
      return (
        <div>
          <dt className="text-label uppercase tracking-wider text-fg-faint">Formula</dt>
          <dd
            className="text-body text-warn break-all tnum"
            title={TITLE_FALLBACK_TOOLTIP}
            aria-label={`${formula.name} (${TITLE_FALLBACK_TOOLTIP})`}
          >
            {formula.name}
            <span className="ml-2 text-label uppercase tracking-wider text-warn">
              inferred from bead title
            </span>
          </dd>
        </div>
      );
    default: {
      // Exhaustiveness: a new WorkflowFormulaSource variant must declare its
      // own render path — falling through to a default warn tone would
      // silently misrepresent its provenance.
      const _exhaustive: never = formula.source;
      return _exhaustive;
    }
  }
}

function snapshotLabel(
  detail: WorkflowRunDetailData,
): string {
  return detail.snapshotEventSeq.kind === 'known'
    ? `v${detail.snapshotVersion} · seq ${detail.snapshotEventSeq.seq}`
    : `v${detail.snapshotVersion}`;
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
