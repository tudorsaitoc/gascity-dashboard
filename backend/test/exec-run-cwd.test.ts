import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isValidRunCwd } from '../src/exec.js';

// gascity-dashboard-k2b8: isValidRunCwd guards the cwd that the run-detail
// diff path feeds to `git -C <cwd>`. The cwd originates from supervisor run
// metadata (gc.cwd / gc.work_dir / gc.rig_root), so a buggy or compromised
// supervisor value could otherwise point the dashboard's last shell-read at
// any git repo on the host. The allowlist (RUN_CWD_ALLOWED_ROOTS) is the
// defense-in-depth prefix gate; when empty the validator preserves the prior
// shape-only behavior so existing deployments do not regress.

describe('isValidRunCwd — shape (allowlist empty)', () => {
  const noRoots: readonly string[] = [];

  test('accepts a safe absolute path', () => {
    assert.equal(isValidRunCwd('/home/ds/gascity/polecat-1', noRoots), true);
  });

  test('rejects a relative path', () => {
    assert.equal(isValidRunCwd('home/ds/run', noRoots), false);
  });

  test('rejects a path with a .. traversal segment', () => {
    assert.equal(isValidRunCwd('/home/ds/../etc', noRoots), false);
  });

  test('rejects a path containing a NUL byte', () => {
    assert.equal(isValidRunCwd('/home/ds/run\0/x', noRoots), false);
  });

  test('rejects the empty string', () => {
    assert.equal(isValidRunCwd('', noRoots), false);
  });

  test('defaults to shape-only when allowedRoots is omitted', () => {
    assert.equal(isValidRunCwd('/anywhere/on/host'), true);
  });
});

describe('isValidRunCwd — prefix allowlist (configured)', () => {
  const roots = ['/home/ds/gascity', '/home/ds/gascity-dashboard'];

  test('accepts a cwd that is exactly an allowed root', () => {
    assert.equal(isValidRunCwd('/home/ds/gascity', roots), true);
  });

  test('accepts a cwd nested under an allowed root', () => {
    assert.equal(isValidRunCwd('/home/ds/gascity/polecat-1', roots), true);
  });

  test('normalizes a trailing-slash root so nested cwds still match', () => {
    // A PATH-style entry supplied with a trailing slash must behave identically.
    assert.equal(isValidRunCwd('/home/ds/gascity/subdir', ['/home/ds/gascity/']), true);
    assert.equal(isValidRunCwd('/home/ds/gascity', ['/home/ds/gascity/']), true);
    assert.equal(isValidRunCwd('/home/ds/gascity-evil', ['/home/ds/gascity/']), false);
  });

  test('accepts a cwd under the second allowed root', () => {
    assert.equal(isValidRunCwd('/home/ds/gascity-dashboard/backend', roots), true);
  });

  test('rejects a cwd outside every allowed root', () => {
    assert.equal(isValidRunCwd('/etc', roots), false);
    assert.equal(isValidRunCwd('/home/ds/other-project', roots), false);
  });

  test('rejects a sibling that only shares a string prefix (segment-boundary, not startsWith)', () => {
    // /home/ds/gascity-evil must NOT be admitted by the /home/ds/gascity root.
    assert.equal(isValidRunCwd('/home/ds/gascity-evil', roots), false);
  });

  test('still applies the shape check even when the prefix would match', () => {
    // A .. segment is rejected before the prefix is ever considered.
    assert.equal(isValidRunCwd('/home/ds/gascity/../../etc', roots), false);
  });
});
