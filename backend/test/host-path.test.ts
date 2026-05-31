import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isValidHostPath } from '../src/lib/hostPath.js';

// Shared host-path gate used by both exec.ts (--city flag) and dolt.ts
// (.dolt/noms stat). SHOULD-FIX #6 — one rule for both sites.
describe('isValidHostPath', () => {
  test('accepts a clean absolute path', () => {
    assert.equal(isValidHostPath('/srv/cities/racoon-city'), true);
    assert.equal(isValidHostPath('/home/op/.gascity'), true);
  });

  test('rejects an empty or relative path', () => {
    assert.equal(isValidHostPath(''), false);
    assert.equal(isValidHostPath('relative/path'), false);
    assert.equal(isValidHostPath('./x'), false);
  });

  test('rejects a .. traversal segment even when absolute', () => {
    assert.equal(isValidHostPath('/srv/../etc'), false);
    assert.equal(isValidHostPath('/srv/cities/../../etc/passwd'), false);
    assert.equal(isValidHostPath('/..'), false);
  });

  test('does not false-positive on a literal ".." inside a segment name', () => {
    // `..foo` and `foo..bar` are ordinary names, not traversal segments.
    assert.equal(isValidHostPath('/srv/..foo'), true);
    assert.equal(isValidHostPath('/srv/foo..bar/baz'), true);
  });

  test('rejects a NUL byte', () => {
    assert.equal(isValidHostPath('/srv/a\0b'), false);
  });
});
