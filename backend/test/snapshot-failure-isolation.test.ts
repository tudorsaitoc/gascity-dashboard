import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CityStatusSummary,
  DashboardSnapshot,
  ResourceSummary,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  createSnapshotService,
  type SourceCacheMap,
} from '../src/snapshot/service.js';

// ── Failure-isolation contract for readSources ───────────────────────────
//
// Regression guard for gascity-dashboard-9tv (Phase 4 review finding from
// wave-8nj). readSources composes six SourceCaches with Promise.allSettled
// so that a rejected promise from any single cache.get()/refresh() resolves
// into a status='error' SourceState envelope rather than rejecting the
// entire aggregate. Today SourceCache.refreshUnshared catches all collector
// errors internally — but the route-level guarantee should not depend on
// that invariant. If a future collector wrapper escapes the cache's catch
// (sync throw, returned rejected promise, etc.), the snapshot must still
// serve a partial envelope, not 500 the route.

const SAMPLE_CITY: CityStatusSummary = {
  activeAgents: 1,
  totalAgents: 1,
  activeSessions: 1,
  suspendedSessions: 0,
  maxSessions: 10,
  sessionsByProvider: [],
  rigs: [],
};

const SAMPLE_WORKFLOWS: WorkflowSummary = {
  totalActive: 0,
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
    aimux: new SourceCache({
      source: 'aimux',
      ttlMs: 30_000,
      load: () => {
        throw new Error('aimux collector not wired');
      },
    }),
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
    github: new SourceCache({
      source: 'github',
      ttlMs: 30_000,
      load: () => {
        throw new Error('github collector not wired');
      },
    }),
    tokens: new SourceCache({
      source: 'tokens',
      ttlMs: 30_000,
      load: () => {
        throw new Error('tokens collector not wired');
      },
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

function buildService(caches: SourceCacheMap): { getSnapshot: () => Promise<DashboardSnapshot> } {
  return createSnapshotService({
    caches,
    config: {
      cityRoot: '/tmp/test-city',
      githubRepo: 'test-org/test-repo',
      useFixtures: false,
    },
  });
}

describe('readSources failure isolation (Promise.allSettled contract)', () => {
  test('a single cache rejecting becomes status=error in the envelope, siblings stay fresh', async () => {
    const caches = buildHealthyCaches();
    sabotageCache(caches.city as SourceCache<unknown>, 'simulated unhandled rejection');

    const service = buildService(caches);

    const snapshot = await service.getSnapshot();

    assert.equal(snapshot.sources.city.status, 'error');
    assert.equal(snapshot.sources.city.data, null);
    assert.equal(snapshot.sources.city.source, 'city');

    assert.equal(snapshot.sources.resources.status, 'fresh');
    assert.deepEqual(snapshot.sources.resources.data, SAMPLE_RESOURCES);
    assert.equal(snapshot.sources.workflows.status, 'fresh');
    assert.deepEqual(snapshot.sources.workflows.data, SAMPLE_WORKFLOWS);
  });

  test('every cache rejecting still resolves with a fully-shaped envelope (no thrown promise)', async () => {
    const caches = buildHealthyCaches();
    sabotageCache(caches.aimux as SourceCache<unknown>, 'aimux down');
    sabotageCache(caches.city as SourceCache<unknown>, 'city down');
    sabotageCache(caches.resources as SourceCache<unknown>, 'resources down');
    sabotageCache(caches.workflows as SourceCache<unknown>, 'workflows down');
    sabotageCache(caches.github as SourceCache<unknown>, 'github down');
    sabotageCache(caches.tokens as SourceCache<unknown>, 'tokens down');

    const service = buildService(caches);

    const snapshot = await service.getSnapshot();

    for (const name of ['aimux', 'city', 'resources', 'workflows', 'github', 'tokens'] as const) {
      assert.equal(snapshot.sources[name].status, 'error', `${name} should be status=error`);
      assert.equal(snapshot.sources[name].data, null, `${name} should have data=null`);
      assert.equal(snapshot.sources[name].source, name, `${name} envelope should carry source name`);
    }
  });

  test('refresh() with a rejecting cache also resolves (does not 500 the route)', async () => {
    const caches = buildHealthyCaches();
    sabotageCache(caches.city as SourceCache<unknown>, 'city refresh exploded');

    const service = createSnapshotService({
      caches,
      config: {
        cityRoot: '/tmp/test-city',
        githubRepo: 'test-org/test-repo',
        useFixtures: false,
      },
    });

    const snapshot = await service.refresh(['city', 'resources']);

    assert.equal(snapshot.sources.city.status, 'error');
    assert.equal(snapshot.sources.city.data, null);
    assert.equal(snapshot.sources.resources.status, 'fresh');
    assert.deepEqual(snapshot.sources.resources.data, SAMPLE_RESOURCES);
  });
});
