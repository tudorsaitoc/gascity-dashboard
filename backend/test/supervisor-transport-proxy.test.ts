import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';

import { supervisorTransportProxy } from '../src/routes/supervisor-transport-proxy.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface RunningServer {
  url: string;
  close(): Promise<void>;
}

describe('supervisor transport proxy', () => {
  let upstreamRequests: string[];
  let upstream: RunningServer;

  beforeEach(async () => {
    upstreamRequests = [];
    upstream = await startServer((req, res) => {
      upstreamRequests.push(req.url ?? '');
      res.statusCode = 207;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-gc-request-id', 'req-123');
      res.end('{"transport":"only","items":null}');
    });
  });

  afterEach(async () => {
    await upstream.close();
  });

  test('forwards supervisor v0 traffic byte-for-byte without owning DTO shape', async () => {
    const app = express();
    app.use('/gc-supervisor', supervisorTransportProxy(upstream.url));
    const dashboard = await startExpress(app);
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/cities?limit=1`, {
        headers: { accept: 'application/json' },
      });

      assert.equal(res.status, 207);
      assert.equal(res.headers.get('x-gc-request-id'), 'req-123');
      assert.equal(await res.text(), '{"transport":"only","items":null}');
      assert.deepEqual(upstreamRequests, ['/v0/cities?limit=1']);
    } finally {
      await dashboard.close();
    }
  });

  test('forwards supervisor health without colliding with the dashboard /health route', async () => {
    const app = express();
    app.use('/gc-supervisor', supervisorTransportProxy(upstream.url));
    const dashboard = await startExpress(app);
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/health`);

      assert.equal(res.status, 207);
      assert.deepEqual(upstreamRequests, ['/health']);
    } finally {
      await dashboard.close();
    }
  });

  test('rejects paths outside the supervisor HTTP API surface', async () => {
    const app = express();
    app.use('/gc-supervisor', supervisorTransportProxy(upstream.url));
    const dashboard = await startExpress(app);
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/admin`);

      assert.equal(res.status, 404);
      assert.deepEqual(upstreamRequests, []);
    } finally {
      await dashboard.close();
    }
  });
});

interface UpstreamCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

describe('supervisor transport proxy — read-only mode (DASHBOARD_READONLY=1)', () => {
  let calls: UpstreamCall[];
  let upstream: RunningServer;

  beforeEach(async () => {
    calls = [];
    upstream = await startServer((req, res) => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });

  afterEach(async () => {
    await upstream.close();
  });

  function readOnlyDashboard(): Promise<RunningServer> {
    const app = express();
    app.use('/gc-supervisor', supervisorTransportProxy(upstream.url, true));
    return startExpress(app);
  }

  test('rejects a mutation (POST sling carrying X-GC-Request) with 405, never forwarding it', async () => {
    const dashboard = await readOnlyDashboard();
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/sling`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gc-request': 'dashboard' },
        body: '{"target":"mayor"}',
      });

      assert.equal(res.status, 405);
      // RFC 9110 §15.5.6: a 405 advertises the supported methods.
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
      assert.deepEqual(calls, []);
    } finally {
      await dashboard.close();
    }
  });

  test('forwards an allowlisted HEAD read as HEAD', async () => {
    const dashboard = await readOnlyDashboard();
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/beads`, {
        method: 'HEAD',
      });

      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.method, 'HEAD');
      assert.equal(call.url, '/v0/city/test-city/beads');
    } finally {
      await dashboard.close();
    }
  });

  test('rejects a `..` traversal read with 404, never forwarding it upstream', async () => {
    // Sent over a raw socket so the `..` survives to the server — fetch/new URL
    // would collapse it client-side before the request leaves. The proxy must
    // reject it (404) instead of forwarding the resolved GLOBAL cross-city
    // stream `/v0/events/stream`.
    const dashboard = await readOnlyDashboard();
    try {
      const res = await rawGet(dashboard.url, '/gc-supervisor/v0/city/../events/stream');

      assert.equal(res.statusCode, 404);
      assert.deepEqual(calls, []);
    } finally {
      await dashboard.close();
    }
  });

  // The literal `..` above was closed once, but the bypass survived in
  // percent-encoded form: Express 4 leaves `%2e` undecoded in `req.path`, so a
  // `req.path`-based guard misses it, while `new URL(req.url, base)` decodes
  // `%2e` → `.` and resolves to the GLOBAL `/v0/events/stream`. These raw-socket
  // cases drive the exact path where `new URL` runs and assert nothing reaches
  // upstream. Each variant decodes to `/v0/city/../events/stream`.
  for (const encoded of [
    '%2e%2e', // lowercase
    '%2E%2E', // uppercase
    '.%2e', // mixed literal + encoded
    '%2e.', // mixed encoded + literal
  ]) {
    test(`rejects encoded traversal (${encoded}) with 404, never forwarding upstream`, async () => {
      const dashboard = await readOnlyDashboard();
      try {
        const res = await rawGet(dashboard.url, `/gc-supervisor/v0/city/${encoded}/events/stream`);

        assert.equal(res.statusCode, 404, `expected 404 for ${encoded}`);
        assert.deepEqual(calls, [], `expected zero upstream calls for ${encoded}`);
      } finally {
        await dashboard.close();
      }
    });
  }

  test('rejects an authority-bearing target (//host) instead of proxying a foreign origin', async () => {
    // `new URL('//evil.example/...', base)` retargets at evil.example; the proxy
    // must pin the supervisor origin and 404 rather than make the request.
    const dashboard = await readOnlyDashboard();
    try {
      const res = await rawGet(
        dashboard.url,
        '/gc-supervisor//evil.example/v0/city/test-city/beads',
      );

      assert.equal(res.statusCode, 404);
      assert.deepEqual(calls, []);
    } finally {
      await dashboard.close();
    }
  });

  test('rejects an absolute-URL request target (foreign origin) instead of proxying it', async () => {
    // Absolute-form request target (`GET http://evil.example/gc-supervisor/... HTTP/1.1`):
    // Express matches the mount on its pathname, so the router sees
    // `req.url === 'http://evil.example/v0/city/test-city/beads'`, and
    // `new URL(req.url, base)` resolves to the evil.example origin. The origin
    // pin must 404 rather than forward to a foreign host. Locked in CI.
    const dashboard = await readOnlyDashboard();
    try {
      const res = await rawGet(
        dashboard.url,
        'http://evil.example/gc-supervisor/v0/city/test-city/beads',
      );

      assert.equal(res.statusCode, 404);
      assert.deepEqual(calls, []);
    } finally {
      await dashboard.close();
    }
  });

  test('forwards an allowlisted read but strips the write-authorizing headers', async () => {
    const dashboard = await readOnlyDashboard();
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/beads`, {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-gc-request': 'dashboard',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.method, 'GET');
      assert.equal(call.url, '/v0/city/test-city/beads');
      assert.equal(call.headers['x-gc-request'], undefined);
      assert.equal(call.headers['content-type'], undefined);
    } finally {
      await dashboard.close();
    }
  });

  test('default-denies a non-allowlisted read (the side-effecting agent prime GET) with 404', async () => {
    const dashboard = await readOnlyDashboard();
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/agent/mayor/prime`);

      assert.equal(res.status, 404);
      assert.deepEqual(calls, []);
    } finally {
      await dashboard.close();
    }
  });

  test('keeps both SSE streams (city events + session) on the read allowlist', async () => {
    const dashboard = await readOnlyDashboard();
    try {
      const events = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/events/stream`);
      const session = await fetch(
        `${dashboard.url}/gc-supervisor/v0/city/test-city/session/s1/stream`,
      );

      assert.equal(events.status, 200);
      assert.equal(session.status, 200);
      assert.deepEqual(
        calls.map((c) => c.url),
        ['/v0/city/test-city/events/stream', '/v0/city/test-city/session/s1/stream'],
      );
    } finally {
      await dashboard.close();
    }
  });

  test('still preserves the read query string when forwarding', async () => {
    const dashboard = await readOnlyDashboard();
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/beads?limit=5`);

      assert.equal(res.status, 200);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.url, '/v0/city/test-city/beads?limit=5');
    } finally {
      await dashboard.close();
    }
  });
});

