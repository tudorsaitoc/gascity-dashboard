import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { WorkflowMap } from '../components/workflow/WorkflowMap';
import { useCachedData } from '../hooks/useCachedData';
import { formatRelative } from '../hooks/time';

// /workflows route (gascity-dashboard-0t6). Reads /api/snapshot via
// useCachedData (stale-while-revalidate) and hands the workflows source
// to WorkflowMap. Freshness is shown as text — "stale 2m ago" — when
// the snapshot envelope reports anything other than status='fresh'.
//
// No SSE wiring in v0; the snapshot route's own TTL refresh + a manual
// "Refresh" button covers the operator's expected cadence.

const TICK_MS = 5_000;

export function WorkflowsPage() {
  const { data, loading, error, refresh } = useCachedData('snapshot', () =>
    api.snapshot(),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const workflows = data?.sources.workflows ?? null;
  const synopsis = data
    ? `${data.headline.activeWorkflows ?? 0} active workflows across the supervisor's bead store. Phase grammar: intake, implementation, review, approval, finalization.`
    : 'Loading the workflow lanes.';

  const freshnessLabel = workflows
    ? workflows.status === 'fresh'
      ? null
      : workflows.status === 'fixture'
        ? 'fixture data'
        : workflows.status === 'error'
          ? 'live data unavailable'
          : workflows.fetchedAt
            ? `stale ${formatRelative(workflows.fetchedAt, now)} ago`
            : 'stale'
    : null;

  return (
    <section>
      <PageHeader
        title="Workflows"
        synopsis={synopsis}
        meta={
          <>
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            {freshnessLabel !== null && (
              <span
                className={`text-label uppercase tracking-wider tnum ${
                  workflows?.status === 'error'
                    ? 'text-accent'
                    : 'text-fg-faint'
                }`}
              >
                {freshnessLabel}
              </span>
            )}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {data === undefined || workflows === null ? (
        <p className="text-body text-fg-muted italic">Loading workflows.</p>
      ) : (
        <WorkflowMap source={workflows} now={now} />
      )}
    </section>
  );
}
