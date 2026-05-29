import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichWorkflowRun,
  UnsupportedWorkflowError,
} from '../src/workflows/enrich.js';
import type {
  GcWorkflowSnapshot,
  WorkflowDisplayNode,
  WorkflowExecutionInstance,
  WorkflowRunDetail,
} from 'gas-city-dashboard-shared';
import {
  activeAdoptPrGraphV2Snapshot,
  capturedDashboardGraphV2SmokeSnapshot,
  completedBugHuntGraphV2Snapshot,
} from './fixtures/workflow-snapshots.js';

describe('workflow presentation enrichment fixtures', () => {
  test('captured supervisor smoke snapshot collapses hidden scope-check controls into display edges and badges', () => {
    const detail = enrichWorkflowRun(capturedDashboardGraphV2SmokeSnapshot, {});

    assert.equal(detail.workflowId, 'gvt-nayu');
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
    const detail = enrichWorkflowRun(activeAdoptPrGraphV2Snapshot, {
      rigRoot: '/unused/rig-root',
    });

    assert.equal(detail.workflowId, 'gc-adopt-pr-active');
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
    assert.equal(root.constructKind, 'workflow-root');
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

    assert.equal(
      detail.edges.some((edge) => edge.from === 'pre-approval-ci' && edge.to === 'gc-adopt-finalize'),
      false,
      'hidden workflow-finalize bead should not produce a visible edge',
    );
  });

  test('completed bug-hunt graph preserves failed retry transcript history and fanout semantics', () => {
    const detail = enrichWorkflowRun(completedBugHuntGraphV2Snapshot, {
      rigRoot: '/Users/csells/Code/gascity/bug-rig',
    });

    assert.equal(detail.workflowId, 'gc-bug-hunt-complete');
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
    assert.equal(JSON.stringify(detail).toLowerCase().includes('ralph'), false);
  });

  test('keeps supervisor formula order for nodes while preferring logical edges', () => {
    const detail = enrichWorkflowRun(formulaOrderGraphSnapshot({
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
    const detail = enrichWorkflowRun(formulaOrderGraphSnapshot({
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
    const detail = enrichWorkflowRun(waitingGraphSnapshot(), {});

    assert.equal(findNode(detail, 'ready-step').status, 'ready');
    assert.equal(findNode(detail, 'blocked-step').status, 'blocked');
    assert.equal(findNode(detail, 'done-step').status, 'completed');
    assert.deepEqual(detail.progress.statusCounts, {
      ready: 2,
      blocked: 1,
      completed: 1,
    });
  });

  test('marks loop body nodes missing from the latest iteration as historical-only', () => {
    const detail = enrichWorkflowRun(historicalOnlyLoopSnapshot(), {});

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
  });

  test('rejects graph.v2 contract aliases outside current supervisor metadata', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    const root = snapshot.beads?.find((bead) => bead.id === 'gc-root');
    assert.ok(root);
    root.metadata = {
      'gc.kind': 'workflow',
      contract: 'graph.v2',
      formula_contract: 'graph.v2',
      'gc.contract': 'graph.v2',
      'gc.formula': 'mol-test',
    };

    assert.throws(
      () => enrichWorkflowRun(snapshot, {}),
      UnsupportedWorkflowError,
    );
  });

  test('rejects snapshots whose root bead id does not match a supervisor bead', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    snapshot.root_bead_id = 'missing-root';

    assert.throws(
      () => enrichWorkflowRun(snapshot, {}),
      UnsupportedWorkflowError,
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
      () => enrichWorkflowRun(missingRef, {}),
      UnsupportedWorkflowError,
    );
    assert.throws(
      () => enrichWorkflowRun(invalidKind, {}),
      UnsupportedWorkflowError,
    );
  });

  test('rejects malformed required snapshot metadata', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    snapshot.snapshot_version = '8' as unknown as number;

    assert.throws(
      () => enrichWorkflowRun(snapshot, {}),
      UnsupportedWorkflowError,
    );
  });

  test('rejects missing required supervisor identity and store fields', () => {
    const missingWorkflowId = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    missingWorkflowId.workflow_id = '   ';
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
      () => enrichWorkflowRun(missingWorkflowId, {}),
      UnsupportedWorkflowError,
    );
    assert.throws(
      () => enrichWorkflowRun(missingRootStore, {}),
      UnsupportedWorkflowError,
    );
    assert.throws(
      () => enrichWorkflowRun(missingResolvedStore, {}),
      UnsupportedWorkflowError,
    );
    assert.throws(
      () => enrichWorkflowRun(malformedPartial, {}),
      UnsupportedWorkflowError,
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
      'gc.kind': 'workflow',
      'gc.formula_contract': 'graph.v2',
      formula: 'legacy-alias',
    };

    const detail = enrichWorkflowRun(snapshot, {});

    assert.deepEqual(detail.formula, {
      kind: 'unavailable',
      reason: 'missing_formula_metadata',
    });
  });

  // gascity-dashboard-sadp: the resolveWorkflowFormulaName helper has
  // its own unit-test surface in workflow-formula-name.test.ts; the
  // tests below verify it composes correctly into enrichWorkflowRun.

  test('reads formula name from title for graph.v2 roots when gc.formula is absent but gc.run_target is set', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    const root = snapshot.beads?.find((bead) => bead.id === 'gc-root');
    assert.ok(root);
    // Use a fixture-style title (not a live-data string) so the test
    // intent reads as "the title flows through, whatever it is" rather
    // than "we expect a specific live workflow's name".
    root.title = 'fixture-formula';
    root.metadata = {
      'gc.kind': 'workflow',
      'gc.formula_contract': 'graph.v2',
      'gc.run_target': '/fixture/run/target',
    };

    const detail = enrichWorkflowRun(snapshot, {});

    assert.deepEqual(detail.formula, {
      kind: 'known',
      name: 'fixture-formula',
      source: 'title_fallback',
    });
  });

  test('does NOT fall back to title when gc.run_target is absent (formula cannot be fetched anyway)', () => {
    const snapshot = formulaOrderGraphSnapshot({
      deps: [],
      logical_edges: [],
    });
    const root = snapshot.beads?.find((bead) => bead.id === 'gc-root');
    assert.ok(root);
    root.title = 'fixture-formula';
    root.metadata = {
      'gc.kind': 'workflow',
      'gc.formula_contract': 'graph.v2',
    };

    const detail = enrichWorkflowRun(snapshot, {});

    assert.deepEqual(detail.formula, {
      kind: 'unavailable',
      reason: 'missing_formula_metadata',
    });
  });
});

function findNode(detail: WorkflowRunDetail, id: string): WorkflowDisplayNode {
  const node = detail.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `expected workflow node ${id}`);
  return node;
}

