import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { GcClient } from '../gc-client.js';
import type { AdminConfig } from '../config.js';
import { createCityRuntime } from './runtime.js';

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
    readOnly: false,
    modules: {
      maintainer: {
        githubRepo: 'gastownhall/gascity',
        slingTarget: 'mayor',
        triageTarget: 'chief-of-staff',
        refreshIntervalMs: 0,
        cachePath: '.gascity-dashboard/maintainer-cache.json',
      },
      refinery: {
        repoPath: '',
        riverLogDir: '',
        routedTo: '',
        windowDays: 7,
        stuckHours: 24,
      },
    },
    useFixtures: false,
    enabledModules: null,
    defaultView: null,
    ...overrides,
  };
}

// createCityRuntime never touches the GcClient during construction (the
// samplers only call it once started), so a bare stub keeps this projection
// test free of any supervisor network dependency.
const stubGc = {} as GcClient;

describe('createCityRuntime: read-only posture projection (gascity-dashboard-uzhr)', () => {
  test('projects config.readOnly=true onto dashboardConfig.readOnly', () => {
    const runtime = createCityRuntime({
      cityName: 'test-city',
      cityPath: '/host/test-city',
      config: makeConfig({ readOnly: true }),
      gc: stubGc,
    });
    assert.equal(runtime.dashboardConfig.readOnly, true);
  });

  test('projects config.readOnly=false onto dashboardConfig.readOnly', () => {
    const runtime = createCityRuntime({
      cityName: 'test-city',
      cityPath: '/host/test-city',
      config: makeConfig({ readOnly: false }),
      gc: stubGc,
    });
    assert.equal(runtime.dashboardConfig.readOnly, false);
  });
});
