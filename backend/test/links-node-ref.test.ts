import { parseRef, sanitiseUrl } from 'gas-city-dashboard-shared';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('parseRef', () => {
  test('parses pr/<n> and issue/<n>', () => {
    assert.deepEqual(parseRef('pr/123'), { ok: true, type: 'github_pr', value: '123' });
    assert.deepEqual(parseRef('issue/45'), { ok: true, type: 'github_issue', value: '45' });
  });

  test('parses a bead-id-shaped ref', () => {
    const r = parseRef('gascity-dashboard-j4x');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.type, 'bead');
  });

  test('rejects empty and metacharacter-laden refs', () => {
    assert.equal(parseRef('').ok, false);
    assert.equal(parseRef('  ').ok, false);
    assert.equal(parseRef('bad id !!').ok, false);
    assert.equal(parseRef('../etc/passwd').ok, false);
  });

  test('pr with non-numeric tail is rejected', () => {
    assert.equal(parseRef('pr/abc').ok, false);
  });
});

describe('sanitiseUrl (R4)', () => {
  test('passes http and https', () => {
    assert.equal(sanitiseUrl('https://x.test/a'), 'https://x.test/a');
    assert.equal(sanitiseUrl('http://x.test/a'), 'http://x.test/a');
  });

  test('rejects javascript:, data:, and non-strings', () => {
    assert.equal(sanitiseUrl('javascript:alert(1)'), null);
    assert.equal(sanitiseUrl('data:text/html,<script>'), null);
    assert.equal(sanitiseUrl(undefined), null);
    assert.equal(sanitiseUrl(42), null);
  });
});
