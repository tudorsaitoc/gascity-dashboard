import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createCityRegistry, type SupervisorCityDescriptor } from '../src/city/registry.js';
import type { CityRuntime } from '../src/city/runtime.js';
import { cityDispatch } from '../src/middleware/city-dispatch.js';
import type { AdminConfig } from '../src/config.js';

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    port: 8081,
    bindHost: '127.0.0.1',
    extraAllowedHosts: [],
    gcSupervisorUrl: 'http://127.0.0.1:1',
    cityName: 'test-city',
    cityPath: '',
    runCwdAllowedRoots: [],
    auditLogPath: '.gc/events.jsonl',
    frontendDistPath: '../frontend/dist-does-not-exist',
    disabled: false,
    modules: {
      maintainer: {
        githubRepo: 'gastownhall/gascity',
        slingTarget: 'mayor',
        triageTarget: 'chief-of-staff',
        refreshIntervalMs: 0,
        cachePath: '.gascity-dashboard/maintainer-cache.json',
      },
    },
    useFixtures: false,
    enabledModules: null,
    defaultView: null,
    ...overrides,
  };
}

/** A fake runtime that records start/stop and exposes a trivial router that
 *  echoes the city name, so dispatch tests can assert which runtime served. */
function fakeRuntime(cityName: string): CityRuntime & { started: number; stopped: number } {
  const router = express.Router();
  router.get('/whoami', (_req, res) => res.json({ city: cityName }));
  const rt = {
    cityName,
    router,
    dashboardConfig: {
      cityName,
      cityRoot: '',
      useFixtures: false,
      enabledModules: null,
      defaultView: null,
    },
    started: 0,
    stopped: 0,
    start() {
      rt.started += 1;
    },
    async stop() {
      rt.stopped += 1;
    },
  };
  return rt;
}

describe('city registry: get-or-create + single-flight', () => {
  test('builds exactly one runtime for concurrent first-requests of the same city', async () => {
    let builds = 0;
    let listCalls = 0;
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => {
        listCalls += 1;
        // Delay so all three callers are in-flight before the list resolves.
        await new Promise((r) => setTimeout(r, 25));
        return [{ name: 'racoon-city', path: '/host/racoon', running: true }];
      },
      createRuntime: (d: SupervisorCityDescriptor) => {
        builds += 1;
        return fakeRuntime(d.name);
      },
    });

    const results = await Promise.all([
      registry.resolve('racoon-city'),
      registry.resolve('racoon-city'),
      registry.resolve('racoon-city'),
    ]);

    for (const r of results) assert.equal(r.kind, 'ok');
    assert.equal(builds, 1, 'exactly one CityRuntime built');
    assert.equal(listCalls, 1, 'one /v0/cities lookup shared by all three');
    // All three callers share the same runtime instance.
    const runtimes = results.map((r) => (r.kind === 'ok' ? r.runtime : null));
    assert.equal(runtimes[0], runtimes[1]);
    assert.equal(runtimes[1], runtimes[2]);
  });

  test('a second request after build reuses the live runtime (no rebuild)', async () => {
    let builds = 0;
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [{ name: 'racoon-city', path: '/host/racoon', running: true }],
      createRuntime: (d) => {
        builds += 1;
        return fakeRuntime(d.name);
      },
    });
    await registry.resolve('racoon-city');
    await registry.resolve('racoon-city');
    assert.equal(builds, 1);
  });

  test('two cities get two isolated runtimes', async () => {
    const built: string[] = [];
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [
        { name: 'racoon-city', path: '/host/racoon', running: true },
        { name: 'gas-town', path: '/host/gas', running: true },
      ],
      createRuntime: (d) => {
        built.push(d.name);
        return fakeRuntime(d.name);
      },
    });
    const a = await registry.resolve('racoon-city');
    const b = await registry.resolve('gas-town');
    assert.equal(a.kind, 'ok');
    assert.equal(b.kind, 'ok');
    assert.notEqual(a.kind === 'ok' ? a.runtime : null, b.kind === 'ok' ? b.runtime : null);
    assert.deepEqual(built, ['racoon-city', 'gas-town']);
  });

  test('unknown-but-valid city resolves to unknown (no fallback)', async () => {
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [{ name: 'racoon-city', path: '/host/racoon', running: true }],
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const r = await registry.resolve('ghost-town');
    assert.equal(r.kind, 'unknown');
  });

  test('invalid city name is rejected WITHOUT calling listCities', async () => {
    let listCalls = 0;
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => {
        listCalls += 1;
        return [];
      },
      createRuntime: (d) => fakeRuntime(d.name),
    });
    for (const bad of ['../etc', 'a/b', 'a..b', '-bad', '']) {
      const r = await registry.resolve(bad);
      assert.equal(r.kind, 'invalid', `expected invalid for ${JSON.stringify(bad)}`);
    }
    assert.equal(listCalls, 0, 'no supervisor call for a traversal/invalid name');
  });

  test('upstream listCities failure surfaces as upstream-error (no fallback)', async () => {
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => {
        throw new Error('gc supervisor returned 503');
      },
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const r = await registry.resolve('racoon-city');
    assert.equal(r.kind, 'upstream-error');
  });

  test('a failed build clears the in-flight slot so the next request retries', async () => {
    let attempt = 0;
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('gc supervisor returned 503');
        return [{ name: 'racoon-city', path: '/host/racoon', running: true }];
      },
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const first = await registry.resolve('racoon-city');
    assert.equal(first.kind, 'upstream-error');
    const second = await registry.resolve('racoon-city');
    assert.equal(second.kind, 'ok');
  });

  test('a throwing start() leaves a registered, stoppable runtime (no leak)', async () => {
    // MUST-FIX (registry): runtimes.set(...) BEFORE runtime.start() so a
    // start that throws still leaves a runtime stopAll() can tear down.
    const rt = fakeRuntime('racoon-city');
    let started = false;
    rt.start = () => {
      started = true;
      throw new Error('worker boot failed');
    };
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [{ name: 'racoon-city', path: '/host/racoon', running: true }],
      createRuntime: () => rt,
    });
    await assert.rejects(registry.resolve('racoon-city'), /worker boot failed/);
    assert.equal(started, true);
    // The half-started runtime is reachable for cleanup.
    await registry.stopAll();
    assert.equal(rt.stopped, 1, 'stopAll could tear down the registered runtime');
  });

  test('the shared build rides no per-caller AbortSignal; both requesters resolve (SHOULD-FIX)', async () => {
    // Two concurrent first-requests for the same city collapse to ONE shared
    // build. resolve() deliberately takes no signal, so the shared
    // construction can never be cancelled by one requester's abort. listCities
    // must therefore be invoked WITHOUT a signal — proving no per-caller abort
    // can reach the shared build — and both requesters resolve ok.
    let listCalls = 0;
    let sawSignal = false;
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async (signal) => {
        listCalls += 1;
        if (signal !== undefined) sawSignal = true;
        await new Promise((r) => setTimeout(r, 25));
        return [{ name: 'racoon-city', path: '/host/racoon', running: true }];
      },
      createRuntime: (d) => fakeRuntime(d.name),
    });

    const [r1, r2] = await Promise.all([
      registry.resolve('racoon-city'),
      registry.resolve('racoon-city'),
    ]);
    assert.equal(r1.kind, 'ok');
    assert.equal(r2.kind, 'ok', 'second requester still resolves');
    assert.equal(listCalls, 1, 'one shared build for both requesters');
    assert.equal(sawSignal, false, 'shared build invoked listCities WITHOUT a per-caller signal');
  });

  test('stopAll stops every live runtime', async () => {
    const runtimes: ReturnType<typeof fakeRuntime>[] = [];
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [
        { name: 'racoon-city', path: '/host/racoon', running: true },
        { name: 'gas-town', path: '/host/gas', running: true },
      ],
      createRuntime: (d) => {
        const rt = fakeRuntime(d.name);
        runtimes.push(rt);
        return rt;
      },
    });
    await registry.resolve('racoon-city');
    await registry.resolve('gas-town');
    await registry.stopAll();
    assert.equal(runtimes.length, 2);
    for (const rt of runtimes) assert.equal(rt.stopped, 1);
  });
});

