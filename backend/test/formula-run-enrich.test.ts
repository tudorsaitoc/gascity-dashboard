import type {
  GcRunSnapshot,
  RunDisplayNode,
  RunExecutionInstance,
  FormulaRunDetail,
} from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  enrichFormulaRun,
  UnsupportedRunError,
} from '../src/runs/enrich.js';
import {
  activeAdoptPrGraphV2Snapshot,
  capturedDashboardGraphV2SmokeSnapshot,
  completedBugHuntGraphV2Snapshot,
} from './fixtures/run-snapshots.js';

describe('run presentation enrichment fixtures', () => {
  test('captured supervisor smoke snapshot collapses hidden scope-check controls into display edges and badges', () => {
    const detail = enrichFormulaRun(capturedDashboardGraphV2SmokeSnapshot, {});

    assert.equal(detail.runId, 'gvt-nayu');
    assert.equal(detail.scopeKind, 'rig');
    assert.equal(detail.scopeRef, 'dashboard-graphv2-test');
    assert.deepEqual(detail.formula, {
      kind: 'unavailable',
      reason: 'missing_formula_metadata',
    });
    assert.deepEqual(detail.nodes.map((node) => node.id), [
      'gvt-nayu',
      'inspect',
      'summarize',
    ]);
    assert.deepEqual(detail.edges, [
      { from: 'inspect', to: 'summarize', kind: 'blocks' },
    ]);
    assert.deepEqual(findNode(detail, 'gvt-nayu').controlBadges, [
      { id: 'gvt-stzb', label: 'finalize', status: 'pending' },
    ]);
    assert.deepEqual(findNode(detail, 'inspect').controlBadges, [
      { id: 'gvt-0vsm', label: 'scope check', status: 'pending' },
    ]);
    assert.deepEqual(findNode(detail, 'summarize').controlBadges, [
      { id: 'gvt-toae', label: 'scope check', status: 'pending' },
    ]);
  });

  test('active adopt-pr graph keeps latest loop iteration selectable and historical sessions available', () => {
    const detail = enrichFormulaRun(activeAdoptPrGraphV2Snapshot, {
      rigRoot: '/unused/rig-root',
    });

    assert.equal(detail.runId, 'gc-adopt-pr-active');
    assert.equal(formulaName(detail), 'mol-adopt-pr-v2');
    assert.equal(executionPath(detail), '/tmp/gascity/adopt-pr-42');
    assert.equal(JSON.stringify(detail).toLowerCase().includes('ralph'), false);

    const nodeIds = detail.nodes.map((node) => node.id);
    assert.deepEqual(nodeIds, [
      'gc-adopt-pr-active',
      'rebase-check',
      'review-loop',
      'review-pipeline',
      'apply-fixes',
      'pre-approval-ci',
    ]);

    const root = findNode(detail, 'gc-adopt-pr-active');
    assert.equal(root.constructKind, 'run-root');
    assert.deepEqual(root.controlBadges, [
      { id: 'gc-adopt-finalize', label: 'finalize', status: 'ready' },
    ]);

    const reviewLoop = findNode(detail, 'review-loop');
    assert.equal(reviewLoop.constructKind, 'check-loop');
    assert.deepEqual(reviewLoop.attemptSummary, {
      kind: 'tracked',
      count: 1,
      badge: { kind: 'bounded', label: '1/999' },
      active: { kind: 'idle' },
    });

    const reviewPipeline = findNode(detail, 'review-pipeline');
    assert.equal(reviewPipeline.constructKind, 'expansion');
    assert.equal(reviewPipeline.status, 'active');
    assertStackedIteration(reviewPipeline, 2, 2, 'review-loop');
    assert.equal(reviewPipeline.executionInstances.length, 2);
    assert.equal(reviewPipeline.executionInstances[0]?.historical, true);
    assert.equal(streamable(reviewPipeline.executionInstances[0]), false);
    assert.equal(reviewPipeline.executionInstances[1]?.currentIteration, true);
    assert.equal(streamable(reviewPipeline.executionInstances[1]), true);
    assert.equal(sessionId(reviewPipeline.executionInstances[1]), 'gc-session-review-i2');
    assert.deepEqual(reviewPipeline.controlBadges, [
      { id: 'gc-review-pipeline-scope-check', label: 'scope check', status: 'completed' },
    ]);

    const applyFixes = findNode(detail, 'apply-fixes');
    assert.equal(applyFixes.status, 'ready');
    assertStackedIteration(applyFixes, 2, 2, 'review-loop');
    assert.equal(applyFixes.executionInstances[0]?.historical, true);
    assert.equal(applyFixes.executionInstances[1]?.currentIteration, true);

    const preApprovalCi = findNode(detail, 'pre-approval-ci');
    assert.equal(preApprovalCi.constructKind, 'condition');
    assert.equal(preApprovalCi.status, 'skipped');
    assertRunningCurrentSessionInvariant(detail);

    assert.equal(
      detail.edges.some((edge) => edge.from === 'pre-approval-ci' && edge.to === 'gc-adopt-finalize'),
      false,
      'hidden run-finalize bead should not produce a visible edge',
    );
  });

  test('completed bug-hunt graph preserves failed retry transcript history and fanout semantics', () => {
    const detail = enrichFormulaRun(completedBugHuntGraphV2Snapshot, {
      rigRoot: '/Users/csells/Code/gascity/bug-rig',
    });

    assert.equal(detail.runId, 'gc-bug-hunt-complete');
    assert.equal(formulaName(detail), 'mol-bug-hunt-v2');
    assert.equal(detail.scopeKind, 'rig');
    assert.equal(detail.scopeRef, 'bug-rig');
    assert.equal(executionPath(detail), '/Users/csells/Code/gascity/bug-rig');

    const body = findNode(detail, 'body');
    assert.equal(body.constructKind, 'scope');
    assert.equal(body.status, 'completed');

    const prepareHunters = findNode(detail, 'prepare-hunters');
    assert.equal(prepareHunters.constructKind, 'retry');
    assert.equal(prepareHunters.status, 'completed');
    assert.deepEqual(prepareHunters.attemptSummary, {
      kind: 'tracked',
      count: 2,
      badge: { kind: 'bounded', label: '2/3' },
      active: { kind: 'idle' },
    });
    assert.equal(prepareHunters.executionInstances.length, 2);
    assert.equal(prepareHunters.executionInstances[0]?.status, 'failed');
    assert.equal(
      sessionId(prepareHunters.executionInstances[0]),
      'gc-session-prepare-a1',
      'failed attempts still need transcript access',
    );
    assert.equal(streamable(prepareHunters.executionInstances[0]), false);
    assert.equal(prepareHunters.executionInstances[1]?.status, 'completed');

    const fanout = findNode(detail, 'hunter-fanout');
    assert.equal(fanout.constructKind, 'fanout');
    assert.equal(fanout.status, 'completed');

    const skippedHunter = findNode(detail, 'hunter-gemini');
    assert.equal(skippedHunter.constructKind, 'condition');
    assert.equal(skippedHunter.status, 'skipped');
    assertNoSession(skippedHunter.executionInstances[0]);

    const synthesize = findNode(detail, 'synthesize-findings');
    assert.equal(synthesize.status, 'completed');
    assertNoSession(synthesize.executionInstances[0]);

    const root = findNode(detail, 'gc-bug-hunt-complete');
    assert.deepEqual(root.controlBadges, [
      { id: 'gc-finalize', label: 'finalize', status: 'completed' },
    ]);
    assertRunningCurrentSessionInvariant(detail);
    assert.equal(JSON.stringify(detail).toLowerCase().includes('ralph'), false);
  });

  test('keeps supervisor formula order for nodes while preferring logical edges', () => {
    const detail = enrichFormulaRun(formulaOrderGraphSnapshot({
      deps: [
        { from: 'gc-root', to: 'gc-step-b', kind: 'physical' },
        { from: 'gc-step-b', to: 'gc-step-a', kind: 'physical' },
      ],
      logical_edges: [
        { from: 'gc-root', to: 'step-a', kind: 'logical' },
        { from: 'step-a', to: 'step-b', kind: 'logical' },
      ],
    }), {});

    assert.deepEqual(detail.nodes.map((node) => node.id), [
      'gc-root',
      'step-b',
      'step-a',
    ]);
    assert.deepEqual(detail.edges, [
      { from: 'gc-root', to: 'step-a', kind: 'logical' },
      { from: 'step-a', to: 'step-b', kind: 'logical' },
    ]);
  });

  test('falls back to physical deps for edges without changing formula order', () => {
    const detail = enrichFormulaRun(formulaOrderGraphSnapshot({
      deps: [
        { from: 'gc-root', to: 'gc-step-a', kind: 'physical' },
        { from: 'gc-step-a', to: 'gc-step-b', kind: 'physical' },
      ],
      logical_edges: [],
    }), {});

    assert.deepEqual(detail.nodes.map((node) => node.id), [
      'gc-root',
      'step-b',
      'step-a',
    ]);
    assert.deepEqual(detail.edges, [
      { from: 'gc-root', to: 'step-a', kind: 'physical' },
      { from: 'step-a', to: 'step-b', kind: 'physical' },
    ]);
  });

  test('derives ready and blocked graph states from dependency edges', () => {
    const detail = enrichFormulaRun(waitingGraphSnapshot(), {});

    assert.equal(findNode(detail, 'ready-step').status, 'ready');
    assert.equal(findNode(detail, 'blocked-step').status, 'blocked');
    assert.equal(findNode(detail, 'done-step').status, 'completed');
    assert.equal(findNode(detail, 'gc-waiting').status, 'active');
    assert.deepEqual(detail.progress.statusCounts, {
      active: 1,
      ready: 1,
      blocked: 1,
      completed: 1,
    });
    assertRunningCurrentSessionInvariant(detail);
  });

  test('marks loop body nodes missing from the latest iteration as historical-only', () => {
    const detail = enrichFormulaRun(historicalOnlyLoopSnapshot(), {});

    const oldOnly = findNode(detail, 'old-only-review');
    assertStackedIteration(oldOnly, 1, 1, 'review-loop');
    assert.equal(oldOnly.historicalOnly, true);
    assert.equal(oldOnly.visibleInGraph, false);
    assert.equal(oldOnly.executionInstances[0]?.historical, true);
    assert.equal(streamable(oldOnly.executionInstances[0]), false);

    const current = findNode(detail, 'current-review');
    assertStackedIteration(current, 2, 1, 'review-loop');
    assert.equal(current.historicalOnly, false);
    assert.equal(current.visibleInGraph, true);
    assertRunningCurrentSessionInvariant(detail);
  });

  test('rejects graph.v2 contract aliases outside current supervisor metadata', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    const root = snapshot.beads?.find((bead) => bead.id === 'gc-root');
    assert.ok(root);
    root.metadata = {
      'gc.kind': 'run',
      contract: 'graph.v2',
      formula_contract: 'graph.v2',
      'gc.contract': 'graph.v2',
      'gc.formula': 'mol-test',
    };

    assert.throws(
      () => enrichFormulaRun(snapshot, {}),
      UnsupportedRunError,
    );
  });

  test('rejects snapshots whose root bead id does not match a supervisor bead', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    snapshot.root_bead_id = 'missing-root';

    assert.throws(
      () => enrichFormulaRun(snapshot, {}),
      UnsupportedRunError,
    );
  });

  test('rejects missing or invalid supervisor scope fields', () => {
    const missingRef = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    missingRef.scope_ref = '   ';
    const invalidKind = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    invalidKind.scope_kind = 'workspace';

    assert.throws(
      () => enrichFormulaRun(missingRef, {}),
      UnsupportedRunError,
    );
    assert.throws(
      () => enrichFormulaRun(invalidKind, {}),
      UnsupportedRunError,
    );
  });

  test('rejects malformed required snapshot metadata', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    snapshot.snapshot_version = '8' as unknown as number;

    assert.throws(
      () => enrichFormulaRun(snapshot, {}),
      UnsupportedRunError,
    );
  });

  test('rejects missing required supervisor identity and store fields', () => {
    const missingRunId = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    missingRunId.run_id = '   ';
    const missingRootStore = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    missingRootStore.root_store_ref = '   ';
    const missingResolvedStore = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    missingResolvedStore.resolved_root_store = '   ';
    const malformedPartial = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    malformedPartial.partial = 'false' as unknown as boolean;

    assert.throws(
      () => enrichFormulaRun(missingRunId, {}),
      UnsupportedRunError,
    );
    assert.throws(
      () => enrichFormulaRun(missingRootStore, {}),
      UnsupportedRunError,
    );
    assert.throws(
      () => enrichFormulaRun(missingResolvedStore, {}),
      UnsupportedRunError,
    );
    assert.throws(
      () => enrichFormulaRun(malformedPartial, {}),
      UnsupportedRunError,
    );
  });

  test('does not read formula names from non-supervisor metadata aliases', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    const root = snapshot.beads?.find((bead) => bead.id === 'gc-root');
    assert.ok(root);
    root.metadata = {
      'gc.kind': 'run',
      'gc.formula_contract': 'graph.v2',
      formula: 'legacy-alias',
    };

    const detail = enrichFormulaRun(snapshot, {});

    assert.deepEqual(detail.formula, {
      kind: 'unavailable',
      reason: 'missing_formula_metadata',
    });
  });

  test('uses Gas City gc.formula_name metadata when gc.formula is absent', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    const root = snapshot.beads?.find((bead) => bead.id === 'gc-root');
    assert.ok(root);
    root.metadata = {
      'gc.kind': 'run',
      'gc.formula_contract': 'graph.v2',
      'gc.formula_name': 'mol-test',
    };

    const detail = enrichFormulaRun(snapshot, {});

    assert.deepEqual(detail.formula, { kind: 'known', name: 'mol-test' });
  });
});

