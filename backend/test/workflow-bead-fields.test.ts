import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcWorkflowBead } from 'gas-city-dashboard-shared';
import {
  attemptFor,
  externalizeId,
  iterationFor,
  meta,
  normalizedStepRef,
  nonEmpty,
} from '../src/workflows/bead-fields.js';

describe('workflow bead field readers', () => {
  test('reads trimmed metadata and string fields', () => {
    const bead = workflowBead({
      step_ref: '  mol.review.iteration.2.apply  ',
      metadata: {
        'gc.step_ref': ' mol.review.iteration.3.apply ',
        count: ' 4 ',
      },
    });

    assert.equal(meta(bead, 'gc.step_ref'), 'mol.review.iteration.3.apply');
    assert.equal(meta(bead, 'count'), '4');
    assert.equal(nonEmpty('  value  '), 'value');
    assert.equal(nonEmpty('   '), undefined);
    assert.equal(normalizedStepRef(bead), 'mol.review.iteration.3.apply');
  });

  test('ignores malformed non-string metadata values', () => {
    const bead = workflowBead({
      metadata: {
        'gc.iteration': 2,
        'gc.step_ref': true,
      } as unknown as Record<string, string>,
    });

    assert.equal(meta(bead, 'gc.iteration'), undefined);
    assert.equal(iterationFor(bead), undefined);
    assert.equal(normalizedStepRef(bead), null);
  });

  test('derives attempt and iteration from metadata before step refs', () => {
    const bead = workflowBead({
      step_ref: 'mol.review.iteration.2.apply.attempt.3',
      attempt: 4,
      metadata: {
        'gc.iteration': '5',
        'gc.attempt': '6',
      },
    });

    assert.equal(iterationFor(bead), 5);
    assert.equal(attemptFor(bead), 6);
  });

  test('falls back to supervisor fields and step ref segments', () => {
    assert.equal(attemptFor(workflowBead({ attempt: 4 })), 4);
    assert.equal(iterationFor(workflowBead({
      step_ref: 'mol.review.iteration.2.apply',
    })), 2);
    assert.equal(attemptFor(workflowBead({
      step_ref: 'mol.review.apply.attempt.3',
    })), 3);
  });

  test('rejects malformed numeric fields instead of parsing numeric prefixes', () => {
    assert.equal(iterationFor(workflowBead({
      metadata: { 'gc.iteration': '2x' },
    })), undefined);
    assert.equal(iterationFor(workflowBead({
      step_ref: 'mol.review.iteration.2x.apply',
    })), undefined);
    assert.equal(attemptFor(workflowBead({
      metadata: { 'gc.attempt': '3x' },
      attempt: 0,
      step_ref: 'mol.review.apply.attempt.4x',
    })), undefined);
  });

  test('ignores non-supervisor metadata aliases for step refs', () => {
    const bead = workflowBead({
      metadata: { step_ref: 'mol.legacy.alias' },
    });

    assert.equal(normalizedStepRef(bead), null);
  });

  test('externalizes implementation-private check-loop ids', () => {
    assert.equal(externalizeId('mol-ralph-review'), 'mol-check-loop-review');
    assert.equal(externalizeId('mol_ralph_review'), 'mol_check-loop_review');
    assert.equal(externalizeId('RALPH'), 'check-loop');
    assert.equal(externalizeId('cryoralphic'), 'cryoralphic');
    assert.equal(externalizeId('review-loop'), 'review-loop');
  });
});

function workflowBead(overrides: Partial<GcWorkflowBead>): GcWorkflowBead {
  return {
    id: 'gc-step',
    title: 'Step',
    status: 'ready',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}
