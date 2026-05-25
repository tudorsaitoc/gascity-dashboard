import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { WorkflowDisplayNode, WorkflowScopeKind } from 'gas-city-dashboard-shared';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { WorkflowRunDiagram } from '../components/workflow/WorkflowRunDiagram';
import { WorkflowRunTabs } from '../components/workflow/WorkflowRunTabs';
import { useWorkflowRunDetail } from '../hooks/useWorkflowRunDetail';

export function WorkflowRunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [search] = useSearchParams();
  const scopeKind = parseScopeKind(search.get('scope_kind'));
  const scopeRef = search.get('scope_ref') ?? undefined;
  const initialNodeId = search.get('node');
  const { detail, diff, loading, error, refresh } = useWorkflowRunDetail(
    workflowId,
    scopeKind,
    scopeRef,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (!detail || !initialNodeId) return;
    if (detail.nodes.some((node) => node.id === initialNodeId)) {
      setSelectedNodeId(initialNodeId);
    }
  }, [detail, initialNodeId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedNodeId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectedNode = useMemo<WorkflowDisplayNode | null>(
    () => detail?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [detail, selectedNodeId],
  );

  const synopsis = detail
    ? `${detail.nodes.length} nodes, ${detail.edges.length} edges. Current working tree diff is shown for the run execution folder.`
    : loading
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
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            {detail && (
              <span className="text-label uppercase tracking-wider text-fg-faint tnum">
                v{detail.snapshotVersion}
              </span>
            )}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {loading && !detail ? (
        <p className="text-body text-fg-muted italic">Loading workflow run.</p>
      ) : error && !detail ? (
        <p className="text-body text-accent" role="alert">{error}</p>
      ) : detail ? (
        <>
          <RunMetadata detail={detail} />
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(22rem,1.05fr)]">
            <WorkflowRunDiagram
              detail={detail}
              selectedNodeId={selectedNodeId}
              onToggleNode={(nodeId) =>
                setSelectedNodeId((current) => (current === nodeId ? null : nodeId))
              }
            />
            <WorkflowRunTabs diff={diff} selectedNode={selectedNode} />
          </div>
        </>
      ) : null}
    </section>
  );
}

function RunMetadata({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof useWorkflowRunDetail>['detail']>;
}) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      <Meta label="Formula" value={detail.formula ?? 'unknown'} />
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

function parseScopeKind(value: string | null): WorkflowScopeKind | undefined {
  return value === 'city' || value === 'rig' ? value : undefined;
}
