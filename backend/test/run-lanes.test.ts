import type { RunDisplayNode } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildRunDisplayLanes } from '../src/runs/lanes.js';

describe('run display lanes', () => {
  test('groups nodes by scope while preserving first-seen lane and node order', () => {
    const lanes = buildRunDisplayLanes([
      node('root'),
      node('rig-a-1', 'rig-a'),
      node('rig-b-1', 'rig-b'),
      node('rig-a-2', 'rig-a'),
    ]);

    assert.deepEqual(lanes, [
      { id: '__run', label: 'Run', nodeIds: ['root'] },
      { id: 'rig-a', label: 'rig-a', nodeIds: ['rig-a-1', 'rig-a-2'] },
      { id: 'rig-b', label: 'rig-b', nodeIds: ['rig-b-1'] },
    ]);
  });
});

function node(id: string, scopeRef?: string): RunDisplayNode {
  const displayNode: RunDisplayNode = {
    id,
    semanticNodeId: id,
    title: id,
    kind: 'step',
    constructKind: 'step',
    status: 'ready',
    currentBeadId: id,
    scope: scopeRef === undefined ? { kind: 'run' } : { kind: 'scoped', ref: scopeRef },
    visibleInGraph: true,
    historicalOnly: false,
    iterationSummary: { kind: 'single' },
    attemptSummary: { kind: 'none' },
    visibleExecutionInstanceId: id,
    executionInstances: [],
    controlBadges: [],
  };
  return displayNode;
}
