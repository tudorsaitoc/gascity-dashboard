import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriageAssessment, sortScore } from './triage-assessment.js';
import type { TriageItem } from 'gas-city-dashboard-shared';

// Label-driven vetted triage assessment parser (gascity-dashboard-are).
//
// The parser is pure: (labels[], opts?) → TriageAssessment | null. All three
// labels (triage/vetted, triage/severity-<n>, triage/simplicity-<band>) must
// be present for the agent path to fire; partial label sets degrade to null
// so the heuristic triage_score remains the sort key. vetted_score must
// live on the same numeric scale as the heuristic so a tier that mixes
// vetted + unvetted items sorts coherently.

const FIXED_VETTED_AT = '2026-05-23T00:00:00.000Z';

function parse(labels: string[]) {
  return parseTriageAssessment(labels, { vettedAt: FIXED_VETTED_AT });
}

describe('parseTriageAssessment — null cases (heuristic remains)', () => {
  test('returns null when label set is empty', () => {
    assert.equal(parse([]), null);
  });

  test('returns null when triage/vetted marker is absent', () => {
    assert.equal(parse(['triage/severity-1', 'triage/simplicity-high']), null);
  });

  test('returns null when only the vetted marker is present', () => {
    assert.equal(parse(['triage/vetted']), null);
  });

  test('returns null when severity is missing', () => {
    assert.equal(parse(['triage/vetted', 'triage/simplicity-medium']), null);
  });

  test('returns null when simplicity is missing', () => {
    assert.equal(parse(['triage/vetted', 'triage/severity-2']), null);
  });

  test('returns null when severity number is out of 0..4 range', () => {
    assert.equal(parse(['triage/vetted', 'triage/severity-5', 'triage/simplicity-low']), null);
    assert.equal(parse(['triage/vetted', 'triage/severity-99', 'triage/simplicity-low']), null);
  });

  test('returns null when simplicity band is unrecognised', () => {
    assert.equal(parse(['triage/vetted', 'triage/severity-1', 'triage/simplicity-extreme']), null);
  });

  test('returns null when severity value is non-numeric', () => {
    assert.equal(
      parse(['triage/vetted', 'triage/severity-critical', 'triage/simplicity-high']),
      null,
    );
  });

  test('label match is case-sensitive (gh label names are stored case-sensitively)', () => {
    assert.equal(parse(['TRIAGE/vetted', 'triage/severity-1', 'triage/simplicity-low']), null);
    assert.equal(parse(['triage/vetted', 'Triage/Severity-1', 'triage/simplicity-low']), null);
  });

  test('label match rejects trailing whitespace (anchored regex)', () => {
    assert.equal(parse(['triage/vetted', 'triage/severity-1 ', 'triage/simplicity-low']), null);
    assert.equal(parse(['triage/vetted', 'triage/severity-1', 'triage/simplicity-low ']), null);
  });
});