function findNode(detail: FormulaRunDetail, id: string): RunDisplayNode {
  const node = detail.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `expected run node ${id}`);
  return node;
}

function formulaName(detail: FormulaRunDetail): string {
  assert.equal(detail.formula.kind, 'known');
  return detail.formula.name;
}

function executionPath(detail: FormulaRunDetail): string {
  assert.equal(detail.executionPath.kind, 'known');
  return detail.executionPath.path;
}

function assertStackedIteration(
  node: RunDisplayNode,
  visibleIteration: number,
  iterationCount: number,
  controlNodeId: string,
): void {
  assert.deepEqual(node.iterationSummary, {
    kind: 'stacked',
    visibleIteration,
    iterationCount,
    control: { kind: 'known', id: controlNodeId },
  });
}

function streamable(instance: RunExecutionInstance | undefined): boolean {
  return instance?.session.kind === 'attached' && instance.session.streamable;
}

function sessionId(instance: RunExecutionInstance | undefined): string {
  assert.equal(instance?.session.kind, 'attached');
  return instance.session.link.sessionId;
}

function assertNoSession(instance: RunExecutionInstance | undefined): void {
  assert.equal(instance?.session.kind, 'none');
}

function assertRunningCurrentSessionInvariant(detail: FormulaRunDetail): void {
  for (const node of detail.nodes) {
    for (const instance of node.executionInstances) {
      if (!instance.currentIteration || !isRunningStatus(instance.status)) continue;
      if (instance.session.kind === 'attached') {
        assert.equal(
          instance.session.streamable,
          true,
          `${node.id}/${instance.id} is running and attached, so it must be streamable`,
        );
      } else {
        assert.equal(
          instance.session.reason,
          'session_unresolved',
          `${node.id}/${instance.id} is running without a session, so it must be explicit`,
        );
      }
    }
  }
}

