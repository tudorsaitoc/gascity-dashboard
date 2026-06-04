import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyItem, isMarkCandidate } from './classifier.js';
import { makeIssue, makePr } from './fixtures/triage-item.js';

// gascity-dashboard-z9sj: direct unit coverage for the priority classifier.
// classifyTier + computeTriageScore are module-private, so they are pinned
// through the exported classifyItem (which surfaces both `tier` and
// `triage_score`). isMarkCandidate is exported and tested directly.
//
// These pin the scoring bands and tier mapping so a band boundary or label
// mapping regression fails loudly instead of silently re-ordering the page.

describe('classifyItem — tier mapping from labels', () => {
  test('kind/bug + priority/p0 → regression_breaking', () => {
    const item = makeIssue({ number: 1, labels: ['kind/bug', 'priority/p0'] });
    assert.equal(classifyItem(item).tier, 'regression_breaking');
  });

  test('kind/bug + priority/p1 → regression_breaking', () => {
    const item = makeIssue({ number: 2, labels: ['kind/bug', 'priority/p1'] });
    assert.equal(classifyItem(item).tier, 'regression_breaking');
  });

  test('kind/bug + priority/p2 → regression (p2 is not a breaking priority)', () => {
    const item = makeIssue({ number: 3, labels: ['kind/bug', 'priority/p2'] });
    assert.equal(classifyItem(item).tier, 'regression');
  });

  test('kind/bug alone → regression', () => {
    const item = makeIssue({ number: 4, labels: ['kind/bug'] });
    assert.equal(classifyItem(item).tier, 'regression');
  });

  test('priority/p0 without kind/bug → stability (breaking priority alone is not a bug)', () => {
    const item = makeIssue({ number: 5, labels: ['priority/p0'] });
    assert.equal(classifyItem(item).tier, 'stability');
  });

  test('no kind label → stability', () => {
    const item = makeIssue({ number: 6, labels: ['kind/feature', 'area/beads'] });
    assert.equal(classifyItem(item).tier, 'stability');
  });

  test('empty labels → stability', () => {
    const item = makeIssue({ number: 7, labels: [] });
    assert.equal(classifyItem(item).tier, 'stability');
  });
});

describe('classifyItem — triage_score severity base by tier', () => {
  // Severity base: regression_breaking 300, regression 200, stability 100.
  // Use an issue with no friction labels and no linked PRs so simplicityBonus
  // is exactly 0 and the base is observable.
  test('regression_breaking issue, no bonus → 300', () => {
    const item = makeIssue({ number: 1, labels: ['kind/bug', 'priority/p0'] });
    assert.equal(classifyItem(item).triage_score, 300);
  });

  test('regression issue, no bonus → 200', () => {
    const item = makeIssue({ number: 2, labels: ['kind/bug'] });
    assert.equal(classifyItem(item).triage_score, 200);
  });

  test('stability issue, no bonus → 100', () => {
    const item = makeIssue({ number: 3, labels: [] });
    assert.equal(classifyItem(item).triage_score, 100);
  });
});

describe('classifyItem — PR simplicity bonus by lines_changed band', () => {
  // Bands: <50 +50, <200 +35, <500 +20, <1000 +10, >=1000 +0.
  // Use status 'open' (no status delta) on a regression_breaking PR (base 300).
  function scoreForLines(lines: number): number {
    const pr = makePr({
      number: 1,
      labels: ['kind/bug', 'priority/p0'],
      status: 'open',
      lines_changed: lines,
    });
    return classifyItem(pr).triage_score;
  }

  test('0 lines → +50 (300+50=350)', () => assert.equal(scoreForLines(0), 350));
  test('49 lines (just under 50) → +50', () => assert.equal(scoreForLines(49), 350));
  test('50 lines (band boundary) → +35 (300+35=335)', () => assert.equal(scoreForLines(50), 335));
  test('199 lines → +35', () => assert.equal(scoreForLines(199), 335));
  test('200 lines (boundary) → +20 (300+20=320)', () => assert.equal(scoreForLines(200), 320));
  test('499 lines → +20', () => assert.equal(scoreForLines(499), 320));
  test('500 lines (boundary) → +10 (300+10=310)', () => assert.equal(scoreForLines(500), 310));
  test('999 lines → +10', () => assert.equal(scoreForLines(999), 310));
  test('1000 lines (boundary) → +0 (300)', () => assert.equal(scoreForLines(1000), 300));
  test('5000 lines → +0', () => assert.equal(scoreForLines(5000), 300));

  test('null lines_changed treated as 0 → +50', () => {
    const pr = makePr({
      number: 9,
      labels: ['kind/bug', 'priority/p0'],
      status: 'open',
      lines_changed: null,
    });
    assert.equal(classifyItem(pr).triage_score, 350);
  });
});

