import { useCallback, useEffect, useRef, useState } from 'react';
import type { KanbanCard, KanbanColumn, KanbanResponse } from 'gas-city-dashboard-shared';
import { KANBAN_COLUMNS } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useKanbanMoves, RECENT_MOVES_CAP, type Move } from '../hooks/kanbanMoves';
import { reconcileKanban } from '../hooks/kanbanReconcile';
import { formatRelative } from '../hooks/time';

// Read-only Kanban view (gascity-dashboard-dh6). Ported from
// Wldc4rd/citadel; visual register rebuilt to pass the Flat Page Rule.
// No bordered card columns; columns are typographic swimlanes with a
// tracked label head and a vertical rhythm of rows. The Greyscale
// Test still reads: column heads are labels, blocker/priority signals
// carry a glyph + word, freshness is shown by text staleness.
//
// READ-ONLY: no drag-drop, no inline edits. Cards link into /beads;
// the quick-detail modal (cd-ykl9 upstream) and move-activity feed
// (cd-6w92 upstream) are deferred. 30s refresh + SSE-on-bead-or-session
// kept.

const REFRESH_INTERVAL_MS = 30_000;
const TICK_MS = 5_000;
const STALE_AMBER_MS = 30_000;
const STALE_RED_MS = 120_000;

const COLUMN_LABELS: Record<KanbanColumn, string> = {
  mayor_plate: 'Mayor plate',
  in_flight: 'In flight',
  stalled: 'Stalled',
  blocked_real: 'Blocked, real',
  blocked_stale: 'Blocked, stale',
  in_review: 'In review',
  needs_changes: 'Needs changes',
  approved: 'Approved',
  closed_24h: 'Closed, 24h',
};

const COLUMN_HELP: Record<KanbanColumn, string> = {
  mayor_plate: 'Open, no in-flight signal. Routing and pickup live here.',
  in_flight: 'Claimed; assignee session active within the last hour.',
  stalled: 'Claimed but session inactive over an hour, or asleep.',
  blocked_real: 'Blocked label with at least one open dependency.',
  blocked_stale: 'Blocked label, all dependencies resolved. Needs unblock.',
  in_review: 'Implementer done; reviewer audits.',
  needs_changes: 'Reviewer bounced. Back to the implementer.',
  approved: 'Reviewer approved. Ready to land.',
  closed_24h: 'Closed within the last twenty-four hours.',
};

export function KanbanPage() {
  const [data, setData] = useState<KanbanResponse | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [viewingBeadId, setViewingBeadId] = useState<string | null>(null);
  // gascity-dashboard-0sh: last-displayed Kanban + per-bead consecutive-miss
  // counts, for reconcileKanban (retain a transiently-missing card across
  // one refresh so a supervisor partial-read doesn't flicker it out).
  const displayedRef = useRef<KanbanResponse | null>(null);
  const absenceRef = useRef<Map<string, number>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.kanban();
      // gascity-dashboard-0sh: reconcile against last-displayed so a
      // transiently-missing bead (supervisor partial city-store read)
      // doesn't flicker out.
      const merged = reconcileKanban(displayedRef.current, d, absenceRef.current);
      displayedRef.current = merged;
      setData(merged);
      setFetchedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'kanban fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(tick);
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(tick);
  }, []);

  useGcEventRefresh(['bead.', 'session.'], () => void refresh());

  const { moves, recentMoveIds } = useKanbanMoves(data, { now });

  const staleness =
    fetchedAt === null
      ? 'down'
      : now - fetchedAt < STALE_AMBER_MS
        ? 'fresh'
        : now - fetchedAt < STALE_RED_MS
          ? 'amber'
          : 'red';

  const synopsis = data
    ? `${data.total} engineering bead${data.total === 1 ? '' : 's'} classified across nine ownership columns. Read-only. Auto-refreshes on the half-minute and on the gc event stream.`
    : 'Loading the classifier.';

  return (
    <section>
      <PageHeader
        title="Kanban"
        synopsis={synopsis}
        meta={
          <>
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            {fetchedAt !== null && (
              <span
                className={`tnum ${
                  staleness === 'fresh'
                    ? 'text-fg-faint'
                    : staleness === 'amber'
                      ? 'text-warn'
                      : 'text-accent'
                }`}
                title={new Date(fetchedAt).toLocaleString()}
              >
                {Math.max(0, Math.round((now - fetchedAt) / 1_000))}s ago
              </span>
            )}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {data === null && !error && (
        <p className="text-body text-fg-muted italic">Loading kanban.</p>
      )}

      {data !== null && (
        <div className="flex gap-10 overflow-x-auto pb-4 -mx-2 px-2">
          {KANBAN_COLUMNS.map((col) => (
            <Column
              key={col}
              col={col}
              cards={data.columns[col]}
              now={now}
              recentMoveIds={recentMoveIds}
              onSelect={setViewingBeadId}
            />
          ))}
        </div>
      )}

      {data !== null && <RecentMoves moves={moves} now={now} />}

      <BeadDetailModal
        open={viewingBeadId !== null}
        onClose={() => setViewingBeadId(null)}
        beadId={viewingBeadId}
      />
    </section>
  );
}

