import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_ID_RE } from '../src/lib/sessionId.js';

describe('SESSION_ID_RE', () => {
  test('accepts supervisor session handles used by peek and stream routes', () => {
    for (const id of ['gc-1', 'gc-session-b', 'td-7t24i6', 'th-abc-123', 'fddc-g3v', 'fddc-pe6']) {
      assert.equal(SESSION_ID_RE.test(id), true, id);
    }
  });

  test('rejects ids that should never reach the supervisor', () => {
    for (const id of [
      '',
      'gc-',
      // Mixed-case look-alikes: supervisor handles are lowercase by convention
      // (every fixture in this repo is lowercase), so the gate is case-sensitive
      // — no /i — to avoid widening the allow-list to upper/mixed-case variants.
      'GC-SESSION-B',
      'TD-7T24I6',
      'agent-diagnostics-y84',
      'gc/session',
      'gc.session',
      'gc_session',
      'gc-contains space',
      'gc-has$dollar',
      'gc-has`backtick`',
      'gc-has;semi',
      `gc-${'a'.repeat(33)}`,
    ]) {
      assert.equal(SESSION_ID_RE.test(id), false, id);
    }
  });
});
