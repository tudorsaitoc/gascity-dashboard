import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { groupRunBeads } from './groups.js';
import type { RunSnapshotBead } from '../run-snapshot.js';

// Scope-check badge targeting regression coverage (audit finding M5,
// run ga-wisp-x0tank). The review-pipeline steps live inside a check loop
// ('review-loop.iteration.1.review-pipeline.<step>'), so their scope-check
// beads carry gc.step_id='review-pipeline.<step>' while the runtime-ref
// fallback in hiddenBadgeTargetFor reduces to the bare last segment
// ('review-claude'). The visible node for each step is the physical retry
// bead (the attempt task bead's gc.logical_bead_id merges into it), whose
// alias set includes the full gc.step_id but NOT the bare segment. Without
// the scope-check bead's own gc.step_id in the badge-target candidate list,
// resolveBadgeTarget returns the bare fallback, a key no group carries, and
// the badges silently vanish from the run-detail page.

const ROOT_ID = 'ga-wisp-x0tank';

function bead(partial: Partial<RunSnapshotBead> & { id: string }): RunSnapshotBead {
  return {
    title: partial.id,
    status: 'open',
    kind: 'task',
    metadata: {},
    ...partial,
  } as RunSnapshotBead;
}

function rootBead(): RunSnapshotBead {
  return bead({
    id: ROOT_ID,
    title: 'Adopt PR',
    status: 'in_progress',
    kind: 'workflow',
    metadata: { 'gc.kind': 'workflow' },
  });
}

interface ReviewClaudeIterationIds {
  retry: string;
  attempt: string;
  scopeCheckAttempt: string;
  scopeCheckStep: string;
}

// Shapes mirror the live ga-wisp-x0tank supervisor payload: a kind=retry
// logical bead plus a kind=task attempt bead pointing at it, and two
// scope-check beads (one per runtime ref form, with and without .attempt.N).
// Parameterized by iteration so the same step can appear more than once: a
// check loop reuses the same gc.step_id ('review-pipeline.review-claude')
// every pass, and only the iteration index in the step/control refs keeps the
// iterations apart.
function reviewClaudeIterationBeads(
  iteration: number,
  ids: ReviewClaudeIterationIds,
): RunSnapshotBead[] {
  const loop = `review-loop.iteration.${iteration}`;
  return [
    bead({
      id: ids.retry,
      title: 'Code review: Claude (reasoning-heavy)',
      status: 'completed',
      kind: 'retry',
      step_ref: `${loop}.review-pipeline.review-claude`,
      scope_ref: loop,
      metadata: {
        'gc.kind': 'retry',
        'gc.scope_ref': loop,
        'gc.step_id': 'review-pipeline.review-claude',
        'gc.step_ref': `${loop}.review-pipeline.review-claude`,
      },
    }),
    bead({
      id: ids.attempt,
      title: 'Code review: Claude (reasoning-heavy)',
      status: 'completed',
      kind: 'task',
      step_ref: `${loop}.review-pipeline.review-claude.attempt.1`,
      logical_bead_id: ids.retry,
      scope_ref: loop,
      metadata: {
        'gc.logical_bead_id': ids.retry,
        'gc.scope_ref': loop,
        'gc.step_id': 'review-pipeline.review-claude',
        'gc.step_ref': `${loop}.review-pipeline.review-claude.attempt.1`,
      },
    }),
    bead({
      id: ids.scopeCheckAttempt,
      title: 'Finalize scope for Code review: Claude (reasoning-heavy)',
      status: 'completed',
      kind: 'scope-check',
      step_ref: `mol-adopt-pr-v2.${loop}.review-pipeline.review-claude.attempt.1-scope-check`,
      scope_ref: loop,
      metadata: {
        'gc.kind': 'scope-check',
        'gc.control_for': `${loop}.review-pipeline.review-claude.attempt.1`,
        'gc.scope_ref': loop,
        'gc.step_id': 'review-pipeline.review-claude',
        'gc.step_ref': `mol-adopt-pr-v2.${loop}.review-pipeline.review-claude.attempt.1-scope-check`,
      },
    }),
    bead({
      id: ids.scopeCheckStep,
      title: 'Finalize scope for Code review: Claude (reasoning-heavy)',
      status: 'completed',
      kind: 'scope-check',
      step_ref: `mol-adopt-pr-v2.${loop}.review-pipeline.review-claude-scope-check`,
      scope_ref: loop,
      metadata: {
        'gc.kind': 'scope-check',
        'gc.control_for': `${loop}.review-pipeline.review-claude`,
        'gc.scope_ref': loop,
        'gc.step_id': 'review-pipeline.review-claude',
        'gc.step_ref': `mol-adopt-pr-v2.${loop}.review-pipeline.review-claude-scope-check`,
      },
    }),
  ];
}