// ── Middleware-level dispatch (validation precedence + status mapping) ────

async function withApp<T>(app: express.Express, fn: (url: string) => Promise<T>): Promise<T> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function mountDispatch(registry: ReturnType<typeof createCityRegistry>): express.Express {
  const app = express();
  app.use('/api/city/:cityName', cityDispatch(registry), (req, res, next) => {
    if (!req.cityRuntime) {
      next();
      return;
    }
    req.cityRuntime.router(req, res, next);
  });
  return app;
}

describe('city-dispatch middleware', () => {
  test('valid city resolves, attaches the runtime, and the router serves', async () => {
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [{ name: 'racoon-city', path: '/host/racoon', running: true }],
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const app = mountDispatch(registry);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/api/city/racoon-city/whoami`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { city: 'racoon-city' });
    });
  });

  test('path-traversal :cityName is rejected 400 BEFORE any listCities call', async () => {
    let listCalls = 0;
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => {
        listCalls += 1;
        return [];
      },
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const app = mountDispatch(registry);
    await withApp(app, async (url) => {
      // %2e%2e%2f = ../ — Express decodes the param; the guard must reject it.
      const res = await fetch(`${url}/api/city/%2e%2e%2fetc/whoami`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'validation');
    });
    assert.equal(listCalls, 0, 'no supervisor call for a traversal attempt');
  });

  test('unknown-but-valid city returns 404 with no fallback', async () => {
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [{ name: 'racoon-city', path: '/host/racoon', running: true }],
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const app = mountDispatch(registry);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/api/city/ghost-town/whoami`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'unknown-city');
    });
  });

  test('a synchronous throw out of runtime build returns 500 (no hang)', async () => {
    // MUST-FIX: Express 4 does not forward a rejected async-middleware promise
    // to its error handler. A throw from runtime construction (e.g. start())
    // must be caught in the middleware and surfaced as 500 — not leave the
    // request hanging open.
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => [{ name: 'racoon-city', path: '/host/racoon', running: true }],
      createRuntime: () => {
        const rt = fakeRuntime('racoon-city');
        rt.start = () => {
          throw new Error('runtime boot exploded');
        };
        return rt;
      },
    });
    const app = mountDispatch(registry);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/api/city/racoon-city/whoami`);
      assert.equal(res.status, 500);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'internal');
    });
  });

  test('supervisor registry unreachable returns an upstream error (no fallback)', async () => {
    const registry = createCityRegistry({
      config: makeConfig(),
      listCities: async () => {
        throw new Error('gc supervisor returned 503');
      },
      createRuntime: (d) => fakeRuntime(d.name),
    });
    const app = mountDispatch(registry);
    await withApp(app, async (url) => {
      const res = await fetch(`${url}/api/city/racoon-city/whoami`);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream');
    });
  });
});
