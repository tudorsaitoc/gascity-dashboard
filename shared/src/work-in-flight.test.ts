// Run with: npx tsx --test shared/src/work-in-flight.test.ts
//
// Work-in-flight assignee parsing: split a bead assignee into its worker role
// and the live session id it embeds. Fixtures use the real verified examples
// (see work-in-flight.ts header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssignee } from './work-in-flight.js';

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

test('parseAssignee keeps the mc- store prefix and wisp- tier of a pool-qualified name', () => {
  // audit finding M8: the old local regex latched onto the 4-letter `wisp`
  // token and dropped `mc-`, so Workers-active could not correlate the bead
  // with its live `mc-wisp-*` supervisor session.
  assert.deepEqual(parseAssignee('gc__implementation-worker-mc-wisp-08fqjv'), {
    role: 'gc__implementation-worker',
    sessionId: 'mc-wisp-08fqjv',
  });
  // All-letter tiered hash: the matched `wisp-` tier proves it is a real bead id.
  assert.deepEqual(parseAssignee('gc__run-operator-mc-wisp-uuafv'), {
    role: 'gc__run-operator',
    sessionId: 'mc-wisp-uuafv',
  });
});

test('parseAssignee backfills role with the session id when the assignee is only a handle', () => {
  assert.deepEqual(parseAssignee('gc-335825'), {
    role: 'gc-335825',
    sessionId: 'gc-335825',
  });
  // A bare tiered id is a session id too, not a role.
  assert.deepEqual(parseAssignee('mc-wisp-08fqjv'), {
    role: 'mc-wisp-08fqjv',
    sessionId: 'mc-wisp-08fqjv',
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

test('parseAssignee does NOT split a short hyphenated role into role + session', () => {
  // audit M8 follow-up: the embedded parser must not give an all-letter 3-char
  // suffix a free pass, or a common role name like `city-api-web` would be
  // mis-correlated as role `city` owning a fabricated session `api-web`. The
  // whole name stays the role and the worker row carries no false session.
  assert.deepEqual(parseAssignee('city-api-web'), { role: 'city-api-web' });
  assert.deepEqual(parseAssignee('ops-qa-run'), { role: 'ops-qa-run' });
});

test('parseAssignee does NOT correlate a no-tier all-letter <=3-char embedded id', () => {
  // Active-worker correlation deliberately degrades to role-only for a real but
  // all-letter short bead id embedded behind a role prefix (`claude-mc-xyz`,
  // `worker-fddc-abc`): the no-tier digit gate cannot tell it from a role word,
  // so the bead stays uncorrelated (a missing worker-row link) instead of
  // attaching to a fabricated session. `worker-fddc-abc` is the case the deleted
  // local regex used to split into `fddc-abc`; contrast `worker-fddc-12xy` above,
  // which carries a digit and still extracts `fddc-12xy`.
  assert.deepEqual(parseAssignee('claude-mc-xyz'), { role: 'claude-mc-xyz' });
  assert.deepEqual(parseAssignee('worker-fddc-abc'), { role: 'worker-fddc-abc' });
});

test('parseAssignee trims surrounding whitespace', () => {
  assert.deepEqual(parseAssignee('  polecat-gc-335825  '), {
    role: 'polecat',
    sessionId: 'gc-335825',
  });
});
