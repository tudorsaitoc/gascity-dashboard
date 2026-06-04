// dw8 — "Needs you" composite predicate over the Maintainer triage
// surface (PRD §6 / specs/plans/workflow-observability-prd.md R13).
//
// The composite is an OR of six documented clauses, each its own named
// pure predicate so per-clause logic is independently testable and so a
// future bead can re-weight or disable a clause without rewriting the
// composite. Tests live in `needsYou.test.ts`.
//
// The clause set was derived from the architect's plan review (H3 in
// the bead's PLAN-REVIEW note): the original "changes-requested OR
// needs-review OR stalled" bullet missed at least three obvious
// "needs you" cases — approved-unmerged PRs (the literal "human
// approval gate"), One Mark Rule marked items, and agent-vetted-but-
// not-yet-acted-on items. Each clause cites why it qualifies.

import type { TriageItem, TriageTierSection } from 'gas-city-dashboard-shared';

/**
 * The `?view=...` query value that activates needs-you mode on the
 * Maintainer page. Single source of truth for both the resolver alias
 * key (`frontend/src/views/resolve.ts` → `VIEW_ALIASES`) and the
 * Maintainer page's mode-detection check. Renaming the activation
 * surface requires editing this one constant.
 */
export const NEEDS_YOU_VIEW_PARAM = 'needs-you';

/**
 * Stall threshold for the `isStalledUnvetted` clause.
 *
 * Distinct from `STALENESS_THRESHOLD_MS` in `frontend/src/hooks/useStaleness.ts`
 * (30 minutes for live workflow lanes). Lane staleness is heartbeat-driven
 * and measured in minutes because a workflow that has been silent for half
 * an hour is genuinely stuck. Triage-item staleness is GitHub-activity-driven
 * and measured in days — a PR with no comment in a week is plausibly idle
 * regardless of how active the operator's workflow lanes are. Reusing the
 * lane threshold here would surface every triage item as stalled.
 */
export const NEEDS_YOU_STALL_THRESHOLD_DAYS = 7;
export const NEEDS_YOU_STALL_THRESHOLD_MS = NEEDS_YOU_STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

/** PR/issue whose status is `changes_requested` — a review cycle is open
 *  and someone owes a response (contributor or operator). */
export function isChangesRequested(item: TriageItem): boolean {
  return item.status === 'changes_requested';
}

/** PR/issue whose status is `needs_review` — the review queue lands on
 *  the operator. */
export function isAwaitingReview(item: TriageItem): boolean {
  return item.status === 'needs_review';
}

/** PR with status `approved` — the literal human-approval gate: the merge
 *  button is the next action and only a human can click it. Restricted to
 *  `kind === 'pr'` because issues do not merge. */
export function isAwaitingMerge(item: TriageItem): boolean {
  return item.kind === 'pr' && item.status === 'approved';
}

/** Item flagged by the One Mark Rule (bug + breaking + actively shipping).
 *  See `TriageItem.is_marked` in `shared/src/index.ts`. */
export function isMarked(item: TriageItem): boolean {
  return item.is_marked;
}

/** Agent has finished vetting (`triage_assessment !== null`) AND the item
 *  is no longer in flight to an agent (`slung === null`). The operator's
 *  next-action decision (close / sling-for-PR / merge) is the only thing
 *  standing between this item and being done.
 *
 *  Deliberate non-overlap with `isStalledUnvetted`: that predicate
 *  excludes vetted items, this one requires them. Together they cover
 *  the two "agent has done what it can; over to you" cases the operator
 *  needs to see. */
export function isVettedAwaitingDecision(item: TriageItem): boolean {
  return item.triage_assessment !== null && item.slung === null;
}

/** Untouched backlog: `updated_at` strictly older than the threshold AND
 *  no agent has vetted it AND no agent is currently working on it.
 *  Strict `>` so an item touched exactly at the threshold is NOT yet
 *  stalled — round-trip tests pin this. */
export function isStalledUnvetted(item: TriageItem, now: Date | number): boolean {
  if (item.triage_assessment !== null) return false;
  if (item.slung !== null) return false;
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const updatedMs = Date.parse(item.updated_at);
  if (Number.isNaN(updatedMs)) return false;
  return nowMs - updatedMs > NEEDS_YOU_STALL_THRESHOLD_MS;
}

/** Composite: OR of the six clauses above. `now` is injected so the
 *  caller controls the clock (NowContext on the frontend, fixed time in
 *  tests). */
export function isNeedsYou(item: TriageItem, now: Date | number): boolean {
  return (
    isChangesRequested(item) ||
    isAwaitingReview(item) ||
    isAwaitingMerge(item) ||
    isMarked(item) ||
    isVettedAwaitingDecision(item) ||
    isStalledUnvetted(item, now)
  );
}

/** Filter a single tier section to items matching `isNeedsYou`. Returns
 *  a new `TriageTierSection`; the input is not mutated. Empty clusters
 *  are dropped (mirrors `filterTierByNeedsPr` / `filterTierByAwaitingTriage`
 *  in `Maintainer.tsx`). `lines_pending` is passed through unchanged —
 *  it is the tier-level metric the wire envelope ships, and recomputing
 *  it here would make the "N of M" header reads inconsistent with the
 *  unfiltered envelope. */
export function filterTierByNeedsYou(
  section: TriageTierSection,
  now: Date | number,
): TriageTierSection {
  const keep = (item: TriageItem): boolean => isNeedsYou(item, now);
  const filteredClusters = section.clusters
    .map((cluster) => ({
      ...cluster,
      items: cluster.items.filter(keep),
    }))
    .filter((cluster) => cluster.items.length > 0);
  return {
    ...section,
    clusters: filteredClusters,
    unclustered: section.unclustered.filter(keep),
  };
}
