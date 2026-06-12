import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRunFormulaIdentity, resolveRunFormulaName } from './formula-name.js';
import type { RunSnapshotBead } from '../run-snapshot.js';

// Audit finding M3 (run ga-wisp-x0tank): the supervisor retired
// `gc.run_target` as a root wire field (upstream gascity ga-eld2x / #2763)
// in favor of `gc.routed_to`, but the title-fallback gate still required
// the retired key. Every current graph.v2 root (27 of 32 surveyed live
// workflow roots carry only `gc.routed_to`) resolved to name=null, so the
// run-detail page rendered Formula='metadata missing', the generic 5-stage
// ladder, and never fetched /formulas/{name}.

/**
 * Shape mirrors the real ga-wisp-x0tank root bead: a live graph.v2
 * mol-adopt-pr-v2 run whose root carries `gc.routed_to` and NO
 * `gc.formula` / `gc.run_target`.
 */
function routedToRoot(overrides: Partial<RunSnapshotBead> = {}): RunSnapshotBead {
  return {
    id: 'ga-wisp-x0tank',
    title: 'mol-adopt-pr-v2',
    status: 'pending',
    kind: 'workflow',
    metadata: {
      'gc.formula_contract': 'graph.v2',
      'gc.graphv2_root_key': 'graphv2-root:ga-hvg0gb:mol-adopt-pr-v2:15569633545c81d0:default',
      'gc.input_convoy_id': 'ga-hvg0gb',
      'gc.kind': 'workflow',
      'gc.root_store_ref': 'rig:gascity',
      'gc.routed_to': 'gascity/gc.run-operator',
      'gc.session_name': 'gc__design-test-risk-reviewer-mc-wisp-nw0w7v',
      'gc.work_dir': '/data/projects/gascity',
    },
    ...overrides,
  };
}

function withMetadata(extra: Record<string, string>, drop: string[] = []): RunSnapshotBead {
  const root = routedToRoot();
  const metadata = { ...root.metadata, ...extra };
  for (const key of drop) delete metadata[key];
  return { ...root, metadata };
}

describe('resolveRunFormulaIdentity title fallback on gc.routed_to roots (M3)', () => {
  test('route mode resolves the title fallback when the root carries only gc.routed_to', () => {
    const resolved = resolveRunFormulaIdentity('route', { root: routedToRoot() });
    assert.deepEqual(resolved, {
      name: 'mol-adopt-pr-v2',
      source: 'title_fallback',
      target: 'gascity/gc.run-operator',
    });
  });

  test('state and detail modes resolve the same routed_to root', () => {
    for (const mode of ['state', 'detail'] as const) {
      const resolved = resolveRunFormulaIdentity(mode, { root: routedToRoot() });
      assert.equal(resolved.name, 'mol-adopt-pr-v2', `mode=${mode}`);
      assert.equal(resolved.source, 'title_fallback', `mode=${mode}`);
    }
  });

  test('lane mode keeps the mol- prefix guard for routed_to roots', () => {
    const molRoot = routedToRoot();
    assert.equal(
      resolveRunFormulaIdentity('lane', { root: molRoot, issues: [molRoot] }).name,
      'mol-adopt-pr-v2',
    );
    const retitled = routedToRoot({ title: 'Adopt PR #3212' });
    assert.equal(
      resolveRunFormulaIdentity('lane', { root: retitled, issues: [retitled] }).name,
      null,
    );
  });

  test('legacy gc.run_target roots keep resolving (backwards compatibility)', () => {
    const legacy = withMetadata({ 'gc.run_target': 'test-city/codex' }, ['gc.routed_to']);
    const resolved = resolveRunFormulaIdentity('route', { root: legacy });
    assert.deepEqual(resolved, {
      name: 'mol-adopt-pr-v2',
      source: 'title_fallback',
      target: 'test-city/codex',
    });
  });

  test('explicit gc.formula metadata still wins over the title fallback', () => {
    const explicit = withMetadata({ 'gc.formula': 'mol-other' });
    const resolved = resolveRunFormulaIdentity('route', { root: explicit });
    assert.equal(resolved.name, 'mol-other');
    assert.equal(resolved.source, 'metadata');
  });

  test('terminal routed_to roots are still excluded from the title fallback (xfb7)', () => {
    for (const status of ['closed', 'completed', 'failed']) {
      const resolved = resolveRunFormulaIdentity('route', { root: routedToRoot({ status }) });
      assert.equal(resolved.name, null, `status=${status}`);
      assert.equal(resolved.source, null, `status=${status}`);
    }
  });

  test('roots with neither gc.run_target nor gc.routed_to still resolve to null', () => {
    const untargeted = withMetadata({}, ['gc.routed_to']);
    const resolved = resolveRunFormulaIdentity('route', { root: untargeted });
    assert.equal(resolved.name, null);
  });

  test('non-graph.v2 roots with gc.routed_to never title-fallback', () => {
    const nonGraph = withMetadata({ 'gc.formula_contract': 'legacy' });
    assert.equal(resolveRunFormulaIdentity('route', { root: nonGraph }).name, null);
  });
});

describe('resolveRunFormulaName on gc.routed_to roots (M3)', () => {
  test('resolves the title fallback for a live routed_to root', () => {
    assert.deepEqual(resolveRunFormulaName(routedToRoot()), {
      name: 'mol-adopt-pr-v2',
      source: 'title_fallback',
    });
  });

  test('keeps resolving legacy gc.run_target roots', () => {
    const legacy = withMetadata({ 'gc.run_target': 'test-city/codex' }, ['gc.routed_to']);
    assert.deepEqual(resolveRunFormulaName(legacy), {
      name: 'mol-adopt-pr-v2',
      source: 'title_fallback',
    });
  });

  test('returns null for terminal routed_to roots', () => {
    assert.equal(resolveRunFormulaName(routedToRoot({ status: 'completed' })), null);
  });
});