describe('parseTriageAssessment — vetted cases', () => {
  test('returns vetted assessment when all three labels present', () => {
    const result = parse(['triage/vetted', 'triage/severity-1', 'triage/simplicity-high']);
    assert.ok(result !== null);
    assert.equal(result.source, 'agent');
    assert.equal(result.notes, '');
    assert.equal(result.vetted_at, FIXED_VETTED_AT);
    assert.equal(typeof result.vetted_score, 'number');
  });

  test('vetted_score scales by severity (lower n = higher score)', () => {
    const sev0 = parse(['triage/vetted', 'triage/severity-0', 'triage/simplicity-medium']);
    const sev2 = parse(['triage/vetted', 'triage/severity-2', 'triage/simplicity-medium']);
    const sev4 = parse(['triage/vetted', 'triage/severity-4', 'triage/simplicity-medium']);
    assert.ok(sev0 && sev2 && sev4);
    assert.ok(sev0.vetted_score > sev2.vetted_score);
    assert.ok(sev2.vetted_score > sev4.vetted_score);
  });

  test('vetted_score scales by simplicity within a severity', () => {
    const low = parse(['triage/vetted', 'triage/severity-2', 'triage/simplicity-low']);
    const med = parse(['triage/vetted', 'triage/severity-2', 'triage/simplicity-medium']);
    const high = parse(['triage/vetted', 'triage/severity-2', 'triage/simplicity-high']);
    assert.ok(low && med && high);
    assert.ok(high.vetted_score > med.vetted_score);
    assert.ok(med.vetted_score > low.vetted_score);
  });

  test('vetted_score lives on the heuristic 100..300+ scale', () => {
    // severity 0 (max) + simplicity high (max bonus) should sit at or above
    // the heuristic regression_breaking severity_base of 300.
    const top = parse(['triage/vetted', 'triage/severity-0', 'triage/simplicity-high']);
    assert.ok(top !== null);
    assert.ok(top.vetted_score >= 300);

    // severity 4 (min) + simplicity low (min bonus) should sit at or above
    // the heuristic stability severity_base of 100 (still a real signal).
    const bottom = parse(['triage/vetted', 'triage/severity-4', 'triage/simplicity-low']);
    assert.ok(bottom !== null);
    assert.ok(bottom.vetted_score >= 100);
  });

  test('passes notes from opts through onto the assessment', () => {
    const result = parseTriageAssessment(
      ['triage/vetted', 'triage/severity-1', 'triage/simplicity-medium'],
      { vettedAt: FIXED_VETTED_AT, notes: 'agent: dupe of #42' },
    );
    assert.ok(result !== null);
    assert.equal(result.notes, 'agent: dupe of #42');
  });

  test('ignores unrelated labels mixed in', () => {
    const result = parse([
      'kind/bug',
      'priority/p1',
      'triage/vetted',
      'area/beads',
      'triage/severity-1',
      'triage/simplicity-high',
    ]);
    assert.ok(result !== null);
    assert.equal(result.source, 'agent');
  });
});

describe('sortScore — vetted overrides heuristic, falls back when null', () => {
  function makeItem(overrides: Partial<TriageItem>): TriageItem {
    return {
      kind: 'issue',
      number: 1,
      title: 't',
      status: 'open',
      author: {
        login: 'x',
        tier: 'regular',
        issues_accepted: null,
        issues_opened: null,
        prs_merged: null,
        prs_opened: null,
        computed_at: null,
      },
      created_at: '',
      updated_at: '',
      labels: [],
      tier: 'regression',
      triage_score: 200,
      triage_assessment: null,
      slung: null,
      cluster_id: null,
      blast_files: [],
      lines_changed: null,
      weak_ties: [],
      linked_numbers: [],
      html_url: '',
      is_marked: false,
      has_in_flight_pr: false,
      ...overrides,
    };
  }

  test('returns triage_score when triage_assessment is null', () => {
    const item = makeItem({ triage_score: 215 });
    assert.equal(sortScore(item), 215);
  });

  test('returns vetted_score when triage_assessment is set, ignoring heuristic', () => {
    const item = makeItem({
      triage_score: 150,
      triage_assessment: {
        vetted_score: 280,
        source: 'agent',
        notes: '',
        vetted_at: FIXED_VETTED_AT,
      },
    });
    assert.equal(sortScore(item), 280);
  });

  test('returns 0 when both are missing (defensive)', () => {
    const item = makeItem({ triage_score: null });
    assert.equal(sortScore(item), 0);
  });

  test('sort comparator using sortScore puts vetted high above heuristic low within same tier', () => {
    const vettedHigh = makeItem({
      number: 1,
      triage_score: 120,
      triage_assessment: {
        vetted_score: 290,
        source: 'agent',
        notes: '',
        vetted_at: FIXED_VETTED_AT,
      },
    });
    const heuristicMid = makeItem({ number: 2, triage_score: 215 });
    const sorted = [heuristicMid, vettedHigh].sort((a, b) => sortScore(b) - sortScore(a));
    assert.equal(sorted[0]?.number, 1);
  });
});
