import type {
  GcRunBead,
  RunConstructKind,
} from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  badgeLabelFor,
  constructKindFor,
  displayTitleFor,
  externalKindFor,
  hiddenBadgeTargetFor,
  isHiddenConstruct,
  loopControlNodeIdFor,
  semanticNodeIdFor,
} from '../src/runs/node-shape.js';

describe('run node shape projection', () => {
  test('derives semantic ids by precedence without exposing private names', () => {
    assert.equal(semanticNodeIdFor(runBead({ id: 'root' }), 'root'), 'root');
    assert.equal(
      semanticNodeIdFor(runBead({
        logical_bead_id: 'review-ralph',
        metadata: { 'gc.step_id': 'ignored-step' },
      }), 'root'),
      'review-check-loop',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        metadata: { 'gc.step_id': 'apply-fixes' },
        step_ref: 'mol.review-loop.iteration.2.ignored',
      }), 'root'),
      'apply-fixes',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        step_ref: 'mol.review-loop.iteration.2.review-ralph',
      }), 'root'),
      'review-check-loop',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        step_ref: 'mol.review.attempt.2',
      }), 'root'),
      'review',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        step_ref: 'mol.review-loop.run.1',
      }), 'root'),
      'review-loop',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        step_ref: 'mol.review-loop.check.1',
      }), 'root'),
      'review-loop',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        step_ref: 'mol.review-loop.iteration.2',
      }), 'root'),
      'review-loop',
    );
    assert.equal(
      semanticNodeIdFor(runBead({
        step_ref: 'mol.review-loop.iteration.2.review-codex.attempt.3',
      }), 'root'),
      'review-codex',
    );
  });

  test('maps supervisor kinds to public construct kinds', () => {
    assert.equal(constructKindFor(runBead({ id: 'root' }), 'root'), 'run-root');
    assert.equal(kindFor('ralph'), 'check-loop');
    assert.equal(kindFor('retry'), 'retry');
    assert.equal(kindFor('epic'), 'scope');
    assert.equal(kindFor('body'), 'scope');
    assert.equal(kindFor('fanout'), 'fanout');
    assert.equal(kindFor('condition'), 'condition');
    assert.equal(kindFor('expand'), 'expansion');
    assert.equal(kindFor('scope-check'), 'scope-check');
    assert.equal(kindFor('run-finalize'), 'run-finalize');
    assert.equal(kindFor('spec'), 'spec');
    assert.equal(kindFor('cleanup'), 'control');
    assert.equal(kindFor('task'), 'step');
  });

  test('ignores non-supervisor constructKind metadata aliases', () => {
    assert.equal(
      constructKindFor(runBead({
        metadata: { constructKind: 'fanout', 'gc.kind': 'task' },
      }), 'root'),
      'step',
    );
    assert.equal(
      constructKindFor(runBead({
        metadata: { constructKind: 'not-real', 'gc.kind': 'retry' },
      }), 'root'),
      'retry',
    );
  });

  test('external kind labels also suppress private names', () => {
    const bead = runBead({ metadata: { 'gc.kind': 'ralph' } });

    assert.equal(externalKindFor(bead, 'check-loop'), 'check-loop');
    assert.equal(externalKindFor(runBead({ kind: 'task' }), 'step'), 'task');
    assert.equal(externalKindFor(runBead({ kind: ' ' }), 'step'), 'step');
  });

  test('computes hidden control badge targets and labels', () => {
    assert.equal(
      hiddenBadgeTargetFor(runBead({
        metadata: {
          'gc.kind': 'run-finalize',
          'gc.step_ref': 'mol.finalize',
        },
      }), 'root'),
      'root',
    );
    assert.equal(
      hiddenBadgeTargetFor(runBead({
        metadata: {
          'gc.kind': 'scope-check',
          'gc.step_ref': 'mol.review-loop.iteration.2.review-pipeline.scope-check',
        },
      }), 'root'),
      'review-pipeline',
    );
    assert.equal(
      hiddenBadgeTargetFor(runBead({
        metadata: {
          'gc.kind': 'scope-check',
          'gc.step_ref': 'mol.review-loop.run.3.review-pipeline.review-codex.run.1-scope-check',
          'gc.control_for': 'review-loop.run.3.review-pipeline.review-codex.run.1',
        },
      }), 'root'),
      'review-codex',
    );
    assert.equal(
      hiddenBadgeTargetFor(runBead({
        metadata: {
          'gc.kind': 'scope-check',
          'gc.step_ref': 'mol.review-loop.run.3.review-pipeline.review-codex.eval.1-scope-check',
        },
      }), 'root'),
      'review-codex',
    );
    assert.equal(badgeLabelFor('scope-check'), 'scope check');
    assert.equal(badgeLabelFor('run-finalize'), 'finalize');
    assert.equal(badgeLabelFor('check-loop'), 'check loop');
  });

  test('classifies hidden/control constructs and visible constructs', () => {
    assert.equal(isHiddenConstruct('scope-check'), true);
    assert.equal(isHiddenConstruct('run-finalize'), true);
    assert.equal(isHiddenConstruct('spec'), true);
    assert.equal(isHiddenConstruct('control'), true);
    assert.equal(isHiddenConstruct('step'), false);
  });

  test('derives loop control ids from iteration step refs', () => {
    assert.equal(
      loopControlNodeIdFor(runBead({
        step_ref: 'mol.review-ralph.iteration.2.review-pipeline',
      })),
      'review-check-loop',
    );
    assert.equal(
      loopControlNodeIdFor(runBead({
        metadata: {
          'gc.scope_ref': 'mol.review-loop.run.2',
          'gc.step_ref': 'mol.review-loop.run.2.review-pipeline.review-codex.run.1',
        },
      })),
      'review-loop',
    );
    assert.equal(loopControlNodeIdFor(runBead({ step_ref: 'mol.review' })), undefined);
  });

  test('uses title when present and falls back to readable ids', () => {
    assert.equal(displayTitleFor(runBead({ title: ' Review pipeline ' }), 'fallback'), 'Review pipeline');
    assert.equal(displayTitleFor(runBead({ title: ' ' }), 'review-pipeline'), 'review pipeline');
  });

  test('suppresses private check-loop names in display titles', () => {
    assert.equal(
      displayTitleFor(runBead({ title: 'Review ralph pass' }), 'fallback'),
      'Review check loop pass',
    );
    assert.equal(
      displayTitleFor(runBead({ title: 'mol_ralph_review' }), 'fallback'),
      'mol check loop review',
    );
    assert.equal(
      displayTitleFor(runBead({ title: 'cryoralphic analysis' }), 'fallback'),
      'cryoralphic analysis',
    );
  });
});

function kindFor(kind: string): RunConstructKind {
  return constructKindFor(runBead({ kind, metadata: { 'gc.kind': kind } }), 'root');
}

function runBead(overrides: Partial<GcRunBead>): GcRunBead {
  return {
    id: 'node',
    title: 'Node',
    status: 'ready',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}
