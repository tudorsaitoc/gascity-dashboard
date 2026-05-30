import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { AdminConfig } from '../src/config.js';
import { createDashboardApp } from '../src/app.js';

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
    maintainerRepo: 'gastownhall/gascity',
    maintainerCachePath: '.gascity-dashboard/maintainer-cache.json',
    maintainerRefreshIntervalMs: 0,
    maintainerSlingTarget: 'mayor',
    maintainerTriageTarget: 'chief-of-staff',
    useFixtures: false,
    ...overrides,
  };
}

async function withApp<T>(app: Express, fn: (url: string) => Promise<T>): Promise<T> {
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

describe('createDashboardApp', () => {
  test('assembles the Express app separately from process startup', async () => {
    const { app, runtime } = createDashboardApp(makeConfig());
    runtime.start();
    try {
      await withApp(app, async (url) => {
        const health = await fetch(`${url}/api/health`);
        assert.equal(health.status, 200);
        const body = (await health.json()) as { ok: boolean; ts: string };
        assert.equal(body.ok, true);
        assert.equal(typeof body.ts, 'string');

        const config = await fetch(`${url}/api/config`);
        assert.equal(config.status, 200);
        assert.deepEqual(await config.json(), {
          cityName: 'test-city',
          cityRoot: '',
          githubRepo: 'gastownhall/gascity',
          useFixtures: false,
        });
      });
    } finally {
      await runtime.stop();
    }
  });
});
