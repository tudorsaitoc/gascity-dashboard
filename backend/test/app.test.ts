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
    // Unroutable supervisor so /api/cities + city dispatch fail fast.
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
  test('serves the top-level health endpoint independent of any city', async () => {
    const { app, runtime } = createDashboardApp(makeConfig());
    runtime.start();
    try {
      await withApp(app, async (url) => {
        const health = await fetch(`${url}/api/health`);
        assert.equal(health.status, 200);
        const body = (await health.json()) as { ok: boolean; ts: string };
        assert.equal(body.ok, true);
        assert.equal(typeof body.ts, 'string');
      });
    } finally {
      await runtime.stop();
    }
  });

  test('rejects a path-traversal :cityName at the dispatch boundary (400)', async () => {
    const { app, runtime } = createDashboardApp(makeConfig());
    runtime.start();
    try {
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/api/city/%2e%2e%2fetc/config`);
        assert.equal(res.status, 400);
        const body = (await res.json()) as { kind?: string };
        assert.equal(body.kind, 'validation');
      });
    } finally {
      await runtime.stop();
    }
  });

  test('city dispatch surfaces an upstream error when the supervisor registry is unreachable', async () => {
    const { app, runtime } = createDashboardApp(makeConfig());
    runtime.start();
    try {
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/api/city/test-city/config`);
        // Unroutable supervisor -> the /v0/cities lookup fails, mapped to a
        // 502/504 upstream error. NEVER a silent fallback / 200.
        assert.ok(
          res.status === 502 || res.status === 504,
          `expected upstream error status, got ${res.status}`,
        );
      });
    } finally {
      await runtime.stop();
    }
  });
});
