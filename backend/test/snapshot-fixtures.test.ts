import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  fixtureSourceLoader,
  loadFixtureSnapshot,
} from '../src/snapshot/fixtures/loader.js';
import { fixtureSnapshot } from '../src/snapshot/fixtures/snapshot.js';

// Fixture-mode runtime coverage for gascity-dashboard-hzy. Compile-time
// drift detection is enforced by the `: DashboardSnapshot` annotation on
// fixtureSnapshot in src/snapshot/fixtures/snapshot.ts — if the shared
// type grows a required field, tsc fails before this test ever runs.

describe('loadFixtureSnapshot', () => {
  test('returns the committed fixtureSnapshot', async () => {
    const snap = await loadFixtureSnapshot();
    assert.equal(snap, fixtureSnapshot);
    assert.equal(snap.config.useFixtures, true);
    assert.equal(snap.sources.city.status, 'fixture');
  });
});

describe('fixtureSourceLoader', () => {
  test('resolves to populated data for sources with collectors wired', async () => {
    const data = await fixtureSourceLoader('city')();
    assert.equal(data.activeAgents, 12);
    assert.equal(data.rigs.length, 1);
  });

  test('rejects for placeholder sources whose data is null', async () => {
    await assert.rejects(
      fixtureSourceLoader('aimux')(),
      /fixture data for source 'aimux' is null/,
    );
    await assert.rejects(
      fixtureSourceLoader('github')(),
      /fixture data for source 'github' is null/,
    );
    await assert.rejects(
      fixtureSourceLoader('tokens')(),
      /fixture data for source 'tokens' is null/,
    );
  });
});

describe('SourceCache + fixtureSourceLoader integration', () => {
  test('SourceCache falls back to fixture when live load throws and useFixture is true', async () => {
    const cache = new SourceCache({
      source: 'city',
      ttlMs: 1_000,
      useFixture: true,
      load: async () => {
        throw new Error('supervisor unreachable');
      },
      loadFixture: fixtureSourceLoader('city'),
      // gascity-dashboard-4r5: mirror the city collector's prod
      // contract (opt out of default-on sanitization because GcClient
      // already sanitizes upstream messages). Without this, the
      // assertion below would see the generic "city collection failed".
      sanitizeErrorMessage: null,
    });

    const state = await cache.get();
    assert.equal(state.source, 'city');
    assert.equal(state.status, 'fixture');
    assert.equal(state.error, 'supervisor unreachable');
    assert.equal(state.data?.activeAgents, 12);
  });
});
