import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { TriageItem, TriageItemStatus } from 'gas-city-dashboard-shared';
import { selectOneMark } from '../src/maintainer/triage.js';

// gascity-dashboard-bs2: One Mark must skip issues with in-flight PRs.
// The maroon ● indicates "what most needs operator action." The only
// meaningful operator move on a maintainer triage row is slinging a
// triage/draft agent. If an open PR already exists for an issue, the
// PR IS the action queue — slinging would just duplicate it.
//
// These tests pin the selectOneMark contract directly. The slung-overlay
// integration coverage lives in maintainer-sling.test.ts; here we lock
// down the pure function.

const FIXED_ISO = '2026-05-24T00:00:00.000Z';

interface ItemOverrides extends Partial<TriageItem> {
  number: number;
}

function makeIssue(overrides: ItemOverrides): TriageItem {
  return {
    kind: 'issue',
    title: `issue ${overrides.number}`,
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
    lines_changed: null,
    weak_ties: [],
    linked_numbers: [],
    html_url: `https://example/issues/${overrides.number}`,
    // Issues are not mark candidates per isMarkCandidate, so default false.
    is_marked: false,
    ...overrides,
  };
}

function makePr(overrides: ItemOverrides): TriageItem {
  return {
    kind: 'pr',
    title: `pr ${overrides.number}`,
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
    lines_changed: 50,
    weak_ties: [],
    linked_numbers: [],
    html_url: `https://example/pull/${overrides.number}`,
    is_marked: true,
    ...overrides,
  };
}

describe('selectOneMark — One Mark Rule winnower', () => {
  test('single marked PR wins the mark', () => {
    const pr = makePr({ number: 1 });
    selectOneMark([pr]);
    assert.equal(pr.is_marked, true);
  });

  test('multiple marked PRs: only the top scorer keeps the mark', () => {
    const top = makePr({ number: 1, triage_score: 350 });
    const lower = makePr({ number: 2, triage_score: 300 });
    selectOneMark([top, lower]);
    assert.equal(top.is_marked, true);
    assert.equal(lower.is_marked, false);
  });

  test('items not is_marked are not considered candidates', () => {
    const pr = makePr({ number: 1, is_marked: false });
    selectOneMark([pr]);
    assert.equal(pr.is_marked, false);
  });
});

describe('selectOneMark — in-flight PR excludes parent issue from the mark (bs2)', () => {
  test('issue + open PR pair: mark stays on the PR, NOT transferred to issue', () => {
    // Bug #2522 + PR #2558 "closes #2522" shape from the bead description.
    // Before bs2: transfer block handed mark to the issue. After bs2:
    // PR keeps it because the PR IS the action queue.
    const issue = makeIssue({ number: 2522 });
    const pr = makePr({
      number: 2558,
      linked_numbers: [2522],
      status: 'open',
    });
    selectOneMark([issue, pr]);
    assert.equal(issue.is_marked, false, 'issue must not carry the mark');
    assert.equal(pr.is_marked, true, 'PR keeps the mark — it is the action queue');
  });

  test('issue + draft PR pair: same exclusion (draft still means in-flight)', () => {
    const issue = makeIssue({ number: 100 });
    const pr = makePr({
      number: 101,
      linked_numbers: [100],
      status: 'draft',
      // Draft PRs are excluded by isMarkCandidate, so they would not
      // normally arrive with is_marked=true — but selectOneMark must
      // never anchor on the parent issue regardless.
      is_marked: false,
    });
    selectOneMark([issue, pr]);
    assert.equal(issue.is_marked, false, 'parent issue must not carry the mark');
    assert.equal(pr.is_marked, false, 'draft PR was not a candidate to begin with');
  });

  test('issue + needs_review PR: PR keeps the mark (in-flight)', () => {
    const issue = makeIssue({ number: 200 });
    const pr = makePr({
      number: 201,
      linked_numbers: [200],
      status: 'needs_review',
    });
    selectOneMark([issue, pr]);
    assert.equal(issue.is_marked, false);
    assert.equal(pr.is_marked, true);
  });

  test('issue with multiple open PR children: any one open PR is enough', () => {
    const issue = makeIssue({ number: 300 });
    const prA = makePr({
      number: 301,
      linked_numbers: [300],
      triage_score: 320,
    });
    const prB = makePr({
      number: 302,
      linked_numbers: [300],
      triage_score: 310,
    });
    selectOneMark([issue, prA, prB]);
    assert.equal(issue.is_marked, false, 'parent issue does not carry the mark');
    // Top scorer wins among the two PRs.
    assert.equal(prA.is_marked, true);
    assert.equal(prB.is_marked, false);
  });

  test('standalone PR with no parent in envelope: keeps its mark', () => {
    const pr = makePr({ number: 400, linked_numbers: [9999] });
    selectOneMark([pr]);
    assert.equal(pr.is_marked, true);
  });

  test('PR with linked parent in envelope: PR retains mark (no transfer)', () => {
    // Even though parent issue is in view, the mark stays with the PR.
    // This is the inverse-statement of the headline case — gates the
    // legacy parent-transfer behaviour.
    const parent = makeIssue({ number: 500 });
    const pr = makePr({ number: 501, linked_numbers: [500] });
    selectOneMark([parent, pr]);
    assert.equal(parent.is_marked, false);
    assert.equal(pr.is_marked, true);
  });
});