const ITERATION_1_IDS: ReviewClaudeIterationIds = {
  retry: 'ga-wisp-dftrbb',
  attempt: 'ga-wisp-ov9nus',
  scopeCheckAttempt: 'ga-wisp-k2xt12',
  scopeCheckStep: 'ga-wisp-u6zevb',
};

const ITERATION_2_IDS: ReviewClaudeIterationIds = {
  retry: 'ga-wisp-e7h2kp',
  attempt: 'ga-wisp-r3m8qd',
  scopeCheckAttempt: 'ga-wisp-w9b4xt',
  scopeCheckStep: 'ga-wisp-z5c1nf',
};

function reviewClaudeBeads(): RunSnapshotBead[] {
  return reviewClaudeIterationBeads(1, ITERATION_1_IDS);
}

// A step whose gc.step_id has no pipeline prefix (mirrors the live
// pre-review-ci repair step, ga-wisp-a2s47g): the bare-segment fallback
// already equals gc.step_id and the badges attach today. Coverage that the
// fix does not regress this path.
function repairStepBeads(): RunSnapshotBead[] {
  return [
    bead({
      id: 'ga-wisp-a2s47g',
      title: 'Repair pre-review CI failures',
      status: 'completed',
      kind: 'retry',
      step_ref: 'pre-review-ci.iteration.1.repair-pre-review-ci-failures',
      metadata: {
        'gc.kind': 'retry',
        'gc.step_id': 'repair-pre-review-ci-failures',
        'gc.step_ref': 'pre-review-ci.iteration.1.repair-pre-review-ci-failures',
      },
    }),
    bead({
      id: 'ga-wisp-6sslpf',
      title: 'Repair pre-review CI failures',
      status: 'completed',
      kind: 'task',
      step_ref: 'pre-review-ci.iteration.1.repair-pre-review-ci-failures.attempt.1',
      logical_bead_id: 'ga-wisp-a2s47g',
      metadata: {
        'gc.logical_bead_id': 'ga-wisp-a2s47g',
        'gc.step_id': 'repair-pre-review-ci-failures',
        'gc.step_ref': 'pre-review-ci.iteration.1.repair-pre-review-ci-failures.attempt.1',
      },
    }),
    bead({
      id: 'ga-wisp-6nm1th',
      title: 'Finalize scope for Repair pre-review CI failures',
      status: 'completed',
      kind: 'scope-check',
      step_ref:
        'mol-adopt-pr-v2.pre-review-ci.iteration.1.repair-pre-review-ci-failures-scope-check',
      metadata: {
        'gc.kind': 'scope-check',
        'gc.control_for': 'pre-review-ci.iteration.1.repair-pre-review-ci-failures',
        'gc.step_id': 'repair-pre-review-ci-failures',
        'gc.step_ref':
          'mol-adopt-pr-v2.pre-review-ci.iteration.1.repair-pre-review-ci-failures-scope-check',
      },
    }),
  ];
}

