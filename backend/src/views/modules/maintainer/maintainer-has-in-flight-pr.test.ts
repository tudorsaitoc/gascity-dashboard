import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeHasInFlightPr } from './triage.js';
import { makeIssue, makePr } from './fixtures/triage-item.js';

// gascity-dashboard-omv: TriageItem.has_in_flight_pr is the
// backend-shipped, per-item signal that drives both the issue-row
// "needs PR" indicator and the "Needs PR only" filter chip on the
// maintainer view.
//
// Contract: for each item in the envelope, has_in_flight_pr === true
// iff at least one item in the SAME envelope is a PR with
// linked_numbers including this item's number AND PR.status is not
// 'merged' / not 'closed' (i.e. it's "in flight" — open / draft /
// needs_review / approved / changes_requested).
//
// PRs themselves always have has_in_flight_pr === false in v1: the
// signal is issue-anchored. The field is still required on PR items
// so the consumer (frontend filter) doesn't have to special-case kind.
//
// This is the inverse of the bs2 issueNumbersWithInFlightPr set used
// by selectOneMark, but materialised as a typed boolean on every item
// so consumers don't have to recompute it.

describe('computeHasInFlightPr — backend-shipped per-item signal', () => {
  test('issue with NO linked PRs in envelope: has_in_flight_pr=false', () => {
    const issue = makeIssue({ number: 100 });
    computeHasInFlightPr([issue]);
    assert.equal(issue.has_in_flight_pr, false);
  });

  test('issue with an open PR claiming to close it: has_in_flight_pr=true', () => {
    const issue = makeIssue({ number: 200 });
    const pr = makePr({ number: 201, linked_numbers: [200], status: 'open' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('issue with a draft PR claiming to close it: has_in_flight_pr=true', () => {
    const issue = makeIssue({ number: 300 });
    const pr = makePr({ number: 301, linked_numbers: [300], status: 'draft' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('issue with a needs_review PR: has_in_flight_pr=true', () => {
    const issue = makeIssue({ number: 400 });
    const pr = makePr({ number: 401, linked_numbers: [400], status: 'needs_review' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('issue with an approved PR: has_in_flight_pr=true (still in flight, not yet merged)', () => {
    const issue = makeIssue({ number: 500 });
    const pr = makePr({ number: 501, linked_numbers: [500], status: 'approved' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('issue with a changes_requested PR: has_in_flight_pr=true', () => {
    const issue = makeIssue({ number: 600 });
    const pr = makePr({ number: 601, linked_numbers: [600], status: 'changes_requested' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('issue with only a MERGED linked PR: has_in_flight_pr=false (merged is not in-flight)', () => {
    const issue = makeIssue({ number: 700 });
    const pr = makePr({ number: 701, linked_numbers: [700], status: 'merged' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, false);
  });

  test('issue with only a CLOSED linked PR: has_in_flight_pr=false (closed is not in-flight)', () => {
    const issue = makeIssue({ number: 800 });
    const pr = makePr({ number: 801, linked_numbers: [800], status: 'closed' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(issue.has_in_flight_pr, false);
  });

  test('issue with a linked PR number NOT in the envelope: has_in_flight_pr=false', () => {
    // Reverse-mapped issue.linked_numbers may reference a PR that
    // didn't make it into the envelope (truncation / pagination).
    // Without seeing the PR's status we cannot claim in-flight, so the
    // conservative answer is false: the operator will see "needs PR".
    const issue = makeIssue({ number: 900, linked_numbers: [9999] });
    computeHasInFlightPr([issue]);
    assert.equal(issue.has_in_flight_pr, false);
  });

  test('issue with multiple linked PRs: ANY one in-flight is enough', () => {
    const issue = makeIssue({ number: 1000 });
    const merged = makePr({ number: 1001, linked_numbers: [1000], status: 'merged' });
    const open = makePr({ number: 1002, linked_numbers: [1000], status: 'open' });
    computeHasInFlightPr([issue, merged, open]);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('PR items always have has_in_flight_pr=false (signal is issue-anchored)', () => {
    const pr = makePr({ number: 1100, linked_numbers: [1099], status: 'open' });
    computeHasInFlightPr([pr]);
    assert.equal(pr.has_in_flight_pr, false);
  });

  test('PR items have has_in_flight_pr=false even when their parent issue is in envelope', () => {
    // The signal is "does someone need to write a PR for this item?".
    // For a PR item the answer is always trivially no — the PR IS the
    // work. Don't blur this by reflecting the parent's signal.
    const issue = makeIssue({ number: 1200 });
    const pr = makePr({ number: 1201, linked_numbers: [1200], status: 'open' });
    computeHasInFlightPr([issue, pr]);
    assert.equal(pr.has_in_flight_pr, false);
    assert.equal(issue.has_in_flight_pr, true);
  });

  test('empty input: no throw, no mutation', () => {
    assert.doesNotThrow(() => computeHasInFlightPr([]));
  });

  test('field is set on EVERY item (never undefined) even when no PRs in envelope', () => {
    const issueA = makeIssue({ number: 1300 });
    const issueB = makeIssue({ number: 1301 });
    computeHasInFlightPr([issueA, issueB]);
    assert.equal(issueA.has_in_flight_pr, false);
    assert.equal(issueB.has_in_flight_pr, false);
    // Guard against accidental `undefined` from a missing assignment.
    assert.notEqual(issueA.has_in_flight_pr, undefined);
    assert.notEqual(issueB.has_in_flight_pr, undefined);
  });
});
