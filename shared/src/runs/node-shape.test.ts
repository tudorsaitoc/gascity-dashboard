import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { constructKindFor, hiddenBadgeTargetFor, isHiddenConstruct } from './node-shape.js';
import { enrichFormulaRun } from './enrich.js';
import type { RunSnapshot, RunSnapshotBead } from '../run-snapshot.js';

// Audit finding M6: the supervisor's graph.v2 compiler emits the finalize
// control with gc.kind 'workflow-finalize' (gascity internal/formula/graph.go),
// but the node-shaper only recognized 'run-finalize'. The finalize construct
// therefore leaked into the graph as a visible blocked step, and its inbound
// blocks-edge into the root flipped a healthy in-flight run root to 'blocked'.

const ROOT_ID = 'ga-wisp-x0tank';

function bead(overrides: Partial<RunSnapshotBead> & { id: string }): RunSnapshotBead {
  return {
    title: overrides.id,
    status: 'pending',
    kind: 'task',
    metadata: {},
    ...overrides,
  } as RunSnapshotBead;
}

// Mirrors ga-wisp-kodbcf from the captured ga-wisp-x0tank supervisor payload:
// the real wire kind string is 'workflow-finalize' in both `kind` and `gc.kind`.
function workflowFinalizeBead(): RunSnapshotBead {
  return bead({
    id: 'ga-wisp-kodbcf',
    title: 'Finalize workflow',
    status: 'pending',
    kind: 'workflow-finalize',
    step_ref: 'mol-adopt-pr-v2.workflow-finalize',
    assignee: 'gascity--control-dispatcher',
    metadata: {
      'gc.kind': 'workflow-finalize',
      'gc.root_bead_id': ROOT_ID,
      'gc.root_store_ref': 'rig:gascity',
      'gc.step_ref': 'mol-adopt-pr-v2.workflow-finalize',
    },
  });
}

describe('constructKindFor — finalize construct recognition (M6)', () => {
  test("real wire kind 'workflow-finalize' classifies as run-finalize, not step", () => {
    assert.equal(constructKindFor(workflowFinalizeBead(), ROOT_ID), 'run-finalize');
  });

  test("legacy 'run-finalize' kind still classifies as run-finalize", () => {
    const legacy = bead({
      id: 'ga-wisp-legacy',
      kind: 'run-finalize',
      metadata: { 'gc.kind': 'run-finalize' },
    });
    assert.equal(constructKindFor(legacy, ROOT_ID), 'run-finalize');
  });

  test('the workflow-finalize construct is hidden and badges the run root', () => {
    const finalize = workflowFinalizeBead();
    assert.equal(isHiddenConstruct(constructKindFor(finalize, ROOT_ID)), true);
    assert.equal(hiddenBadgeTargetFor(finalize, ROOT_ID), ROOT_ID);
  });
});

describe('enrichFormulaRun — workflow-finalize does not leak into the graph (M6)', () => {
  function snapshot(): RunSnapshot {
    const root = bead({
      id: ROOT_ID,
      title: 'mol-adopt-pr-v2',
      status: 'pending',
      kind: 'workflow',
      metadata: { 'gc.formula_contract': 'graph.v2' },
    });
    const step = bead({
      id: 'ga-wisp-step01',
      title: 'Preflight repository and source convoy',
      status: 'completed',
      kind: 'task',
      step_ref: 'mol-adopt-pr-v2.preflight',
      metadata: {
        'gc.root_bead_id': ROOT_ID,
        'gc.step_id': 'preflight',
        'gc.step_ref': 'mol-adopt-pr-v2.preflight',
      },
    });
    return {
      run_id: ROOT_ID,
      root_bead_id: ROOT_ID,
      root_store_ref: 'rig:gascity',
      resolved_root_store: 'rig:gascity',
      scope_kind: 'rig',
      scope_ref: 'gascity',
      snapshot_version: 7976089,
      snapshot_event_seq: 100,
      partial: false,
      stores_scanned: ['rig:gascity'],
      beads: [root, step, workflowFinalizeBead()],
      deps: [
        { from: 'ga-wisp-step01', to: 'ga-wisp-kodbcf', kind: 'blocks' },
        { from: 'ga-wisp-kodbcf', to: ROOT_ID, kind: 'blocks' },
      ],
      logical_nodes: [],
      logical_edges: [],
      scope_groups: [],
    };
  }

  test('finalize renders as a root badge, not a visible step node', () => {
    const detail = enrichFormulaRun(snapshot(), {});

    const leaked = detail.nodes.find((node) =>
      node.executionInstances.some((instance) => instance.beadId === 'ga-wisp-kodbcf'),
    );
    assert.equal(leaked, undefined, 'workflow-finalize must not surface as a graph node');

    const root = detail.nodes.find((node) => node.id === ROOT_ID);
    assert.ok(root, 'run root node present');
    assert.deepEqual(
      root.controlBadges.map((badge) => badge.label),
      ['finalize'],
    );
  });

  test('the pending finalize construct no longer flips the open root to blocked', () => {
    const detail = enrichFormulaRun(snapshot(), {});
    const root = detail.nodes.find((node) => node.id === ROOT_ID);
    assert.ok(root, 'run root node present');
    assert.equal(root.status, 'ready');
  });
});
