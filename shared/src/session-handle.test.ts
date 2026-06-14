// Run with: npx tsx --test shared/src/session-handle.test.ts
//
// The shared tier-aware extraction primitive behind the run-detail Session
// link, the Workers-active assignee parser, and the worker display-name
// cleaner. Fixtures use the real captured shapes (see session-handle.ts header).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchSessionHandle, supervisorSessionIdFrom } from './session-handle.js';

describe('supervisorSessionIdFrom', () => {
  test('keeps the 2-letter store prefix on a pool-qualified name', () => {
    assert.equal(
      supervisorSessionIdFrom('gc__implementation-worker-mc-wisp-08fqjv'),
      'mc-wisp-08fqjv',
    );
  });

  test('does not anchor on a 4-letter role word inside the template part', () => {
    assert.equal(
      supervisorSessionIdFrom('gc__design-test-risk-reviewer-mc-wisp-nw0w7v'),
      'mc-wisp-nw0w7v',
    );
  });

  test('accepts an all-letter base36 hash when the wisp-/mol- tier marker matched', () => {
    // `uuafv` is a structurally valid bd hash with no digit (bd forces no
    // digit, so ~1-in-5 hashes are all-letter — `gd-wisp-uuafv` is a real
    // dependency bead of this very workflow). The matched `wisp-` tier proves
    // the token is a real bead id, so the digit gate must not drop it.
    assert.equal(
      supervisorSessionIdFrom('gc__implementation-worker-mc-wisp-uuafv'),
      'mc-wisp-uuafv',
    );
    assert.equal(supervisorSessionIdFrom('mc-wisp-uuafv'), 'mc-wisp-uuafv');
    assert.equal(supervisorSessionIdFrom('gc__run-operator-mc-mol-abcde'), 'mc-mol-abcde');
  });

  test('passes a clean session id through unchanged, incl. all-letter no-tier hashes', () => {
    assert.equal(supervisorSessionIdFrom('gc-333573'), 'gc-333573');
    assert.equal(supervisorSessionIdFrom('mc-wisp-08fqjv'), 'mc-wisp-08fqjv');
    // No tier marker and an all-letter hash: the SESSION_ID_RE fallback still
    // trusts an already-clean id even though the no-tier suffix gate alone
    // would reject `abcde`.
    assert.equal(supervisorSessionIdFrom('gc-abcde'), 'gc-abcde');
    // A short hyphenated handle whose WHOLE form is a valid id shape is trusted
    // by that same fallback rather than split: `city-api-web` passes through
    // whole, NOT as a fabricated `api-web` — the embedded parser no longer
    // strips the `city-` prefix (audit M8 follow-up).
    assert.equal(supervisorSessionIdFrom('city-api-web'), 'city-api-web');
  });

  test('prefers the embedded id over a short-template-base pool name (masquerade)', () => {
    // After widening the id alphabet to any 2-4 letter prefix, a pool name whose
    // sanitized base is itself a bare 2-4 letter token would satisfy the
    // whole-string validator and 404. Extraction-first returns the real id.
    assert.equal(supervisorSessionIdFrom('ml-mc-wisp-abc12'), 'mc-wisp-abc12');
  });

  test('degrades to undefined for role words and bare names', () => {
    assert.equal(supervisorSessionIdFrom('polecat-crew-lead'), undefined);
    assert.equal(supervisorSessionIdFrom('polecat'), undefined);
    assert.equal(supervisorSessionIdFrom('mystery-handle'), undefined);
    assert.equal(supervisorSessionIdFrom(undefined), undefined);
    assert.equal(supervisorSessionIdFrom('   '), undefined);
  });

  test('does NOT extract a no-tier all-letter <=3-char id embedded behind a role prefix', () => {
    // Intentional, documented boundary (see session-handle.ts isBeadIdSuffix):
    // a no-tier suffix needs a digit at every length, so a real but all-letter
    // short bead id embedded behind a role prefix is NOT pulled out. At this
    // layer there is no way to tell `mc-xyz` (a real bd id) from `api-web` (a
    // role word), and fabricating a session from a role word is the more
    // dangerous error, so the parser refuses both. `claude-`/`worker-` are
    // 6-letter role prefixes, so the whole-string SESSION_ID_RE fallback cannot
    // rescue these either: the embedded handle yields no id at all.
    assert.equal(supervisorSessionIdFrom('claude-mc-xyz'), undefined);
    assert.equal(supervisorSessionIdFrom('worker-fddc-abc'), undefined);
  });

  test('still recovers the SAME short all-letter id when it appears bare (no role prefix)', () => {
    // The boundary above is specifically about the prefixed/embedded form. A
    // bare clean id of the very same shape is trusted by the SESSION_ID_RE
    // fallback, so bd-valid short all-letter ids are not globally rejected —
    // only un-disambiguatable embedded ones are.
    assert.equal(supervisorSessionIdFrom('mc-xyz'), 'mc-xyz');
    assert.equal(supervisorSessionIdFrom('fddc-abc'), 'fddc-abc');
  });
});

