import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcWorkflowBead } from 'gas-city-dashboard-shared';
import { resolveWorkflowExecutionPath } from '../src/workflows/execution-path.js';

describe('workflow execution path resolution', () => {
  test('prefers formula execution cwd on the root bead', () => {
    const root = workflowBead({
      metadata: {
        'gc.cwd': ' /runs/adopt-pr ',
        'gc.work_dir': '/runs/older',
        'gc.rig_root': '/rig/root',
      },
    });
    const child = workflowBead({
      id: 'child',
      metadata: { 'gc.cwd': '/runs/child' },
    });

    assert.equal(
      resolveWorkflowExecutionPath(root, [root, child], '/configured/rig'),
      '/runs/adopt-pr',
    );
  });

  test('falls back to child or session work-dir metadata before rig roots', () => {
    const root = workflowBead({
      metadata: { 'gc.rig_root': '/rig/root' },
    });
    const sessionBead = workflowBead({
      id: 'session-step',
      metadata: { work_dir: ' /runs/session-step ' },
    });

    assert.equal(
      resolveWorkflowExecutionPath(root, [root, sessionBead], '/configured/rig'),
      '/runs/session-step',
    );
  });

  test('uses supervisor rig-root metadata when cwd/work-dir metadata is missing', () => {
    const root = workflowBead({ metadata: { rig_root: ' /rig/from-root ' } });

    assert.equal(
      resolveWorkflowExecutionPath(root, [root], '/configured/rig'),
      '/rig/from-root',
    );
  });

  test('uses the configured rig root when supervisor data has no execution path', () => {
    assert.equal(
      resolveWorkflowExecutionPath(workflowBead({}), [], ' /configured/rig '),
      '/configured/rig',
    );
  });

  test('returns null instead of a blank path when no execution path is available', () => {
    assert.equal(resolveWorkflowExecutionPath(workflowBead({}), [], '  '), null);
    assert.equal(resolveWorkflowExecutionPath(undefined, [], undefined), null);
  });
});

function workflowBead(overrides: Partial<GcWorkflowBead>): GcWorkflowBead {
  return {
    id: 'root',
    title: 'Workflow',
    status: 'ready',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}
