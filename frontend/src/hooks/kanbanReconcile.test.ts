import { describe, expect, it } from 'vitest';
import type { KanbanCard, KanbanColumn, KanbanResponse } from 'gas-city-dashboard-shared';
import { reconcileKanban } from './kanbanReconcile';

const AT = '2026-05-23T12:00:00.000Z';

function card(id: string, opts: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: opts.title ?? `Title for ${id}`,
    assignee: opts.assignee ?? '',
    last_active: opts.last_active ?? null,
    open_blocker_count: opts.open_blocker_count ?? 0,
    priority: opts.priority ?? 2,
  };
}

function emptyColumns(): Record<KanbanColumn, KanbanCard[]> {
  return {
    mayor_plate: [],
    in_flight: [],
    stalled: [],
    blocked_real: [],
    blocked_stale: [],
    in_review: [],
    needs_changes: [],
    approved: [],
    closed_24h: [],
  };
}

function snapshot(
  placements: Partial<Record<KanbanColumn, KanbanCard[]>>,
): KanbanResponse {
  const columns = emptyColumns();
  for (const [col, cards] of Object.entries(placements)) {
    columns[col as KanbanColumn] = cards ?? [];
  }
  const total = Object.values(columns).reduce((n, cs) => n + cs.length, 0);
  return { as_of: AT, columns, total };
}

describe('reconcileKanban', () => {
  it('passes next through unchanged on initial load (prev null) and clears absence', () => {
    const absence = new Map<string, number>([['stale', 1]]);
    const next = snapshot({ in_flight: [card('bead-1')] });
    const out = reconcileKanban(null, next, absence);
    expect(out).toBe(next);
    expect(absence.size).toBe(0);
  });

  it('retains a transiently-missing card for one refresh', () => {
    const prev = snapshot({ in_flight: [card('keep'), card('vanish')] });
    const next = snapshot({ in_flight: [card('keep')] });
    const absence = new Map<string, number>();

    const out = reconcileKanban(prev, next, absence);
    const ids = out.columns.in_flight.map((c) => c.id);
    expect(ids).toContain('vanish');
    expect(ids).toContain('keep');
    expect(out.total).toBe(2);
    expect(absence.get('vanish')).toBe(1);
  });

  it('drops a card after two consecutive misses', () => {
    const prev = snapshot({ in_flight: [card('keep'), card('vanish')] });
    const next = snapshot({ in_flight: [card('keep')] });
    const absence = new Map<string, number>();

    // First miss: retained.
    const first = reconcileKanban(prev, next, absence);
    expect(first.columns.in_flight.map((c) => c.id)).toContain('vanish');

    // Second consecutive miss: dropped. prev is the reconciled output, which
    // still carried 'vanish'; next still omits it.
    const second = reconcileKanban(first, next, absence);
    expect(second.columns.in_flight.map((c) => c.id)).not.toContain('vanish');
    expect(second.total).toBe(1);
    expect(absence.has('vanish')).toBe(false);
  });

  it('resets the miss counter when a card reappears', () => {
    const full = snapshot({ in_flight: [card('keep'), card('flaky')] });
    const partial = snapshot({ in_flight: [card('keep')] });
    const absence = new Map<string, number>();

    // Miss once (retained, absence=1).
    reconcileKanban(full, partial, absence);
    expect(absence.get('flaky')).toBe(1);

    // Reappears: counter cleared, no pending miss.
    const recovered = reconcileKanban(partial, full, absence);
    expect(recovered.columns.in_flight.map((c) => c.id)).toContain('flaky');
    expect(absence.has('flaky')).toBe(false);
  });

  it('keeps the retained card in its prior column', () => {
    const prev = snapshot({ blocked_real: [card('blk')], in_flight: [card('run')] });
    const next = snapshot({ in_flight: [card('run')] });
    const absence = new Map<string, number>();

    const out = reconcileKanban(prev, next, absence);
    expect(out.columns.blocked_real.map((c) => c.id)).toContain('blk');
    expect(out.columns.in_flight.map((c) => c.id)).toEqual(['run']);
  });
});
