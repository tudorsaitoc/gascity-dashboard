import type { MaintainerTriage, TriageItem } from 'gas-city-dashboard-shared';
import { isMarkCandidate } from './classifier.js';
import { readSlungState, slungKey } from './slung-state.js';
import { collectItems, selectOneMark } from './triage.js';

/**
 * Mutates the cached envelope in place to reflect the latest slung
 * state. Order matters:
 *   1. Hydrate item.slung from the file (vetted-overrides-slung: a
 *      vetted item is not in flight even if the file says otherwise;
 *      the worker sweep eventually purges those entries from disk,
 *      this is the serve-side guarantee).
 *   2. Re-evaluate isMarkCandidate per item so item.is_marked
 *      reflects the slung filter. Tier was set at compose time and
 *      doesn't change here.
 *   3. Re-run selectOneMark across all items so the maroon dot lands
 *      on the next non-slung candidate.
 *
 * readSlungState swallows its own IO + parse errors and returns {},
 * so a corrupt slung-state file can't 502 the route.
 */
export async function applySlungOverlay(
  envelope: MaintainerTriage,
  slungStatePath: string,
): Promise<void> {
  const state = await readSlungState(slungStatePath);
  const allItems = collectItems(envelope);
  const slung: TriageItem[] = [];
  for (const item of allItems) {
    const persisted = state[slungKey(item.kind, item.number)];
    // Active slung: a persisted entry AND not yet vetted. Vetted items
    // force slung=null (the agent already delivered; slung was the
    // placeholder while waiting) and stay in their tier.
    const active = persisted !== undefined && item.triage_assessment == null;
    item.slung = active ? persisted : null;
    // Stamp the run-detail cross-link (gascity-dashboard-djpk): only
    // active-slung items can carry a run id, and only when the sling
    // captured a bead_id (null otherwise means slung-but-no-run-yet).
    if (active) item.run_id = persisted.bead_id ?? null;
    item.is_marked = item.tier !== null && isMarkCandidate(item, item.tier);
    if (active) slung.push(item);
  }
  // Winnow the One Mark before lifting slung items out of the tiers.
  // selectOneMark reads the flat list (not tier membership), and slung
  // items already have is_marked=false (isMarkCandidate excludes them),
  // so the mark lands on the top surviving in-tier candidate.
  selectOneMark(allItems);
  // Lift active-slung items out of their tier rows into a dedicated
  // section (gascity-dashboard-2yr) so the operator sees the in-flight
  // batch as a group instead of inline markers. Most-recent sling on top.
  if (slung.length > 0) {
    removeItemsFromTiers(envelope, slung);
    slung.sort((a, b) => (b.slung?.slung_at ?? '').localeCompare(a.slung?.slung_at ?? ''));
  }
  envelope.slung_section = slung;
}

/**
 * Remove the given items (by kind:number identity) from every tier's
 * clusters and unclustered lists, dropping any cluster left empty so the
 * UI never renders a zero-row cluster block.
 */
function removeItemsFromTiers(envelope: MaintainerTriage, toRemove: readonly TriageItem[]): void {
  const keys = new Set(toRemove.map((it) => slungKey(it.kind, it.number)));
  const keep = (it: TriageItem): boolean => !keys.has(slungKey(it.kind, it.number));
  for (const tier of envelope.tiers) {
    tier.clusters = tier.clusters
      .map((cluster) => ({ ...cluster, items: cluster.items.filter(keep) }))
      .filter((cluster) => cluster.items.length > 0);
    tier.unclustered = tier.unclustered.filter(keep);
  }
}
