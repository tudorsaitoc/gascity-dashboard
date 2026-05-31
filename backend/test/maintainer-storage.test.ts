import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MaintainerTriage } from 'gas-city-dashboard-shared';

import { readCache, writeCache } from '../src/views/modules/maintainer/storage.js';

// gascity-dashboard-xk8x: writeCache must serialise concurrent writers the
// same way the sibling slung-state.ts does. The background runRefresh worker
// and the route POST /api/maintainer/refresh are two real concurrent writers;
// without a mutex they can land on the same `${cachePath}.tmp-${pid}-${Date.now()}`
// within one millisecond, interleave fs.writeFile (torn tmp), and both rename.

function makeEnvelope(repo: string): MaintainerTriage {
  return {
    computed_at: null,
    repo,
    tiers: [],
    totals: { issues_open: 0, prs_open: 0 },
  };
}

describe('maintainer storage writeCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintainer-storage-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('concurrent writers serialise: never share a tmp path, never overlap writeFile', async () => {
    const cachePath = path.join(dir, 'maintainer-cache.json');

    const realWriteFile = fs.writeFile.bind(fs);
    const tmpPaths: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    // Wrap fs.writeFile to (a) record each tmp path written and (b) hold the
    // write open briefly so two unserialised writers would visibly overlap.
    // With the mutex, the second writer's writeFile cannot start until the
    // first writer's rename has completed, so maxInFlight stays 1.
    const writeFileSpy = (async (file: unknown, ...rest: unknown[]) => {
      tmpPaths.push(String(file));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        // @ts-expect-error spy forwards the original variadic signature
        return await realWriteFile(file, ...rest);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fs.writeFile;

    (fs as { writeFile: typeof fs.writeFile }).writeFile = writeFileSpy;
    try {
      await Promise.all([
        writeCache(cachePath, makeEnvelope('owner/a')),
        writeCache(cachePath, makeEnvelope('owner/b')),
      ]);
    } finally {
      (fs as { writeFile: typeof fs.writeFile }).writeFile = realWriteFile;
    }

    assert.equal(tmpPaths.length, 2, 'both writers should have written a tmp file');
    assert.notEqual(tmpPaths[0], tmpPaths[1], 'concurrent writers must not share a tmp path');
    assert.equal(maxInFlight, 1, 'writes must be serialised — only one writeFile in flight at a time');

    // No leftover tmp files: every tmp was renamed away, nothing torn behind.
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], `no tmp files should remain, found: ${leftovers.join(', ')}`);
  });

  test('final file is a clean, parseable envelope after concurrent writes', async () => {
    const cachePath = path.join(dir, 'maintainer-cache.json');

    await Promise.all([
      writeCache(cachePath, makeEnvelope('owner/a')),
      writeCache(cachePath, makeEnvelope('owner/b')),
    ]);

    const result = await readCache(cachePath);
    assert.equal(result.status, 'ready');
    if (result.status === 'ready') {
      assert.ok(
        result.envelope.repo === 'owner/a' || result.envelope.repo === 'owner/b',
        'final envelope must be exactly one of the two writers, not a torn mix',
      );
    }
  });
});
