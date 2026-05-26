import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eventsRouter } from '../src/routes/events.js';

// gascity-dashboard-iew: backend-side SSE proxy so the browser doesn't
// need to reach the supervisor's loopback directly. Tests cover: byte
// pipe (event framing preserved), Last-Event-ID / ?after= resume,
// upstream-unreachable / non-200, and client-disconnect cleanup.

interface FakeSse {
  baseUrl: string;
  /** Last request the fake received. */
  lastRequest: { url: string; headers: http.IncomingHttpHeaders } | null;
  /** Replace the request handler. */
  setHandler(h: (req: http.IncomingMessage, res: http.ServerResponse) => void): void;
  /** Count of currently-connected upstream clients (after handler ran). */
  liveConnections(): number;
  close(): Promise<void>;
}

function startFakeSse(): Promise<FakeSse> {
  return new Promise((resolve) => {
    const sockets = new Set<import('node:net').Socket>();
    let live = 0;
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (
      _req,
      res,
    ) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write('event: event\ndata: {"type":"hello"}\nid: 1\n\n');
      // hold open until client disconnects
    };
    const fake: Partial<FakeSse> = { lastRequest: null };
    const server = http.createServer((req, res) => {
      fake.lastRequest = { url: req.url ?? '', headers: req.headers };
      live++;
      res.on('close', () => {
        live--;
      });
      handler(req, res);
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      Object.assign(fake, {
        baseUrl: `http://127.0.0.1:${port}`,
        setHandler(h: typeof handler) {
          handler = h;
        },
        liveConnections() {
          return live;
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
      resolve(fake as FakeSse);
    });
  });
}

function buildApp(supervisorUrl: string): express.Express {
  const app = express();
  app.use('/api/events', eventsRouter({ supervisorUrl, cityName: 'test', heartbeatMs: 60_000 }));
  return app;
}

function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<import('node:net').Socket>();
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise<void>((r) => srv.close(() => r()));
        },
      });
    });
    srv.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
  });
}

/** Read at least `minBytes` bytes from a streaming Response body, then return as text. */
async function readSome(
  res: globalThis.Response,
  minBytes: number,
  timeoutMs: number,
): Promise<string> {
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (acc.length < minBytes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timer = new Promise<{ value?: undefined; done: true }>((r) =>
      setTimeout(() => r({ done: true }), remaining),
    );
    const next = await Promise.race([reader.read(), timer]);
    if (next.done || !next.value) break;
    acc += decoder.decode(next.value, { stream: true });
  }
  try {
    reader.releaseLock();
  } catch {
    // ignore
  }
  return acc;
}

describe('events proxy: GET /api/events/stream', () => {
  let fake: FakeSse;
  beforeEach(async () => {
    fake = await startFakeSse();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('pipes SSE bytes verbatim from upstream to client', async () => {
    const app = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/events/stream`, { signal: ctrl.signal });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const body = await readSome(res, 40, 1_000);
      ctrl.abort();
      assert.match(body, /event: event/);
      assert.match(body, /data: \{"type":"hello"\}/);
      assert.match(body, /id: 1/);
    } finally {
      await close();
    }
  });

  test('opens the browser-facing stream before quiet upstream sends an event', async () => {
    fake.setHandler((_req, _res) => {
      // Hold the upstream request open without flushing headers. The browser
      // EventSource should still leave CONNECTING because the dashboard proxy
      // owns the client-facing stream lifecycle.
    });
    const app = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/events/stream`, { signal: ctrl.signal });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const body = await readSome(res, 3, 1_000);
      assert.equal(body, ':\n\n');
      const deadline = Date.now() + 1_000;
      while (!fake.lastRequest && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      ctrl.abort();
      assert.ok(fake.lastRequest, 'upstream connection should be attempted');
    } finally {
      await close();
    }
  });

  test('forwards Last-Event-ID header as ?after= upstream', async () => {
    const app = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/events/stream`, {
        headers: { 'Last-Event-ID': '42' },
        signal: ctrl.signal,
      });
      await readSome(res, 10, 1_000);
      ctrl.abort();
      assert.ok(fake.lastRequest, 'fake received no upstream request');
      assert.match(fake.lastRequest.url, /[?&]after=42(?:$|&)/);
    } finally {
      await close();
    }
  });

  test('forwards ?after= query as ?after= upstream', async () => {
    const app = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/events/stream?after=99`, { signal: ctrl.signal });
      await readSome(res, 10, 1_000);
      ctrl.abort();
      assert.match(fake.lastRequest?.url ?? '', /[?&]after=99(?:$|&)/);
    } finally {
      await close();
    }
  });

  test('emits an SSE error event when upstream is unreachable after stream open', async () => {
    const app = buildApp('http://127.0.0.1:1');
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/events/stream`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const body = await res.text();
      assert.match(body, /event: error/);
      assert.match(body, /gc supervisor SSE upstream unreachable/);
    } finally {
      await close();
    }
  });

  test('emits an SSE error event when upstream returns non-200 after stream open', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('broken');
    });
    const app = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/events/stream`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const body = await res.text();
      assert.match(body, /event: error/);
      assert.match(body, /gc supervisor returned 500/);
    } finally {
      await close();
    }
  });

  test('client disconnect aborts upstream', async () => {
    const app = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/events/stream`, { signal: ctrl.signal });
      await readSome(res, 10, 1_000);
      assert.ok(fake.liveConnections() >= 1, 'upstream connection should be open');
      ctrl.abort();
      // Give the proxy a moment to propagate abort.
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && fake.liveConnections() > 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(fake.liveConnections(), 0, 'upstream should be closed after client disconnect');
    } finally {
      await close();
    }
  });
});