describe('classifyItem — PR status delta', () => {
  // Small (<50 lines, +50) regression_breaking PR base = 350 before status.
  function scoreForStatus(status: Parameters<typeof makePr>[0]['status']): number {
    const pr = makePr({
      number: 1,
      labels: ['kind/bug', 'priority/p0'],
      status,
      lines_changed: 10,
    });
    return classifyItem(pr).triage_score;
  }

  test('approved → +15 (350+15=365)', () => assert.equal(scoreForStatus('approved'), 365));
  test('needs_review → +10 (350+10=360)', () => assert.equal(scoreForStatus('needs_review'), 360));
  test('open → +0 (350)', () => assert.equal(scoreForStatus('open'), 350));
  test('draft → -15 (350-15=335)', () => assert.equal(scoreForStatus('draft'), 335));
  test('changes_requested → -10 (350-10=340)', () =>
    assert.equal(scoreForStatus('changes_requested'), 340));
});

describe('classifyItem — issue simplicity bonus', () => {
  // Stability issue base = 100.
  test('linked open PR (linked_numbers non-empty) → +40 (140)', () => {
    const item = makeIssue({ number: 1, labels: [], linked_numbers: [42] });
    assert.equal(classifyItem(item).triage_score, 140);
  });

  test('status/needs-info → -25 (75)', () => {
    const item = makeIssue({ number: 2, labels: ['status/needs-info'] });
    assert.equal(classifyItem(item).triage_score, 75);
  });

  test('status/needs-repro → -25 (75)', () => {
    const item = makeIssue({ number: 3, labels: ['status/needs-repro'] });
    assert.equal(classifyItem(item).triage_score, 75);
  });

  test('status/stale → -30 (70)', () => {
    const item = makeIssue({ number: 4, labels: ['status/stale'] });
    assert.equal(classifyItem(item).triage_score, 70);
  });

  test('status/help-wanted → -15 (85)', () => {
    const item = makeIssue({ number: 5, labels: ['status/help-wanted'] });
    assert.equal(classifyItem(item).triage_score, 85);
  });

  test('friction labels stack: needs-info + stale → -55 (45)', () => {
    const item = makeIssue({
      number: 6,
      labels: ['status/needs-info', 'status/stale'],
    });
    assert.equal(classifyItem(item).triage_score, 45);
  });

  test('linked PR + friction: +40 -25 → 115', () => {
    const item = makeIssue({
      number: 7,
      labels: ['status/needs-info'],
      linked_numbers: [99],
    });
    assert.equal(classifyItem(item).triage_score, 115);
  });
});

describe('isMarkCandidate — truth table', () => {
  // A mark candidate is: kind==='pr' AND tier==='regression_breaking'
  //   AND slung == null AND status NOT in {draft, changes_requested}.
  test('PR, regression_breaking, open, not slung → candidate', () => {
    const pr = makePr({ number: 1, status: 'open', slung: null });
    assert.equal(isMarkCandidate(pr, 'regression_breaking'), true);
  });

  test('issue is never a candidate (kind gate)', () => {
    const issue = makeIssue({ number: 2, status: 'open' });
    assert.equal(isMarkCandidate(issue, 'regression_breaking'), false);
  });

  test('regression tier → not a candidate', () => {
    const pr = makePr({ number: 3, status: 'open' });
    assert.equal(isMarkCandidate(pr, 'regression'), false);
  });

  test('stability tier → not a candidate', () => {
    const pr = makePr({ number: 4, status: 'open' });
    assert.equal(isMarkCandidate(pr, 'stability'), false);
  });

  test('draft PR → not a candidate', () => {
    const pr = makePr({ number: 5, status: 'draft' });
    assert.equal(isMarkCandidate(pr, 'regression_breaking'), false);
  });

  test('changes_requested PR → not a candidate', () => {
    const pr = makePr({ number: 6, status: 'changes_requested' });
    assert.equal(isMarkCandidate(pr, 'regression_breaking'), false);
  });

  test('approved PR → candidate', () => {
    const pr = makePr({ number: 7, status: 'approved' });
    assert.equal(isMarkCandidate(pr, 'regression_breaking'), true);
  });

  test('needs_review PR → candidate', () => {
    const pr = makePr({ number: 8, status: 'needs_review' });
    assert.equal(isMarkCandidate(pr, 'regression_breaking'), true);
  });

  test('already-slung PR → not a candidate (mark moves to next unhandled)', () => {
    const pr = makePr({
      number: 9,
      status: 'open',
      slung: {
        slung_at: '2026-05-24T00:00:00.000Z',
        target: 'mayor',
        bead_id: null,
        resolved_session_name: null,
      },
    });
    assert.equal(isMarkCandidate(pr, 'regression_breaking'), false);
  });
});

describe('classifyItem — provisional is_marked mirrors isMarkCandidate', () => {
  test('candidate PR carries provisional is_marked=true', () => {
    const pr = makePr({
      number: 1,
      labels: ['kind/bug', 'priority/p0'],
      status: 'open',
      slung: null,
    });
    assert.equal(classifyItem(pr).is_marked, true);
  });

  test('non-candidate issue carries is_marked=false', () => {
    const issue = makeIssue({ number: 2, labels: ['kind/bug', 'priority/p0'] });
    assert.equal(classifyItem(issue).is_marked, false);
  });
});
