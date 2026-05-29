import type { TriageItem, TriageTier } from 'gas-city-dashboard-shared';

// Priority classifier + triage scoring (gascity-dashboard-7ts).
//
// Two passes:
//   1. classifyTier(item) — labels → tier. Deterministic; the labels
//      carry the semantic load, this just maps them.
//   2. computeTriageScore(item, tier) — severity (from tier) + a
//      simplicity-of-fix bonus, so the top of each tier section is
//      the highest-priority-by-triage item: big severity AND likely
//      to ship soon. Captures the maintainer's actual triage skill
//      of "balance burning fires against quick wins."
//
// gastownhall/gascity uses a structured label taxonomy:
//   kind/<bug|chore|feature|enhancement|refactor|docs|design|performance>
//   priority/<p0|p1|p2|p3>
//   status/<needs-review|in-progress|needs-triage|needs-info|...>
//   area/<beads|...>
//
// Mapping (per PRODUCT.md: bugs > breaking > stability):
//   kind/bug AND priority/{p0,p1}  → regression_breaking
//   kind/bug                       → regression
//   *                              → stability
//
// Items lacking any kind/* label default to stability. A follow-up bead
// can add an LLM fallback for the unlabeled long tail if coverage on
// other repos is sparse — here it's high.

const BUG_LABEL = 'kind/bug';
const BREAKING_PRIORITY_LABELS: ReadonlySet<string> = new Set([
  'priority/p0',
  'priority/p1',
]);

export interface ClassifiedItem {
  tier: TriageTier;
  is_marked: boolean;
  triage_score: number;
}

export function classifyItem(item: TriageItem): ClassifiedItem {
  const tier = classifyTier(item);
  const is_mark_candidate = isMarkCandidate(item, tier);
  const triage_score = computeTriageScore(item, tier);
  // is_marked is provisional here — composeEnvelope (in triage.ts) does
  // the global top-1 winnowing so at most ONE item carries the mark
  // across the entire page, honouring the One Mark Rule.
  return { tier, is_marked: is_mark_candidate, triage_score };
}

function classifyTier(item: TriageItem): TriageTier {
  const labels = new Set(item.labels);
  const isBug = labels.has(BUG_LABEL);
  const isBreaking = anyOf(labels, BREAKING_PRIORITY_LABELS);
  if (isBug && isBreaking) return 'regression_breaking';
  if (isBug) return 'regression';
  return 'stability';
}

/**
 * Candidate test for the One Mark. The maintainer's most-actionable
 * single move is "merge a non-blocked PR that fixes a P0/P1 bug" —
 * the one thing worth interrupting their day for. So:
 *   - kind must be 'pr' (issues are not directly shippable)
 *   - tier must be regression_breaking
 *   - status NOT 'draft' (author still working on it)
 *   - status NOT 'changes_requested' (review feedback to address)
 *   - NOT currently slung (item is already with the triage agent;
 *     mark should move to the next unhandled candidate — gascity-
 *     dashboard-9qs). Loose `!= null` catches stale-cache `undefined`.
 * Everything else (open / approved / needs_review) qualifies because
 * gh's reviewDecision is null on most PRs in this workflow — open
 * effectively means "in the review queue, not blocked."
 *
 * Page-level uniqueness contract: this predicate identifies *candidates*
 * per item, not the winner. selectOneMark (backend/src/maintainer/triage.ts)
 * scans the flat list and clears `is_marked` on every non-top-scorer so at
 * most one item per envelope carries the maroon mark. The frontend renderer
 * (TriageSections.tsx IssueRow + PrRow) emits the mark per-row based on
 * `item.is_marked` and trusts this backend invariant — it does NOT enforce
 * uniqueness itself. Any change that lets two candidates survive
 * selectOneMark would silently render two maroon marks on the page; keep
 * the winnow + the predicate change in the same commit if you touch either.
 */
export function isMarkCandidate(item: TriageItem, tier: TriageTier): boolean {
  if (item.kind !== 'pr') return false;
  if (tier !== 'regression_breaking') return false;
  if (item.slung != null) return false;
  return item.status !== 'draft' && item.status !== 'changes_requested';
}

/**
 * Higher score = should appear closer to the top of its tier section.
 *
 * Score = severity_base + simplicity_bonus
 *
 * severity_base sets the tier-major ordering even if the wire-shape ever
 * mixed tiers in a single list. simplicity_bonus is the within-tier
 * sorter — bubbles up items that the maintainer can dispatch quickly.
 */
function computeTriageScore(item: TriageItem, tier: TriageTier): number {
  const severityBase =
    tier === 'regression_breaking' ? 300 : tier === 'regression' ? 200 : 100;

  let simplicityBonus = 0;
  const labels = new Set(item.labels);

  if (item.kind === 'pr') {
    // Smaller diff = simpler to land. lines_changed includes additions +
    // deletions; the bands are deliberately coarse (don't pretend to
    // know the true complexity from line count alone).
    const lines = item.lines_changed ?? 0;
    if (lines < 50) simplicityBonus += 50;
    else if (lines < 200) simplicityBonus += 35;
    else if (lines < 500) simplicityBonus += 20;
    else if (lines < 1000) simplicityBonus += 10;
    // PR status adjustments — "approved" is the most-shippable;
    // "draft" / "changes_requested" need more work before merge.
    if (item.status === 'approved') simplicityBonus += 15;
    else if (item.status === 'needs_review') simplicityBonus += 10;
    else if (item.status === 'draft') simplicityBonus -= 15;
    else if (item.status === 'changes_requested') simplicityBonus -= 10;
  } else {
    // For issues: a linked open PR means someone's already on it, so
    // from the maintainer's POV the issue is closer to "ship the PR"
    // than to "fix from scratch."
    if (item.linked_numbers.length > 0) simplicityBonus += 40;
    // Friction labels — issue itself is blocked / stuck.
    if (labels.has('status/needs-info')) simplicityBonus -= 25;
    if (labels.has('status/needs-repro')) simplicityBonus -= 25;
    if (labels.has('status/stale')) simplicityBonus -= 30;
    if (labels.has('status/help-wanted')) simplicityBonus -= 15;
  }

  return severityBase + simplicityBonus;
}

function anyOf<T>(set: ReadonlySet<T>, candidates: ReadonlySet<T>): boolean {
  for (const c of candidates) {
    if (set.has(c)) return true;
  }
  return false;
}
