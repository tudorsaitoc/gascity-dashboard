import type { GcRunBead } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { groupRunBeads } from '../src/runs/groups.js';

describe('run bead grouping', () => {
  test('groups physical attempts by stable semantic node id while preserving first-seen order', () => {
    const grouped = groupRunBeads([
      bead({
        id: 'gc-root',
        title: 'Root',
        kind: 'run',
      }),
      bead({
        id: 'attempt-1',
        title: 'Review once',
        logicalId: 'review-node',
        attempt: 1,
      }),
      bead({
        id: 'attempt-2',
        title: 'Review twice',
        logicalId: 'review-node',
        attempt: 2,
      }),
    ], 'gc-root');

    assert.deepEqual(grouped.groups.map((group) => group.semanticNodeId), [
      'gc-root',
      'review-node',
    ]);
    assert.deepEqual(
      grouped.groups[1]?.beads.map((candidate) => candidate.id),
      ['attempt-1', 'attempt-2'],
    );
    assert.equal(grouped.physicalToSemantic.get('attempt-1'), 'review-node');
    assert.equal(grouped.physicalToSemantic.get('attempt-2'), 'review-node');
  });

  test('collapses hidden control beads into badges on their visible target', () => {
    const grouped = groupRunBeads([
      bead({ id: 'gc-root', title: 'Root', kind: 'run' }),
      bead({
        id: 'review-node',
        title: 'Review',
        kind: 'expand',
        stepRef: 'mol.review-node',
      }),
      bead({
        id: 'review-scope-check',
        kind: 'scope-check',
        status: 'closed',
        stepRef: 'mol.review-node.scope-check',
      }),
      bead({
        id: 'finalize',
        kind: 'run-finalize',
        status: 'ready',
        stepRef: 'mol.finalize',
      }),
    ], 'gc-root');

    assert.deepEqual(grouped.groups.map((group) => group.semanticNodeId), [
      'gc-root',
      'review-node',
    ]);
    assert.deepEqual(grouped.badgesByTarget.get('review-node'), [
      { id: 'review-scope-check', label: 'scope check', status: 'completed' },
    ]);
    assert.deepEqual(grouped.badgesByTarget.get('gc-root'), [
      { id: 'finalize', label: 'finalize', status: 'ready' },
    ]);
    assert.equal(grouped.physicalToSemantic.get('review-scope-check'), 'scope-check');
  });

  test('externalizes implementation-private check loop ids before they reach graph data', () => {
    const grouped = groupRunBeads([
      bead({ id: 'gc-root', title: 'Root', kind: 'run' }),
      bead({
        id: 'gc-ralph',
        title: 'Internal loop',
        logicalId: 'ralph',
        kind: 'ralph',
      }),
    ], 'gc-root');

    const loop = grouped.groups[1];
    assert.equal(loop?.semanticNodeId, 'check-loop');
    assert.equal(loop?.kind, 'check-loop');
    assert.equal(
      JSON.stringify(grouped.groups.map(({ semanticNodeId, kind, constructKind }) => ({
        semanticNodeId,
        kind,
        constructKind,
      }))).includes('ralph'),
      false,
    );
  });

  test('keeps repeated formula steps distinct when only the final step-ref segment matches', () => {
    const grouped = groupRunBeads([
      bead({ id: 'gc-root', title: 'Root', kind: 'run' }),
      bead({
        id: 'draft-1',
        title: 'Draft plan iteration 1',
        stepRef: 'mol-demo-plan-review.plan-cycle.iter1.draft',
      }),
      bead({
        id: 'draft-2',
        title: 'Draft plan iteration 2',
        stepRef: 'mol-demo-plan-review.plan-cycle.iter2.draft',
      }),
      bead({
        id: 'draft-1-scope',
        kind: 'scope-check',
        stepRef: 'mol-demo-plan-review.plan-cycle.iter1.draft-scope-check',
        controlFor: 'plan-cycle.iter1.draft',
      }),
      bead({
        id: 'draft-2-scope',
        kind: 'scope-check',
        stepRef: 'mol-demo-plan-review.plan-cycle.iter2.draft-scope-check',
        controlFor: 'plan-cycle.iter2.draft',
      }),
    ], 'gc-root');

    assert.deepEqual(grouped.groups.map((group) => group.semanticNodeId), [
      'gc-root',
      'plan-cycle.iter1.draft',
      'plan-cycle.iter2.draft',
    ]);
    assert.equal(grouped.physicalToSemantic.get('draft-1'), 'plan-cycle.iter1.draft');
    assert.equal(grouped.physicalToSemantic.get('draft-2'), 'plan-cycle.iter2.draft');
    assert.deepEqual(grouped.badgesByTarget.get('plan-cycle.iter1.draft'), [
      { id: 'draft-1-scope', label: 'scope check', status: 'ready' },
    ]);
    assert.deepEqual(grouped.badgesByTarget.get('plan-cycle.iter2.draft'), [
      { id: 'draft-2-scope', label: 'scope check', status: 'ready' },
    ]);
  });

  test('groups check-loop controls with their generated execution bead', () => {
    const grouped = groupRunBeads([
      bead({ id: 'gc-root', title: 'Root', kind: 'run' }),
      bead({
        id: 'review-attempt',
        title: 'Review plan iteration 1',
        kind: 'task',
        logicalId: 'review-control',
        stepRef: 'plan-cycle.iter1.review.iteration.1',
        stepId: 'plan-cycle.iter1.review',
        attempt: 1,
      }),
      bead({
        id: 'review-control',
        title: 'Review plan iteration 1',
        kind: 'ralph',
        stepRef: 'mol-demo-plan-review.plan-cycle.iter1.review',
        stepId: 'plan-cycle.iter1.review',
      }),
      bead({
        id: 'review-scope-check',
        kind: 'scope-check',
        stepRef: 'mol-demo-plan-review.plan-cycle.iter1.review-scope-check',
        controlFor: 'plan-cycle.iter1.review',
      }),
    ], 'gc-root');

    assert.deepEqual(grouped.groups.map((group) => group.semanticNodeId), [
      'gc-root',
      'review-control',
    ]);
    assert.equal(grouped.groups[1]?.constructKind, 'check-loop');
    assert.equal(grouped.groups[1]?.kind, 'check-loop');
    assert.deepEqual(
      grouped.groups[1]?.beads.map((candidate) => candidate.id),
      ['review-attempt', 'review-control'],
    );
    assert.equal(grouped.physicalToSemantic.get('review-control'), 'review-control');
    assert.equal(grouped.physicalToSemantic.get('review-attempt'), 'review-control');
    assert.deepEqual(grouped.badgesByTarget.get('review-control'), [
      { id: 'review-scope-check', label: 'scope check', status: 'ready' },
    ]);
  });
});

function bead(opts: {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  logicalId?: string;
  stepRef?: string;
  stepId?: string;
  attempt?: number;
  controlFor?: string;
}): GcRunBead {
  const metadata: Record<string, string> = {};
  if (opts.logicalId) metadata['gc.logical_bead_id'] = opts.logicalId;
  if (opts.stepRef) metadata['gc.step_ref'] = opts.stepRef;
  if (opts.stepId) metadata['gc.step_id'] = opts.stepId;
  if (opts.attempt !== undefined) metadata['gc.attempt'] = String(opts.attempt);
  if (opts.controlFor) metadata['gc.control_for'] = opts.controlFor;
  return {
    id: opts.id,
    title: opts.title ?? opts.id,
    status: opts.status ?? 'ready',
    kind: opts.kind ?? 'task',
    metadata,
  };
}
