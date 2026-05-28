import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  slungKey,
  readSlungState,
  writeSlungEntry,
  purgeSlungKeys,
  type SlungStateMap,
} from '../src/maintainer/slung-state.js';

// Active sling state persistence (gascity-dashboard-9qs).
//
// JSON map keyed by `kind:number` (single-repo scope per CLAUDE.md).
// Atomic tmp+rename mirrors backend/src/maintainer/storage.ts. Tests
// use a unique tmpdir per case so concurrent test runs don't collide
// and assert isolation is intact.

let tmpDir: string;
let statePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slung-state-test-'));
  statePath = path.join(tmpDir, 'slung-state.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('slungKey', () => {
  test('combines kind and number deterministically', () => {
    assert.equal(slungKey('pr', 42), 'pr:42');
    assert.equal(slungKey('issue', 7), 'issue:7');
  });

  test('a PR and issue with the same number produce distinct keys', () => {
    assert.notEqual(slungKey('pr', 42), slungKey('issue', 42));
  });
});

describe('readSlungState', () => {
  test('returns empty map when file does not exist (ENOENT)', async () => {
    const state = await readSlungState(statePath);
    assert.deepEqual(state, {});
  });

  test('returns parsed map when file exists', async () => {
    const seed: SlungStateMap = {
      'pr:1': {
        slung_at: '2026-05-24T12:00:00.000Z',
        target: 'chief-of-staff',
        bead_id: 'gastown-abc',
        resolved_session_name: null,
      },
    };
    await fs.writeFile(statePath, JSON.stringify(seed), 'utf-8');
    const state = await readSlungState(statePath);
    assert.deepEqual(state, seed);
  });

  test('returns empty map and warns on malformed JSON (corrupt file)', async () => {
    await fs.writeFile(statePath, '{not valid json', 'utf-8');
    const state = await readSlungState(statePath);
    assert.deepEqual(state, {});
  });

  test('returns empty map when top-level is not an object', async () => {
    await fs.writeFile(statePath, '[1,2,3]', 'utf-8');
    const state = await readSlungState(statePath);
    assert.deepEqual(state, {});
  });

  test('returns empty map when an entry omits resolved_session_name', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        'pr:1': {
          slung_at: '2026-05-24T12:00:00.000Z',
          target: 'chief-of-staff',
          bead_id: null,
        },
      }),
      'utf-8',
    );

    const state = await readSlungState(statePath);
    assert.deepEqual(state, {});
  });
});

describe('writeSlungEntry', () => {
  test('creates the file when it does not exist and persists the entry', async () => {
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-abc',
      resolved_session_name: null,
    });
    const state = await readSlungState(statePath);
    assert.deepEqual(state, {
      'pr:1': {
        slung_at: '2026-05-24T12:00:00.000Z',
        target: 'chief-of-staff',
        bead_id: 'gastown-abc',
        resolved_session_name: null,
      },
    });
  });

  test('merges new entry into existing map without clobbering siblings', async () => {
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-abc',
      resolved_session_name: null,
    });
    await writeSlungEntry(statePath, slungKey('issue', 5), {
      slung_at: '2026-05-24T12:01:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-def',
      resolved_session_name: null,
    });
    const state = await readSlungState(statePath);
    assert.equal(Object.keys(state).length, 2);
    assert.ok(state['pr:1']);
    assert.ok(state['issue:5']);
  });

  test('overwrites entry for the same key (re-sling)', async () => {
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-abc',
      resolved_session_name: null,
    });
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T13:00:00.000Z',
      target: 'project-lead',
      bead_id: 'gastown-xyz',
      resolved_session_name: 'project-lead-session',
    });
    const state = await readSlungState(statePath);
    assert.equal(state['pr:1']?.target, 'project-lead');
    assert.equal(state['pr:1']?.bead_id, 'gastown-xyz');
    assert.equal(Object.keys(state).length, 1);
  });

  test('concurrent writes to different keys both land (mutex serialises read-modify-write)', async () => {
    await Promise.all([
      writeSlungEntry(statePath, slungKey('pr', 1), {
        slung_at: '2026-05-24T12:00:00.000Z',
        target: 'chief-of-staff',
        bead_id: 'gastown-a',
        resolved_session_name: null,
      }),
      writeSlungEntry(statePath, slungKey('pr', 2), {
        slung_at: '2026-05-24T12:00:00.000Z',
        target: 'chief-of-staff',
        bead_id: 'gastown-b',
        resolved_session_name: null,
      }),
      writeSlungEntry(statePath, slungKey('issue', 3), {
        slung_at: '2026-05-24T12:00:00.000Z',
        target: 'chief-of-staff',
        bead_id: 'gastown-c',
        resolved_session_name: null,
      }),
    ]);
    const state = await readSlungState(statePath);
    assert.equal(Object.keys(state).length, 3);
    assert.ok(state['pr:1']);
    assert.ok(state['pr:2']);
    assert.ok(state['issue:3']);
  });

  test('bead_id can be null when gc sling stdout did not yield a parseable id', async () => {
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: null,
      resolved_session_name: null,
    });
    const state = await readSlungState(statePath);
    assert.equal(state['pr:1']?.bead_id, null);
  });

  test('logs write-chain failures and allows the next write to continue', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...optionalParams: unknown[]) => {
      warnings.push([message, ...optionalParams].map(String).join(' '));
    };
    const badParent = path.join(tmpDir, 'not-a-directory');
    await fs.writeFile(badParent, 'blocks mkdir', 'utf-8');
    try {
      await assert.rejects(
        writeSlungEntry(path.join(badParent, 'slung-state.json'), slungKey('pr', 99), {
          slung_at: '2026-05-24T12:00:00.000Z',
          target: 'chief-of-staff',
          bead_id: 'gastown-bad',
          resolved_session_name: null,
        }),
      );
      await writeSlungEntry(statePath, slungKey('pr', 100), {
        slung_at: '2026-05-24T12:01:00.000Z',
        target: 'chief-of-staff',
        bead_id: 'gastown-good',
        resolved_session_name: null,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.match(warnings.join('\n'), /slung-state write failed/);
    const state = await readSlungState(statePath);
    assert.equal(state['pr:100']?.bead_id, 'gastown-good');
  });
});

describe('purgeSlungKeys', () => {
  test('removes the named keys and leaves siblings intact', async () => {
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'a',
      resolved_session_name: null,
    });
    await writeSlungEntry(statePath, slungKey('pr', 2), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'b',
      resolved_session_name: null,
    });
    await writeSlungEntry(statePath, slungKey('issue', 3), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'c',
      resolved_session_name: null,
    });
    await purgeSlungKeys(statePath, ['pr:2']);
    const state = await readSlungState(statePath);
    assert.equal(Object.keys(state).length, 2);
    assert.ok(state['pr:1']);
    assert.ok(state['issue:3']);
    assert.equal(state['pr:2'], undefined);
  });

  test('is a no-op when file does not exist', async () => {
    await purgeSlungKeys(statePath, ['pr:1']);
    const state = await readSlungState(statePath);
    assert.deepEqual(state, {});
  });

  test('is a no-op when none of the keys match', async () => {
    await writeSlungEntry(statePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'a',
      resolved_session_name: null,
    });
    await purgeSlungKeys(statePath, ['pr:999', 'issue:999']);
    const state = await readSlungState(statePath);
    assert.equal(Object.keys(state).length, 1);
    assert.ok(state['pr:1']);
  });
});
