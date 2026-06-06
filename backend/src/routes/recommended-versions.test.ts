import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LocalToolVersion } from 'gas-city-dashboard-shared';
import {
  compareVersions,
  driftAgainstFloor,
  parseVersionTuple,
  recommendedToolVersion,
} from './recommended-versions.js';

const available = (version: string): LocalToolVersion => ({
  status: 'available',
  version,
  source: 'test probe',
});

const unavailable: LocalToolVersion = { status: 'unavailable', reason: 'probe failed' };

describe('parseVersionTuple', () => {
  test('parses an X.Y.Z version', () => {
    assert.deepEqual(parseVersionTuple('2.1.2'), [2, 1, 2]);
  });

  test('trims surrounding whitespace', () => {
    assert.deepEqual(parseVersionTuple('  1.0.4 \n'), [1, 0, 4]);
  });

  test('returns null for a non-X.Y.Z string', () => {
    assert.equal(parseVersionTuple('dev'), null);
    assert.equal(parseVersionTuple('1.0'), null);
    assert.equal(parseVersionTuple('1.0.4-rc1'), null);
    assert.equal(parseVersionTuple('1.2.3.4'), null);
  });
});

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    assert.equal(compareVersions('2.1.2', '2.1.1'), 1);
    assert.equal(compareVersions('2.0.9', '2.1.0'), -1);
    assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
    assert.equal(compareVersions('2.1.2', '2.1.2'), 0);
  });

  test('returns null when either side is not comparable', () => {
    assert.equal(compareVersions('dev', '2.1.2'), null);
    assert.equal(compareVersions('2.1.2', 'dev'), null);
  });
});

describe('driftAgainstFloor', () => {
  test('satisfied when installed is at or above the floor', () => {
    assert.equal(driftAgainstFloor(available('2.1.2'), '2.1.2'), 'satisfied');
    assert.equal(driftAgainstFloor(available('2.2.0'), '2.1.2'), 'satisfied');
  });

  test('below_floor when installed is under the floor', () => {
    assert.equal(driftAgainstFloor(available('2.0.7'), '2.1.2'), 'below_floor');
  });

  test('unknown when the floor is unpublished', () => {
    assert.equal(driftAgainstFloor(available('dev'), null), 'unknown');
    assert.equal(driftAgainstFloor(available('2.1.2'), null), 'unknown');
  });

  test('unknown when the probe failed', () => {
    assert.equal(driftAgainstFloor(unavailable, '2.1.2'), 'unknown');
  });

  test('unknown when installed is not a comparable semver', () => {
    assert.equal(driftAgainstFloor(available('dev'), '2.1.2'), 'unknown');
  });
});

describe('recommendedToolVersion', () => {
  test('assembles installed, floor, and computed drift', () => {
    assert.deepEqual(recommendedToolVersion(available('2.0.7'), '2.1.2'), {
      installed: available('2.0.7'),
      recommendedFloor: '2.1.2',
      drift: 'below_floor',
    });
  });

  test('carries a null floor through as unknown drift', () => {
    assert.deepEqual(recommendedToolVersion(available('dev'), null), {
      installed: available('dev'),
      recommendedFloor: null,
      drift: 'unknown',
    });
  });
});
