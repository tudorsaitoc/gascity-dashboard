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
    // Caller aborts are AbortError, not TimeoutError; isTimeoutError must
    // distinguish so routes can map only true timeouts to HTTP 504.
    assert.equal((err as Error).name, 'AbortError');
    assert.equal(GcClient.isTimeoutError(err), false);
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

describe('GcClient error handling', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('non-ok upstream error message does not leak supervisor URL or topology', async () => {
    // gascity-dashboard-ais: routes forward fetchOnce's thrown
    // err.message verbatim into details.message of 502 responses. The
    // upstream URL exposes the supervisor port and city name, which is
    // topology leakage to the browser. The status code alone is enough
    // context; the route already discriminates with kind:'upstream'.
    fake.setHandler((_req, res) => {
      res.statusCode = 503;
      res.end('upstream down');
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'secret-city',
      defaultTimeoutMs: 5_000,
    });
    let err: unknown;
    try {
      await gc.listSessions();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, 'expected an Error rejection');
    const msg = (err as Error).message;
    // Positive: status is preserved for operator-facing debugging.
    assert.match(msg, /503/);
    assert.match(msg, /gc supervisor returned/);
    // Negative: nothing identifying the supervisor topology leaks.
    assert.doesNotMatch(msg, /http:\/\//, `message leaked URL scheme: ${msg}`);
    assert.doesNotMatch(msg, /127\.0\.0\.1/, `message leaked loopback address: ${msg}`);
    assert.doesNotMatch(msg, /\/city\//, `message leaked city path: ${msg}`);
    assert.doesNotMatch(msg, /secret-city/, `message leaked city name: ${msg}`);
  });
});

// gascity-dashboard-x82: GcClient.getStatus GETs /v0/city/{name}/status,
// the source of store_health.size_bytes for the dolt-noms trend sampler.
describe('GcClient.getStatus', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('GETs the city status endpoint and parses store_health', async () => {
    let method: string | undefined;
    let url: string | undefined;
    fake.setHandler((req, res) => {
      method = req.method;
      url = req.url;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          store_health: {
            size_bytes: 123_456,
            live_rows: 2139,
            ratio_mb_per_row: 0.05,
            last_gc_at: '2026-05-26T00:00:00Z',
          },
        }),
      );
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'test-city', defaultTimeoutMs: 5_000 });

    const out = await gc.getStatus();

    assert.equal(method, 'GET');
    assert.equal(url, '/v0/city/test-city/status');
    assert.equal(out.store_health?.size_bytes, 123_456);
    assert.equal(out.store_health?.live_rows, 2139);
  });

  test('non-2xx throws a redacted error (status only, no topology)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 503;
      res.end('upstream down');
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'secret-city', defaultTimeoutMs: 5_000 });
    let err: unknown;
    try {
      await gc.getStatus();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, 'expected an Error rejection');
    const msg = (err as Error).message;
    assert.match(msg, /503/);
    assert.match(msg, /gc supervisor returned/);
    assert.doesNotMatch(msg, /secret-city/, `message leaked city name: ${msg}`);
    assert.doesNotMatch(msg, /127\.0\.0\.1/, `message leaked loopback address: ${msg}`);
  });
});

// gascity-dashboard-mq2: GcClient.sling POSTs to the supervisor's write
// endpoint in place of the `gc sling` CLI subprocess.
describe('GcClient.sling', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('POSTs to the city sling endpoint with the CSRF header + JSON body, parses the response', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let csrf: string | undefined;
    let contentType: string | undefined;
    let bodyRaw = '';
    fake.setHandler((req, res) => {
      method = req.method;
      url = req.url;
      csrf = req.headers['x-gc-request'] as string | undefined;
      contentType = req.headers['content-type'] as string | undefined;
      req.on('data', (c) => (bodyRaw += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ root_bead_id: 'gc-900', target: 'mayor', status: 'ok' }));
      });
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'test-city', defaultTimeoutMs: 5_000 });

    const out = await gc.sling({ target: 'mayor', bead: 'Please review PR https://x/pull/1' });

    assert.equal(method, 'POST');
    assert.equal(url, '/v0/city/test-city/sling');
    // Anti-CSRF presence header — any non-empty value (the supervisor only
    // checks presence), so assert it's a non-empty string.
    assert.ok(csrf && csrf.length > 0, 'X-GC-Request header must be present');
    assert.match(contentType ?? '', /application\/json/);
    assert.deepEqual(JSON.parse(bodyRaw), {
      target: 'mayor',
      bead: 'Please review PR https://x/pull/1',
    });
    assert.equal(out.root_bead_id, 'gc-900');
  });

  test('non-2xx throws a redacted error (status only, no topology)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 502;
      res.end('boom');
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'secret-city', defaultTimeoutMs: 5_000 });
    let err: unknown;
    try {
      await gc.sling({ target: 'mayor', bead: 'x' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, 'expected an Error rejection');
    const msg = (err as Error).message;
    assert.match(msg, /502/);
    assert.doesNotMatch(msg, /secret-city/, `message leaked city name: ${msg}`);
    assert.doesNotMatch(msg, /127\.0\.0\.1/, `message leaked loopback address: ${msg}`);
  });
});

