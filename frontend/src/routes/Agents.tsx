import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GcSession, GcSessionState, TranscriptResult } from 'gas-city-dashboard-shared';
import { effectiveContextPct } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { FilterChips } from '../components/FilterChips';
import { GroupedTable } from '../components/GroupedTable';
import { ListSearchBar } from '../components/ListSearchBar';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { SessionPeekContent, formatPeekChars } from '../components/SessionPeek';
import { SortToggle } from '../components/SortToggle';
import { SseIndicator } from '../components/SseIndicator';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { type TableColumn } from '../components/Table';
import { useCachedData } from '../hooks/useCachedData';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useListFilters, type FilterChip, type SortMode } from '../hooks/useListFilters';
import { formatRelative } from '../hooks/time';
import {
  ORCHESTRATION_PROJECT,
  isPerRigDispatcher,
  sessionProject,
} from '../hooks/projectOf';
import { sessionSlug } from '../hooks/sessionSlug';

const PINNED_PROJECTS = [ORCHESTRATION_PROJECT];
const NON_COLLAPSIBLE_PROJECTS = new Set([ORCHESTRATION_PROJECT]);

// Activity = the most recent timestamp on the session, used both for
// the rig-group sort and as the column sort value. Returns undefined
// when neither field is parseable so the hook can sink such rigs to
// the bottom in activity-sort mode rather than ranking them at epoch 0.
function sessionActivity(s: GcSession): number | undefined {
  const raw = s.last_active ?? s.created_at;
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

const SORT_OPTIONS: ReadonlyArray<{ id: SortMode; label: string }> = [
  { id: 'activity', label: 'activity' },
  { id: 'alpha', label: 'alphabetical' },
];

// Session state chips collapse the gc supervisor's many states into
// buckets the operator actually filters by. Every named GcSessionState
// must map to at least one chip — otherwise sessions in that state
// vanish silently when any chip is active (see gascity-dashboard-9yb).
// Detached gets its own chip because it is semantically distinct: the
// session may still be running, just disconnected from tmux, so
// bucketing it under idle or stopped would misrepresent its state.
// Exported so tests can assert full state coverage.
export const SESSION_CHIPS: ReadonlyArray<FilterChip<GcSession>> = [
  {
    id: 'running',
    label: 'running',
    match: (s) => s.state === 'active' || s.state === 'running' || s.running === true,
  },
  {
    id: 'idle',
    label: 'idle',
    match: (s) => s.state === 'asleep' || s.state === 'idle' || s.state === 'creating',
  },
  {
    id: 'detached',
    label: 'detached',
    match: (s) => s.state === 'detached',
  },
  {
    id: 'stopped',
    label: 'stopped',
    match: (s) =>
      s.state === 'failed' || s.state === 'closed' || s.state === 'errored' || s.state === 'stuck',
  },
];

const SESSION_SEARCH_FIELDS = (s: GcSession): ReadonlyArray<string | undefined> => [
  s.id,
  s.alias,
  s.title,
  s.template,
  s.pool,
  s.rig,
  s.provider,
  s.model,
];

export function AgentsPage() {
  const { data, loading, error, refresh } = useCachedData(
    'sessions',
    () => api.listSessions(),
  );
  const rows = useMemo(() => data?.items ?? [], [data]);
  const [now, setNow] = useState(() => Date.now());

  const [peekFor, setPeekFor] = useState<GcSession | null>(null);
  const [peekResult, setPeekResult] = useState<TranscriptResult | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 15_000);
    return () => clearInterval(tick);
  }, []);

  const sseState = useGcEventRefresh(['session.'], () => void refresh());

  const handlePeek = useCallback(async (session: GcSession) => {
    setPeekFor(session);
    setPeekResult(null);
    setPeekError(null);
    setPeekLoading(true);
    try {
      const result = await api.peekSession(session.id);
      setPeekResult(result);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'peek failed';
      setPeekError(msg);
    } finally {
      setPeekLoading(false);
    }
  }, []);

  const synopsis = useMemo(() => buildSynopsis(rows), [rows]);

  const filters = useListFilters<GcSession>({
    viewKey: 'agents',
    rows,
    projectOf: sessionProject,
    searchOf: SESSION_SEARCH_FIELDS,
    chips: SESSION_CHIPS,
    defaultCollapsed: true,
    activityOf: sessionActivity,
    defaultSortMode: 'activity',
    pinnedProjects: PINNED_PROJECTS,
    nonCollapsibleProjects: NON_COLLAPSIBLE_PROJECTS,
  });

  const columns = useMemo<ReadonlyArray<TableColumn<GcSession>>>(() => [
    {
      key: 'alias',
      label: 'Agent',
      sortable: true,
      sortValue: (r) => r.alias ?? r.title ?? r.id,
      render: (r) => {
        // Per-rig dispatchers (alias '<rig>/control-dispatcher') live
        // inside their rig group but perform an orchestration role.
        // Italicize the alias so the operator can spot them at a glance
        // without lifting them out of their rig (cross-rig
        // orchestration is handled separately by the Orchestration
        // pinned group).
        const dispatcher = isPerRigDispatcher(r);
        const label = r.alias ?? r.title ?? r.id;
        return (
          <div className="min-w-0">
            <Link
              to={`/agents/${encodeURIComponent(sessionSlug(r))}`}
              className={`block text-fg truncate hover:text-accent focus-mark ${
                dispatcher ? 'font-normal italic' : 'font-medium'
              }`}
              title={`Open drilldown for ${label}`}
            >
              {label}
            </Link>
            <div className="text-label uppercase tracking-wider text-fg-faint mt-1 truncate">
              {r.template ?? r.provider ?? ''}
            </div>
          </div>
        );
      },
    },
    {
      key: 'state',
      label: 'State',
      sortable: true,
      sortValue: (r) => r.state,
      render: (r) => (
        <StatusBadge
          tone={stateTone(r.state)}
          label={r.state}
          trailing={r.attached ? 'att' : undefined}
          title={r.reason ? `reason: ${r.reason}` : undefined}
        />
      ),
      className: 'w-32',
    },
    {
      key: 'activity',
      label: 'Activity',
      sortable: true,
      sortValue: (r) => r.activity ?? '',
      render: (r) => (
        <span className="text-fg-muted">
          {r.activity ?? (r.running ? 'running' : '·')}
        </span>
      ),
      className: 'w-28',
    },
    {
      key: 'context',
      label: 'Context',
      sortable: true,
      // Sort by the value we DISPLAY, not the raw gc value — otherwise
      // mayor (raw 89%, effective 18%) would sort above a true-90%
      // session that looks calmer.
      sortValue: (r) => effectiveContextPct(r) ?? -1,
      align: 'right',
      render: (r) => {
        const pct = effectiveContextPct(r);
        if (typeof pct !== 'number') {
          return <span className="text-fg-faint">·</span>;
        }
        // Tooltip exposes the raw gc value when scaling kicked in so
        // the operator can audit the dashboard against gc directly.
        const title =
          typeof r.context_pct === 'number' && r.context_pct !== pct
            ? `gc reports ${r.context_pct}% against ${r.context_window ?? '?'}-token window; scaled to model's true window`
            : undefined;
        return (
          <span
            title={title}
            className={`tnum ${
              pct >= 95
                ? 'text-accent font-medium'
                : pct >= 80
                  ? 'text-warn font-medium'
                  : 'text-fg-muted'
            }`}
          >
            {pct}%
          </span>
        );
      },
      className: 'w-24',
    },
    {
      key: 'last_active',
      label: 'Last active',
      sortable: true,
      sortValue: (r) => r.last_active ?? r.created_at,
      render: (r) => (
        <span className="tnum text-fg-muted">
          {formatRelative(r.last_active ?? r.created_at, now)}
        </span>
      ),
      className: 'w-32',
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <Button size="sm" tone="quiet" onClick={() => void handlePeek(r)}>
          Peek
        </Button>
      ),
      align: 'right',
      className: 'w-20',
    },
  ], [handlePeek, now]);

  return (
    <section>
      <PageHeader
        title="Agents"
        synopsis={synopsis}
        meta={
          <>
            <SseIndicator state={sseState} />
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      <div className="mb-6 space-y-3">
        <ListSearchBar
          value={filters.search}
          onChange={filters.setSearch}
          placeholder="Search agents by alias, rig, pool, template"
          matchCount={filters.totalMatches}
          totalCount={rows.length}
          ariaLabel="Search agents"
        />
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <FilterChips
            chips={SESSION_CHIPS}
            activeIds={filters.activeChipIds}
            onToggle={filters.toggleChip}
            legend="State"
          />
          <SortToggle<SortMode>
            value={filters.sortMode}
            options={SORT_OPTIONS}
            onChange={filters.setSortMode}
            legend="Sort"
          />
        </div>
      </div>

      <GroupedTable
        groups={filters.groups}
        columns={columns}
        rowKey={(r) => r.id}
        onToggleProject={filters.toggleProject}
        emptyMessage={
          filters.search.length > 0 || filters.activeChipIds.size > 0
            ? 'No sessions match the current search or filter.'
            : 'No sessions running.'
        }
        perProjectEmpty="No sessions in this project."
        initialSort={{ key: 'last_active', dir: 'desc' }}
      />

      <Modal
        open={peekFor !== null}
        onClose={() => setPeekFor(null)}
        title={peekFor ? `${peekFor.alias ?? peekFor.title ?? peekFor.id}` : 'Transcript'}
        caption={
          peekResult
            ? `${peekResult.turns.length} turn(s), ${formatPeekChars(peekResult.total_chars)}, captured ${formatRelative(peekResult.captured_at, Date.now())}`
            : "One-shot snapshot from the supervisor's transcript API."
        }
        widthClass="max-w-5xl"
        footer={
          <Button
            size="sm"
            tone="quiet"
            onClick={() => peekFor && void handlePeek(peekFor)}
            disabled={peekLoading}
          >
            Re-fetch
          </Button>
        }
      >
        <SessionPeekContent
          loading={peekLoading}
          error={peekError}
          result={peekResult}
        />
      </Modal>
    </section>
  );
}

