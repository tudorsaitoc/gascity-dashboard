import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDisplayNode } from 'gas-city-dashboard-shared';
import { buildWorkflowDisplayLanes } from '../src/workflows/lanes.js';

describe('workflow display lanes', () => {
  test('groups nodes by scope while preserving first-seen lane and node order', () => {
    const lanes = buildWorkflowDisplayLanes([
      node('root'),
      node('rig-a-1', 'rig-a'),
      node('rig-b-1', 'rig-b'),
      node('rig-a-2', 'rig-a'),
    ]);

    assert.deepEqual(lanes, [
      { id: '__workflow', label: 'Workflow', nodeIds: ['root'] },
      { id: 'rig-a', label: 'rig-a', nodeIds: ['rig-a-1', 'rig-a-2'] },
      { id: 'rig-b', label: 'rig-b', nodeIds: ['rig-b-1'] },
    ]);
  });
});

function node(id: string, scopeRef?: string): WorkflowDisplayNode {
  return {
    id,
    semanticNodeId: id,
    title: id,
    kind: 'step',
    constructKind: 'step',
    status: 'ready',
    scopeRef,
    executionInstances: [],
  };
}