// gascity-dashboard-mq2: GcClient.updateBead PATCHes /bead/{id} (the canonical
// update verb per api-ops-design.md) in place of the `gc bd update` CLI
// subprocess (the bead-CLAIM path).
describe('GcClient.updateBead', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('PATCHes the city bead endpoint with the CSRF header + JSON body', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let csrf: string | undefined;
    let contentType: string | undefined;
    let bodyRaw = '';
    fake.setHandler((req, res) => {
      method = req.method;
      url = req.url;
      csrf = req.headers['x-gc-request'] as string | undefined;
      contentType = req.headers['content-type'] as string | undefined;
      req.on('data', (c) => (bodyRaw += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'test-city', defaultTimeoutMs: 5_000 });

    await gc.updateBead('td-wisp-abc123', { status: 'in_progress', assignee: 'stephanie' });

    assert.equal(method, 'PATCH');
    assert.equal(url, '/v0/city/test-city/bead/td-wisp-abc123');
    assert.ok(csrf && csrf.length > 0, 'X-GC-Request header must be present');
    assert.match(contentType ?? '', /application\/json/);
    assert.deepEqual(JSON.parse(bodyRaw), {
      status: 'in_progress',
      assignee: 'stephanie',
    });
  });

  test('URL-encodes the bead id in the path', async () => {
    let url: string | undefined;
    fake.setHandler((req, res) => {
      url = req.url;
      req.on('data', () => {});
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'test-city', defaultTimeoutMs: 5_000 });
    await gc.updateBead('gc-1/2', { status: 'in_progress' });
    assert.equal(url, '/v0/city/test-city/bead/gc-1%2F2');
  });

  test('non-2xx throws a redacted error (status only, no topology)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 502;
      res.end('boom');
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'secret-city', defaultTimeoutMs: 5_000 });
    let err: unknown;
    try {
      await gc.updateBead('td-wisp-abc123', { status: 'in_progress' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, 'expected an Error rejection');
    const msg = (err as Error).message;
    assert.match(msg, /502/);
    assert.doesNotMatch(msg, /secret-city/, `message leaked city name: ${msg}`);
    assert.doesNotMatch(msg, /127\.0\.0\.1/, `message leaked loopback address: ${msg}`);
  });
});

// gascity-dashboard-mq2: GcClient.sendMail POSTs to /mail in place of the
// `gc mail send` CLI subprocess. The supervisor returns 201 with the created
// Message; the caller reads `id` off the response.
describe('GcClient.sendMail', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('POSTs to the city mail endpoint with the CSRF header + JSON body, parses the 201 Message', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let csrf: string | undefined;
    let contentType: string | undefined;
    let bodyRaw = '';
    fake.setHandler((req, res) => {
      method = req.method;
      url = req.url;
      csrf = req.headers['x-gc-request'] as string | undefined;
      contentType = req.headers['content-type'] as string | undefined;
      req.on('data', (c) => (bodyRaw += c));
      req.on('end', () => {
        // Supervisor returns 201 Created on mail send.
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'td-wisp-xyz789',
            from: 'human',
            to: 'mayor',
            subject: 'status',
            body: 'all green',
            created_at: '2026-05-26T00:00:00Z',
            read: false,
          }),
        );
      });
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'test-city', defaultTimeoutMs: 5_000 });

    const out = await gc.sendMail({ to: 'mayor', subject: 'status', body: 'all green', from: 'human' });

    assert.equal(method, 'POST');
    assert.equal(url, '/v0/city/test-city/mail');
    assert.ok(csrf && csrf.length > 0, 'X-GC-Request header must be present');
    assert.match(contentType ?? '', /application\/json/);
    assert.deepEqual(JSON.parse(bodyRaw), {
      to: 'mayor',
      subject: 'status',
      body: 'all green',
      from: 'human',
    });
    assert.equal(out.id, 'td-wisp-xyz789');
  });

  test('non-2xx throws a redacted error (status only, no topology)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 502;
      res.end('boom');
    });
    const gc = new GcClient({ baseUrl: fake.baseUrl, cityName: 'secret-city', defaultTimeoutMs: 5_000 });
    let err: unknown;
    try {
      await gc.sendMail({ to: 'mayor', subject: 'x', body: 'y', from: 'human' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, 'expected an Error rejection');
    const msg = (err as Error).message;
    assert.match(msg, /502/);
    assert.doesNotMatch(msg, /secret-city/, `message leaked city name: ${msg}`);
    assert.doesNotMatch(msg, /127\.0\.0\.1/, `message leaked loopback address: ${msg}`);
  });
});
