import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  GcWorkflowSnapshot,
  WorkflowDisplayNode,
} from 'gas-city-dashboard-shared';
import { buildWorkflowDisplayEdges } from '../src/workflows/edges.js';

describe('workflow display edge projection', () => {
  test('prefers supervisor logical edges when they produce visible edges', () => {
    const detailEdges = buildWorkflowDisplayEdges(
      snapshot({
        deps: [{ from: 'physical-root', to: 'physical-b', kind: 'physical' }],
        logical_edges: [
          { from: 'root', to: 'a', kind: 'logical' },
          { from: 'a', to: 'b', kind: 'logical' },
        ],
      }),
      new Map([
        ['physical-root', 'root'],
        ['physical-b', 'b'],
      ]),
      nodes(['root', 'a', 'b']),
    );

    assert.deepEqual(detailEdges, [
      { from: 'root', to: 'a', kind: 'logical' },
      { from: 'a', to: 'b', kind: 'logical' },
    ]);
  });

  test('falls back to physical deps when logical edges have no visible projection', () => {
    const detailEdges = buildWorkflowDisplayEdges(
      snapshot({
        deps: [
          { from: 'physical-root', to: 'physical-a', kind: 'physical' },
          { from: 'physical-a', to: 'physical-b', kind: 'physical' },
        ],
        logical_edges: [{ from: 'hidden-a', to: 'hidden-b', kind: 'logical' }],
      }),
      new Map([
        ['physical-root', 'root'],
        ['physical-a', 'a'],
        ['physical-b', 'b'],
      ]),
      nodes(['root', 'a', 'b']),
    );

    assert.deepEqual(detailEdges, [
      { from: 'root', to: 'a', kind: 'physical' },
      { from: 'a', to: 'b', kind: 'physical' },
    ]);
  });

  test('drops hidden, duplicate, self, and empty edges', () => {
    const detailEdges = buildWorkflowDisplayEdges(
      snapshot({
        deps: [
          { from: 'root', to: 'a', kind: 'blocks' },
          { from: 'root', to: 'a', kind: 'blocks' },
          { from: 'a', to: 'a', kind: 'self' },
          { from: 'a', to: 'hidden', kind: 'hidden' },
          { from: ' ', to: 'b', kind: 'empty' },
          { from: 'a', to: 'b' },
        ],
        logical_edges: [],
      }),
      new Map(),
      nodes(['root', 'a', 'b']),
    );

    assert.deepEqual(detailEdges, [
      { from: 'root', to: 'a', kind: 'blocks' },
      { from: 'a', to: 'b' },
    ]);
  });

  test('drops edges connected to nodes hidden from the visible graph', () => {
    const detailEdges = buildWorkflowDisplayEdges(
      snapshot({
        deps: [
          { from: 'root', to: 'old-only-review', kind: 'historical' },
          { from: 'root', to: 'current-review', kind: 'current' },
        ],
        logical_edges: [],
      }),
      new Map(),
      [
        node('root'),
        node('old-only-review', { visibleInGraph: false }),
        node('current-review'),
      ],
    );

    assert.deepEqual(detailEdges, [
      { from: 'root', to: 'current-review', kind: 'current' },
    ]);
  });

  test('bridges visible dependency edges through hidden scope-check controls', () => {
    const detailEdges = buildWorkflowDisplayEdges(
      {
        ...snapshot({
          deps: [
            { from: 'root', to: 'step-a', kind: 'tracks' },
            { from: 'step-a', to: 'step-a-scope-check', kind: 'blocks' },
            { from: 'step-a-scope-check', to: 'step-b', kind: 'blocks' },
            { from: 'step-b', to: 'finalize', kind: 'blocks' },
            { from: 'finalize', to: 'root', kind: 'blocks' },
          ],
          logical_edges: [],
        }),
        beads: [
          bead('step-a-scope-check', 'scope-check'),
          bead('finalize', 'workflow-finalize'),
        ],
      },
      new Map([
        ['root', 'root'],
        ['step-a', 'step-a'],
        ['step-a-scope-check', 'step-a-scope-check'],
        ['step-b', 'step-b'],
        ['finalize', 'finalize'],
      ]),
      nodes(['root', 'step-a', 'step-b']),
    );

    assert.deepEqual(detailEdges, [
      { from: 'step-a', to: 'step-b', kind: 'blocks' },
    ]);
  });

  test('externalizes implementation-private ids in visible fallback edges', () => {
    const detailEdges = buildWorkflowDisplayEdges(
      snapshot({
        deps: [{ from: 'review-ralph', to: 'apply-fixes', kind: 'blocks' }],
        logical_edges: [],
      }),
      new Map(),
      nodes(['review-check-loop', 'apply-fixes']),
    );

    assert.deepEqual(detailEdges, [
      { from: 'review-check-loop', to: 'apply-fixes', kind: 'blocks' },
    ]);
  });
});

function snapshot(edges: Pick<GcWorkflowSnapshot, 'deps' | 'logical_edges'>): GcWorkflowSnapshot {
  return {
    workflow_id: 'root',
    root_bead_id: 'root',
    root_store_ref: 'city:racoon-city',
    resolved_root_store: 'city:racoon-city',
    scope_kind: 'city',
    scope_ref: 'racoon-city',
    snapshot_version: 1,
    snapshot_event_seq: 1,
    partial: false,
    stores_scanned: ['city:racoon-city'],
    beads: [],
    scope_groups: [],
    logical_nodes: [],
    deps: edges.deps,
    logical_edges: edges.logical_edges,
  };
}

function bead(id: string, kind: string) {
  return {
    id,
    title: id,
    status: 'pending',
    kind,
    metadata: { 'gc.kind': kind },
  };
}

function nodes(ids: string[]): WorkflowDisplayNode[] {
  return ids.map((id) => node(id));
}

function node(
  id: string,
  overrides: Partial<WorkflowDisplayNode> = {},
): WorkflowDisplayNode {
  return {
    id,
    semanticNodeId: id,
    title: id,
    kind: 'task',
    constructKind: 'step',
    status: 'ready',
    executionInstances: [],
    ...overrides,
  };
}
