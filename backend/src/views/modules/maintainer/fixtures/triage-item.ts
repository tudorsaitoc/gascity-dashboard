// Shared TriageItem test fixtures for backend test suites.
//
// Why this lives here: prior to gascity-dashboard-i8w each backend test
// file that needed a TriageItem inlined its own makeIssue / makePr
// helper. When the wire shape grew a required field
// (e.g. `triage_assessment` per gascity-dashboard-are), each local
// helper had to be updated independently — the xba-wave CI break was
// exactly this drift, where one test file's helper got the new field
// and another did not, and the second only went red on
// `tsc --project tsconfig.test.json`, not on the default typecheck.
//
// Consolidating to one fixture means adding a new required field to
// TriageItem is a single-file update (this file) plus whichever tests
// actually exercise the new field.
//
// Scope note: a shared fixture across backend AND frontend was
// considered and rejected. Frontend tests run under Vitest in a JSDOM
// environment with a separate tsconfig path graph; importing across
// `backend/` and `frontend/` worktree roots would require a third
// workspace package or fragile relative paths. The two test surfaces
// already differ in the TriageItem subset they exercise (the frontend
// fixture covers render-shape assertions, the backend one covers
// scoring + overlay logic). Keep this fixture backend-only; the
// frontend equivalent is `frontend/src/views/modules/maintainer/maintainerSelection.test.ts`'s
// mkItem helper — left in place per the bead's OUT OF SCOPE.

import type { TriageItem, TriageItemStatus } from 'gas-city-dashboard-shared';

const FIXED_ISO = '2026-05-24T00:00:00.000Z';

/**
 * Canonical defaults shared by both factories. Authored as a plain
 * function rather than a frozen object so callers cannot accidentally
 * mutate the shared state across tests.
 *
 * Default tier is `regression_breaking` + `triage_score: 300` so the
 * item is a plausible One Mark candidate without further setup; tests
 * that need a different tier override explicitly.
 */
function commonDefaults(
  number: number,
): Omit<TriageItem, 'kind' | 'title' | 'html_url' | 'lines_changed' | 'is_marked'> {
  return {
    number,
    status: 'open' as TriageItemStatus,
    author: {
      login: 'someone',
      tier: 'regular',
      issues_accepted: null,
      issues_opened: null,
      prs_merged: null,
      prs_opened: null,
      computed_at: null,
    },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    labels: ['kind/bug', 'priority/p0'],
    tier: 'regression_breaking',
    triage_score: 300,
    triage_assessment: null,
    slung: null,
    cluster_id: null,
    blast_files: [],
    weak_ties: [],
    linked_numbers: [],
    // Default false: most fixture-driven tests construct items in
    // isolation and don't care about the omv signal. Tests that
    // exercise the needs-PR semantics set this explicitly via
    // computeHasInFlightPr or via overrides.
    has_in_flight_pr: false,
  };
}

/**
 * Build a TriageItem with kind='issue'. Default `is_marked: false`
 * because issues are not One Mark candidates (`isMarkCandidate` rejects
 * them); tests opt in by overriding.
 */
export function makeIssue(overrides: Partial<TriageItem> & { number: number }): TriageItem {
  return {
    ...commonDefaults(overrides.number),
    kind: 'issue',
    title: `issue ${overrides.number}`,
    html_url: `https://example/issues/${overrides.number}`,
    lines_changed: null,
    is_marked: false,
    ...overrides,
  };
}

/**
 * Build a TriageItem with kind='pr'. Default `is_marked: true` because
 * PRs are the typical One Mark candidates in these test suites; tests
 * that exercise non-candidate PRs override explicitly.
 *
 * Default `lines_changed: 50` is arbitrary — no test asserts on the
 * value. The two pre-consolidation factories disagreed (50 vs 100);
 * 50 was chosen as the smaller, safer default for clusters where the
 * value would feed into a sum.
 */
export function makePr(overrides: Partial<TriageItem> & { number: number }): TriageItem {
  return {
    ...commonDefaults(overrides.number),
    kind: 'pr',
    title: `pr ${overrides.number}`,
    html_url: `https://example/pull/${overrides.number}`,
    lines_changed: 50,
    is_marked: true,
    ...overrides,
  };
}
