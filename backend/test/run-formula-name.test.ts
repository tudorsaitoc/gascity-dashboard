import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcFormulaDetail, GcRunBead } from 'gas-city-dashboard-shared';
import {
  resolveRunFormulaIdentity,
  resolveRunFormulaName,
} from '../src/runs/formula-name.js';

// gascity-dashboard-sadp: unit tests for the workflow-formula-name
// resolver. Both routes/workflows.ts and workflows/formula-run.ts call
// into this helper so the formula-detail fetch and the display-state
// derivation can never drift apart again.

function makeRoot(metadata: Record<string, string>, title = 'fixture-title'): GcRunBead {
  return {
    id: 'fixture-root',
    title,
    status: 'in_progress',
    kind: 'run',
    metadata,
  };
}

describe('resolveRunFormulaName', () => {
  test('returns null for undefined root', () => {
    assert.equal(resolveRunFormulaName(undefined), null);
  });

  test('tags the explicit gc.formula key as source: metadata', () => {
    const root = makeRoot(
      { 'gc.kind': 'workflow', 'gc.formula': 'mol-explicit' },
      'descriptive-title-that-should-be-ignored',
    );
    assert.deepEqual(resolveRunFormulaName(root), {
      name: 'mol-explicit',
      source: 'metadata',
    });
  });

  test('tags the gated title fallback as source: title_fallback for graph.v2 roots with gc.run_target', () => {
    // gascity-dashboard-e7hj: title-derived names are NOT canonical
    // metadata; the source discriminator lets the dashboard render them
    // in a warn tone instead of silently passing them through.
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '/fixture/run/target',
      },
      'mol-fixture-formula',
    );
    assert.deepEqual(resolveRunFormulaName(root), {
      name: 'mol-fixture-formula',
      source: 'title_fallback',
    });
  });

  test('tags the title fallback for graph.v2 roots gated by gc.routed_to (no gc.run_target) — rig-store routed roots (tqus)', () => {
    // gascity-dashboard-tqus: the supervisor marks routed rig-store workflow
    // roots with gc.routed_to (a work-dir path) instead of gc.run_target.
    // The runnable-root gate must accept it or every rig-store run collapses
    // to 'metadata missing'.
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.routed_to': '/home/ds/gascity-packs/gascity-packs-polecat',
      },
      'mol-focus-review',
    );
    assert.deepEqual(resolveRunFormulaName(root), {
      name: 'mol-focus-review',
      source: 'title_fallback',
    });
  });

  test('does NOT fall back to title for graph.v2 roots without gc.run_target or gc.routed_to', () => {
    // Without any routing signal the formula can't be fetched anyway;
    // surfacing the title as a "known" name would be a silent fallback that
    // masks the actual missing-config failure mode.
    const root = makeRoot(
      { 'gc.kind': 'workflow', 'gc.formula_contract': 'graph.v2' },
      'mol-fixture-formula',
    );
    assert.equal(resolveRunFormulaName(root), null);
  });

  test('does NOT fall back to title for non-graph.v2 roots', () => {
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'legacy.v1',
        'gc.run_target': '/fixture/run/target',
      },
      'mol-fixture-formula',
    );
    assert.equal(resolveRunFormulaName(root), null);
  });

  test('rejects whitespace-only titles even when the gate fires', () => {
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '/fixture/run/target',
      },
      '   ',
    );
    assert.equal(resolveRunFormulaName(root), null);
  });

  test('rejects whitespace-only gc.run_target via meta() nonEmpty normalization', () => {
    // meta() routes through nonEmpty() which treats whitespace as absent.
    // Lock that in here so a future refactor to a literal `in metadata`
    // check would have to update this contract intentionally.
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '   ',
      },
      'mol-fixture-formula',
    );
    assert.equal(resolveRunFormulaName(root), null);
  });

  test('does NOT fall back to title for CLOSED graph.v2 roots even with gc.run_target (xfb7)', () => {
    // gascity-dashboard-xfb7: operators sometimes retitle a CLOSED graph.v2
    // workflow root after a run completes (e.g. to 'investigation: foo bug').
    // Such a root still carries gc.run_target, which would otherwise pass
    // the title-fallback gate and surface the edited title as the formula
    // name. A closed run cannot be re-fetched against a formula registry to
    // refute the bad name, so the safer behavior is to defer — return null
    // and let the consumer render 'unavailable' rather than a false
    // attribution. Set gc.formula in metadata to recover.
    const root: GcRunBead = {
      id: 'fixture-root',
      title: 'investigation: foo bug',
      status: 'closed',
      kind: 'run',
      metadata: {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '/fixture/run/target',
      },
    };
    assert.equal(resolveRunFormulaName(root), null);
  });

  test('closed root still resolves explicit gc.formula (metadata wins over closed-status guard)', () => {
    // The closed-status guard only suppresses the title fallback; an
    // explicit gc.formula remains canonical regardless of run state.
    const root: GcRunBead = {
      id: 'fixture-root',
      title: 'investigation: foo bug',
      status: 'closed',
      kind: 'run',
      metadata: {
        'gc.kind': 'workflow',
        'gc.formula': 'mol-adopt-pr-v2',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '/fixture/run/target',
      },
    };
    assert.deepEqual(resolveRunFormulaName(root), {
      name: 'mol-adopt-pr-v2',
      source: 'metadata',
    });
  });

  test('does NOT read formula names from non-canonical aliases (boundary preserved)', () => {
    // Mirrors the deliberate boundary in workflow-enrich.test.ts: a
    // graph.v2 root with `formula: 'legacy-alias'` (NOT `gc.formula`) and
    // no run_target must NOT surface the alias OR the title as the
    // formula name.
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        formula: 'legacy-alias',
      },
      'mol-fixture-formula',
    );
    assert.equal(resolveRunFormulaName(root), null);
  });
});