function Column({
  col,
  cards,
  now,
  recentMoveIds,
  onSelect,
}: {
  col: KanbanColumn;
  cards: ReadonlyArray<KanbanCard>;
  now: number;
  recentMoveIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="shrink-0 w-64 space-y-3">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-label uppercase tracking-wider text-fg">
            {COLUMN_LABELS[col]}
          </h2>
          <span className="text-label uppercase tracking-wider text-fg-faint tnum">
            {cards.length}
          </span>
        </div>
        <p className="text-label normal-case tracking-normal text-fg-faint italic leading-snug">
          {COLUMN_HELP[col]}
        </p>
      </header>

      {cards.length === 0 ? (
        <p className="text-label normal-case tracking-normal text-fg-faint italic">
          empty
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {cards.map((c) => (
            <Card
              key={c.id}
              card={c}
              column={col}
              now={now}
              flashing={recentMoveIds.has(c.id)}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({
  card,
  column,
  now,
  flashing,
  onSelect,
}: {
  card: KanbanCard;
  column: KanbanColumn;
  now: number;
  flashing: boolean;
  onSelect: (id: string) => void;
}) {
  // Two-line typographic row: title + id on the first line, meta on
  // the second. Hover surface is a subtle tint, not a border-box —
  // hierarchy is carried by space and weight, the way the page does
  // it everywhere else. Click opens the bead detail modal. When the
  // card just moved between columns, `flashing` is true and a 1.5s
  // ring-highlight fades out (see `.ring-flash` in styles/index.css).
  return (
    <li
      className={`py-2 hover:bg-surface-tint -mx-2 px-2 rounded-sm transition-colors duration-150 ease-out-quart${flashing ? ' ring-flash' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSelect(card.id)}
        className="block w-full text-left focus-mark rounded-sm"
        title={`Open ${card.id}`}
      >
        <div className="flex items-baseline gap-2">
          <PriorityMark priority={card.priority} />
          <p className="text-body text-fg leading-snug line-clamp-2 min-w-0 flex-1">
            {card.title || '(untitled)'}
          </p>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2 text-label uppercase tracking-wider">
          <span className="text-fg-faint tnum truncate" title={card.id}>
            {card.id}
          </span>
          <div className="flex items-baseline gap-3 shrink-0">
            {card.open_blocker_count > 0 && (
              <StatusBadge
                tone="warn"
                label={`${card.open_blocker_count} blocked by`}
                className="text-label normal-case tracking-wider"
              />
            )}
            <span className="text-fg-muted truncate max-w-[6rem]" title={card.assignee || 'unassigned'}>
              {card.assignee || '·'}
            </span>
            <span className="text-fg-faint tnum tabular-nums whitespace-nowrap">
              {formatRelativeNow(card.last_active, now, column === 'closed_24h')}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function RecentMoves({
  moves,
  now,
}: {
  moves: ReadonlyArray<Move>;
  now: number;
}) {
  // Typographic activity feed below the board. Hairline divides, no
  // container chrome (Flat Page Rule). Each row reads as a sentence:
  // bead-id · from → to · 12s. Reads in greyscale because nothing
  // here is signaled by color alone.
  if (moves.length === 0) return null;
  return (
    <section className="mt-12 max-w-prose">
      <header className="space-y-1 mb-3">
        <h2 className="text-label uppercase tracking-wider text-fg">
          Recent moves
        </h2>
        <p className="text-label normal-case tracking-normal text-fg-faint italic leading-snug">
          Column transitions observed since you opened this view. Up to {RECENT_MOVES_CAP} shown, last two minutes.
        </p>
      </header>
      <ul className="divide-y divide-rule">
        {moves.map((m) => (
          <li
            key={m.moveId}
            className="py-2 flex items-baseline gap-3 text-body"
          >
            <span className="text-fg-faint tnum truncate min-w-0 flex-1" title={m.title}>
              {m.id}
            </span>
            <span className="text-label uppercase tracking-wider text-fg-muted whitespace-nowrap">
              {COLUMN_LABELS[m.from]}
              <span className="text-fg-faint mx-2" aria-hidden="true">
                →
              </span>
              {COLUMN_LABELS[m.to]}
            </span>
            <span
              className="text-label uppercase tracking-wider text-fg-faint tnum tabular-nums whitespace-nowrap w-12 text-right"
              title={new Date(m.at).toLocaleString()}
            >
              {formatRelative(m.at, now)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PriorityMark({ priority }: { priority: number }) {
  // Priority carries with text + color; P0 is the single loud signal,
  // P1 warm warn, P2+ quiet. Always paired with the literal "P{n}" so
  // the page still reads in greyscale.
  const tone =
    priority === 0
      ? 'text-accent'
      : priority === 1
        ? 'text-warn'
        : 'text-fg-faint';
  return (
    <span
      className={`text-label uppercase tracking-wider tnum shrink-0 ${tone}`}
      aria-label={`Priority ${priority}`}
    >
      P{priority}
    </span>
  );
}

function formatRelativeNow(
  iso: string | null,
  now: number,
  preferAbsolute: boolean,
): string {
  if (!iso) return '·';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '·';
  const diffSec = Math.max(0, Math.round((now - ms) / 1_000));
  if (preferAbsolute && diffSec >= 3600) {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h`;
  return `${Math.round(diffSec / 86_400)}d`;
}
