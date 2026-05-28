import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { GcStatus } from 'gas-city-dashboard-shared';
import { sampleDoltNomsSize } from '../src/routes/dolt.js';

// gascity-dashboard-x82: the dolt-noms sampler reads the supervisor's
// already-exposed store_health.size_bytes (GET /v0/city/{name}/status)
// instead of returning a null stub.
describe('sampleDoltNomsSize', () => {
  test('reads store_health.size_bytes from the status fetch', async () => {
    const status: GcStatus = {
      store_health: { size_bytes: 987_654, live_rows: 42 },
    };
    const bytes = await sampleDoltNomsSize(() => Promise.resolve(status));
    assert.equal(bytes, 987_654);
  });

  test('returns null when store_health is absent (no fake zero)', async () => {
    const bytes = await sampleDoltNomsSize(() => Promise.resolve({}));
    assert.equal(bytes, null);
  });

  test('propagates a status-fetch error instead of swallowing it', async () => {
    await assert.rejects(
      () =>
        sampleDoltNomsSize(() =>
          Promise.reject(new Error('gc supervisor returned 503')),
        ),
      /gc supervisor returned 503/,
    );
  });
});