describe('groupRunBeads — scope-check badge targeting (audit M5)', () => {
  test('scope-checks for a nested-pipeline step attach to the merged retry-bead node', () => {
    const { groups, badgesByTarget } = groupRunBeads([rootBead(), ...reviewClaudeBeads()], ROOT_ID);

    const reviewNode = groups.find((group) => group.semanticNodeId === 'ga-wisp-dftrbb');
    assert.ok(reviewNode, 'retry + attempt beads merge into one node keyed by the retry bead id');
    assert.deepEqual(reviewNode.beads.map((b) => b.id).sort(), [
      'ga-wisp-dftrbb',
      'ga-wisp-ov9nus',
    ]);

    const badges = badgesByTarget.get('ga-wisp-dftrbb') ?? [];
    assert.deepEqual(
      badges.map((badge) => badge.id).sort(),
      ['ga-wisp-k2xt12', 'ga-wisp-u6zevb'],
      'both scope-check beads must land on the visible node the run-detail page renders',
    );
    assert.ok(
      badges.every((badge) => badge.label === 'scope check'),
      'badges carry the scope-check label',
    );

    assert.equal(
      badgesByTarget.has('review-claude'),
      false,
      'no badges may be stranded under the bare semantic segment, which no group carries',
    );
  });

  test('scope-checks for a repeated nested-pipeline step attach to each iteration’s own retry node', () => {
    // A review loop re-runs the same review-pipeline step when the first pass
    // finds blockers. Both iterations register gc.step_id
    // 'review-pipeline.review-claude', so that alias resolves to two visible
    // nodes and is dropped as ambiguous. Resolution must fall through to the
    // iteration-qualified step-ref identity (audit M5); otherwise every
    // scope-check strands under the shared bare 'review-claude' key again.
    const { groups, badgesByTarget } = groupRunBeads(
      [
        rootBead(),
        ...reviewClaudeIterationBeads(1, ITERATION_1_IDS),
        ...reviewClaudeIterationBeads(2, ITERATION_2_IDS),
      ],
      ROOT_ID,
    );

    const iteration1Node = groups.find((group) => group.semanticNodeId === ITERATION_1_IDS.retry);
    const iteration2Node = groups.find((group) => group.semanticNodeId === ITERATION_2_IDS.retry);
    assert.ok(iteration1Node, 'iteration 1 retry + attempt beads merge into their own node');
    assert.ok(
      iteration2Node,
      'iteration 2 retry + attempt beads merge into a separate node, not the iteration 1 node',
    );

    assert.deepEqual(
      (badgesByTarget.get(ITERATION_1_IDS.retry) ?? []).map((badge) => badge.id).sort(),
      [ITERATION_1_IDS.scopeCheckStep, ITERATION_1_IDS.scopeCheckAttempt].sort(),
      'iteration 1 scope-checks attach to the iteration 1 node',
    );
    assert.deepEqual(
      (badgesByTarget.get(ITERATION_2_IDS.retry) ?? []).map((badge) => badge.id).sort(),
      [ITERATION_2_IDS.scopeCheckStep, ITERATION_2_IDS.scopeCheckAttempt].sort(),
      'iteration 2 scope-checks attach to the iteration 2 node, not bleeding onto iteration 1',
    );

    assert.equal(
      badgesByTarget.has('review-claude'),
      false,
      'the ambiguous bare segment shared by both iterations must not strand badges',
    );
  });

  test('scope-checks for a non-nested step keep attaching via the runtime-ref fallback path', () => {
    const { groups, badgesByTarget } = groupRunBeads([rootBead(), ...repairStepBeads()], ROOT_ID);

    const repairNode = groups.find((group) => group.semanticNodeId === 'ga-wisp-a2s47g');
    assert.ok(repairNode, 'retry + attempt beads merge into one node keyed by the retry bead id');

    const badges = badgesByTarget.get('ga-wisp-a2s47g') ?? [];
    assert.deepEqual(
      badges.map((badge) => badge.id),
      ['ga-wisp-6nm1th'],
      'previously-working scope-check attachment is preserved',
    );
  });
});
