import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CityStatusSummary,
  ResourceSummary,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  createSnapshotService,
  type SnapshotService,
  type SourceCacheMap,
} from '../src/snapshot/service.js';

// ── Failure-isolation contract for readSources ───────────────────────────
//
// Regression guard for gascity-dashboard-9tv (Phase 4 review finding from
// wave-8nj). readSources composes six SourceCaches with Promise.all over
// a `settle()` wrapper: a rejected promise from any single
// cache.get()/refresh() resolves into a status='error' SourceState
// envelope rather than rejecting the entire aggregate. Today
// SourceCache.refreshUnshared catches all collector errors internally —
// but the route-level guarantee should not depend on that invariant. If
// a future collector wrapper escapes the cache's catch (sync throw,
// returned rejected promise, etc.), the snapshot must still serve a
// partial envelope, not 500 the route.
//
// Cross-bead invariant (gascity-dashboard-4r5 + 9tv): the settle catch
// must route the rejected error through cache.sanitize() before writing
// to SourceState.error. Otherwise the failure-isolation wrapper would
// itself bypass the default-on sanitization that 4r5 introduced —
// leaking raw error.message (potentially OS-internal paths) to the wire
// in exactly the escape-the-internal-catch scenario that settle exists
// to protect against. Asserted below by the "sanitizes the leaked error"
// case.

const SAMPLE_CITY: CityStatusSummary = {
  activeAgents: 1,
  totalAgents: 1,
  activeSessions: 1,
  suspendedSessions: 0,
  maxSessions: { status: 'available', value: 10 },
  sessionsByProvider: [],
  rigs: [],
};

const SAMPLE_WORKFLOWS: WorkflowSummary = {
  totalActive: 0,
  totalHistorical: 0,
  runCounts: {
    total: 0,
    visible: 0,
    prReview: 0,
    designReview: 0,
    bugfix: 0,
    blocked: 0,
    other: 0,
  },
  lanes: [],
  historicalLanes: [],
  // gascity-dashboard-3ax: the health engine derives a census in the read
  // path; with no lanes it is the all-zero census the served data carries.
  census: {
    status: 'available',
    data: {
      byPhase: {
        intake: 0,
        implementation: 0,
        review: 0,
        approval: 0,
        finalization: 0,
        blocked: 0,
        complete: 0,
        active: 0,
      },
      totalInFlight: 0,
      unverifiable: 0,
      knownDenominator: 0,
      thrashing: 0,
    },
  },
  recentChanges: [],
};

const SAMPLE_RESOURCES: ResourceSummary = {
  vcpuCount: 1,
  loadAverage: [0, 0, 0],
  loadPerVcpu: 0,
  memory: { totalBytes: 1, usedBytes: 0, availableBytes: 1, utilization: 0 },
  uptimeSeconds: 1,
  samples: [],
};

/**
 * Build a healthy cache for a source whose data fits SourceCache<T>.
 * Default loaders return the SAMPLE_* fixtures so siblings stay 'fresh'
 * when one cache is sabotaged below.
 */
function buildHealthyCaches(): SourceCacheMap {
  return {
    city: new SourceCache({
      source: 'city',
      ttlMs: 45_000,
      load: async () => SAMPLE_CITY,
    }),
    resources: new SourceCache({
      source: 'resources',
      ttlMs: 30_000,
      load: async () => SAMPLE_RESOURCES,
    }),
    workflows: new SourceCache({
      source: 'workflows',
      ttlMs: 60_000,
      load: async () => SAMPLE_WORKFLOWS,
    }),
  };
}

/**
 * Replace cache.get / cache.refresh on a single SourceCache with stubs
 * that reject. This simulates a future code path where a collector
 * wrapper bypasses SourceCache.refreshUnshared's internal catch — the
 * exact regression class this test guards against.
 */
function sabotageCache(cache: SourceCache<unknown>, message: string): void {
  const rejector = () => Promise.reject(new Error(message));
  // Cast via unknown — we deliberately overwrite the method to model a
  // hostile/buggy future caller wrapper.
  (cache as unknown as { get: () => Promise<unknown> }).get = rejector;
  (cache as unknown as { refresh: () => Promise<unknown> }).refresh = rejector;
}

