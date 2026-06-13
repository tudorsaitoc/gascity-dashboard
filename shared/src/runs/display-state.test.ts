import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyDisplayNodeStates } from './display-state.js';
import type { RunDisplayEdge, RunDisplayNode, RunNodeStatus } from '../run-detail.js';

// gascity-dashboard (PR #120 review): `blocked` and `waiting` are two different
// facts that previously collapsed onto one value. `applyDisplayNodeStates` must
// derive `waiting` for a pending node still gated by upstream work, while a raw
// supervisor `blocked` bead is left untouched so genuinely blocked work stays
// operator-actionable. These tests pin that boundary.
describe('applyDisplayNodeStates', () => {
  test('derives waiting for a pending node with an unfinished upstream blocker', () => {
    const nodes = [nodeWith('upstream', 'active'), nodeWith('downstream', 'pending')];
    const edges: RunDisplayEdge[] = [edge('upstream', 'downstream')];

    const result = applyDisplayNodeStates(nodes, edges);

    assert.equal(statusOf(result, 'downstream'), 'waiting');
  });

  test('derives ready for a pending node whose blockers are all terminal', () => {
    const nodes = [nodeWith('upstream', 'completed'), nodeWith('downstream', 'pending')];
    const edges: RunDisplayEdge[] = [edge('upstream', 'downstream')];

    const result = applyDisplayNodeStates(nodes, edges);

    assert.equal(statusOf(result, 'downstream'), 'ready');
  });

  test('derives ready for a pending node with no upstream blockers', () => {
    const nodes = [nodeWith('lonely', 'pending')];

    const result = applyDisplayNodeStates(nodes, []);

    assert.equal(statusOf(result, 'lonely'), 'ready');
  });

  test('preserves a raw blocked bead — it is not downgraded to the calm waiting state', () => {
    // The supervisor reports this node as `blocked` (a store fact). It is NOT
    // pending, so the derivation must leave it as the operator-actionable
    // `blocked`, never the derived `waiting`.
    const nodes = [nodeWith('upstream', 'active'), nodeWith('stuck', 'blocked')];
    const edges: RunDisplayEdge[] = [edge('upstream', 'stuck')];

    const result = applyDisplayNodeStates(nodes, edges);

    assert.equal(statusOf(result, 'stuck'), 'blocked');
  });

  test('passes non-pending statuses through unchanged', () => {
    const passthrough: RunNodeStatus[] = ['active', 'failed', 'completed', 'done', 'skipped'];
    const nodes = passthrough.map((status) => nodeWith(status, status));

    const result = applyDisplayNodeStates(nodes, []);

    for (const status of passthrough) {
      assert.equal(statusOf(result, status), status);
    }
  });
});

function statusOf(nodes: readonly RunDisplayNode[], id: string): RunNodeStatus {
  const node = nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `expected node ${id} in result`);
  return node.status;
}

function edge(from: string, to: string): RunDisplayEdge {
  return { from, to, kind: 'dependency' };
}

function nodeWith(id: string, status: RunNodeStatus): RunDisplayNode {
  return {
    id,
    semanticNodeId: id,
    title: id,
    kind: 'step',
    constructKind: 'step',
    status,
    currentBeadId: id,
    scope: { kind: 'run' },
    visibleInGraph: true,
    historicalOnly: false,
    iterationSummary: { kind: 'single' },
    attemptSummary: { kind: 'none' },
    visibleExecutionInstanceId: id,
    executionInstances: [
      {
        id,
        semanticNodeId: id,
        beadId: id,
        iteration: { kind: 'base' },
        attempt: { kind: 'untracked' },
        label: 'base',
        status,
        session: { kind: 'none', reason: 'not_started' },
        currentIteration: true,
        historical: false,
      },
    ],
    controlBadges: [],
  };
}