function isRunningStatus(status: RunExecutionInstance['status']): boolean {
  return status === 'active' || status === 'running';
}

function formulaOrderGraphSnapshot(edges: {
  deps: GcRunSnapshot['deps'];
  logical_edges: GcRunSnapshot['logical_edges'];
}): GcRunSnapshot {
  return {
    run_id: 'gc-root',
    root_bead_id: 'gc-root',
    root_store_ref: 'city:racoon-city',
    resolved_root_store: 'city:racoon-city',
    scope_kind: 'city',
    scope_ref: 'racoon-city',
    snapshot_version: 8,
    snapshot_event_seq: 43,
    partial: false,
    stores_scanned: ['city:racoon-city'],
    beads: [
      {
        id: 'gc-root',
        title: 'Formula-order run',
        status: 'in_progress',
        kind: 'run',
        metadata: {
          'gc.kind': 'run',
          'gc.formula_contract': 'graph.v2',
          'gc.formula': 'mol-test',
        },
      },
      {
        id: 'gc-step-b',
        title: 'Step B',
        status: 'ready',
        kind: 'task',
        step_ref: 'mol-test.step-b',
        logical_bead_id: 'step-b',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'step-b',
          'gc.step_ref': 'mol-test.step-b',
        },
      },
      {
        id: 'gc-step-a',
        title: 'Step A',
        status: 'closed',
        kind: 'task',
        step_ref: 'mol-test.step-a',
        logical_bead_id: 'step-a',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'step-a',
          'gc.step_ref': 'mol-test.step-a',
        },
      },
    ],
    deps: edges.deps,
    logical_nodes: [],
    logical_edges: edges.logical_edges,
    scope_groups: [],
  };
}

