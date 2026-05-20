import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GcBead, GcMailItem, GcSession, TranscriptResult } from 'gas-city-dashboard-shared';
import { effectiveContextPct } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { SessionPeekContent, formatPeekChars } from '../components/SessionPeek';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { useViewingAs } from '../contexts/ViewingAsContext';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { formatRelative } from '../hooks/time';

// Read-only drilldown for a single agent. Route: /agents/:slug where
// slug resolves against session_name, alias, then id (see sessionSlug).
//
// Surface:
//   - Header with state badge, identity line, back link
//   - Metadata block (rig, pool, template, model, ctx, attached, timestamps)
//   - Beads assigned to this agent (filtered from /api/beads)
//   - Live peek panel (auto-refresh, visibility-gated, abort-guarded)
//
// Deferred (read-only scope): nudge button, directives panel. Send half
// of the chat thread (compose form) is filed separately. Directives
// needs a new backend endpoint.

const PEEK_AUTO_REFRESH_MS = 7_000;
const SESSIONS_REFRESH_MS = 15_000;
const BEADS_REFRESH_MS = 30_000;
const CHAT_REFRESH_MS = 10_000;
const CHAT_MAX_MESSAGES = 200;
const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

export function AgentDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { viewingAs } = useViewingAs();

  const [sessions, setSessions] = useState<GcSession[] | null>(null);
  const [beads, setBeads] = useState<GcBead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewingBead, setViewingBead] = useState<GcBead | null>(null);

  const [peekResult, setPeekResult] = useState<TranscriptResult | null>(null);
  const [peekFetchedAt, setPeekFetchedAt] = useState<number | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [chatItems, setChatItems] = useState<GcMailItem[] | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [directivesPrompt, setDirectivesPrompt] = useState<string | null>(null);
  const [directivesLoading, setDirectivesLoading] = useState(false);
  const [directivesError, setDirectivesError] = useState<{
    status?: number;
    kind?: string;
    message: string;
  } | null>(null);
  const [directivesAliasFetched, setDirectivesAliasFetched] = useState<string | null>(null);

  const decoded = useMemo(() => {
    try {
      return decodeURIComponent(slug);
    } catch {
      return slug;
    }
  }, [slug]);

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await api.listSessions();
      setSessions(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sessions failed');
    }
  }, []);

  const refreshBeads = useCallback(async () => {
    try {
      const { items } = await api.listBeads(true);
      setBeads(items);
    } catch {
      // Beads panel surfaces its own loading state; don't blank the page.
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshBeads();
  }, [refreshSessions, refreshBeads]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) void refreshSessions();
    }, SESSIONS_REFRESH_MS);
    return () => clearInterval(tick);
  }, [refreshSessions]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) void refreshBeads();
    }, BEADS_REFRESH_MS);
    return () => clearInterval(tick);
  }, [refreshBeads]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 5_000);
    return () => clearInterval(tick);
  }, []);

  useGcEventRefresh(['session.', 'bead.'], () => {
    void refreshSessions();
    void refreshBeads();
  });

  const session = useMemo<GcSession | null>(() => {
    if (sessions === null) return null;
    return (
      sessions.find((s) => s.session_name === decoded) ??
      sessions.find((s) => s.alias === decoded) ??
      sessions.find((s) => s.id === decoded) ??
      null
    );
  }, [sessions, decoded]);

  // Beads belonging to this agent. Two link paths in circulation, both
  // need to be matched or polecat-style sessions (empty alias, work
  // bead linked only via metadata.session_id) silently render empty:
  //   1. bead.assignee == alias | session_name | id
  //   2. bead.metadata.session_id == session.id (supervisor-spawned)
  //   3. bead.metadata.session_name == session.session_name (CLI-tagged)
  const assignedBeads = useMemo<GcBead[]>(() => {
    if (session === null || beads === null) return [];
    const candidates = new Set<string>();
    if (session.alias) candidates.add(session.alias);
    if (session.session_name) candidates.add(session.session_name);
    candidates.add(session.id);
    return beads.filter((b) => {
      if (b.assignee !== undefined && candidates.has(b.assignee)) return true;
      const md = b.metadata;
      if (md && typeof md === 'object') {
        const sid = (md as Record<string, unknown>).session_id;
        if (typeof sid === 'string' && sid === session.id) return true;
        const sname = (md as Record<string, unknown>).session_name;
        if (
          typeof sname === 'string' &&
          session.session_name !== undefined &&
          sname === session.session_name
        ) {
          return true;
        }
      }
      return false;
    });
  }, [session, beads]);

  const refreshPeek = useCallback(async () => {
    if (session === null) return;
    setPeekLoading(true);
    setPeekError(null);
    try {
      const result = await api.peekSession(session.id);
      setPeekResult(result);
      setPeekFetchedAt(Date.now());
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
  }, [session]);

  useEffect(() => {
    if (session === null) return;
    void refreshPeek();
    const tick = setInterval(() => {
      if (!document.hidden) void refreshPeek();
    }, PEEK_AUTO_REFRESH_MS);
    return () => clearInterval(tick);
  }, [session, refreshPeek]);

  // Chat thread: wide /api/mail box=all fetch, client-side filter for
  // messages between operator and this agent. AbortController guard per
  // tick prevents a stale response overwriting a fresher one — fetch
  // ordering matters here because messages render chronologically and
  // an out-of-order overwrite can make a just-arrived message vanish.
  const agentAliases = useMemo<ReadonlyArray<string>>(() => {
    if (session === null) return [];
    const out = new Set<string>();
    if (session.alias) out.add(session.alias.toLowerCase());
    if (session.session_name) out.add(session.session_name.toLowerCase());
    out.add(session.id.toLowerCase());
    return [...out];
  }, [session]);

  const operatorAliases = useMemo<ReadonlyArray<string>>(
    () => [viewingAs.alias.toLowerCase(), 'human'],
    [viewingAs.alias],
  );

  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    let controller = new AbortController();
    const aliasParam = viewingAs.alias;

    const tickOnce = async () => {
      controller.abort();
      controller = new AbortController();
      const localController = controller;
      setChatLoading(true);
      try {
        // box='all' makes the alias query param a no-op upstream
        // (see backend/src/routes/mail.ts) — pass the operator alias as
        // a safe default. Client-side filter narrows to operator↔agent.
        const { items } = await api.listMail('all', aliasParam);
        if (cancelled || localController.signal.aborted) return;
        setChatItems(items);
        setChatError(null);
      } catch (err) {
        if (cancelled || localController.signal.aborted) return;
        const msg =
          err instanceof ApiClientError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'mail failed';
        setChatError(msg);
      } finally {
        if (!cancelled && !localController.signal.aborted) {
          setChatLoading(false);
        }
      }
    };

    void tickOnce();
    const interval = setInterval(() => {
      if (!document.hidden) void tickOnce();
    }, CHAT_REFRESH_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [session, viewingAs.alias]);

  // Directives: lazy-fetch the agent's composed prompt via `gc prime`.
  // Cached for the lifetime of the page (no auto-refresh); operator can
  // manually re-pull. Bail out (render nothing) when there's no alias
  // candidate — `gc prime` is alias-keyed, not id-keyed.
  const primeAlias = useMemo<string | null>(() => {
    if (session === null) return null;
    return session.alias ?? session.template ?? null;
  }, [session]);

  const refreshDirectives = useCallback(async () => {
    if (primeAlias === null) return;
    setDirectivesLoading(true);
    setDirectivesError(null);
    try {
      const result = await api.agentPrime(primeAlias);
      setDirectivesPrompt(result.prompt);
      setDirectivesAliasFetched(primeAlias);
    } catch (err) {
      const status = err instanceof ApiClientError ? err.status : undefined;
      const kind = err instanceof ApiClientError ? err.kind : undefined;
      const message =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'directives fetch failed';
      setDirectivesError({ status, kind, message });
      setDirectivesPrompt(null);
      setDirectivesAliasFetched(primeAlias);
    } finally {
      setDirectivesLoading(false);
    }
  }, [primeAlias]);

  useEffect(() => {
    if (primeAlias === null) return;
    // Only fetch the first time we see this alias — page-lifetime cache.
    // Manual Refresh button is the documented re-pull path.
    if (directivesAliasFetched === primeAlias) return;
    void refreshDirectives();
  }, [primeAlias, directivesAliasFetched, refreshDirectives]);

  const chatMessages = useMemo<ReadonlyArray<GcMailItem>>(() => {
    if (chatItems === null) return [];
    const agents = new Set(agentAliases);
    const operators = new Set(operatorAliases);
    const filtered = chatItems.filter((m) => {
      const from = (m.from ?? '').toLowerCase();
      const to = (m.to ?? '').toLowerCase();
      // Operator → agent
      if (operators.has(from) && agents.has(to)) return true;
      // Agent → operator
      if (agents.has(from) && operators.has(to)) return true;
      return false;
    });
    filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (filtered.length > CHAT_MAX_MESSAGES) {
      return filtered.slice(filtered.length - CHAT_MAX_MESSAGES);
    }
    return filtered;
  }, [chatItems, agentAliases, operatorAliases]);

  if (sessions === null) {
    return (
      <section>
        <PageHeader title="Agent" synopsis="Loading session list." />
      </section>
    );
  }

  if (session === null) {
    return (
      <section>
        <PageHeader
          title="Agent"
          synopsis={
            <>
              No session matches <code className="text-fg">{decoded}</code>.
            </>
          }
          meta={
            <Button size="sm" tone="quiet" onClick={() => navigate('/agents')}>
              ← Agents
            </Button>
          }
        />
        <p className="text-body text-fg-muted max-w-prose">
          The slug doesn't match any current session's session_name, alias, or id.
          Sessions are listed at{' '}
          <Link to="/agents" className="text-accent hover:underline">
            /agents
          </Link>
          .
        </p>
      </section>
    );
  }

  const label = session.alias ?? session.title ?? session.id;
  const tone = stateTone(session.state);

  return (
    <section>
      <PageHeader
        title={label}
        synopsis={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <StatusBadge
              tone={tone}
              label={session.state}
              trailing={session.attached ? 'att' : undefined}
              title={session.reason ? `reason: ${session.reason}` : undefined}
            />
            <span className="text-fg-faint">·</span>
            <code className="text-fg-muted">{session.template ?? '—'}</code>
            {session.session_name && session.session_name !== session.alias && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="text-fg-faint">{session.session_name}</span>
              </>
            )}
            <span className="text-fg-faint">·</span>
            <span className="text-fg-faint">id <code className="text-fg-muted">{session.id}</code></span>
          </span>
        }
        meta={
          <Link to="/agents">
            <Button size="sm" tone="quiet">
              ← Agents
            </Button>
          </Link>
        }
      />

      {error && (
        <p className="text-body text-accent mb-6" role="alert">
          {error}
        </p>
      )}

      <Metadata session={session} now={now} />

      <BeadsAssigned
        beads={assignedBeads}
        loading={beads === null}
        onSelect={setViewingBead}
      />

      <LivePeek
        result={peekResult}
        loading={peekLoading}
        error={peekError}
        fetchedAt={peekFetchedAt}
        now={now}
        onRefresh={() => void refreshPeek()}
      />

      {primeAlias !== null && (
        <Directives
          alias={primeAlias}
          prompt={directivesPrompt}
          loading={directivesLoading}
          error={directivesError}
          onRefresh={() => void refreshDirectives()}
        />
      )}

      <ChatThread
        messages={chatMessages}
        loading={chatLoading && chatItems === null}
        error={chatError}
        now={now}
      />

      <BeadDetailModal
        open={viewingBead !== null}
        onClose={() => setViewingBead(null)}
        beadId={viewingBead?.id ?? null}
        initialBead={viewingBead}
      />
    </section>
  );
}

