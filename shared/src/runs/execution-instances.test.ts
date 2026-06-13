import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRunDisplayNode, type RunNodeGroup } from './execution-instances.js';
import type { RunSnapshotBead } from '../run-snapshot.js';

// Audit finding M7: when a logical node has multiple physical execution
// instances tied on (iteration, attempt) — the retry-shell-plus-attempt-bead
// shape — the visible instance must be the most-progressed one, not whichever
// bead id happens to sort last. Real case: run ga-wisp-x0tank's Gemini review
// node rendered '· ready' for ~6 minutes because the pending retry shell
// ga-wisp-o5x581 sorted lexicographically above the COMPLETED attempt bead
// ga-wisp-n3cf3y (gc.outcome=pass), while the identically-shaped Claude/Codex
// nodes showed '✓ done' purely by luck of id ordering.

function bead(overrides: Partial<RunSnapshotBead> & { id: string }): RunSnapshotBead {
  return {
    title: 'Code review: Gemini (cross-file consistency)',
    status: 'pending',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}

// Shaped like /tmp/wf-x0tank.json: the retry shell for the Gemini review step.
function retryShell(id: string, status: string): RunSnapshotBead {
  return bead({
    id,
    status,
    kind: 'retry',
    step_ref: 'review-loop.iteration.1.review-pipeline.review-gemini',
    attempt: 1,
    scope_ref: 'review-loop.iteration.1',
    metadata: {
      'gc.attempt': '1',
      'gc.kind': 'retry',
      'gc.max_attempts': '1',
      'gc.step_id': 'review-pipeline.review-gemini',
      'gc.step_ref': 'review-loop.iteration.1.review-pipeline.review-gemini',
    },
  });
}

// Shaped like /tmp/wf-x0tank.json: the attempt bead spawned by the shell.
function attemptBead(
  id: string,
  shellId: string,
  status: string,
  outcome?: string,
): RunSnapshotBead {
  return bead({
    id,
    status,
    kind: 'task',
    step_ref: 'review-loop.iteration.1.review-pipeline.review-gemini.attempt.1',
    attempt: 1,
    logical_bead_id: shellId,
    scope_ref: 'review-loop.iteration.1',
    metadata: {
      'gc.attempt': '1',
      'gc.logical_bead_id': shellId,
      'gc.step_id': 'review-pipeline.review-gemini',
      'gc.step_ref': 'review-loop.iteration.1.review-pipeline.review-gemini.attempt.1',
      ...(outcome === undefined ? {} : { 'gc.outcome': outcome }),
    },
  });
}

function group(beads: RunSnapshotBead[]): RunNodeGroup {
  return {
    semanticNodeId: 'review-loop.iteration.1.review-pipeline.review-gemini',
    title: 'Code review: Gemini (cross-file consistency)',
    kind: 'task',
    constructKind: 'retry',
    scopeRef: 'review-loop.iteration.1',
    beads,
  };
}

describe('preferred execution instance — M7 tiebreak', () => {
  test('completed attempt wins over pending retry shell even when the shell id sorts last', () => {
    // 'o5x581' > 'n3cf3y' lexicographically, so a pure id tiebreak picks the
    // pending shell and the page shows '· ready' for a review that passed.
    const node = buildRunDisplayNode(
      group([
        retryShell('ga-wisp-o5x581', 'pending'),
        attemptBead('ga-wisp-n3cf3y', 'ga-wisp-o5x581', 'completed', 'pass'),
      ]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-n3cf3y');
    assert.equal(node.currentBeadId, 'ga-wisp-n3cf3y');
    assert.equal(node.status, 'completed');
  });

  test('completed attempt still wins when its id already sorts last (Claude/Codex shape)', () => {
    // 'ov9nus' > 'dftrbb': the attempt bead won the old id tiebreak by luck.
    // The status-aware preference must keep picking it.
    const node = buildRunDisplayNode(
      group([
        retryShell('ga-wisp-dftrbb', 'pending'),
        attemptBead('ga-wisp-ov9nus', 'ga-wisp-dftrbb', 'completed', 'pass'),
      ]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-ov9nus');
    assert.equal(node.status, 'completed');
  });

  test('failed attempt wins over pending retry shell', () => {
    const node = buildRunDisplayNode(
      group([
        retryShell('ga-wisp-o5x581', 'pending'),
        attemptBead('ga-wisp-n3cf3y', 'ga-wisp-o5x581', 'completed', 'fail'),
      ]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-n3cf3y');
    assert.equal(node.status, 'failed');
  });

  test('active attempt wins over pending retry shell', () => {
    const node = buildRunDisplayNode(
      group([
        retryShell('ga-wisp-o5x581', 'pending'),
        attemptBead('ga-wisp-n3cf3y', 'ga-wisp-o5x581', 'in_progress'),
      ]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-n3cf3y');
    assert.equal(node.status, 'active');
  });

  test('terminal instance wins over an active one at the same iteration and attempt', () => {
    // Most-progressed ordering: terminal > active > pending. The node-level
    // status still reports active via aggregateStatus when anything runs.
    const node = buildRunDisplayNode(
      group([
        attemptBead('ga-wisp-zzzzzz', 'ga-wisp-o5x581', 'in_progress'),
        attemptBead('ga-wisp-n3cf3y', 'ga-wisp-o5x581', 'completed', 'pass'),
      ]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-n3cf3y');
    assert.equal(node.status, 'active');
  });

  test('higher attempt still outranks status progress', () => {
    // A pending attempt-2 shell outranks the completed attempt-1 bead:
    // attempt ordering stays primary, status only breaks exact ties.
    const shell2 = retryShell('ga-wisp-aaaaaa', 'pending');
    shell2.attempt = 2;
    shell2.metadata = { ...shell2.metadata, 'gc.attempt': '2' };
    const node = buildRunDisplayNode(
      group([shell2, attemptBead('ga-wisp-n3cf3y', 'ga-wisp-o5x581', 'completed', 'pass')]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-aaaaaa');
  });

  test('bead id remains the final deterministic tiebreak when status also ties', () => {
    const node = buildRunDisplayNode(
      group([
        attemptBead('ga-wisp-bbbbbb', 'ga-wisp-o5x581', 'completed', 'pass'),
        attemptBead('ga-wisp-aaaaaa', 'ga-wisp-o5x581', 'completed', 'pass'),
      ]),
      [],
      undefined,
    );
    assert.equal(node.visibleExecutionInstanceId, 'ga-wisp-bbbbbb');
  });
});
