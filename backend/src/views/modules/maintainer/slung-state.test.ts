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
} from './slung-state.js';

// Active sling state persistence (gascity-dashboard-9qs).
//
// JSON map keyed by `kind:number` (single-repo scope per CLAUDE.md).
// Atomic tmp+rename mirrors the sibling storage.ts. Tests
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

  // gascity-dashboard-oc4l: a slung-state.json written before
  // gascity-dashboard-55b (which introduced resolved_session_name
  // persistence) does NOT carry that field. The read path must accept
  // those legacy entries and normalize the absent field to `null` so the
  // wire contract (SlungState.resolved_session_name: string | null) holds
  // for downstream consumers (frontend SlungLink checks === null
  // explicitly). Without this tolerance the entire map is silently
  // discarded on the first read after an operator upgrade, losing all
  // in-flight slung items.
  test('preserves an entry that omits resolved_session_name and normalizes the field to null', async () => {
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
    assert.equal(Object.keys(state).length, 1);
    assert.deepEqual(state['pr:1'], {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: null,
      resolved_session_name: null,
    });
  });

  // gascity-dashboard-aqf8: a real upgrade-window file can mix legacy
  // entries (written before gascity-dashboard-55b added
  // resolved_session_name persistence) with modern entries written after
  // the upgrade. Normalization must coerce the legacy absent field to
  // null AND preserve the modern entry untouched in the same read pass.
  // Type boundary refactor (Partial<SlungState> intermediate) verifies
  // mixed maps still narrow correctly back to the strict wire shape.
  test('normalizes legacy and modern entries together in a mixed map', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        // legacy: pre-55b file omits resolved_session_name entirely
        'pr:1': {
          slung_at: '2026-05-24T12:00:00.000Z',
          target: 'chief-of-staff',
          bead_id: 'gastown-legacy',
        },
        // modern: post-55b file carries the resolved session id
        'issue:2': {
          slung_at: '2026-05-24T12:05:00.000Z',
          target: 'project-lead',
          bead_id: 'gastown-modern',
          resolved_session_name: 'project-lead-session',
        },
      }),
      'utf-8',
    );

    const state = await readSlungState(statePath);
    assert.equal(Object.keys(state).length, 2);
    assert.deepEqual(state['pr:1'], {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-legacy',
      resolved_session_name: null,
    });
    assert.deepEqual(state['issue:2'], {
      slung_at: '2026-05-24T12:05:00.000Z',
      target: 'project-lead',
      bead_id: 'gastown-modern',
      resolved_session_name: 'project-lead-session',
    });
  });

  // gascity-dashboard-jo07: a mixed legacy + modern + legacy file must
  // emit a SINGLE migration warning per read, not one per legacy entry.
  // The warning is operator-facing — repeated lines for the same upgrade
  // event would spam the log and obscure unrelated maintainer warnings.
  // Pair with the multi-legacy assertion to lock in count==2 migrated
  // entries surface as one consolidated log line.
  test('emits a single migration warning for a mixed map with multiple legacy entries', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        // two legacy entries (both missing resolved_session_name)
        'pr:1': {
          slung_at: '2026-05-24T12:00:00.000Z',
          target: 'chief-of-staff',
          bead_id: 'gastown-legacy-1',
        },
        'pr:2': {
          slung_at: '2026-05-24T12:01:00.000Z',
          target: 'chief-of-staff',
          bead_id: 'gastown-legacy-2',
        },
        // one modern entry — should not trigger a per-entry warning
        'issue:3': {
          slung_at: '2026-05-24T12:05:00.000Z',
          target: 'project-lead',
          bead_id: 'gastown-modern',
          resolved_session_name: 'project-lead-session',
        },
      }),
      'utf-8',
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => {
      warnings.push(line);
    };
    try {
      const state = await readSlungState(statePath);
      assert.equal(Object.keys(state).length, 3);
      assert.equal(state['pr:1']?.resolved_session_name, null);
      assert.equal(state['pr:2']?.resolved_session_name, null);
      assert.equal(state['issue:3']?.resolved_session_name, 'project-lead-session');
    } finally {
      console.warn = originalWarn;
    }

    const migrationWarnings = warnings.filter((w) => w.includes('normalized'));
    assert.equal(
      migrationWarnings.length,
      1,
      `expected exactly one consolidated migration warning, got ${migrationWarnings.length}: ${JSON.stringify(migrationWarnings)}`,
    );
    // Plural form ("entries") proves the count was aggregated, not per-entry.
    assert.match(migrationWarnings[0]!, /normalized 2 pre-55b entries/);
  });

  test('returns empty map when an entry has resolved_session_name of the wrong type', async () => {
    // Regression guard: legacy tolerance is for ABSENT only. A present
    // field that is neither null nor string is still a shape violation
    // and rejects the whole map (preserves the strict wire-shape check
    // for non-migration cases).
    await fs.writeFile(
      statePath,
      JSON.stringify({
        'pr:1': {
          slung_at: '2026-05-24T12:00:00.000Z',
          target: 'chief-of-staff',
          bead_id: null,
          resolved_session_name: 42,
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
