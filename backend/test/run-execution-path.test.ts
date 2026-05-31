import type { GcRunBead } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveRunExecutionPath } from '../src/runs/execution-path.js';

describe('run execution path resolution', () => {
  test('prefers formula execution cwd on the root bead', () => {
    const root = runBead({
      metadata: {
        'gc.cwd': ' /runs/adopt-pr ',
        'gc.work_dir': '/runs/older',
        'gc.rig_root': '/rig/root',
      },
    });
    const child = runBead({
      id: 'child',
      metadata: { 'gc.cwd': '/runs/child' },
    });

    assert.deepEqual(
      resolveRunExecutionPath(root, [root, child], '/configured/rig'),
      { kind: 'known', path: '/runs/adopt-pr' },
    );
  });

  test('falls back to child or session work-dir metadata before rig roots', () => {
    const root = runBead({
      metadata: { 'gc.rig_root': '/rig/root' },
    });
    const sessionBead = runBead({
      id: 'session-step',
      metadata: { work_dir: ' /runs/session-step ' },
    });

    assert.deepEqual(
      resolveRunExecutionPath(root, [root, sessionBead], '/configured/rig'),
      { kind: 'known', path: '/runs/session-step' },
    );
  });

  test('uses supervisor rig-root metadata when cwd/work-dir metadata is missing', () => {
    const root = runBead({ metadata: { rig_root: ' /rig/from-root ' } });

    assert.deepEqual(
      resolveRunExecutionPath(root, [root], '/configured/rig'),
      { kind: 'known', path: '/rig/from-root' },
    );
  });

  test('uses the configured rig root when supervisor data has no execution path', () => {
    assert.deepEqual(
      resolveRunExecutionPath(runBead({}), [], ' /configured/rig '),
      { kind: 'known', path: '/configured/rig' },
    );
  });

  test('returns an explicit unavailable state when no execution path is available', () => {
    assert.deepEqual(resolveRunExecutionPath(runBead({}), [], '  '), {
      kind: 'unavailable',
      reason: 'missing_cwd_and_rig_root',
    });
    assert.deepEqual(resolveRunExecutionPath(undefined, [], undefined), {
      kind: 'unavailable',
      reason: 'missing_cwd_and_rig_root',
    });
  });
});

function runBead(overrides: Partial<GcRunBead>): GcRunBead {
  return {
    id: 'root',
    title: 'Run',
    status: 'ready',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}
