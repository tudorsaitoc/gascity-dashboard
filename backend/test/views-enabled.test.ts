import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';

import type { BackendModule } from '../src/views/types.js';
import { resolveEnabledFirstPartyIds } from '../src/views/enabled.js';

// PR-C / bead 9yj.5 — module-enable resolution against a synthetic registry.
//
// Uses fixtures (not ALL_MODULES) so the test does not break when the real
// registry grows. Each fixture covers one named decision rule from the
// resolver's JSDoc; the JSDoc is the spec, this file proves it.

function fakeModule(id: string, kind: 'core' | 'firstParty'): BackendModule<unknown> {
  return {
    id,
    kind,
    resources: {},
    needs: () => undefined,
    mount: () => Router(),
  } as BackendModule<unknown>;
}

const registry: ReadonlyArray<BackendModule<unknown>> = [
  fakeModule('health', 'core'),
  fakeModule('snapshot', 'core'),
  fakeModule('maintainer', 'firstParty'),
  fakeModule('something', 'firstParty'),
];

describe('resolveEnabledFirstPartyIds', () => {
  test('null env (unset) → no firstParty ids enabled — core-only default (PR-D)', () => {
    const enabled = resolveEnabledFirstPartyIds(registry, null);
    assert.equal(enabled.size, 0);
  });

  test('empty set env → no firstParty ids enabled', () => {
    const enabled = resolveEnabledFirstPartyIds(registry, new Set());
    assert.equal(enabled.size, 0);
  });

  test('CSV env → exactly those firstParty ids enabled', () => {
    const enabled = resolveEnabledFirstPartyIds(registry, new Set(['maintainer']));
    assert.deepEqual([...enabled], ['maintainer']);
  });

  test('CSV env naming a core id is silently ignored — core mounts unconditionally', () => {
    const enabled = resolveEnabledFirstPartyIds(
      registry,
      new Set(['health', 'maintainer']),
    );
    // 'health' is core, not present in the firstParty-only result set.
    assert.deepEqual([...enabled].sort(), ['maintainer']);
  });

  test('CSV env with unknown id warns and continues — the typo does not crash boot', () => {
    // PR-C Phase-4 fix (MED-1 from correctness review): assert the warn
    // actually FIRES, not just that the typo is dropped. Without this,
    // silent-removal of the logWarn call would pass tests.
    const warns: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (text.includes('typo-here')) warns.push(text);
      return origStderr(chunk);
    }) as typeof process.stderr.write;
    let enabled: ReadonlySet<string>;
    try {
      enabled = resolveEnabledFirstPartyIds(
        registry,
        new Set(['maintainer', 'typo-here']),
      );
    } finally {
      process.stderr.write = origStderr;
    }
    // Typo dropped; the rest of the set survives.
    assert.deepEqual([...enabled], ['maintainer']);
    // The unknown-id warn fired (premortem #4 anti-drift signal).
    assert.ok(warns.length >= 1, `expected unknown-id warn to fire, got ${warns.length}`);
  });

  test('returned set is a fresh copy, not the input', () => {
    const input = new Set(['maintainer']);
    const enabled = resolveEnabledFirstPartyIds(registry, input);
    assert.notEqual(enabled, input);
  });
});
