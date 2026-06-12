import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRunExecutionPath } from './execution-path.js';
import type { RunSnapshotBead } from '../run-snapshot.js';

// M15: the run-detail "Local changes" diff panel diffed whatever gc.work_dir
// pointed at. For run ga-wisp-x0tank that was the SHARED checkout
// /data/projects/gascity — live on another workflow's branch with 67 dirty
// files — while the run's actual execution worktree was already recorded on
// the root bead as work_dir (/data/projects/gascity/.gc/worktrees/ga-hvg0gb).
// The supervisor resolves work_dir BEFORE gc.work_dir
// (gascity internal/dispatch/ralph.go resolveInheritedMetadata(store, bead,
// contract.LegacyWorkDirKey, "gc.work_dir")), so the dashboard must match
// that precedence or the panel presents another workflow's working tree as
// this run's changes.

function bead(
  id: string,
  metadata: Record<string, string>,
  overrides: Partial<RunSnapshotBead> = {},
): RunSnapshotBead {
  return {
    id,
    title: 'mol-adopt-pr-v2',
    status: 'pending',
    kind: 'workflow',
    metadata,
    ...overrides,
  };
}

describe('resolveRunExecutionPath — per-run work_dir beats inherited gc.work_dir (M15)', () => {
  test('root carrying both keys resolves the recorded run worktree, not the shared checkout', () => {
    // Shaped like the ga-wisp-x0tank root bead: gc.work_dir is the shared rig
    // checkout inherited from dispatch, work_dir is the gc-managed worktree
    // where the run actually executed.
    const root = bead('ga-wisp-x0tank', {
      'gc.formula_contract': 'graph.v2',
      'gc.input_convoy_id': 'ga-hvg0gb',
      'gc.kind': 'workflow',
      'gc.root_store_ref': 'rig:gascity',
      'gc.routed_to': 'gascity/gc.run-operator',
      'gc.work_dir': '/data/projects/gascity',
      work_dir: '/data/projects/gascity/.gc/worktrees/ga-hvg0gb',
    });

    assert.deepEqual(resolveRunExecutionPath(root, [root]), {
      kind: 'known',
      path: '/data/projects/gascity/.gc/worktrees/ga-hvg0gb',
    });
  });

  test('root work_dir beats step beads carrying the shared-checkout gc.work_dir', () => {
    const root = bead('ga-wisp-x0tank', {
      'gc.work_dir': '/data/projects/gascity',
      work_dir: '/data/projects/gascity/.gc/worktrees/ga-hvg0gb',
    });
    const steps = [
      bead('ga-wisp-s9lygz', { 'gc.work_dir': '/data/projects/gascity' }, { kind: 'task' }),
      bead('ga-wisp-9rsood', { 'gc.work_dir': '/data/projects/gascity' }, { kind: 'task' }),
    ];

    assert.deepEqual(resolveRunExecutionPath(root, [root, ...steps]), {
      kind: 'known',
      path: '/data/projects/gascity/.gc/worktrees/ga-hvg0gb',
    });
  });

  test('gc.cwd still outranks work_dir when present', () => {
    const root = bead('ga-wisp-x0tank', {
      'gc.cwd': '/data/projects/gascity/.gc/worktrees/explicit-cwd',
      'gc.work_dir': '/data/projects/gascity',
      work_dir: '/data/projects/gascity/.gc/worktrees/ga-hvg0gb',
    });

    assert.deepEqual(resolveRunExecutionPath(root, [root]), {
      kind: 'known',
      path: '/data/projects/gascity/.gc/worktrees/explicit-cwd',
    });
  });

  test('gc.work_dir alone still resolves (no regression when only the prefixed key exists)', () => {
    const root = bead('ga-wisp-x0tank', { 'gc.work_dir': '/data/projects/gascity' });

    assert.deepEqual(resolveRunExecutionPath(root, [root]), {
      kind: 'known',
      path: '/data/projects/gascity',
    });
  });

  test('falls back to rig roots, then the rigRoot argument, then unavailable', () => {
    const root = bead('ga-wisp-x0tank', { 'gc.rig_root': '/data/projects/gascity' });
    assert.deepEqual(resolveRunExecutionPath(root, [root]), {
      kind: 'known',
      path: '/data/projects/gascity',
    });

    const bare = bead('ga-wisp-x0tank', {});
    assert.deepEqual(resolveRunExecutionPath(bare, [bare], '/data/projects/gascity'), {
      kind: 'known',
      path: '/data/projects/gascity',
    });
    assert.deepEqual(resolveRunExecutionPath(bare, [bare]), {
      kind: 'unavailable',
      reason: 'missing_cwd_and_rig_root',
    });
  });
});
