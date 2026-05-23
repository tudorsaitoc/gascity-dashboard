import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import type {
  CityStatusSummary,
  DashboardSnapshot,
  ResourceSummary,
  SourceName,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  createSnapshotService,
  type SourceCacheMap,
} from '../src/snapshot/service.js';
import { snapshotRouter } from '../src/routes/snapshot.js';
import { fixtureSourceLoader } from '../src/snapshot/fixtures/loader.js';

// ── Integration coverage for the snapshot aggregate route ────────────────
//
// Acceptance gates (from gascity-dashboard-8nj):
//   1. GET /api/snapshot returns DashboardSnapshot with city/workflows/resources populated.
//   2. Concurrent GETs coalesce upstream load() calls (SourceCache single-flight).
//   3. POST /refresh { sources: ['city'] } only re-fetches the named caches.
//   4. POST /refresh with bogus source name → 400 validation error.
//   5. Failure isolation: one source's load() throwing leaves siblings 'fresh'.
//   6. SNAPSHOT_USE_FIXTURES=1 + live load fails + fixture wired → status='fixture' with data.

const SAMPLE_CITY: CityStatusSummary = {
  activeAgents: 2,
  totalAgents: 3,
  activeSessions: 2,
  suspendedSessions: 0,
  maxSessions: 100,
  sessionsByProvider: [{ provider: 'codex', active: 2, total: 3 }],
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
  vcpuCount: 4,
  loadAverage: [0.1, 0.2, 0.3],
  loadPerVcpu: 0.025,
  memory: { totalBytes: 1024, usedBytes: 512, availableBytes: 512, utilization: 0.5 },
  uptimeSeconds: 3600,
  samples: [],
};

interface SpyLoads {
  city: number;
  workflows: number;
  resources: number;
}

/**
 * Build a SourceCacheMap wired with spy-tracked loaders so tests can
 * assert exactly which caches were re-fetched. aimux/github/tokens are
 * wired with throwing loaders (the v0 deferred contract — they surface
 * as status='error' in the snapshot).
 */
