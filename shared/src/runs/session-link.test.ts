import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runSessionLinkFor } from './session-link.js';

// Regression coverage for the rig-store / polecat run "invalid session id"
// bug. A polecat run records its session as the pool-qualified NAME
// (`polecat-gc-333573`), whose real supervisor session id is the gc-suffix
// (`gc-333573`). When the session has completed it is absent from the live
// session index, so it can't be resolved by name — the link must normalize
// the recorded value to the supervisor id itself, or the Session tab feeds a
// name where an id is expected and the route rejects it as "invalid session id".
describe('runSessionLinkFor — session id normalization', () => {
  test('normalizes a pool-qualified session name in metadata to the supervisor id', () => {
    const bead = {
      assignee: 'polecat-gc-333573',
      metadata: { session_id: 'polecat-gc-333573' },
    } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'gc-333573');
  });

  test('leaves a clean gc-prefixed session id unchanged', () => {
    const bead = { metadata: { session_id: 'gc-333573' } } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'gc-333573');
  });

  test('derives the id from a pool-qualified assignee when no metadata id is present', () => {
    const bead = { assignee: 'polecat-gc-333573' } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'gc-333573');
  });

  test('degrades to no link when an unresolvable value carries no supervisor id', () => {
    // A completed run whose recorded handle carries no extractable supervisor
    // id and is absent from the live session index must NOT leak that handle
    // into link.sessionId — the session route would reject it as "invalid
    // session id". The link degrades so the Session tab shows a clean
    // "session not available" empty state instead.
    const bead = { metadata: { session_id: 'mystery-handle' } } as never;
    assert.equal(runSessionLinkFor(bead, 'done'), undefined);
  });

  test('degrades a runtime-derived bare assignee that cannot yield a supervisor id', () => {
    // The runtime-derived path: a completed pool/rig-store run records only an
    // assignee (no session_id metadata), and that assignee is a bare worker
    // name with no embedded supervisor id. With no live index match there is
    // no usable id, so the link degrades rather than feeding "polecat" to the
    // route as an "invalid session id".
    const bead = { assignee: 'polecat' } as never;
    assert.equal(runSessionLinkFor(bead, 'done'), undefined);
  });

  test('returns undefined for pending/ready nodes (no session yet)', () => {
    const bead = { assignee: 'polecat-gc-333573' } as never;
    assert.equal(runSessionLinkFor(bead, 'pending'), undefined);
    assert.equal(runSessionLinkFor(bead, 'ready'), undefined);
  });
});

// Regression coverage for the mangled-session-id bug (audit finding M8). The
// supervisor builds pool worker session names as
// `{sanitized template base}-{session bead id}` (gascity
// cmd/gc/pool_session_name.go PoolSessionName), so a wisp step records
// `gc__implementation-worker-mc-wisp-08fqjv` for the real supervisor session
// id `mc-wisp-08fqjv`. The old suffix regex could not represent the 2-letter
// `mc-` store prefix: it latched onto the first 4-letter word followed by a
// hyphen, deriving `wisp-08fqjv` (drops `mc-`) and — because `test` is a
// 4-letter word — `test-risk-reviewer-mc-wisp-nw0w7v`, which 404s on the
// supervisor. Beads are shaped like the captured ga-wisp-x0tank payload.
describe('runSessionLinkFor — supervisor session id extraction from gc__<role>-<bead-id> names', () => {
  test('extracts the full session bead id, keeping the mc- store prefix', () => {
    const bead = {
      assignee: 'gc__implementation-worker-mc-wisp-08fqjv',
      metadata: {
        'gc.session_name': 'gc__implementation-worker-mc-wisp-08fqjv',
        'gc.run_target': 'gascity/gc.implementation-worker',
      },
    } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'mc-wisp-08fqjv');
    assert.equal(link?.sessionName, 'gc__implementation-worker-mc-wisp-08fqjv');
  });

  test('does not anchor on a 4-letter word inside a hyphenated role name', () => {
    // `test` in `design-test-risk-reviewer` matched the old [a-z]{4} prefix
    // alternation, producing the dangling id
    // `test-risk-reviewer-mc-wisp-nw0w7v`.
    const bead = {
      assignee: 'gc__design-test-risk-reviewer-mc-wisp-nw0w7v',
      metadata: {
        'gc.session_name': 'gc__design-test-risk-reviewer-mc-wisp-nw0w7v',
        'gc.run_target': 'gascity/gc.design-test-risk-reviewer',
      },
    } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'mc-wisp-nw0w7v');
  });

  test('extracts from an assignee-only bead with no session metadata', () => {
    // ga-wisp-2aadix in the captured payload: assignee only, no
    // gc.session_name.
    const bead = { assignee: 'gc__run-operator-mc-wisp-r5uqi9' } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'mc-wisp-r5uqi9');
  });

  test('passes a bare 2-letter-prefixed session bead id through unchanged', () => {
    const bead = { metadata: { session_id: 'mc-wisp-08fqjv' } } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'mc-wisp-08fqjv');
  });

  test('degrades when the trailing tokens are role words, not a bead id', () => {
    // `crew-lead` is shaped like `<prefix>-<suffix>` but `lead` is an
    // English word, not a bead-id hash — bd requires a digit in 4-8 char
    // hash suffixes. The old regex extracted `crew-lead` as a session id.
    const bead = { assignee: 'polecat-crew-lead' } as never;
    assert.equal(runSessionLinkFor(bead, 'done'), undefined);
  });
});