describe('resolveRunFormulaIdentity', () => {
  test('route mode lets gc.formula_name beat graph.v2 title fallback', () => {
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.formula_name': 'mol-canonical-metadata',
        'gc.run_target': '/fixture/run/target',
      },
      'mol-title-fallback',
    );

    assert.deepEqual(resolveRunFormulaIdentity('route', { root }), {
      name: 'mol-canonical-metadata',
      source: 'metadata',
      target: '/fixture/run/target',
    });
  });

  test('state mode uses formula detail before title fallback when root metadata is missing', () => {
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '/fixture/run/target',
      },
      'mol-title-fallback',
    );
    const formulaDetail: GcFormulaDetail = { name: 'mol-from-detail' };

    assert.deepEqual(resolveRunFormulaIdentity('state', { root, formulaDetail }), {
      name: 'mol-from-detail',
      source: 'formula_detail',
      target: '/fixture/run/target',
    });
  });

  test('state + lane modes resolve title_fallback for a gc.routed_to-gated rig-store root (tqus)', () => {
    // The live ds-research regression: rig-store roots carry gc.routed_to
    // (a work-dir path) and a mol- title, but no gc.run_target. Both the
    // run-detail (state) and the snapshot lane must surface the title.
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.routed_to': '/home/ds/gascity-packs/gascity-packs-polecat',
      },
      'mol-focus-review',
    );

    assert.deepEqual(resolveRunFormulaIdentity('state', { root }), {
      name: 'mol-focus-review',
      source: 'title_fallback',
      target: '/home/ds/gascity-packs/gascity-packs-polecat',
    });
    assert.deepEqual(resolveRunFormulaIdentity('lane', { root, issues: [root] }), {
      name: 'mol-focus-review',
      source: 'title_fallback',
      target: '/home/ds/gascity-packs/gascity-packs-polecat',
    });
  });

  test('lane mode rejects non-mol graph.v2 titles that detail mode accepts as title fallback', () => {
    const root = makeRoot(
      {
        'gc.kind': 'workflow',
        'gc.formula_contract': 'graph.v2',
        'gc.run_target': '/fixture/run/target',
      },
      'descriptive operator title',
    );

    assert.deepEqual(resolveRunFormulaIdentity('detail', { root }), {
      name: 'descriptive operator title',
      source: 'title_fallback',
      target: '/fixture/run/target',
    });
    assert.deepEqual(resolveRunFormulaIdentity('lane', { root, issues: [root] }), {
      name: null,
      source: null,
      target: '/fixture/run/target',
    });
  });

  test('target precedence is gc.run_target, then gc.routed_to, then assignee', () => {
    const explicitTarget = makeRoot(
      {
        'gc.formula': 'mol-explicit',
        'gc.run_target': '/target/from-run-target',
        'gc.routed_to': '/target/from-routed-to',
      },
      'ignored',
    );
    const routedTo = makeRoot(
      {
        'gc.formula': 'mol-explicit',
        'gc.routed_to': '/target/from-routed-to',
      },
      'ignored',
    );
    const assignee = makeRoot({ 'gc.formula': 'mol-explicit' }, 'ignored');
    assignee.assignee = 'worker-alias';

    assert.equal(resolveRunFormulaIdentity('detail', { root: explicitTarget }).target, '/target/from-run-target');
    assert.equal(resolveRunFormulaIdentity('detail', { root: routedTo }).target, '/target/from-routed-to');
    assert.equal(resolveRunFormulaIdentity('detail', { root: assignee }).target, 'worker-alias');
  });
});