function waitingGraphSnapshot(): GcRunSnapshot {
  return {
    run_id: 'gc-waiting',
    root_bead_id: 'gc-waiting',
    root_store_ref: 'city:racoon-city',
    resolved_root_store: 'city:racoon-city',
    scope_kind: 'city',
    scope_ref: 'racoon-city',
    snapshot_version: 10,
    snapshot_event_seq: 45,
    partial: false,
    stores_scanned: ['city:racoon-city'],
    beads: [
      {
        id: 'gc-waiting',
        title: 'Waiting run',
        status: 'in_progress',
        kind: 'run',
        metadata: {
          'gc.kind': 'run',
          'gc.formula_contract': 'graph.v2',
        },
      },
      {
        id: 'gc-done-step',
        title: 'Done step',
        status: 'closed',
        kind: 'task',
        logical_bead_id: 'done-step',
        metadata: {
          'gc.kind': 'task',
          'gc.outcome': 'pass',
          'gc.step_id': 'done-step',
        },
      },
      {
        id: 'gc-ready-step',
        title: 'Ready step',
        status: 'open',
        kind: 'task',
        logical_bead_id: 'ready-step',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'ready-step',
        },
      },
      {
        id: 'gc-blocked-step',
        title: 'Blocked step',
        status: 'open',
        kind: 'task',
        logical_bead_id: 'blocked-step',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'blocked-step',
        },
      },
    ],
    deps: [
      { from: 'gc-done-step', to: 'gc-ready-step', kind: 'blocks' },
      { from: 'gc-ready-step', to: 'gc-blocked-step', kind: 'blocks' },
    ],
    logical_nodes: [],
    logical_edges: [],
    scope_groups: [],
  };
}

