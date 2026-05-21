/**
 * Client-side column-transition detector and `Recent moves` log for the
 * Kanban view. Port "in spirit" of upstream cd-6w92: between Kanban
 * refreshes, diff the previous snapshot against the next, surface beads
 * whose column changed, and feed a rolling activity list below the
 * board.
 *
 * Pure detection lives in `detectMoves` — no React, no time, no DOM —
 * so the rule is unit-testable. Lifecycle and storage live in
 * `useKanbanMoves`, which holds the previous snapshot in a ref and the
 * capped log in state, and tracks short-lived `recentMoveIds` for the
 * ring-highlight on freshly-moved cards.
 *
 * What is NOT a move:
 *   - A bead that wasn't on the previous board (creation).
 *   - A bead that was on the previous board but isn't on the next
 *     (aged out of closed_24h, deleted, classifier excluded it).
 *   - A title or assignee change with the same column.
 *
 * Only same-id-different-column counts. Initial load (`prev === null`)
 * always returns `[]` so the operator doesn't see the entire board
 * "appear" as moves on first paint.
 */

import { useEffect, useRef, useState } from 'react';
import type { KanbanColumn, KanbanResponse } from 'gas-city-dashboard-shared';

export interface Move {
  /** Stable per-move identifier (bead id + at + to). Used as React key. */
  moveId: string;
  id: string;
  title: string;
  from: KanbanColumn;
  to: KanbanColumn;
  /** Epoch ms when the move was observed. */
  at: number;
}

/** Capacity of the rolling feed. */
export const RECENT_MOVES_CAP = 12;

/** Entries older than this fall off the feed. */
export const RECENT_MOVES_TTL_MS = 2 * 60 * 1_000;

/** A freshly-moved card carries a ring-highlight for this long. */
export const RING_HIGHLIGHT_MS = 1_800;

interface CardLocation {
  column: KanbanColumn;
  title: string;
}

function indexById(snapshot: KanbanResponse): Map<string, CardLocation> {
  const map = new Map<string, CardLocation>();
  for (const [col, cards] of Object.entries(snapshot.columns)) {
    for (const c of cards) {
      map.set(c.id, { column: col as KanbanColumn, title: c.title });
    }
  }
  return map;
}

/**
 * Diff two Kanban snapshots and return the moves observed.
 *
 * Pure function. `null` prev (no prior observation) always yields `[]`.
 */
export function detectMoves(
  prev: KanbanResponse | null,
  next: KanbanResponse,
  at: number,
): Move[] {
  if (prev === null) return [];

  const prevIndex = indexById(prev);
  const nextIndex = indexById(next);

  const moves: Move[] = [];
  for (const [id, nextLoc] of nextIndex) {
    const prevLoc = prevIndex.get(id);
    if (!prevLoc) continue;
    if (prevLoc.column === nextLoc.column) continue;
    moves.push({
      moveId: `${id}@${at}->${nextLoc.column}`,
      id,
      title: nextLoc.title,
      from: prevLoc.column,
      to: nextLoc.column,
      at,
    });
  }
  return moves;
}

interface UseKanbanMovesResult {
  /** Newest-first move log, capped + TTL-evicted. */
  moves: ReadonlyArray<Move>;
  /** Bead ids whose ring-highlight is currently active. */
  recentMoveIds: ReadonlySet<string>;
}

/**
 * Tracks Kanban column transitions across successive snapshots.
 *
 * Call with the latest `data` on every render. Internally:
 *   1. Compares against the previous observation (stored in a ref).
 *   2. Appends any new moves to the log, capped and TTL-pruned.
 *   3. Marks moved bead ids as "ring-flashing" for ~1.8s.
 *
 * The first observation seeds the ref without emitting moves.
 */
export function useKanbanMoves(
  data: KanbanResponse | null,
  options: { now?: number } = {},
): UseKanbanMovesResult {
  const prevRef = useRef<KanbanResponse | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [recentMoveIds, setRecentMoveIds] = useState<Set<string>>(() => new Set());
  const ringTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Track moves across data changes. Effect intentionally depends on
  // `data` only — `now` is read for TTL pruning but doesn't need to
  // re-trigger on every tick.
  useEffect(() => {
    if (data === null) return;
    const at = Date.now();
    const newMoves = detectMoves(prevRef.current, data, at);
    prevRef.current = data;

    if (newMoves.length > 0) {
      setMoves((current) => {
        const merged = [...newMoves, ...current];
        const cutoff = at - RECENT_MOVES_TTL_MS;
        return merged.filter((m) => m.at >= cutoff).slice(0, RECENT_MOVES_CAP);
      });
      setRecentMoveIds((current) => {
        const next = new Set(current);
        for (const m of newMoves) next.add(m.id);
        return next;
      });
      const timers = ringTimersRef.current;
      for (const m of newMoves) {
        const existing = timers.get(m.id);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          setRecentMoveIds((current) => {
            if (!current.has(m.id)) return current;
            const next = new Set(current);
            next.delete(m.id);
            return next;
          });
          timers.delete(m.id);
        }, RING_HIGHLIGHT_MS);
        timers.set(m.id, t);
      }
    }
  }, [data]);

  // TTL pruning runs on a clock independent of refreshes so old entries
  // disappear on schedule even if the Kanban hasn't refreshed.
  const nowMs = options.now;
  useEffect(() => {
    if (nowMs === undefined) return;
    setMoves((current) => {
      const cutoff = nowMs - RECENT_MOVES_TTL_MS;
      const filtered = current.filter((m) => m.at >= cutoff);
      return filtered.length === current.length ? current : filtered;
    });
  }, [nowMs]);

  // Clean up pending ring timers on unmount.
  useEffect(() => {
    const timers = ringTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return { moves, recentMoveIds };
}
