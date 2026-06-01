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

  // gascity-dashboard-a9yi: the "uses the configured rig root" case was
  // removed. app.ts no longer injects config.cityPath as the rig-root
  // fallback (it is the non-git city config dir, not a per-run worktree),
  // so a run with no execution-path metadata must resolve to
  // {unavailable, missing_cwd_and_rig_root} — the honest "Execution folder
  // is unknown" — rather than a known-but-useless path. The function still
  // honors an explicit rig_root in supervisor metadata (test above).

  test('resolves gc.routed_to as the work dir for rig-store routed roots (tqus)', () => {
    // gascity-dashboard-tqus: the supervisor marks routed rig-store workflow
    // roots with gc.routed_to (an absolute work-dir path) instead of
    // gc.cwd/gc.work_dir, so the diff resolver must accept it.
    const root = runBead({
      metadata: { 'gc.routed_to': ' /home/ds/gascity-packs/gascity-packs-polecat ' },
    });

    assert.deepEqual(resolveRunExecutionPath(root, [root], undefined), {
      kind: 'known',
      path: '/home/ds/gascity-packs/gascity-packs-polecat',
    });
  });

  test('a child work_dir outranks the root gc.routed_to (real worktree beats canonical routing dir)', () => {
    // gascity-dashboard-tqus: rig-store roots often carry a canonical
    // gc.routed_to that may not be the instantiated worktree, while the
    // child session records the real gc.work_dir. The real worktree must win.
    const root = runBead({
      metadata: { 'gc.routed_to': '/home/ds/gascity-packs/gascity-packs-polecat' },
    });
    const child = runBead({
      id: 'session-step',
      metadata: { 'gc.work_dir': '/home/ds/gascity-packs-worktrees/polecat-2' },
    });

    assert.deepEqual(resolveRunExecutionPath(root, [root, child], undefined), {
      kind: 'known',
      path: '/home/ds/gascity-packs-worktrees/polecat-2',
    });
  });

  test('prefers an explicit gc.cwd over gc.routed_to', () => {
    const root = runBead({
      metadata: { 'gc.cwd': '/runs/explicit', 'gc.routed_to': '/home/ds/packs/x' },
    });

    assert.deepEqual(resolveRunExecutionPath(root, [root], undefined), {
      kind: 'known',
      path: '/runs/explicit',
    });
  });

  test('ignores a non-path gc.routed_to (agent alias) so it cannot shadow a rig root', () => {
    // gc.routed_to is sometimes an agent alias rather than a path; only an
    // absolute path is a usable git cwd. A non-path value must fall through.
    const root = runBead({
      metadata: { 'gc.routed_to': 'polecat', 'gc.rig_root': '/rig/from-root' },
    });

    assert.deepEqual(resolveRunExecutionPath(root, [root], undefined), {
      kind: 'known',
      path: '/rig/from-root',
    });
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
