import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  GcFormulaDetail,
  GcWorkflowBead,
} from 'gas-city-dashboard-shared';
import { groupWorkflowBeads } from '../src/workflows/groups.js';
import { orderWorkflowNodeGroups } from '../src/workflows/formula-order.js';

describe('workflow formula source ordering', () => {
  test('orders display groups by compiled formula steps instead of shuffled bead order', () => {
    const groups = groupWorkflowBeads([
      bead('review-attempt-1', 'Review plan iteration 1', {
        'gc.logical_bead_id': 'review-control-1',
        'gc.step_ref': 'plan-cycle.iter1.review.iteration.1',
      }),
      bead('inspect-bead', 'Inspect scaffold', {
        'gc.step_ref': 'mol-demo-plan-review.inspect',
      }),
      bead('review-control-1', 'Review plan iteration 1', {
        'gc.kind': 'ralph',
        'gc.step_ref': 'mol-demo-plan-review.plan-cycle.iter1.review',
      }),
      bead('draft-bead', 'Draft plan iteration 1', {
        'gc.step_ref': 'mol-demo-plan-review.plan-cycle.iter1.draft',
      }),
    ], 'root').groups;

    const ordered = orderWorkflowNodeGroups(groups, formulaDetail(), 'root');

    assert.deepEqual(ordered.map((group) => group.semanticNodeId), [
      'inspect',
      'draft',
      'review-control-1',
    ]);
  });
});

function formulaDetail(): GcFormulaDetail {
  return {
    name: 'mol-demo-plan-review',
    preview: {
      nodes: [
        { id: 'mol-demo-plan-review.inspect', title: 'Inspect scaffold', kind: 'task' },
        { id: 'mol-demo-plan-review.plan-cycle.iter1.draft', title: 'Draft plan iteration 1', kind: 'task' },
        { id: 'mol-demo-plan-review.plan-cycle.iter1.review.iteration.1', title: 'Review plan iteration 1', kind: 'task' },
        { id: 'mol-demo-plan-review.plan-cycle.iter1.review', title: 'Review plan iteration 1', kind: 'ralph' },
      ],
      edges: [],
    },
  };
}

function bead(
  id: string,
  title: string,
  metadata: Record<string, string>,
): GcWorkflowBead {
  return {
    id,
    title,
    status: 'pending',
    kind: metadata['gc.kind'] ?? 'task',
    metadata,
  };
}
