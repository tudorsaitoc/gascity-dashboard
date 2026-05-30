import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';

import type { AdminConfig } from '../src/config.js';
import type { GcClient } from '../src/gc-client.js';
import { ALL_MODULES } from '../src/views/registry.js';
import {
  bind,
  type BackendModule,
  type BackgroundWorker,
  type CityContext,
} from '../src/views/types.js';
import { healthBackend } from '../src/views/modules/health.module.js';

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    port: 8081,
    bindHost: '127.0.0.1',
    extraAllowedHosts: [],
    gcSupervisorUrl: 'http://127.0.0.1:1',
    cityName: 'test-city',
    cityPath: '',
    auditLogPath: '.gc/events.jsonl',
    frontendDistPath: '../frontend/dist-does-not-exist',
    disabled: false,
    modules: {
      maintainer: {
        githubRepo: 'gastownhall/gascity',
        slingTarget: 'mayor',
        triageTarget: 'mayor',
        refreshIntervalMs: 0,
      },
    },
    useFixtures: false,
    ...overrides,
  };
}

function fakeCityContext(config: AdminConfig): CityContext {
  return {
    cityName: config.cityName,
    cityPath: config.cityPath,
    cityDataDir: '/tmp/gascity-dashboard-test',
    // The registry tests only exercise structural mounting paths; modules
    // that actually hit the supervisor have integration tests of their own.
    gc: {} as GcClient,
    config,
  };
}

describe('views/registry', () => {
  test('ALL_MODULES includes the health module', () => {
    const ids = ALL_MODULES.map((m) => m.id);
    assert.ok(ids.includes('health'), `expected 'health' in ${JSON.stringify(ids)}`);
  });

  test('ALL_MODULES includes the maintainer module', () => {
    const ids = ALL_MODULES.map((m) => m.id);
    assert.ok(ids.includes('maintainer'), `expected 'maintainer' in ${JSON.stringify(ids)}`);
  });

  test('ALL_MODULES has no duplicate ids', () => {
    const seen = new Set<string>();
    for (const mod of ALL_MODULES) {
      assert.ok(!seen.has(mod.id), `duplicate module id: ${mod.id}`);
      seen.add(mod.id);
    }
  });

  test('every module declares a working needs(config) function', () => {
    const config = makeConfig();
    for (const mod of ALL_MODULES) {
      assert.equal(
        typeof mod.needs,
        'function',
        `module ${mod.id} is missing needs()`,
      );
      // Smoke-call needs() so the registry test catches a throw at boot
      // instead of waiting for the first request to a /api/<id> route.
      assert.doesNotThrow(() => mod.needs(config), `${mod.id}.needs threw`);
    }
  });
});

describe('views/types#bind', () => {
  test('bind(healthBackend) returns a MountedModule whose mount() yields a Router', () => {
    const config = makeConfig();
    const mounted = bind(healthBackend, config);
    assert.equal(mounted.id, 'health');
    assert.equal(mounted.kind, 'core');
    const router = mounted.mount(fakeCityContext(config));
    // express.Router instances expose `.use` + `.get` + `.stack` — that's
    // the structural test that we actually got a Router back, not just an
    // object literal.
    assert.equal(typeof router, 'function');
    assert.equal(typeof router.use, 'function');
    assert.equal(typeof router.get, 'function');
  });

  test('bind() throws when a module is missing needs()', () => {
    const broken = {
      ...healthBackend,
      // Simulate JS-interop drift: the field exists but is not a function.
      needs: undefined as unknown as (config: AdminConfig) => void,
    } as BackendModule<void>;
    assert.throws(
      () => bind(broken, makeConfig()),
      /missing required needs/,
    );
  });

  test('@ts-expect-error: BackendModule without `needs` field is a compile error (Phase-4 TS M3)', () => {
    // The PRD explicitly requires `needs` non-optional so the type system
    // catches a missing field at compile time, not just bind()'s runtime
    // guard. If `needs` is ever made optional, the @ts-expect-error
    // directive below becomes a "Unused @ts-expect-error" tsc error and
    // typecheck fails — that IS the regression alarm.

    // @ts-expect-error needs is required by BackendModule — omitting it must be a compile error
    const _bad: BackendModule<void> = {
      id: 'bad',
      kind: 'core',
      resources: {},
      mount: () => Router(),
    };
    void _bad;
  });
});

describe('BackgroundWorker contract', () => {
  test('stop() returns a Promise', async () => {
    const worker: BackgroundWorker = {
      start() {
        // no-op
      },
      async stop() {
        // no-op
      },
    };
    worker.start();
    const result = worker.stop();
    assert.ok(result instanceof Promise, 'stop() must return a Promise');
    await result;
  });

  test('a no-workers module yields undefined for the bound worker', () => {
    const config = makeConfig();
    const mounted = bind(healthBackend, config);
    // health declares no workers — `worker` is undefined on the MountedModule.
    assert.equal(mounted.worker, undefined);
  });
});

describe('views/types#bind — non-void Deps fixture', () => {
  // Regression test for premortem #3: the iterator must NEVER need to see
  // the Deps type. We define a fixture module with a non-trivial Deps shape
  // and prove that bind() still produces a uniform MountedModule.
  interface FixtureDeps {
    label: string;
  }
  const fixture: BackendModule<FixtureDeps> = {
    id: 'test-fixture',
    kind: 'firstParty',
    resources: {},
    needs: (config) => ({ label: `fixture-${config.cityName}` }),
    mount: (_ctx, deps) => {
      const router = Router();
      router.get('/', (_req, res) => res.json({ label: deps.label }));
      return router;
    },
  };

  test('non-void Deps flow through bind() without type erasure', () => {
    const config = makeConfig({ cityName: 'fixture-city' });
    const mounted = bind(fixture, config);
    assert.equal(mounted.id, 'test-fixture');
    const router = mounted.mount(fakeCityContext(config));
    assert.equal(typeof router.use, 'function');
  });
});