function formulaName(detail: WorkflowRunDetail): string {
  assert.equal(detail.formula.kind, 'known');
  return detail.formula.name;
}

function executionPath(detail: WorkflowRunDetail): string {
  assert.equal(detail.executionPath.kind, 'known');
  return detail.executionPath.path;
}

function assertStackedIteration(
  node: WorkflowDisplayNode,
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

function streamable(instance: WorkflowExecutionInstance | undefined): boolean {
  return instance?.session.kind === 'attached' && instance.session.streamable;
}

function sessionId(instance: WorkflowExecutionInstance | undefined): string {
  assert.equal(instance?.session.kind, 'attached');
  return instance.session.link.sessionId;
}

function assertNoSession(instance: WorkflowExecutionInstance | undefined): void {
  assert.equal(instance?.session.kind, 'none');
}

function formulaOrderGraphSnapshot(edges: {
  deps: GcWorkflowSnapshot['deps'];
  logical_edges: GcWorkflowSnapshot['logical_edges'];
}): GcWorkflowSnapshot {
  return {
    workflow_id: 'gc-root',
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
        title: 'Formula-order workflow',
        status: 'in_progress',
        kind: 'workflow',
        metadata: {
          'gc.kind': 'workflow',
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

function waitingGraphSnapshot(): GcWorkflowSnapshot {
  return {
    workflow_id: 'gc-waiting',
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
        title: 'Waiting workflow',
        status: 'in_progress',
        kind: 'workflow',
        metadata: {
          'gc.kind': 'workflow',
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

function historicalOnlyLoopSnapshot(): GcWorkflowSnapshot {
  return {
    workflow_id: 'gc-root',
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
        title: 'Historical loop workflow',
        status: 'in_progress',
        kind: 'workflow',
        metadata: {
          'gc.kind': 'workflow',
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