function buildService(caches: SourceCacheMap): SnapshotService {
  return createSnapshotService({
    caches,
	    config: {
	      cityName: 'test-city',
	      cityRoot: '/tmp/test-city',
      useFixtures: false,
    },
  });
}

describe('readSources failure isolation (settle wrapper contract)', () => {
  test('a single cache rejecting becomes status=error in the envelope, siblings stay fresh', async () => {
    const caches = buildHealthyCaches();
    sabotageCache(caches.city as SourceCache<unknown>, 'simulated unhandled rejection');

    const service = buildService(caches);

    const snapshot = await service.getSnapshot();

    assert.equal(snapshot.sources.city.status, 'error');
    assert.equal('data' in snapshot.sources.city, false);
    assert.equal(snapshot.sources.city.source, 'city');

    assert.equal(snapshot.sources.resources.status, 'fresh');
    assert.deepEqual(snapshot.sources.resources.data, SAMPLE_RESOURCES);
    assert.equal(snapshot.sources.workflows.status, 'fresh');
    assert.deepEqual(snapshot.sources.workflows.data, SAMPLE_WORKFLOWS);
  });

  test('every cache rejecting still resolves with a fully-shaped envelope (no thrown promise)', async () => {
    const caches = buildHealthyCaches();
    sabotageCache(caches.city as SourceCache<unknown>, 'city down');
    sabotageCache(caches.resources as SourceCache<unknown>, 'resources down');
    sabotageCache(caches.workflows as SourceCache<unknown>, 'workflows down');

    const service = buildService(caches);

    const snapshot = await service.getSnapshot();

    for (const name of ['city', 'resources', 'workflows'] as const) {
      assert.equal(snapshot.sources[name].status, 'error', `${name} should be status=error`);
      assert.equal('data' in snapshot.sources[name], false, `${name} should not expose data`);
      assert.equal(snapshot.sources[name].source, name, `${name} envelope should carry source name`);
    }
  });

  test('refresh() with a rejecting cache also resolves (does not 500 the route)', async () => {
    const caches = buildHealthyCaches();
    sabotageCache(caches.city as SourceCache<unknown>, 'city refresh exploded');

    const service = buildService(caches);

    const snapshot = await service.refresh(['city', 'resources']);

    assert.equal(snapshot.sources.city.status, 'error');
    assert.equal('data' in snapshot.sources.city, false);
    assert.equal(snapshot.sources.resources.status, 'fresh');
    assert.deepEqual(snapshot.sources.resources.data, SAMPLE_RESOURCES);
  });

  test('sanitizes the leaked error via cache.sanitize before writing to SourceState.error', async () => {
    // Cross-bead regression guard (gascity-dashboard-4r5 + 9tv). If
    // settle() emits raw error.message, the OS-path-bearing string below
    // lands on the wire — exactly the failure mode 4r5 was added to
    // prevent. With cache.sanitize routing, the default sanitizer fires
    // for caches that omit sanitizeErrorMessage (resources) and the raw
    // string passes through for caches that explicitly opt out.
    const caches = buildHealthyCaches();
    const leakyPath = '/home/operator/.ssh/id_rsa';

    // resources cache uses the default (no sanitizeErrorMessage option) →
    // generic message expected on the wire.
    sabotageCache(caches.resources as SourceCache<unknown>, leakyPath);

    const service = buildService(caches);
    const snapshot = await service.getSnapshot();

    assert.equal(snapshot.sources.resources.status, 'error');
    assert.equal(
      snapshot.sources.resources.error,
      'resources collection failed',
      'settle() must route through cache.sanitize() so the default-on sanitizer fires',
    );
    assert.ok(
      !snapshot.sources.resources.error?.includes(leakyPath),
      'raw OS path must not leak to the wire even when the catch fires outside refreshUnshared',
    );
  });
});