function Metadata({ session, now }: { session: GcSession; now: number }) {
  const pct = effectiveContextPct(session);
  const items: ReadonlyArray<{ label: string; value: React.ReactNode }> = [
    { label: 'Rig', value: session.rig ?? '·' },
    { label: 'Pool', value: session.pool ?? '·' },
    { label: 'Provider', value: session.provider ?? '·' },
    { label: 'Model', value: session.model ?? '·' },
    {
      label: 'Context',
      value:
        typeof pct === 'number' ? (
          <span
            className={`tnum ${
              pct >= 95 ? 'text-accent' : pct >= 80 ? 'text-warn' : 'text-fg'
            }`}
          >
            {pct}%
          </span>
        ) : (
          '·'
        ),
    },
    { label: 'Attached', value: session.attached ? 'yes' : 'no' },
    {
      label: 'Created',
      value: <span className="tnum">{formatRelative(session.created_at, now)}</span>,
    },
    {
      label: 'Last active',
      value: <span className="tnum">{formatRelative(session.last_active, now)}</span>,
    },
  ];

  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5 mb-12">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-label uppercase tracking-wider text-fg-faint mb-1">
            {it.label}
          </dt>
          <dd className="text-body text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BeadsAssigned({
  beads,
  loading,
  onSelect,
}: {
  beads: ReadonlyArray<GcBead>;
  loading: boolean;
  onSelect: (bead: GcBead) => void;
}) {
  return (
    <section className="mb-12">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Beads assigned
        </h2>
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          {loading ? '·' : beads.length}
        </span>
      </header>
      {loading ? (
        <p className="text-body text-fg-muted italic">Loading beads.</p>
      ) : beads.length === 0 ? (
        <p className="text-body text-fg-muted italic">No beads assigned to this agent.</p>
      ) : (
        <ul className="space-y-2">
          {beads.map((b) => (
            <li key={b.id} className="flex items-baseline gap-3 min-w-0">
              <span className="text-label uppercase tracking-wider text-fg-faint tnum shrink-0">
                {b.id}
              </span>
              <button
                type="button"
                onClick={() => onSelect(b)}
                className="text-body text-fg hover:text-accent truncate min-w-0 text-left focus-mark"
                title={`Open ${b.id}`}
              >
                {b.title}
              </button>
              <span className="text-label uppercase tracking-wider text-fg-faint shrink-0">
                {b.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LivePeek({
  result,
  loading,
  error,
  fetchedAt,
  now,
  onRefresh,
}: {
  result: TranscriptResult | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  now: number;
  onRefresh: () => void;
}) {
  const captionParts: string[] = [];
  if (result) {
    captionParts.push(`${result.turns.length} turn(s)`);
    captionParts.push(formatPeekChars(result.total_chars));
    captionParts.push(`captured ${formatRelative(result.captured_at, now)}`);
  }
  if (fetchedAt !== null) {
    captionParts.push(`refreshed ${formatRelative(new Date(fetchedAt).toISOString(), now)}`);
  }
  captionParts.push(`auto-refresh ${PEEK_AUTO_REFRESH_MS / 1_000}s`);

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Live peek
        </h2>
        <Button size="sm" tone="quiet" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing' : 'Refresh'}
        </Button>
      </header>
      <p className="text-label uppercase tracking-wider text-fg-faint mb-4 tnum">
        {captionParts.join(' · ')}
      </p>
      <SessionPeekContent loading={loading} error={error} result={result} />
    </section>
  );
}

function ChatThread({
  messages,
  loading,
  error,
  now,
}: {
  messages: ReadonlyArray<GcMailItem>;
  loading: boolean;
  error: string | null;
  now: number;
}) {
  return (
    <section className="mt-12">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Chat thread
        </h2>
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          {loading ? '·' : messages.length}
        </span>
      </header>
      <p className="text-label uppercase tracking-wider text-fg-faint mb-4">
        <span className="text-accent">▲ {PROMPT_INJECTION_NOTICE}</span>
      </p>
      {loading ? (
        <p className="text-body text-fg-muted italic">Loading messages.</p>
      ) : error !== null ? (
        <p className="text-body text-accent" role="alert">
          {error}
        </p>
      ) : messages.length === 0 ? (
        <p className="text-body text-fg-muted italic">
          No messages between operator and this agent.
        </p>
      ) : (
        <ul className="space-y-6">
          {messages.map((m) => (
            <li key={m.id} className="space-y-2 pb-4 border-b border-rule last:border-0">
              <header className="flex items-baseline justify-between gap-3">
                <div className="text-label uppercase tracking-wider text-fg-muted truncate">
                  <span className="text-fg font-medium">{m.from}</span>
                  <span className="mx-1.5 text-fg-faint">→</span>
                  <span>{m.to}</span>
                </div>
                <span className="text-label uppercase tracking-wider text-fg-faint tnum shrink-0">
                  {formatRelative(m.created_at, now)}
                </span>
              </header>
              {m.subject && (
                <p className="text-body font-medium text-fg">{m.subject}</p>
              )}
              <pre className="text-body whitespace-pre-wrap leading-relaxed text-fg overflow-x-auto">
                {m.body}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Directives({
  alias,
  prompt,
  loading,
  error,
  onRefresh,
}: {
  alias: string;
  prompt: string | null;
  loading: boolean;
  error: { status?: number; kind?: string; message: string } | null;
  onRefresh: () => void;
}) {
  const isNotFound = error?.status === 404 || error?.kind === 'not_found';
  const charsLabel =
    prompt !== null
      ? `${prompt.length.toLocaleString()} chars`
      : loading
        ? 'loading'
        : error !== null
          ? '—'
          : '·';

  return (
    <section className="mt-12">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Directives
        </h2>
        <div className="flex items-baseline gap-3">
          <span className="text-label uppercase tracking-wider text-fg-faint tnum">
            {charsLabel}
          </span>
          <Button size="sm" tone="quiet" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing' : 'Refresh'}
          </Button>
        </div>
      </header>
      {loading && prompt === null && error === null ? (
        <p className="text-body text-fg-muted italic">Loading directives.</p>
      ) : isNotFound ? (
        <p className="text-body text-warn">
          Agent <code className="text-fg">{alias}</code> has no entry in city
          config.
        </p>
      ) : error !== null ? (
        <p className="text-body text-accent" role="alert">
          {error.status ? `${error.status} ` : ''}
          {error.message}
        </p>
      ) : prompt !== null ? (
        <pre
          className="text-body whitespace-pre-wrap leading-relaxed text-fg overflow-x-auto max-h-[60vh] overflow-y-auto"
        >
          {prompt}
        </pre>
      ) : null}
    </section>
  );
}

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
    case 'detached':
    default:
      return 'neutral';
  }
}

