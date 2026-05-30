import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { migrateLegacyMaintainerPaths } from './migrate-legacy-paths.js';

// Migration helper coverage (PR-B2, audit-C8 Option A). Verifies the
// matrix the descriptor relies on:
//   - happy path: legacy file present, new absent → move
//   - no-op (new present): both present → leave both as-is
//   - no-op (old absent): nothing to migrate
//   - per-file independence: one file migrates while the other is already
//     at the new path
//   - same-dir guard: old === new is a silent no-op

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'maintainer-migrate-'));
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

describe('migrateLegacyMaintainerPaths', () => {
  let oldDir: string;
  let newDir: string;

  beforeEach(async () => {
    oldDir = await makeTempDir();
    // Make a parent and use a not-yet-existing subdir for newDir so the
    // helper proves it creates the destination directory.
    const parent = await makeTempDir();
    newDir = path.join(parent, 'cities', 'racoon-city');
  });

  afterEach(async () => {
    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.rm(path.dirname(path.dirname(newDir)), { recursive: true, force: true });
  });

  test('moves legacy cache + slung-state files to the new location', async () => {
    await fs.writeFile(path.join(oldDir, 'maintainer-cache.json'), '{"old":"cache"}');
    await fs.writeFile(path.join(oldDir, 'slung-state.json'), '{"old":"slung"}');

    await migrateLegacyMaintainerPaths(oldDir, newDir);

    assert.equal(await readMaybe(path.join(newDir, 'maintainer-cache.json')), '{"old":"cache"}');
    assert.equal(await readMaybe(path.join(newDir, 'slung-state.json')), '{"old":"slung"}');
    assert.equal(await readMaybe(path.join(oldDir, 'maintainer-cache.json')), null);
    assert.equal(await readMaybe(path.join(oldDir, 'slung-state.json')), null);
  });

  test('no-ops when new files already exist (does not overwrite operator data)', async () => {
    await fs.writeFile(path.join(oldDir, 'maintainer-cache.json'), '{"old":"cache"}');
    await fs.writeFile(path.join(oldDir, 'slung-state.json'), '{"old":"slung"}');
    await fs.mkdir(newDir, { recursive: true });
    await fs.writeFile(path.join(newDir, 'maintainer-cache.json'), '{"new":"cache"}');
    await fs.writeFile(path.join(newDir, 'slung-state.json'), '{"new":"slung"}');

    await migrateLegacyMaintainerPaths(oldDir, newDir);

    // New content is preserved; legacy files stay in place untouched.
    assert.equal(await readMaybe(path.join(newDir, 'maintainer-cache.json')), '{"new":"cache"}');
    assert.equal(await readMaybe(path.join(newDir, 'slung-state.json')), '{"new":"slung"}');
    assert.equal(await readMaybe(path.join(oldDir, 'maintainer-cache.json')), '{"old":"cache"}');
    assert.equal(await readMaybe(path.join(oldDir, 'slung-state.json')), '{"old":"slung"}');
  });

  test('no-ops silently when no legacy files exist (fresh install)', async () => {
    await migrateLegacyMaintainerPaths(oldDir, newDir);
    // newDir was never created because nothing needed to be moved.
    const newCache = await readMaybe(path.join(newDir, 'maintainer-cache.json'));
    assert.equal(newCache, null);
  });

  test('migrates one file while leaving an already-migrated sibling in place', async () => {
    await fs.writeFile(path.join(oldDir, 'maintainer-cache.json'), '{"old":"cache"}');
    await fs.mkdir(newDir, { recursive: true });
    await fs.writeFile(path.join(newDir, 'slung-state.json'), '{"new":"slung"}');

    await migrateLegacyMaintainerPaths(oldDir, newDir);

    assert.equal(await readMaybe(path.join(newDir, 'maintainer-cache.json')), '{"old":"cache"}');
    assert.equal(await readMaybe(path.join(newDir, 'slung-state.json')), '{"new":"slung"}');
    assert.equal(await readMaybe(path.join(oldDir, 'maintainer-cache.json')), null);
  });

  test('same dir is a no-op (operator already on the new path layout)', async () => {
    await fs.writeFile(path.join(oldDir, 'maintainer-cache.json'), '{"in-place":true}');
    await migrateLegacyMaintainerPaths(oldDir, oldDir);
    // File stays where it was — no rename onto itself, no exception.
    assert.equal(await readMaybe(path.join(oldDir, 'maintainer-cache.json')), '{"in-place":true}');
  });

  test('symlink at legacy path is skipped, not relocated (Phase-4 security)', async () => {
    // Plant a symlink at the legacy location pointing somewhere benign.
    // The helper must lstat + skip rather than `rename` the symlink (which
    // would move the LINK, leaving the target in place but the link reborn
    // under cities/<city>/ — a silent home-tree mutation).
    const linkTarget = path.join(oldDir, 'innocent.json');
    await fs.writeFile(linkTarget, '{"benign":true}');
    await fs.symlink(linkTarget, path.join(oldDir, 'maintainer-cache.json'));

    await migrateLegacyMaintainerPaths(oldDir, newDir);

    // The symlink stays at the legacy location, no new file at the target.
    const oldLinkStat = await fs.lstat(path.join(oldDir, 'maintainer-cache.json'));
    assert.ok(oldLinkStat.isSymbolicLink(), 'legacy symlink should still exist');
    assert.equal(await readMaybe(path.join(newDir, 'maintainer-cache.json')), null);
  });
});