function buildCaches(opts: {
  loadCounts: SpyLoads;
  cityResult?: () => Promise<CityStatusSummary> | CityStatusSummary;
  workflowsResult?: () => Promise<WorkflowSummary> | WorkflowSummary;
  resourcesResult?: () => Promise<ResourceSummary> | ResourceSummary;
  useFixture?: boolean;
  wireFixturesFor?: SourceName[];
}): SourceCacheMap {
  const { loadCounts } = opts;
  const useFixture = opts.useFixture ?? false;
  const wireFor = new Set<SourceName>(opts.wireFixturesFor ?? []);

  const cityLoad = opts.cityResult ?? (() => SAMPLE_CITY);
  const workflowsLoad = opts.workflowsResult ?? (() => SAMPLE_WORKFLOWS);
  const resourcesLoad = opts.resourcesResult ?? (() => SAMPLE_RESOURCES);

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
      useFixture,
      load: async () => {
        loadCounts.city += 1;
        return cityLoad();
      },
      loadFixture: wireFor.has('city') ? fixtureSourceLoader('city') : undefined,
    }),
    resources: new SourceCache({
      source: 'resources',
      ttlMs: 30_000,
      useFixture,
      load: async () => {
        loadCounts.resources += 1;
        return resourcesLoad();
      },
      loadFixture: wireFor.has('resources') ? fixtureSourceLoader('resources') : undefined,
    }),
    workflows: new SourceCache({
      source: 'workflows',
      ttlMs: 60_000,
      useFixture,
      load: async () => {
        loadCounts.workflows += 1;
        return workflowsLoad();
      },
      loadFixture: wireFor.has('workflows') ? fixtureSourceLoader('workflows') : undefined,
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

function buildApp(caches: SourceCacheMap): express.Express {
  const service = createSnapshotService({
    caches,
    config: {
      cityRoot: '/tmp/test-city',
      githubRepo: 'test-org/test-repo',
      useFixtures: false,
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/snapshot', snapshotRouter(service));
  return app;
}

function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

describe('GET /api/snapshot', () => {
  test('returns DashboardSnapshot with city/workflows/resources populated', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(buildCaches({ loadCounts: counts }));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/snapshot`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as DashboardSnapshot;

      assert.equal(body.sources.city.status, 'fresh');
      assert.deepEqual(body.sources.city.data, SAMPLE_CITY);
      assert.equal(body.sources.workflows.status, 'fresh');
      assert.deepEqual(body.sources.workflows.data, SAMPLE_WORKFLOWS);
      assert.equal(body.sources.resources.status, 'fresh');
      assert.deepEqual(body.sources.resources.data, SAMPLE_RESOURCES);

      // headline composed from city + workflows.
      assert.equal(body.headline.activeAgents, 2);
      assert.equal(body.headline.maxAgents, 100);
      assert.equal(body.headline.activeSessions, 2);

      // generatedAt present and ISO.
      assert.ok(body.generatedAt.endsWith('Z'));

      // config reflects what was passed in.
      assert.equal(body.config.cityRoot, '/tmp/test-city');
      assert.equal(body.config.useFixtures, false);
    } finally {
      await close();
    }
  });

  test('concurrent GETs coalesce upstream load() per source (single-flight)', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    let resolveCity: ((v: CityStatusSummary) => void) | undefined;
    const app = buildApp(
      buildCaches({
        loadCounts: counts,
        cityResult: () =>
          new Promise<CityStatusSummary>((resolve) => {
            resolveCity = resolve;
          }),
      }),
    );
    const { url, close } = await startApp(app);
    try {
      const first = fetch(`${url}/api/snapshot`);
      const second = fetch(`${url}/api/snapshot`);
      // Poll until both route handlers have entered the city loader.
      // fetch() returns a promise immediately, but the server-side
      // request callback runs on a later tick — we cannot assume the
      // load() has fired after a single setImmediate.
      const deadlineMs = Date.now() + 1_000;
      while (resolveCity === undefined && Date.now() < deadlineMs) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(resolveCity, 'city load should have started');
      resolveCity?.(SAMPLE_CITY);

      const [resA, resB] = await Promise.all([first, second]);
      assert.equal(resA.status, 200);
      assert.equal(resB.status, 200);

      // city load was invoked exactly once despite two concurrent
      // route hits (SourceCache single-flight).
      assert.equal(counts.city, 1);
    } finally {
      await close();
    }
  });

  test('isolates a failing source: one collector erroring does not poison siblings', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(
      buildCaches({
        loadCounts: counts,
        cityResult: () => {
          throw new Error('supervisor unreachable');
        },
      }),
    );
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/snapshot`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as DashboardSnapshot;
      assert.equal(body.sources.city.status, 'error');
      assert.equal(body.sources.city.data, null);
      assert.match(body.sources.city.error ?? '', /supervisor unreachable/);

      assert.equal(body.sources.resources.status, 'fresh');
      assert.equal(body.sources.workflows.status, 'fresh');
    } finally {
      await close();
    }
  });

  test('useFixtures + supervisor down + fixture wired → city status=fixture with data', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(
      buildCaches({
        loadCounts: counts,
        useFixture: true,
        wireFixturesFor: ['city', 'workflows', 'resources'],
        cityResult: () => {
          throw new Error('supervisor unreachable');
        },
      }),
    );
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/snapshot`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as DashboardSnapshot;
      assert.equal(body.sources.city.status, 'fixture');
      assert.equal(body.sources.city.data?.activeAgents, 12);
    } finally {
      await close();
    }
  });
});

describe('POST /api/snapshot/refresh', () => {
  test('selective refresh: { sources: [city] } only re-fetches city cache', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(buildCaches({ loadCounts: counts }));
    const { url, close } = await startApp(app);
    try {
      // Prime: one GET hits every cache once.
      await fetch(`${url}/api/snapshot`);
      assert.equal(counts.city, 1);
      assert.equal(counts.workflows, 1);
      assert.equal(counts.resources, 1);

      // Refresh city only.
      const res = await fetch(`${url}/api/snapshot/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['city'] }),
      });
      assert.equal(res.status, 200);

      assert.equal(counts.city, 2, 'city must be re-fetched');
      assert.equal(counts.workflows, 1, 'workflows must NOT be re-fetched');
      assert.equal(counts.resources, 1, 'resources must NOT be re-fetched');
    } finally {
      await close();
    }
  });

  test('rejects unknown source names with 400', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(buildCaches({ loadCounts: counts }));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/snapshot/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['bogus'] }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { kind?: string; error?: string };
      assert.equal(body.kind, 'validation');
    } finally {
      await close();
    }
  });

  test('empty body / no sources field → refresh all sources', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(buildCaches({ loadCounts: counts }));
    const { url, close } = await startApp(app);
    try {
      // Prime.
      await fetch(`${url}/api/snapshot`);
      assert.equal(counts.city, 1);

      const res = await fetch(`${url}/api/snapshot/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);

      // All wired sources re-fetched. (aimux/github/tokens throw on load,
      // so their counter is unrelated — the spy is only on the three
      // wired collectors.)
      assert.equal(counts.city, 2);
      assert.equal(counts.workflows, 2);
      assert.equal(counts.resources, 2);
    } finally {
      await close();
    }
  });

  test('rejects body.sources that is an empty array with 400', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(buildCaches({ loadCounts: counts }));
    const { url, close } = await startApp(app);
    try {
      await fetch(`${url}/api/snapshot`);
      const baseline = { ...counts };
      const res = await fetch(`${url}/api/snapshot/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: [] }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'validation');
      // No refresh fired — counts unchanged from baseline.
      assert.equal(counts.city, baseline.city);
      assert.equal(counts.workflows, baseline.workflows);
      assert.equal(counts.resources, baseline.resources);
    } finally {
      await close();
    }
  });

  test('rejects body.sources that is not an array with 400', async () => {
    const counts: SpyLoads = { city: 0, workflows: 0, resources: 0 };
    const app = buildApp(buildCaches({ loadCounts: counts }));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/snapshot/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: 'city' }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'validation');
    } finally {
      await close();
    }
  });
});
