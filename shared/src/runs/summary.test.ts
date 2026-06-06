import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRunSummary, emptyRunSummary } from './summary.js';
import type { RunIssue } from './phaseMapping.js';

// Active-classification regression coverage (gascity-dashboard-4xcv §2).
// Operator repro gc-1920: a long-stale formula latch with status=blocked
// (city-level, no live session) was counted and shown in the ACTIVE lane.
// A blocked run still needs operator attention, but it is not progressing:
// it belongs in its own blocked bucket, never in the Active set or count.

function latch(overrides: Partial<RunIssue> = {}): RunIssue {
  // Shape mirrors a real mol-focus-review latch root (gc-1920-class bead):
  // a single graph.v2 root task with no step children.
  return {
    id: 'gc-1920',
    title: 'mol-focus-review',
    description: 'Focus + in-session review formula. Approval gate, review.',
    status: 'blocked',
    issue_type: 'task',
    updated_at: '2026-04-01T00:00:00Z',
    metadata: {
      'gc.formula_contract': 'graph.v2',
      'gc.kind': 'workflow',
    },
    ...overrides,
  };
}

function activeRun(id: string): RunIssue[] {
  return [
    latch({
      id,
      title: 'Adopt PR #42',
      description: 'implementation work',
      status: 'open',
      updated_at: '2026-06-01T00:00:00Z',
      metadata: { 'gc.formula_contract': 'graph.v2', 'gc.kind': 'run' },
    }),
    {
      id: `${id}-step-1`,
      title: 'Implementation patch',
      status: 'in_progress',
      issue_type: 'task',
      updated_at: '2026-06-01T00:05:00Z',
      metadata: {
        'gc.kind': 'step',
        'gc.root_bead_id': id,
        'gc.step_id': 'implementation.patch',
      },
    },
  ];
}

function completedRun(id: string): RunIssue[] {
  return [
    latch({
      id,
      title: 'Done run',
      description: 'merge finalize',
      status: 'closed',
      updated_at: '2026-05-01T00:00:00Z',
      metadata: { 'gc.formula_contract': 'graph.v2', 'gc.kind': 'run' },
    }),
  ];
}

describe('buildRunSummary — blocked lanes are not Active (gascity-dashboard-4xcv)', () => {
  test('a blocked formula latch lands in blockedLanes, not lanes or totalActive', () => {
    const summary = buildRunSummary([latch(), ...activeRun('run-1')]);

    assert.equal(summary.totalActive, 1);
    assert.deepEqual(
      summary.lanes.map((lane) => lane.id),
      ['run-1'],
    );
    assert.deepEqual(
      summary.blockedLanes.map((lane) => lane.id),
      ['gc-1920'],
    );
    assert.equal(summary.runCounts.total, 1);
    assert.equal(summary.runCounts.blocked, 1);
  });

  test('blocked lanes are not historical either', () => {
    const summary = buildRunSummary([latch(), ...completedRun('run-done')]);

    assert.equal(summary.totalActive, 0);
    assert.equal(summary.totalHistorical, 1);
    assert.deepEqual(
      summary.historicalLanes.map((lane) => lane.id),
      ['run-done'],
    );
    assert.deepEqual(
      summary.blockedLanes.map((lane) => lane.id),
      ['gc-1920'],
    );
  });

  test('with no blocked lanes, blockedLanes is empty and blocked count is zero', () => {
    const summary = buildRunSummary(activeRun('run-1'));

    assert.deepEqual(summary.blockedLanes, []);
    assert.equal(summary.runCounts.blocked, 0);
  });

  test('emptyRunSummary carries an empty blockedLanes array', () => {
    assert.deepEqual(emptyRunSummary().blockedLanes, []);
  });
});
