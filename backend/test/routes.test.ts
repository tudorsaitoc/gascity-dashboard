import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { GcClient } from '../src/gc-client.js';
import { sessionsRouter } from '../src/routes/sessions.js';
import { beadsRouter } from '../src/routes/beads.js';
import { mailRouter } from '../src/routes/mail.js';
import { healthRouter, resolveHealthTimeoutMs } from '../src/routes/health.js';

// End-to-end test that the timeout-aware GcClient + the routes' 504
// translation produce the right wire response when the upstream supervisor
// hangs. This is the user-visible contract for gascity-dashboard-kz8:
// dashboard surfaces a fast, classifiable failure instead of a >10s hang.

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

interface Fake {
  baseUrl: string;
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

function startFake(): Promise<Fake> {
  return new Promise((resolve) => {
    let handler: Handler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [] }));
    };
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((_req, res) => handler(_req, res));
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setHandler(h: Handler) {
          handler = h;
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

function buildApp(fakeUrl: string): { app: express.Express } {
  const gc = new GcClient({
    baseUrl: fakeUrl,
    cityName: 'test',
    defaultTimeoutMs: 100,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter(gc));
  app.use('/api/beads', beadsRouter(gc));
  app.use('/api/mail', mailRouter(gc));
  app.use('/api/system', healthRouter(gc, { supervisorTimeoutMs: 100 }));
  return { app };
}

async function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
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

describe('routes: upstream timeout -> HTTP 504', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('GET /api/sessions returns 504 with upstream-timeout kind when supervisor hangs', async () => {
    fake.setHandler(() => {
      /* never respond */
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const start = Date.now();
      const res = await fetch(`${url}/api/sessions`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 504);
      assert.ok(elapsed < 1000, `expected fast 504, got ${elapsed}ms`);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream-timeout');
    } finally {
      await close();
    }
  });

  test('GET /api/beads returns 504 with upstream-timeout kind when supervisor hangs', async () => {
    fake.setHandler(() => {
      /* never respond */
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const start = Date.now();
      const res = await fetch(`${url}/api/beads`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 504);
      assert.ok(elapsed < 1000, `expected fast 504, got ${elapsed}ms`);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream-timeout');
    } finally {
      await close();
    }
  });

  test('GET /api/sessions returns 502 for non-timeout upstream errors', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/sessions`);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream');
    } finally {
      await close();
    }
  });

  test('GET /api/mail returns 504 with upstream-timeout kind when supervisor hangs', async () => {
    fake.setHandler(() => {
      /* never respond */
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const start = Date.now();
      const res = await fetch(`${url}/api/mail?alias=stephanie&box=inbox`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 504);
      assert.ok(elapsed < 1000, `expected fast 504, got ${elapsed}ms`);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream-timeout');
    } finally {
      await close();
    }
  });

  test('GET /api/mail/threads/:id returns 504 with upstream-timeout kind when supervisor hangs', async () => {
    fake.setHandler(() => {
      /* never respond */
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const start = Date.now();
      const res = await fetch(`${url}/api/mail/threads/abc?alias=stephanie`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 504);
      assert.ok(elapsed < 1000, `expected fast 504, got ${elapsed}ms`);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream-timeout');
    } finally {
      await close();
    }
  });

  test('GET /api/mail returns 502 for non-timeout upstream errors', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/mail`);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream');
    } finally {
      await close();
    }
  });

  test('GET /api/system/system returns 504 with upstream-timeout kind when supervisor /health hangs', async () => {
    fake.setHandler(() => {
      /* never respond */
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const start = Date.now();
      const res = await fetch(`${url}/api/system/system`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 504);
      assert.ok(elapsed < 1000, `expected fast 504, got ${elapsed}ms`);
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream-timeout');
    } finally {
      await close();
    }
  });

  test('GET /api/system/system returns 200 with supervisor=null when supervisor returns non-OK', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('broken');
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/system/system`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { supervisor: unknown };
      assert.equal(body.supervisor, null);
    } finally {
      await close();
    }
  });

  test('GET /api/sessions returns 200 with items on success', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 'td-foo' }] }));
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/sessions`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: { id: string }[] };
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0]?.id, 'td-foo');
    } finally {
      await close();
    }
  });
});

describe('resolveHealthTimeoutMs', () => {
  const ORIGINAL = process.env.GC_HEALTH_TIMEOUT_MS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GC_HEALTH_TIMEOUT_MS;
    else process.env.GC_HEALTH_TIMEOUT_MS = ORIGINAL;
  });

  test('falls back to 2500ms when env var is unset', () => {
    delete process.env.GC_HEALTH_TIMEOUT_MS;
    assert.equal(resolveHealthTimeoutMs(), 2_500);
  });

  test('honors a positive integer env var', () => {
    process.env.GC_HEALTH_TIMEOUT_MS = '7500';
    assert.equal(resolveHealthTimeoutMs(), 7_500);
  });

  test('falls back when env var is non-numeric', () => {
    process.env.GC_HEALTH_TIMEOUT_MS = 'not-a-number';
    assert.equal(resolveHealthTimeoutMs(), 2_500);
  });

  test('falls back when env var is zero or negative (typo guard)', () => {
    process.env.GC_HEALTH_TIMEOUT_MS = '0';
    assert.equal(resolveHealthTimeoutMs(), 2_500);
    process.env.GC_HEALTH_TIMEOUT_MS = '-1';
    assert.equal(resolveHealthTimeoutMs(), 2_500);
  });

  test('clamps oversize values to MAX_HEALTH_TIMEOUT_MS (typo guard)', () => {
    // A typo like '99999999999' would otherwise hold the health route open
    // for hours. Cap at 30s.
    process.env.GC_HEALTH_TIMEOUT_MS = '99999999999';
    assert.equal(resolveHealthTimeoutMs(), 30_000);
    // Exact ceiling passes through.
    process.env.GC_HEALTH_TIMEOUT_MS = '30000';
    assert.equal(resolveHealthTimeoutMs(), 30_000);
    // Just under ceiling passes through unchanged.
    process.env.GC_HEALTH_TIMEOUT_MS = '29999';
    assert.equal(resolveHealthTimeoutMs(), 29_999);
  });
});