describe('matchSessionHandle — role recovery', () => {
  test('reports the role boundary for a prefixed handle', () => {
    const m = matchSessionHandle('gc__implementation-worker-mc-wisp-08fqjv');
    assert.equal(m?.sessionId, 'mc-wisp-08fqjv');
    assert.equal(m?.prefixed, true);
    assert.equal(
      'gc__implementation-worker-mc-wisp-08fqjv'.slice(0, m?.roleEnd),
      'gc__implementation-worker',
    );
  });

  test('marks a bare session id as not prefixed', () => {
    const m = matchSessionHandle('gc-335825');
    assert.equal(m?.sessionId, 'gc-335825');
    assert.equal(m?.prefixed, false);
    assert.equal(m?.roleEnd, 0);
  });

  test('rejects a no-tier role suffix without a digit', () => {
    assert.equal(matchSessionHandle('scix-worker'), undefined);
    assert.equal(matchSessionHandle('city-scix-worker'), undefined);
    // Three-letter all-letter suffixes get no free pass: a common hyphenated
    // role name must not be split into `role + session id` (audit M8 follow-up).
    assert.equal(matchSessionHandle('city-api-web'), undefined);
    assert.equal(matchSessionHandle('ops-qa-run'), undefined);
    // A no-tier embedded all-letter hash stays rejected — only a matched
    // `wisp-`/`mol-` tier or a digit proves a real bead id. This locks the
    // boundary the tiered all-letter positives above (`mc-wisp-uuafv`) rely on.
    assert.equal(matchSessionHandle('gc__implementation-worker-mc-uuafv'), undefined);
  });

  test('does NOT extract a no-tier all-letter <=3-char id from a prefixed handle', () => {
    // The deliberate divergence from bd's 3-char free pass, pinned through the
    // matcher itself: `claude-mc-xyz` and `worker-fddc-abc` carry real bead-id
    // shapes (`mc-xyz`, `fddc-abc`) but no tier and no digit, so the parser
    // refuses them rather than guessing. `worker-fddc-abc` is the exact case the
    // deleted ASSIGNEE_SESSION_ID_RX used to split into `fddc-abc`; the digit
    // gate is the intended trade for never splitting a role word such as
    // `city-api-web` into `city` + `api-web`.
    assert.equal(matchSessionHandle('claude-mc-xyz'), undefined);
    assert.equal(matchSessionHandle('worker-fddc-abc'), undefined);
    // Even the bare form is not "matched" here — it is recovered downstream by
    // the SESSION_ID_RE fallback in supervisorSessionIdFrom, never by the handle
    // matcher, so the no-tier gate stays the single owner of this decision.
    assert.equal(matchSessionHandle('mc-xyz'), undefined);
  });

  test('still extracts a no-tier suffix that carries a digit, at any length', () => {
    // The digit gate rejects all-letter words, not short ids: a 3-char suffix
    // that carries a digit is a real bead id and must still extract.
    const m = matchSessionHandle('gc__worker-gc-9ab');
    assert.equal(m?.sessionId, 'gc-9ab');
    assert.equal(m?.prefixed, true);
    assert.equal('gc__worker-gc-9ab'.slice(0, m?.roleEnd), 'gc__worker');
  });
});