function historicalOnlyLoopSnapshot(): GcRunSnapshot {
  return {
    run_id: 'gc-root',
    root_bead_id: 'gc-root',
    root_store_ref: 'city:racoon-city',
    resolved_root_store: 'city:racoon-city',
    scope_kind: 'city',
    scope_ref: 'racoon-city',
    snapshot_version: 9,
    snapshot_event_seq: 44,
    partial: false,
    stores_scanned: ['city:racoon-city'],
    beads: [
      {
        id: 'gc-root',
        title: 'Historical loop run',
        status: 'in_progress',
        kind: 'run',
        metadata: {
          'gc.kind': 'run',
          'gc.formula_contract': 'graph.v2',
          'gc.formula': 'mol-test',
        },
      },
      {
        id: 'gc-review-loop',
        title: 'Review loop',
        status: 'in_progress',
        kind: 'ralph',
        step_ref: 'mol-test.review-loop',
        logical_bead_id: 'review-loop',
        metadata: {
          'gc.kind': 'ralph',
          'gc.step_id': 'review-loop',
          'gc.step_ref': 'mol-test.review-loop',
        },
      },
      {
        id: 'gc-old-only-review-i1',
        title: 'Old-only review',
        status: 'closed',
        kind: 'task',
        step_ref: 'mol-test.review-loop.iteration.1.old-only-review',
        logical_bead_id: 'old-only-review',
        assignee: 'old-review-session',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'old-only-review',
          'gc.step_ref': 'mol-test.review-loop.iteration.1.old-only-review',
        },
      },
      {
        id: 'gc-current-review-i2',
        title: 'Current review',
        status: 'in_progress',
        kind: 'task',
        step_ref: 'mol-test.review-loop.iteration.2.current-review',
        logical_bead_id: 'current-review',
        assignee: 'current-review-session',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'current-review',
          'gc.step_ref': 'mol-test.review-loop.iteration.2.current-review',
        },
      },
    ],
    deps: [],
    logical_nodes: [],
    logical_edges: [],
    scope_groups: [],
  };
}
