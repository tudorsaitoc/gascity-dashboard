import type { TriageAssessment, TriageItem } from 'gas-city-dashboard-shared';

// Label-driven vetted triage assessment parser (gascity-dashboard-are).
//
// The triage skill agent, after assessing an item, applies a structured
// label convention on the GitHub issue/PR:
//
//   triage/vetted              — marker; presence indicates the agent
//                                has done its assessment
//   triage/severity-<n>        — n in 0..4 (lower = more severe; mirrors
//                                the existing priority/p* convention)
//   triage/simplicity-<band>   — band in {low, medium, high}
//
// All three labels must be present for parseTriageAssessment to return a
// non-null TriageAssessment. Any partial subset (e.g. vetted + severity
// without simplicity) yields null so the heuristic triage_score continues
// to drive sort and render. This avoids surfacing a half-vetted item as
// vetted; either the agent ran end-to-end or it didn't.
//
// vetted_score lives on the SAME numeric scale as classifier.ts's
// triage_score:
//
//   heuristic severity_base: regression_breaking=300, regression=200,
//                            stability=100
//   heuristic simplicity_bonus: typically [10, 50] within tier
//
// Mapping for vetted:
//   severity 0 → 300   (most severe — equivalent to regression_breaking base)
//   severity 1 → 250
//   severity 2 → 200   (equivalent to regression base)
//   severity 3 → 150
//   severity 4 → 100   (equivalent to stability base)
//   simplicity low=10, medium=30, high=50  (same band size as heuristic)
//
// So a vetted_score of 350 (sev0+high) reads "as actionable as the
// highest-scoring heuristic regression_breaking PR with a tiny diff",
// which is exactly the comparison the maintainer needs the sort to
// preserve when a tier mixes vetted and unvetted items.

const VETTED_MARKER = 'triage/vetted';
// Severity capture is constrained to the spec range [0..4] at the pattern
// level so out-of-range labels never reach the numeric parse path; the
// belt-and-suspenders range check in parseTriageAssessment stays as the
// explicit contract for future maintainers.
const SEVERITY_RE = /^triage\/severity-([0-4])$/;
const SIMPLICITY_RE = /^triage\/simplicity-(low|medium|high)$/;

const SEVERITY_BASE: Readonly<Record<number, number>> = {
  0: 300,
  1: 250,
  2: 200,
  3: 150,
  4: 100,
};

const SIMPLICITY_BONUS: Readonly<Record<string, number>> = {
  low: 10,
  medium: 30,
  high: 50,
};

export interface ParseTriageAssessmentOptions {
  /** ISO timestamp the parser stamps onto `vetted_at`. Defaults to now. */
  vettedAt?: string;
  /**
   * Optional notes text (e.g. extracted from a `triage-notes` fenced block
   * in the latest item comment). Defaults to empty string, since comments
   * are not yet fetched by the gh ingest pipeline.
   *
   * SECURITY (gascity-dashboard-8h3): when the ingest path lands, this
   * field will carry third-party-author-controllable content from PR/issue
   * comment bodies. The ingest implementation MUST length-cap (e.g. 2000
   * chars) and strip control chars at parse time, and every consumer MUST
   * render `TriageAssessment.notes` as plain text only, never via
   * `dangerouslySetInnerHTML` and never as unescaped markdown or HTML.
   */
  notes?: string;
}

/**
 * Pure label parser. Returns null when the item is not (fully) vetted;
 * returns a TriageAssessment when all three labels are present and parseable.
 */
export function parseTriageAssessment(
  labels: string[],
  opts: ParseTriageAssessmentOptions = {},
): TriageAssessment | null {
  let hasMarker = false;
  let severity: number | null = null;
  let simplicityBand: string | null = null;

  for (const label of labels) {
    if (label === VETTED_MARKER) {
      hasMarker = true;
      continue;
    }
    const sev = SEVERITY_RE.exec(label);
    if (sev) {
      // Non-optional capture group: a successful exec guarantees sev[1].
      // The assertion satisfies noUncheckedIndexedAccess; the regex
      // engine is the contract.
      const n = Number.parseInt(sev[1]!, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 4) severity = n;
      continue;
    }
    const sim = SIMPLICITY_RE.exec(label);
    if (sim) {
      simplicityBand = sim[1]!;
      continue;
    }
  }

  if (!hasMarker || severity === null || simplicityBand === null) return null;

  const base = SEVERITY_BASE[severity];
  const bonus = SIMPLICITY_BONUS[simplicityBand];
  if (base === undefined || bonus === undefined) return null;

  return {
    vetted_score: base + bonus,
    source: 'agent',
    notes: opts.notes ?? '',
    vetted_at: opts.vettedAt ?? new Date().toISOString(),
  };
}

/**
 * Comparator key used everywhere within-tier item lists are sorted. When a
 * vetted assessment is present its vetted_score wins; otherwise the
 * heuristic triage_score is used. Defensive `?? 0` keeps not-yet-scored
 * items at the bottom without making every caller branch on score presence.
 *
 * Centralising this here keeps the three sort sites (triage.ts,
 * blast-radius.ts, topics.ts) consistent — if the precedence rule ever
 * changes, it changes in one place.
 */
export function sortScore(item: TriageItem): number {
  if (item.triage_assessment !== null) return item.triage_assessment.vetted_score;
  return item.triage_score ?? 0;
}
