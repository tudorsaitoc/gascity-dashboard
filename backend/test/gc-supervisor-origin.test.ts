import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import type { Express } from 'express';
import { createDashboardApp } from '../src/app.js';
import type { AdminConfig } from '../src/config.js';

interface RunningServer {
  url: string;
  close(): Promise<void>;
}

interface UpstreamRequest {
  method: string | undefined;
  url: string | undefined;
  origin: string | string[] | undefined;
}

function makeConfig(supervisorUrl: string): AdminConfig {
  return {
    port: 8081,
    bindHost: '127.0.0.1',
    extraAllowedHosts: [],
    gcSupervisorUrl: supervisorUrl,
    cityName: 'test-city',
    cityPath: '',
    runCwdAllowedRoots: [],
    auditLogPath: '.gc/events.jsonl',
    frontendDistPath: '../frontend/dist-does-not-exist',
    disabled: false,
    readOnly: false,
    operatorAlias: 'operator',
    operatorWireAlias: 'human',
    decisionLabel: 'needs/operator',
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
  };
}

describe('/gc-supervisor origin protection', () => {
  test('rejects forged-Origin writes before the transport proxy can forward them', async () => {
    const upstreamRequests: UpstreamRequest[] = [];
    const upstream = await startSupervisor(upstreamRequests);
    const { app, runtime } = createDashboardApp(makeConfig(upstream.url));
    runtime.start();
    try {
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/gc-supervisor/v0/city/test-city/bead/td-1/close`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://evil.com',
          },
          body: JSON.stringify({ reason: 'done' }),
        });

        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), {
          error: 'Origin not allowed',
          kind: 'origin',
        });
        assert.deepEqual(upstreamRequests, []);
      });
    } finally {
      await runtime.stop();
      await upstream.close();
    }
  });

  test('allows same-origin supervisor writes and strips the Origin before proxying', async () => {
    const upstreamRequests: UpstreamRequest[] = [];
    const upstream = await startSupervisor(upstreamRequests);
    const { app, runtime } = createDashboardApp(makeConfig(upstream.url));
    runtime.start();
    try {
      await withApp(app, async (url) => {
        const res = await fetch(`${url}/gc-supervisor/v0/city/test-city/bead/td-1/close`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://127.0.0.1:8081',
          },
          body: JSON.stringify({ reason: 'done' }),
        });

        assert.equal(res.status, 202);
        assert.deepEqual(await res.json(), { ok: true });
        assert.deepEqual(upstreamRequests, [
          {
            method: 'POST',
            url: '/v0/city/test-city/bead/td-1/close',
            origin: undefined,
          },
        ]);
      });
    } finally {
      await runtime.stop();
      await upstream.close();
    }
  });
});

function startSupervisor(requests: UpstreamRequest[]): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        origin: req.headers.origin,
      });
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1', () => resolve(serverHandle(server)));
  });
}

function withApp<T>(app: Express, fn: (url: string) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      void fn(`http://127.0.0.1:${port}`).then(
        (value) => {
          server.close(() => resolve(value));
        },
        (err: unknown) => {
          server.close(() => reject(err));
        },
      );
    });
  });
}

function serverHandle(server: Server): RunningServer {
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
