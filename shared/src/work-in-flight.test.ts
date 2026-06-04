// Run with: npx tsx --test shared/src/work-in-flight.test.ts
//
// "Work in flight" derivation: parse the live session id out of a bead's
// assignee, join the in-progress beads to their sessions, and order by recency.
// Fixtures use the real verified examples (see work-in-flight.ts header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWorkInFlight,
  parseAssignee,
  type WorkInFlightBead,
  type WorkInFlightSession,
} from './work-in-flight.js';

// Fixtures are typed against the structural minimums the derivation reads
// (WorkInFlightBead/Session), not a full supervisor wire shape — the
// generated client types are the wire authority and aren't mirrored here.
function bead(partial: Partial<WorkInFlightBead> & { id: string }): WorkInFlightBead {
  return {
    title: `title for ${partial.id}`,
    status: 'in_progress',
    created_at: '2026-06-03T00:00:00Z',
    ...partial,
  };
}

function session(partial: Partial<WorkInFlightSession> & { id: string }): WorkInFlightSession {
  return {
    state: 'active',
    ...partial,
  };
}

test('parseAssignee splits the real verified examples into role + session id', () => {
  assert.deepEqual(parseAssignee('polecat-gc-335825'), {
    role: 'polecat',
    sessionId: 'gc-335825',
  });
  assert.deepEqual(parseAssignee('scix-worker-gc-335812'), {
    role: 'scix-worker',
    sessionId: 'gc-335812',
  });
  assert.deepEqual(parseAssignee('enterprisebench-worker-gc-335808'), {
    role: 'enterprisebench-worker',
    sessionId: 'gc-335808',
  });
});

test('parseAssignee extracts td-/th-/4-letter-prefixed handles too', () => {
  assert.deepEqual(parseAssignee('polecat-td-9abc'), {
    role: 'polecat',
    sessionId: 'td-9abc',
  });
  assert.deepEqual(parseAssignee('worker-fddc-12xy'), {
    role: 'worker',
    sessionId: 'fddc-12xy',
  });
});

test('parseAssignee backfills role with the session id when the assignee is only a handle', () => {
  assert.deepEqual(parseAssignee('gc-335825'), {
    role: 'gc-335825',
    sessionId: 'gc-335825',
  });
});

test('parseAssignee falls back to the whole string when no session handle is present', () => {
  assert.deepEqual(parseAssignee('mayor'), { role: 'mayor' });
  assert.deepEqual(parseAssignee('/home/ds/gas-city/city-infra-polecat'), {
    role: '/home/ds/gas-city/city-infra-polecat',
  });
});

test('parseAssignee does NOT misparse a plain role as a bare session id', () => {
  // `scix-worker` is a worker ROLE, not a session id: its body has no digit, so
  // the bare-handle branch must reject it and leave sessionId undefined. (A live
  // session id always carries a numeric handle, e.g. `gc-335812`.)
  assert.deepEqual(parseAssignee('scix-worker'), { role: 'scix-worker' });
});

test('parseAssignee trims surrounding whitespace', () => {
  assert.deepEqual(parseAssignee('  polecat-gc-335825  '), {
    role: 'polecat',
    sessionId: 'gc-335825',
  });
});

test('deriveWorkInFlight joins in-progress beads to their live session, newest first', () => {
  const polecat = session({ id: 'gc-335825', rig: '/home/ds/gascity', last_active: '2026-06-03T10:00:00Z' });
  const scixWorker = session({ id: 'gc-335812', rig: 'scix_experiments', last_active: '2026-06-03T11:00:00Z' });
  const beads = [
    bead({ id: 'gc-5rarj', assignee: 'polecat-gc-335825' }),
    bead({ id: 'scix_experiments-4if7h', assignee: 'scix-worker-gc-335812' }),
  ];
  const rows = deriveWorkInFlight(beads, [polecat, scixWorker]);
  assert.deepEqual(
    rows.map((r) => r.bead.id),
    ['scix_experiments-4if7h', 'gc-5rarj'], // 11:00 before 10:00
  );
  const scixRow = rows.find((r) => r.bead.id === 'scix_experiments-4if7h');
  assert.equal(scixRow?.role, 'scix-worker');
  assert.equal(scixRow?.session?.id, 'gc-335812');
  assert.equal(scixRow?.assignee, 'scix-worker-gc-335812');
});

test('deriveWorkInFlight includes only in-progress beads', () => {
  const beads = [
    bead({ id: 'a-1', status: 'open', assignee: 'polecat-gc-335825' }),
    bead({ id: 'a-2', status: 'closed', assignee: 'polecat-gc-335825' }),
    bead({ id: 'a-3', status: 'in_progress', assignee: 'polecat-gc-335825' }),
  ];
  const rows = deriveWorkInFlight(beads, []);
  assert.deepEqual(rows.map((r) => r.bead.id), ['a-3']);
});

test('deriveWorkInFlight retains a row when the embedded session id does not resolve', () => {
  const beads = [bead({ id: 'EnterpriseBench-mda', assignee: 'enterprisebench-worker-gc-335808' })];
  const rows = deriveWorkInFlight(beads, []); // gc-335808 absent
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.session, undefined);
  assert.equal(rows[0]?.role, 'enterprisebench-worker');
  assert.equal(rows[0]?.assignee, 'enterprisebench-worker-gc-335808');
});

test('deriveWorkInFlight retains an in-progress bead with no assignee', () => {
  const rows = deriveWorkInFlight([bead({ id: 'orphan-1' })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.assignee, undefined);
  assert.equal(rows[0]?.role, undefined);
  assert.equal(rows[0]?.session, undefined);
});

test('deriveWorkInFlight falls back to bead timestamps when no session activity', () => {
  const polecat = session({ id: 'gc-100', last_active: '2026-06-03T10:00:00Z' });
  const noSession = bead({
    id: 'no-sess',
    assignee: 'worker-gc-999999',
    updated_at: '2026-06-03T12:00:00Z', // newer than the joined session's activity
  });
  const rows = deriveWorkInFlight(
    [bead({ id: 'gc-5rarj', assignee: 'polecat-gc-100' }), noSession],
    [polecat],
  );
  assert.equal(rows[0]?.bead.id, 'no-sess'); // 12:00 update beats 10:00 activity
});

test('deriveWorkInFlight returns empty when nothing is in progress', () => {
  assert.deepEqual(deriveWorkInFlight([bead({ id: 'a-1', status: 'open' })], []), []);
});
