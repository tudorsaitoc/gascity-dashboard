import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnsiUp } from 'ansi_up';
import type { GcSession, TranscriptResult, TranscriptTurn } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { FilterChips } from '../components/FilterChips';
import { GroupedTable } from '../components/GroupedTable';
import { ListSearchBar } from '../components/ListSearchBar';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { type TableColumn } from '../components/Table';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useListFilters, type FilterChip } from '../hooks/useListFilters';
import { sessionProject } from '../hooks/projectOf';

// Session state chips collapse the gc supervisor's many states into
// three buckets the operator actually filters by. Unknown states fall
// outside all three chips, so they only show when no chip is active.
const SESSION_CHIPS: ReadonlyArray<FilterChip<GcSession>> = [
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

const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

export function AgentsPage() {
  const [rows, setRows] = useState<GcSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [peekFor, setPeekFor] = useState<GcSession | null>(null);
  const [peekResult, setPeekResult] = useState<TranscriptResult | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items } = await api.listSessions();
      setRows(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  });

  const columns = useMemo<ReadonlyArray<TableColumn<GcSession>>>(() => [
    {
      key: 'alias',
      label: 'Agent',
      sortable: true,
      sortValue: (r) => r.alias ?? r.title ?? r.id,
      render: (r) => (
        <div className="min-w-0">
          <div className="text-fg font-medium truncate">
            {r.alias ?? r.title ?? r.id}
          </div>
          <div className="text-label uppercase tracking-wider text-fg-faint mt-1 truncate">
            {r.template ?? r.provider ?? ''}
          </div>
        </div>
      ),
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
      sortValue: (r) => r.context_pct ?? -1,
      align: 'right',
      render: (r) =>
        typeof r.context_pct === 'number' ? (
          <span
            className={`tnum ${
              r.context_pct >= 95
                ? 'text-accent font-medium'
                : r.context_pct >= 80
                  ? 'text-warn font-medium'
                  : 'text-fg-muted'
            }`}
          >
            {r.context_pct}%
          </span>
        ) : (
          <span className="text-fg-faint">·</span>
        ),
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
        <FilterChips
          chips={SESSION_CHIPS}
          activeIds={filters.activeChipIds}
          onToggle={filters.toggleChip}
          legend="State"
        />
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
            ? `${peekResult.turns.length} turn(s), ${formatChars(peekResult.total_chars)}, captured ${formatRelative(peekResult.captured_at, Date.now())}`
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
        <PeekContent
          loading={peekLoading}
          error={peekError}
          result={peekResult}
        />
      </Modal>
    </section>
  );
}

function PeekContent({
  loading,
  error,
  result,
}: {
  loading: boolean;
  error: string | null;
  result: TranscriptResult | null;
}) {
  if (loading) {
    return <p className="text-fg-muted italic">Fetching transcript.</p>;
  }
  if (error) {
    return (
      <p className="text-accent" role="alert">
        {error}
      </p>
    );
  }
  if (!result) return null;
  if (result.turns.length === 0) {
    return <p className="text-fg-muted italic">No turns in this session yet.</p>;
  }

  return (
    <div className="space-y-6">
      <p className="text-label uppercase tracking-wider text-warn border-l-0 pl-0">
        ▲ {PROMPT_INJECTION_NOTICE}
      </p>
      <ol className="space-y-5">
        {result.turns.map((turn, idx) => (
          <TurnBlock key={idx} turn={turn} index={idx} />
        ))}
      </ol>
      {result.truncated && (
        <p className="text-label uppercase tracking-wider text-fg-faint italic">
          Some turns truncated at the per-turn or total cap. Run <code className="text-fg-muted">gc session peek</code> in a terminal for the full transcript.
        </p>
      )}
    </div>
  );
}

function TurnBlock({ turn, index }: { turn: TranscriptTurn; index: number }) {
  const html = useMemo(() => {
    const renderer = new AnsiUp();
    renderer.use_classes = true;
    return renderer.ansi_to_html(turn.text);
  }, [turn.text]);

  return (
    <li>
      <header className="flex items-baseline justify-between gap-3 pb-2 border-b border-rule mb-2">
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          #{(index + 1).toString().padStart(2, '0')}
        </span>
        <RoleLabel role={turn.role} />
      </header>
      <pre
        className="text-body whitespace-pre-wrap leading-relaxed overflow-x-auto text-fg"
        // eslint-disable-next-line react/no-danger -- html is ansi_up output of server-sanitised text; see SECURITY.md
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </li>
  );
}

function RoleLabel({ role }: { role: string }) {
  // Role gets typesetting weight, not chrome. Different roles read
  // differently because of the word + tone, not because of pill shape.
  const tone = roleTone(role);
  return (
    <span
      className={`text-label uppercase tracking-wider font-medium ${tone}`}
    >
      {role.replace(/_/g, ' ')}
    </span>
  );
}

function SseIndicator({ state }: { state: 'connecting' | 'open' | 'closed' }) {
  const tone: StatusTone =
    state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'stuck';
  const label = state === 'open' ? 'live' : state === 'connecting' ? 'connecting' : 'offline';
  return <StatusBadge tone={tone} label={label} title={`SSE stream: ${state}`} />;
}

// Single source of truth for state → tone mapping. Aligned with how
// the gc supervisor emits session states. Unknown states default to
// neutral so we don't lie about them.
function stateTone(state: string): StatusTone {
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
    case 'asleep':
    case 'idle':
    case 'creating':
    default:
      return 'neutral';
  }
}

function roleTone(role: string): string {
  switch (role) {
    case 'assistant':
      return 'text-accent';
    case 'user':
      return 'text-fg';
    case 'system':
      return 'text-warn';
    case 'tool_use':
    case 'tool_result':
      return 'text-fg-muted';
    default:
      return 'text-fg-faint';
  }
}

function buildSynopsis(rows: ReadonlyArray<GcSession>): string {
  if (rows.length === 0) return 'No sessions running.';
  const counts = new Map<StatusTone, number>();
  for (const r of rows) {
    const t = stateTone(r.state);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const parts: string[] = [];
  const ok = counts.get('ok') ?? 0;
  const warn = counts.get('warn') ?? 0;
  const stuck = counts.get('stuck') ?? 0;
  const neutral = counts.get('neutral') ?? 0;
  if (ok > 0) parts.push(`${ok} active`);
  if (neutral > 0) parts.push(`${neutral} idle`);
  if (warn > 0) parts.push(`${warn} rate-limited`);
  if (stuck > 0) parts.push(`${stuck} stuck`);
  return parts.join(', ') + '.';
}

function formatChars(n: number): string {
  if (n < 1024) return `${n} chars`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string | undefined, now: number): string {
  if (!iso) return '·';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '·';
  const diffSec = Math.max(0, Math.round((now - ms) / 1_000));
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h`;
  return `${Math.round(diffSec / 86_400)}d`;
}
