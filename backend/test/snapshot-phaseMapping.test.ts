import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapWorkflowPhase,
  reviewRoundForIssue,
  type WorkflowIssue,
} from '../src/snapshot/collectors/phaseMapping.js';

// Phase-mapping rules ported from demo-dash src/server/collectors/workflows.ts
// (gascity-dashboard-0t6). Tests pin the upstream classifier behavior so the
// React translation of WorkflowMap inherits a consistent phase grammar.
//
// Divergence from demo-dash (H3 in plan review): GcBead has no `parent` field.
// The adapter populates WorkflowIssue.parent from metadata['gc.parent_bead_id']
// when present. Parent-derived classification falls back to keyword-search on
// title/description/metadata when the parent string is absent. The skipped
// test below documents the case explicitly.

const baseIssue = {
  description: '',
  status: 'open',
  issue_type: 'task',
  updated_at: '2026-05-10T20:00:00Z',
  metadata: {},
} satisfies Partial<WorkflowIssue>;

function issue(
  overrides: Partial<WorkflowIssue> & Pick<WorkflowIssue, 'id' | 'title'>,
): WorkflowIssue {
  return {
    ...baseIssue,
    ...overrides,
    metadata: overrides.metadata ?? {},
    status: overrides.status ?? 'open',
    issue_type: overrides.issue_type ?? 'task',
    updated_at: overrides.updated_at ?? '2026-05-10T20:00:00Z',
  };
}

describe('mapWorkflowPhase', () => {
  test('blocked status wins over all other classifications', () => {
    assert.deepEqual(
      mapWorkflowPhase([
        issue({
          id: 'ga-blocked',
          title: 'Patch implementation',
          status: 'blocked',
        }),
      ]),
      { phase: 'blocked', label: 'blocked', reviewRound: null },
    );
  });

  test('all-closed group resolves to complete', () => {
    assert.deepEqual(
      mapWorkflowPhase([
        issue({ id: 'a', title: 'Setup', status: 'closed' }),
        issue({ id: 'b', title: 'Implement', status: 'closed' }),
      ]),
      { phase: 'complete', label: 'complete', reviewRound: null },
    );
  });

  test('approval keywords map to approval phase', () => {
    assert.deepEqual(
      mapWorkflowPhase([issue({ id: 'a', title: 'Wait on human approval' })]),
      { phase: 'approval', label: 'approval', reviewRound: null },
    );
  });

  test('post-merge keywords map to finalization phase', () => {
    assert.deepEqual(
      mapWorkflowPhase([issue({ id: 'ga-final', title: 'Post-merge report' })]),
      { phase: 'finalization', label: 'finalization', reviewRound: null },
    );
  });

  test('review-round metadata produces "review round N" label', () => {
    const result = mapWorkflowPhase([
      issue({
        id: 'r1',
        title: 'Run review loop',
        status: 'in_progress',
        metadata: { 'review-loop.iteration.3': 'active' },
      }),
    ]);
    assert.equal(result.phase, 'review');
    assert.equal(result.label, 'review round 3');
    assert.equal(result.reviewRound, 3);
  });

  test('review keyword without round falls back to count of review-mentioning issues', () => {
    const result = mapWorkflowPhase([
      issue({ id: 'a', title: 'Review the diff' }),
      issue({ id: 'b', title: 'Second review pass' }),
    ]);
    assert.equal(result.phase, 'review');
    assert.equal(result.label, 'review round 2');
    assert.equal(result.reviewRound, 2);
  });

  test('implementation keywords map to implementation phase', () => {
    assert.deepEqual(
      mapWorkflowPhase([issue({ id: 'a', title: 'Implement the fix' })]),
      {
        phase: 'implementation',
        label: 'implementation',
        reviewRound: null,
      },
    );
  });

  test('intake keywords map to intake phase', () => {
    assert.deepEqual(
      mapWorkflowPhase([issue({ id: 'a', title: 'Load context for router' })]),
      { phase: 'intake', label: 'intake', reviewRound: null },
    );
  });

  test('unclassified work falls back to active phase', () => {
    assert.deepEqual(
      mapWorkflowPhase([issue({ id: 'a', title: 'Refresh demo state' })]),
      { phase: 'active', label: 'active', reviewRound: null },
    );
  });

  test('blocked precedence beats finalization keyword', () => {
    assert.equal(
      mapWorkflowPhase([
        issue({
          id: 'a',
          title: 'Post-merge report',
          status: 'blocked',
        }),
      ]).phase,
      'blocked',
    );
  });

  test('finalization precedence beats review keyword inside the same group', () => {
    // Both "merge" and "review" appear; demo-dash's order checks finalization
    // before review and selects finalization.
    assert.equal(
      mapWorkflowPhase([
        issue({
          id: 'a',
          title: 'Run review pass before merge',
        }),
      ]).phase,
      'finalization',
    );
  });
});

describe('reviewRoundForIssue', () => {
  test('reads iteration.N suffix from metadata key', () => {
    assert.equal(
      reviewRoundForIssue(
        issue({
          id: 'r',
          title: 'review',
          metadata: { 'iteration.2': 'ready' },
        }),
      ),
      2,
    );
  });

  test('reads numeric value for plain iteration key', () => {
    assert.equal(
      reviewRoundForIssue(
        issue({
          id: 'r',
          title: 'review',
          metadata: { 'review-loop.iteration': 5 },
        }),
      ),
      5,
    );
  });

  test('reads attempt key from gc.attempt namespace', () => {
    assert.equal(
      reviewRoundForIssue(
        issue({
          id: 'r',
          title: 'review',
          metadata: { 'gc.attempt': '4' },
        }),
      ),
      4,
    );
  });

  test('returns null when no review-round metadata present', () => {
    assert.equal(
      reviewRoundForIssue(issue({ id: 'r', title: 'review' })),
      null,
    );
  });

  test('reads iteration.N suffix from metadata value as fallback', () => {
    assert.equal(
      reviewRoundForIssue(
        issue({
          id: 'r',
          title: 'review',
          metadata: { 'gc.tag': 'review-loop.iteration.7' },
        }),
      ),
      7,
    );
  });
});

describe('parent-derived classification (GcBead divergence note)', () => {
  // H3 plan note: GcBead has no first-class `parent`. The adapter populates
  // WorkflowIssue.parent from metadata['gc.parent_bead_id'] when present.
  // When that metadata key is absent (the common case until upstream adds
  // it), parent-keyword scans cannot fire and classification falls back to
  // title/description/metadata text scans only. This test pins that fallback.
  test('issue with parent metadata is read into textForIssue indirectly', () => {
    // The phase classifier scans textForIssue, which concatenates the parent
    // string into the keyword corpus. With parent === 'parent-review-bead',
    // the "review" substring inside the parent id surfaces the phase.
    const result = mapWorkflowPhase([
      issue({
        id: 'ga-step',
        title: 'Apply fixes',
        parent: 'parent-review-bead',
      }),
    ]);
    assert.equal(result.phase, 'review');
  });

  test('issue without parent metadata classifies on title text alone', () => {
    const result = mapWorkflowPhase([
      issue({ id: 'ga-step', title: 'Apply fixes' }),
    ]);
    // 'fix' is in the implementation keyword set.
    assert.equal(result.phase, 'implementation');
  });
});
