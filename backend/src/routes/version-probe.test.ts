import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseGcVersionJson, parseVersion } from './version-probe.js';

describe('parseVersion', () => {
  test('extracts the semver from `dolt version` output', () => {
    assert.equal(parseVersion('dolt version 2.0.7\n'), '2.0.7');
  });

  test('extracts the semver from `bd version` output', () => {
    assert.equal(parseVersion('bd version 1.0.4 (ce242a879: HEAD@ce242a879678)\n'), '1.0.4');
  });

  test('returns null when no version token is present', () => {
    assert.equal(parseVersion('command not found'), null);
  });
});

describe('parseGcVersionJson', () => {
  test('reads the version field verbatim, including a bare `dev` build', () => {
    assert.equal(
      parseGcVersionJson('{"commit":"ee446af6b","ok":true,"version":"dev"}'),
      'dev',
    );
  });

  test('reads a release semver from the version field', () => {
    assert.equal(parseGcVersionJson('{"version":"0.9.1"}'), '0.9.1');
  });

  test('returns null when the version field is absent or non-string', () => {
    assert.equal(parseGcVersionJson('{"commit":"abc"}'), null);
    assert.equal(parseGcVersionJson('{"version":123}'), null);
    assert.equal(parseGcVersionJson('{"version":""}'), null);
  });

  test('returns null on malformed JSON', () => {
    assert.equal(parseGcVersionJson('not json'), null);
  });
});
