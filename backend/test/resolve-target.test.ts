import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { GcSession } from 'gas-city-dashboard-shared';
import { resolveTargetToSession } from '../src/maintainer/resolve-target.js';

// gascity-dashboard-55b: role-to-session resolver tests. The function is
// pure (no IO) so all cases use synthesised GcSession fixtures.

function session(overrides: Partial<GcSession> & { id: string }): GcSession {
  return {
    template: 't',
    state: 'active',
    created_at: '2026-05-24T00:00:00Z',
    attached: false,
    ...overrides,
  } as GcSession;
}

describe('resolveTargetToSession', () => {
  test('returns null on empty sessions list', () => {
    assert.equal(resolveTargetToSession('chief-of-staff', []), null);
  });

  test('returns null on empty target', () => {
    const s = session({ id: 'gc-1', alias: 'chief-of-staff' });
    assert.equal(resolveTargetToSession('', [s]), null);
  });

  test('resolves by exact alias match', () => {
    const s = session({
      id: 'gc-1',
      alias: 'chief-of-staff',
      session_name: 'chief-of-staff-gc-1',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), 'chief-of-staff-gc-1');
  });

  test('resolves by pool match (chief-of-staff in oversight-rig)', () => {
    // Real fixture shape: alias=oversight-rig.chief-of-staff, pool=chief-of-staff.
    const s = session({
      id: 'gc-255180',
      alias: 'oversight-rig.chief-of-staff',
      session_name: 'oversight-rig__chief-of-staff',
      pool: 'chief-of-staff',
      agent_kind: 'pool',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), 'oversight-rig__chief-of-staff');
  });

  test('resolves by alias last-segment (split on .)', () => {
    const s = session({
      id: 'gc-1',
      alias: 'oversight-rig.chief-of-staff',
      session_name: 'oversight-rig__chief-of-staff',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), 'oversight-rig__chief-of-staff');
  });

  test('resolves by alias last-segment (split on /)', () => {
    const s = session({
      id: 'gc-1',
      alias: 'gascity-packs/control-dispatcher',
      session_name: 'gascity-packs--control-dispatcher',
    });
    assert.equal(
      resolveTargetToSession('control-dispatcher', [s]),
      'gascity-packs--control-dispatcher',
    );
  });

  test('resolves by session_name last-segment (split on __)', () => {
    const s = session({
      id: 'gc-1',
      session_name: 'oversight-rig__chief-of-staff',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), 'oversight-rig__chief-of-staff');
  });

  test('resolves by session_name last-segment (split on --)', () => {
    const s = session({
      id: 'gc-1',
      session_name: 'codescalebench--control-dispatcher',
    });
    assert.equal(
      resolveTargetToSession('control-dispatcher', [s]),
      'codescalebench--control-dispatcher',
    );
  });

  test('returns null when no session matches the role', () => {
    const s = session({
      id: 'gc-1',
      alias: 'other-role',
      pool: 'other-pool',
      session_name: 'other--name',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), null);
  });

  test('prefers active session when multiple match', () => {
    const asleep = session({
      id: 'gc-1',
      pool: 'chief-of-staff',
      session_name: 'asleep-cos',
      state: 'asleep',
    });
    const active = session({
      id: 'gc-2',
      pool: 'chief-of-staff',
      session_name: 'active-cos',
      state: 'active',
    });
    // Even if the asleep session is first in the list, the active one wins.
    assert.equal(
      resolveTargetToSession('chief-of-staff', [asleep, active]),
      'active-cos',
    );
  });

  test('falls back to non-active when no active session matches', () => {
    const asleep = session({
      id: 'gc-1',
      pool: 'chief-of-staff',
      session_name: 'asleep-cos',
      state: 'asleep',
    });
    const unrelatedActive = session({
      id: 'gc-2',
      pool: 'unrelated',
      session_name: 'something-else',
      state: 'active',
    });
    assert.equal(
      resolveTargetToSession('chief-of-staff', [asleep, unrelatedActive]),
      'asleep-cos',
    );
  });

  test('falls back to alias when session_name absent', () => {
    const s = session({
      id: 'gc-1',
      alias: 'chief-of-staff',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), 'chief-of-staff');
  });

  test('falls back to id when both session_name and alias absent', () => {
    const s = session({
      id: 'gc-1',
      pool: 'chief-of-staff',
    });
    assert.equal(resolveTargetToSession('chief-of-staff', [s]), 'gc-1');
  });

  test('alias exact match outranks last-segment heuristic on a different session', () => {
    // Both sessions "match" the target via different rules. Exact alias
    // match is strongest signal; should be picked over the bare pool match.
    const exact = session({
      id: 'gc-1',
      alias: 'chief-of-staff',
      session_name: 'exact-cos',
    });
    const pooled = session({
      id: 'gc-2',
      alias: 'oversight-rig.chief-of-staff',
      pool: 'chief-of-staff',
      session_name: 'pooled-cos',
    });
    // First active match wins; both are active so iteration order
    // settles it. exact appears first.
    assert.equal(
      resolveTargetToSession('chief-of-staff', [exact, pooled]),
      'exact-cos',
    );
  });

  test('handles real-world chief-of-staff fixture from live supervisor', () => {
    // Verbatim shape from /v0/city/ds-research/sessions:
    //   { id: 'gc-255180', alias: 'oversight-rig.chief-of-staff',
    //     session_name: 'oversight-rig__chief-of-staff',
    //     pool: 'chief-of-staff', agent_kind: 'pool' }
    const s = session({
      id: 'gc-255180',
      alias: 'oversight-rig.chief-of-staff',
      session_name: 'oversight-rig__chief-of-staff',
      pool: 'chief-of-staff',
      agent_kind: 'pool',
    });
    assert.equal(
      resolveTargetToSession('chief-of-staff', [s]),
      'oversight-rig__chief-of-staff',
    );
  });
});