// Single source of truth for state → tone mapping. Aligned with how
// the gc supervisor emits session states. Unknown states default to
// neutral so we don't lie about them. 'detached' is explicit (not a
// silent default) so reviewers see the intent — it's paused-alive,
// same palette as idle/asleep but tracked distinctly in the synopsis.
export function stateTone(state: GcSessionState): StatusTone {
  switch (state) {
    case 'active':
    case 'running':
      return 'ok';
    case 'rate-limited':
    case 'rate_limited':
    case 'waiting':
      return 'warn';
    case 'failed':
    case 'closed':
    case 'errored':
    case 'stuck':
      return 'stuck';
    case 'detached':
    case 'asleep':
    case 'idle':
    case 'creating':
    default:
      return 'neutral';
  }
}

// Buckets a raw state into the synopsis category. Distinct from
// stateTone because 'detached' and 'idle' share a tone (neutral) but
// the header text breaks them out — surfaced in gascity-dashboard-x4k.
export type SynopsisBucket = 'active' | 'idle' | 'detached' | 'rate-limited' | 'stuck';

function stateBucket(state: GcSessionState): SynopsisBucket {
  switch (state) {
    case 'active':
    case 'running':
      return 'active';
    case 'detached':
      return 'detached';
    case 'rate-limited':
    case 'rate_limited':
    case 'waiting':
      return 'rate-limited';
    case 'failed':
    case 'closed':
    case 'errored':
    case 'stuck':
      return 'stuck';
    default:
      return 'idle';
  }
}

export function buildSynopsis(rows: ReadonlyArray<GcSession>): string {
  if (rows.length === 0) return 'No sessions running.';
  const counts = new Map<SynopsisBucket, number>();
  for (const r of rows) {
    const b = stateBucket(r.state);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const parts: string[] = [];
  const active = counts.get('active') ?? 0;
  const idle = counts.get('idle') ?? 0;
  const detached = counts.get('detached') ?? 0;
  const rateLimited = counts.get('rate-limited') ?? 0;
  const stuck = counts.get('stuck') ?? 0;
  if (active > 0) parts.push(`${active} active`);
  if (idle > 0) parts.push(`${idle} idle`);
  if (detached > 0) parts.push(`${detached} detached`);
  if (rateLimited > 0) parts.push(`${rateLimited} rate-limited`);
  if (stuck > 0) parts.push(`${stuck} stuck`);
  return parts.join(', ') + '.';
}
