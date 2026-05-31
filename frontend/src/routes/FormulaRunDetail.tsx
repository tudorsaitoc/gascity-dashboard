import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { GC_EVENT_PREFIX, SCOPE_REF_RE } from 'gas-city-dashboard-shared';
import type {
  FormulaRunDetail as FormulaRunDetailData,
  FormulaRunProgress,
  RunNodeStatus,
  FormulaRunPartialReason,
  RunScopeKind,
} from 'gas-city-dashboard-shared';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { RelatedEntities } from '../components/RelatedEntities';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { FormulaRunDiagram } from '../components/run/FormulaRunDiagram';
import { FormulaRunTabs } from '../components/run/FormulaRunTabs';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import {
  runEventIdentity,
  formulaRunDetailEventMatches,
} from '../hooks/runEventIdentity';
import { useRunNodeSelection } from '../hooks/useRunNodeSelection';
import { useFormulaRunDetail } from '../hooks/useFormulaRunDetail';
import { useEntityLinks } from '../hooks/useEntityLinks';

const RUN_DETAIL_EVENT_PREFIXES = [
  GC_EVENT_PREFIX.bead,
  GC_EVENT_PREFIX.session,
] as const;
const NO_EVENT_PREFIXES: readonly string[] = [];

export function FormulaRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [search] = useSearchParams();
  const parsedScope = parseScope(search);
  const scope = parsedScope.ok ? parsedScope.scope : undefined;
  const routeError = parsedScope.ok ? null : parsedScope.error;
  const initialNodeId = search.get('node');
  const routeSelectionKey = [
    runId ?? '',
    scope?.scopeKind ?? '',
    scope?.scopeRef ?? '',
    initialNodeId ?? '',
  ].join('\u0000');
  const runDetail = useFormulaRunDetail(
    routeError ? undefined : runId,
    scope?.scopeKind,
    scope?.scopeRef,
  );
  const readyRun = runDetail.kind === 'ready' ? runDetail : null;
  const detail = readyRun?.detail ?? null;
  const initialLoading = runDetail.kind === 'loading';
  const refreshing = readyRun !== null && readyRun.refreshState.kind === 'refreshing';
  const loading = initialLoading || refreshing;
  const loadError =
    runDetail.kind === 'failed'
      ? runDetail.error
      : readyRun !== null && readyRun.refreshState.kind === 'failed'
        ? readyRun.refreshState.error
        : null;
  useGcEventRefresh(
    routeError ? NO_EVENT_PREFIXES : RUN_DETAIL_EVENT_PREFIXES,
    () => void runDetail.refresh(),
    {
      matches: (event) =>
        detail === null ||
        formulaRunDetailEventMatches(runEventIdentity(event), {
          runId: detail.runId,
          rootBeadId: detail.rootBeadId,
        }),
    },
  );
  const pageError = routeError ?? loadError;
  const { selectedNodeId, selectedNode, toggleNode } = useRunNodeSelection(
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
    ? `${detail.progress.visibleNodeCount} nodes. ${summarizeNodeStatuses(detail.progress)}. Local changes are shown for the run execution folder.`
    : initialLoading && !routeError
      ? undefined
      : 'Formula run unavailable.';

  return (
    <section>
      <PageHeader
        title={detail?.title ?? 'Formula Run'}
        synopsis={synopsis}
        meta={
          <>
            <Link
              to="/runs"
              className="focus-mark text-label uppercase tracking-wider text-fg-muted hover:text-fg"
            >
              Runs
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
              {refreshing ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {loading && !routeError && !detail ? (
        <p className="text-body text-fg-muted italic">Loading formula run.</p>
      ) : pageError && !detail ? (
        <p className="text-body text-accent" role="alert">{pageError}</p>
      ) : readyRun ? (
        <>
          <RunMetadata detail={readyRun.detail} />
          <FormulaRunPartialNotice detail={readyRun.detail} />
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(22rem,1.05fr)]">
            <FormulaRunDiagram
              detail={readyRun.detail}
              selectedNodeId={selectedNodeId}
              onToggleNode={toggleNode}
            />
            <FormulaRunTabs diff={readyRun.diff} selectedNode={selectedNode} />
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
  detail: FormulaRunDetailData;
}) {
  const formulaDetail = formulaDetailLabel(detail.formulaDetail);
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      <Meta label="Formula" value={formulaLabel(detail.formula)} />
      {formulaDetail !== null && <Meta label="Formula Detail" value={formulaDetail} />}
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
  detail: FormulaRunDetailData,
): string {
  return detail.snapshotEventSeq.kind === 'known'
    ? `v${detail.snapshotVersion} · seq ${detail.snapshotEventSeq.seq}`
    : `v${detail.snapshotVersion}`;
}

function formulaLabel(formula: FormulaRunDetailData['formula']): string {
  return formula.kind === 'known' ? formula.name : 'metadata missing';
}

function formulaDetailLabel(formulaDetail: FormulaRunDetailData['formulaDetail']): string | null {
  if (formulaDetail.kind === 'available') return `available for ${formulaDetail.target}`;
  if (formulaDetail.reason === 'missing_formula_metadata') return null;
  if (formulaDetail.reason === 'missing_run_target') return `missing run target for ${formulaDetail.name}`;
  return `${formulaDetail.failure} for ${formulaDetail.target}`;
}

function FormulaRunPartialNotice({ detail }: { detail: FormulaRunDetailData }) {
  if (detail.completeness.kind !== 'partial') return null;
  const reasons = pageLevelPartialReasons(detail.completeness.reasons);
  if (reasons.length === 0) return null;
  return (
    <p className="mt-5 text-label uppercase tracking-wider text-warn" role="status">
      Partial run data: {partialReasonsLabel(reasons)}.
    </p>
  );
}

function pageLevelPartialReasons(
  reasons: readonly FormulaRunPartialReason[],
): FormulaRunPartialReason[] {
  return reasons.filter((reason) => !isFormulaDetailPartialReason(reason));
}

function isFormulaDetailPartialReason(reason: FormulaRunPartialReason): boolean {
  switch (reason) {
    case 'formula_detail_missing_formula_metadata':
    case 'formula_detail_missing_run_target':
    case 'formula_detail_fetch_failed':
      return true;
    case 'supervisor_snapshot_partial':
    case 'runtime_bead_read_failed':
    case 'session_list_failed':
      return false;
  }
}

function partialReasonsLabel(reasons: readonly FormulaRunPartialReason[]): string {
  return reasons.map(partialReasonLabel).join(', ');
}

function partialReasonLabel(reason: FormulaRunPartialReason): string {
  switch (reason) {
    case 'supervisor_snapshot_partial':
      return 'supervisor snapshot is partial';
    case 'runtime_bead_read_failed':
      return 'runtime bead refresh failed';
    case 'session_list_failed':
      return 'session list failed';
    case 'formula_detail_missing_formula_metadata':
      return 'formula metadata is missing';
    case 'formula_detail_missing_run_target':
      return 'formula run target is missing';
    case 'formula_detail_fetch_failed':
      return 'formula detail fetch failed';
  }
}

type ScopeParseResult =
  | { ok: true; scope?: { scopeKind: RunScopeKind; scopeRef: string } }
  | { ok: false; error: string };

function parseScope(search: URLSearchParams): ScopeParseResult {
  const rawKinds = search.getAll('scope_kind');
  const rawRefs = search.getAll('scope_ref');
  if (rawKinds.length > 1 || rawRefs.length > 1) {
    return { ok: false, error: 'Invalid run scope query.' };
  }

  const rawKind = rawKinds[0];
  const rawRef = rawRefs[0];
  if (rawKind === undefined && rawRef === undefined) return { ok: true };

  // Reject a half-specified scope (one of kind/ref present) rather than
  // silently dropping it — the backend rejects the same input as a 400, so
  // failing closed here keeps a truncated deep link from loading the WRONG
  // (default city) run instead of erroring.
  if (rawKind === undefined || rawRef === undefined) {
    return { ok: false, error: 'Invalid run scope query.' };
  }

  if (rawKind !== 'city' && rawKind !== 'rig') {
    return { ok: false, error: 'Invalid run scope query.' };
  }
  if (!SCOPE_REF_RE.test(rawRef)) {
    return { ok: false, error: 'Invalid run scope query.' };
  }

  return { ok: true, scope: { scopeKind: rawKind, scopeRef: rawRef } };
}

function summarizeNodeStatuses(progress: FormulaRunProgress): string {
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
  progress: FormulaRunProgress,
  statuses: RunNodeStatus | readonly RunNodeStatus[],
  label: string,
): string | null {
  const keys: readonly RunNodeStatus[] =
    typeof statuses === 'string' ? [statuses] : statuses;
  const count = keys.reduce((sum, status) => sum + (progress.statusCounts[status] ?? 0), 0);
  return count > 0 ? `${count} ${label}` : null;
}
