import type { KanbanCard, KanbanColumn, KanbanResponse } from 'gas-city-dashboard-shared';
import { KANBAN_COLUMNS } from 'gas-city-dashboard-shared';

/**
 * gascity-dashboard-0sh (ported from upstream cd-tle7m): reconcile a
 * freshly-fetched Kanban against the last displayed one so a transiently-
 * missing bead doesn't flicker out. The supervisor's
 * /v0/city/{name}/beads can return an inconsistent PARTIAL city-store set
 * per call (the high-churn city/td- store is read mid-bd-auto-import-
 * rebuild; reproduced upstream: td- count swings 14/31/22/32 across
 * consecutive calls while stable stores stay put). So a card present last
 * refresh but absent now is almost always a partial read, not a real
 * removal. Retain such a card for ONE refresh; only drop it after it's
 * been absent from TWO consecutive responses. `absence` holds the
 * per-bead consecutive-miss count (mutated in place).
 *
 * Note: this is a display-layer mitigation; the root fix is a consistent
 * supervisor read (upstream td-k3rxae family).
 */
export function reconcileKanban(
  prev: KanbanResponse | null,
  next: KanbanResponse,
  absence: Map<string, number>,
): KanbanResponse {
  if (prev === null) {
    absence.clear();
    return next;
  }
  const nextIds = new Set<string>();
  for (const col of KANBAN_COLUMNS) {
    for (const card of next.columns[col] ?? []) nextIds.add(card.id);
  }
  // Cards present this read reset their miss counter.
  for (const id of nextIds) absence.delete(id);
  // Start from next, then carry over cards that were displayed last time
  // but are missing now — unless they've already missed once (2nd
  // consecutive miss => genuine removal, drop it).
  const columns = {} as Record<KanbanColumn, KanbanCard[]>;
  for (const col of KANBAN_COLUMNS) {
    columns[col] = [...(next.columns[col] ?? [])];
    for (const card of prev.columns[col] ?? []) {
      if (nextIds.has(card.id)) continue;
      if ((absence.get(card.id) ?? 0) === 0) {
        absence.set(card.id, 1);
        columns[col].push(card);
      } else {
        absence.delete(card.id);
      }
    }
  }
  let total = 0;
  for (const col of KANBAN_COLUMNS) total += columns[col].length;
  return { as_of: next.as_of, columns, total };
}
