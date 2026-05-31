import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { GcStatus } from 'gas-city-dashboard-shared';
import { sampleDoltNomsSize, STORE_HEALTH_SOURCE } from '../src/routes/dolt.js';

// gascity-dashboard-x82: the dolt-noms sampler reads the supervisor's
// already-exposed store_health.size_bytes (GET /v0/city/{name}/status)
// instead of walking the host filesystem's .dolt/noms directory.
describe('sampleDoltNomsSize', () => {
  test('reads store_health.size_bytes from the injected status fetch', async () => {
    const status: GcStatus = {
      store_health: { size_bytes: 987_654, live_rows: 42 },
    };
    const result = await sampleDoltNomsSize(() => Promise.resolve(status));
    assert.deepEqual(result, {
      kind: 'available',
      sample: { bytes: 987_654, source: STORE_HEALTH_SOURCE },
    });
  });

  test('returns unavailable (store_health_absent) when store_health is absent — no fake zero', async () => {
    const result = await sampleDoltNomsSize(() => Promise.resolve({}));
    assert.deepEqual(result, {
      kind: 'unavailable',
      reason: 'store_health_absent',
    });
  });

  // Trust-boundary validation: a malformed or degraded supervisor could
  // return Infinity / NaN / negative size_bytes. JSON.stringify turns
  // Infinity/NaN into "null" (silent corruption) and a negative byte count
  // is meaningless. Treat all of them as absent.
  test('returns unavailable for non-finite or negative size_bytes (Infinity / -Infinity / NaN / -1)', async () => {
    for (const bad of [Infinity, -Infinity, NaN, -1]) {
      const result = await sampleDoltNomsSize(() =>
        Promise.resolve({ store_health: { size_bytes: bad } } as GcStatus),
      );
      assert.deepEqual(
        result,
        { kind: 'unavailable', reason: 'store_health_absent' },
        `expected store_health_absent for size_bytes=${bad}`,
      );
    }
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
