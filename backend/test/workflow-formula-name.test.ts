import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcWorkflowBead } from 'gas-city-dashboard-shared';
import { resolveWorkflowFormulaName } from '../src/workflows/formula-name.js';

// gascity-dashboard-sadp: unit tests for the workflow-formula-name
// resolver. Both routes/workflows.ts and workflows/formula-run.ts call
// into this helper so the formula-detail fetch and the display-state
// derivation can never drift apart again.

function makeRoot(metadata: Record<string, string>, title = 'fixture-title'): GcWorkflowBead {
  return {
    id: 'fixture-root',
    title,
    status: 'in_progress',
    kind: 'workflow',
    metadata,
  };
}

describe('resolveWorkflowFormulaName', () => {
  test('returns null for undefined root', () => {
    assert.equal(resolveWorkflowFormulaName(undefined), null);
  });

  test('tags the explicit gc.formula key as source: metadata', () => {
    const root = makeRoot(
      { 'gc.kind': 'workflow', 'gc.formula': 'mol-explicit' },
      'descriptive-title-that-should-be-ignored',
    );
    assert.deepEqual(resolveWorkflowFormulaName(root), {
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
    assert.deepEqual(resolveWorkflowFormulaName(root), {
      name: 'mol-fixture-formula',
      source: 'title_fallback',
    });
  });

  test('does NOT fall back to title for graph.v2 roots without gc.run_target', () => {
    // Without a target the formula can't be fetched anyway; surfacing the
    // title as a "known" name would be a silent fallback that masks the
    // actual missing-config failure mode.
    const root = makeRoot(
      { 'gc.kind': 'workflow', 'gc.formula_contract': 'graph.v2' },
      'mol-fixture-formula',
    );
    assert.equal(resolveWorkflowFormulaName(root), null);
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
    assert.equal(resolveWorkflowFormulaName(root), null);
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
    assert.equal(resolveWorkflowFormulaName(root), null);
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
    assert.equal(resolveWorkflowFormulaName(root), null);
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
    assert.equal(resolveWorkflowFormulaName(root), null);
  });
});
