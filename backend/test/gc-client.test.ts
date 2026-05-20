import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GcClient } from '../src/gc-client.js';

// Spin up an in-process fake supervisor so we test real timeout / coalescing
// behavior against a real fetch — no http mocks.
type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

interface Fake {
  server: http.Server;
  baseUrl: string;
  hits: number;
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
    let hits = 0;
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => {
      hits += 1;
      handler(req, res);
    });
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        get hits() {
          return hits;
        },
        setHandler(h: Handler) {
          handler = h;
        },
        close() {
          // Force-destroy any open sockets so server.close() can resolve
          // even when a test handler never sent a response.
          for (const s of sockets) s.destroy();
          return new Promise<void>((r) => server.close(() => r()));
        },
      } as Fake);
    });
  });
}

describe('GcClient timeout', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('aborts upstream call that exceeds default timeout', async () => {
    // Handler that never responds — the request would hang forever
    // without a client-side timeout.
    fake.setHandler(() => {
      /* no response, no end */
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 150,
    });
    const start = Date.now();
    let err: unknown;
    try {
      await gc.listSessions();
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    assert.ok(err, 'expected a rejection');
    assert.ok(elapsed < 1000, `expected fast abort, got ${elapsed}ms`);
    // The error should be classifiable as a timeout.
    assert.equal(GcClient.isTimeoutError(err), true);
  });

  test('respects per-call signal that aborts before default timeout', async () => {
    fake.setHandler(() => {
      /* never respond */
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 60_000,
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    let err: unknown;
    try {
      await gc.listSessions(ctl.signal);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected a rejection');
    assert.equal(GcClient.isTimeoutError(err), true);
  });

  test('passes through normal responses', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 'td-abc' }], total: 1 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listBeads(undefined, { limit: 10 });
    assert.equal(out.items.length, 1);
    assert.equal(out.total, 1);
  });
});

describe('GcClient request coalescing', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('collapses concurrent identical requests into one upstream call', async () => {
    let pending: ((value: void) => void) | null = null;
    fake.setHandler((_req, res) => {
      // Hold the response until we release it, so all concurrent
      // callers are in-flight at the same time.
      const release = () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ items: [] }));
      };
      if (pending) {
        // Subsequent hits should NOT happen if coalescing works.
        release();
      } else {
        pending = () => release();
        setTimeout(() => pending && pending(), 50);
      }
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const results = await Promise.all([
      gc.listSessions(),
      gc.listSessions(),
      gc.listSessions(),
    ]);
    assert.equal(results.length, 3);
    assert.equal(fake.hits, 1, `expected 1 upstream hit, got ${fake.hits}`);
  });

  test('does not coalesce requests with different params', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [], total: 0 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await Promise.all([
      gc.listBeads(undefined, { limit: 10 }),
      gc.listBeads(undefined, { limit: 20 }),
    ]);
    assert.equal(fake.hits, 2);
  });

  test('coalesced callers all see the failure when upstream errors', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const results = await Promise.allSettled([
      gc.listSessions(),
      gc.listSessions(),
    ]);
    assert.equal(results[0]?.status, 'rejected');
    assert.equal(results[1]?.status, 'rejected');
    assert.equal(fake.hits, 1);
  });

  test('releases coalesced slot after settle so the next call hits upstream', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await gc.listSessions();
    await gc.listSessions();
    assert.equal(fake.hits, 2);
  });
});
