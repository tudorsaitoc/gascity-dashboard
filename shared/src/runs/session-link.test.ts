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

  test('keeps a tiered bead id whose hash is all letters', () => {
    // bd hashes are base36 with no digit forced, so ~1-in-5 are all-letter
    // (`gd-wisp-uuafv` is a real dependency bead of this workflow). The matched
    // `wisp-` tier proves the trailing token is a real bead id, so the digit
    // gate must not drop it and leave the Session link unresolved.
    const bead = {
      assignee: 'gc__implementation-worker-mc-wisp-uuafv',
      metadata: { 'gc.session_name': 'gc__implementation-worker-mc-wisp-uuafv' },
    } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'mc-wisp-uuafv');
  });

  test('degrades when the trailing tokens are role words, not a bead id', () => {
    // `crew-lead` is shaped like `<prefix>-<suffix>` but `lead` is an
    // English word, not a bead-id hash — bd requires a digit in 4-8 char
    // hash suffixes. The old regex extracted `crew-lead` as a session id.
    const bead = { assignee: 'polecat-crew-lead' } as never;
    assert.equal(runSessionLinkFor(bead, 'done'), undefined);
  });

  test('does not fabricate a stripped session id from a short hyphenated role', () => {
    // audit M8 follow-up: a recorded handle like `city-api-web` must NOT be
    // stripped to a fabricated `api-web` by the shared parser. Its whole form is
    // a valid id shape, so the clean-id fallback links it through unchanged —
    // the link carries the recorded `city-api-web`, never the shorter `api-web`.
    const bead = { assignee: 'city-api-web' } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'city-api-web');
    assert.notEqual(link?.sessionId, 'api-web');
  });

  test('drops the Session link for an assignee-only no-tier all-letter <=3-char id', () => {
    // audit M8 follow-up, assignee/session-name-only path: a completed run whose
    // only session signal is an assignee like `claude-mc-xyz` (no session_id
    // metadata, absent from the live index) carries a real bead-id shape but no
    // tier and no digit. The no-tier gate refuses to fabricate `mc-xyz`, and the
    // 6-letter `claude-` prefix means the whole string also fails SESSION_ID_RE,
    // so the link degrades to a clean "session not available" state rather than
    // feeding an unvalidated handle to the route.
    const bead = { assignee: 'claude-mc-xyz' } as never;
    assert.equal(runSessionLinkFor(bead, 'done'), undefined);
  });

  test('still links an assignee-only handle whose embedded id carries a digit', () => {
    // The contrast that proves the drop above is the digit gate, not a blanket
    // refusal of short ids: the same `claude-` role with a digit-bearing id
    // (`mc-9ab`) extracts and links cleanly.
    const bead = { assignee: 'claude-mc-9ab' } as never;
    const link = runSessionLinkFor(bead, 'done');
    assert.equal(link?.sessionId, 'mc-9ab');
  });
});