describe('supervisor transport proxy — default (read/write) mode', () => {
  let calls: UpstreamCall[];
  let upstream: RunningServer;

  beforeEach(async () => {
    calls = [];
    upstream = await startServer((req, res) => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.statusCode = 200;
      res.end('{"ok":true}');
    });
  });

  afterEach(async () => {
    await upstream.close();
  });

  test('forwards a mutation and preserves X-GC-Request so local writes still work', async () => {
    const app = express();
    app.use('/gc-supervisor', supervisorTransportProxy(upstream.url));
    const dashboard = await startExpress(app);
    try {
      const res = await fetch(`${dashboard.url}/gc-supervisor/v0/city/test-city/sling`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gc-request': 'dashboard' },
        body: '{"target":"mayor"}',
      });

      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['x-gc-request'], 'dashboard');
    } finally {
      await dashboard.close();
    }
  });
});

test('direct supervisor boundary keeps city discovery out of dashboard /api routes', async () => {
  const appSource = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(appSource, /app\.get\(['"`]\/api\/cities['"`]/);
  assert.match(appSource, /supervisorTransportProxy/);
  assert.match(appSource, /\/gc-supervisor/);
});

// Issue a GET with a literal, un-normalized request target (preserving `..`),
// which fetch() / new URL() would otherwise collapse before sending.
function rawGet(baseUrl: string, path: string): Promise<{ statusCode: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function startServer(handler: Handler): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => resolve(serverHandle(server)));
  });
}

function startExpress(app: express.Express): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(serverHandle(server)));
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
