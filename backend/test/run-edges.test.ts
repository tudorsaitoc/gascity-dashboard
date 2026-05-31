import type {
  GcRunSnapshot,
  RunDisplayNode,
} from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildRunDisplayEdges } from '../src/runs/edges.js';

describe('run display edge projection', () => {
  test('prefers supervisor logical edges when they produce visible edges', () => {
    const detailEdges = buildRunDisplayEdges(
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
    const detailEdges = buildRunDisplayEdges(
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
    const detailEdges = buildRunDisplayEdges(
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
      { from: 'a', to: 'b', kind: 'dependency' },
    ]);
  });

  test('drops edges connected to nodes hidden from the visible graph', () => {
    const detailEdges = buildRunDisplayEdges(
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
    const detailEdges = buildRunDisplayEdges(
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
          bead('finalize', 'run-finalize'),
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
    const detailEdges = buildRunDisplayEdges(
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

function snapshot(edges: Pick<GcRunSnapshot, 'deps' | 'logical_edges'>): GcRunSnapshot {
  return {
    run_id: 'root',
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

function nodes(ids: string[]): RunDisplayNode[] {
  return ids.map((id) => node(id));
}

function node(
  id: string,
  overrides: Partial<RunDisplayNode> = {},
): RunDisplayNode {
  return {
    id,
    semanticNodeId: id,
    title: id,
    kind: 'task',
    constructKind: 'step',
    status: 'ready',
    currentBeadId: id,
    scope: { kind: 'run' },
    visibleInGraph: true,
    historicalOnly: false,
    iterationSummary: { kind: 'single' },
    attemptSummary: { kind: 'none' },
    visibleExecutionInstanceId: id,
    executionInstances: [],
    controlBadges: [],
    ...overrides,
  };
}
