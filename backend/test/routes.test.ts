import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { GcClient } from '../src/gc-client.js';
import { sessionsRouter, resolveSessionsTimeoutMs } from '../src/routes/sessions.js';
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
  app.use('/api/beads', beadsRouter(gc, '/home/test/gas-city'));
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

  // gascity-dashboard-sr6: the 502 response must not include raw err.message.
  // Pre-existing leak: fetch-level failures (ECONNREFUSED, DNS errors) carry
  // OS-level detail (interface names, file paths, ports) in their message,
  // and forwarding that verbatim to the browser is a topology leak. The
  // GcClient-classified `gc supervisor returned <status>` shape is the only
  // safe shape; everything else must be redacted to a classification only.
  test('GET /api/sessions 502 redacts raw err.message from response body', async () => {
    // Point the GcClient at an unreachable port so fetch fails with an
    // ECONNREFUSED-shaped error whose `.message` carries OS detail
    // (interface names, ports, file paths depending on platform).
    const gc = new GcClient({
      baseUrl: 'http://127.0.0.1:1',
      cityName: 'test',
      defaultTimeoutMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter(gc, { sessionsTimeoutMs: 500 }));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/sessions`);
      assert.equal(res.status, 502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        kind?: string;
        details?: Record<string, string>;
      };
      assert.equal(body.kind, 'upstream');
      // The contract: details may carry a classification (err.name) but
      // never the raw err.message. ECONNREFUSED messages typically include
      // "ECONNREFUSED" plus host/port; assert none of those slip through.
      assert.equal(
        body.details?.message,
        undefined,
        'details.message must be redacted',
      );
      assert.ok(
        !text.includes('ECONNREFUSED'),
        `response leaks ECONNREFUSED: ${text}`,
      );
      assert.ok(
        !text.includes('127.0.0.1:1'),
        `response leaks upstream host:port: ${text}`,
      );
    } finally {
      await close();
    }
  });

  // Same redaction contract as the GET handler above. Peek uses the same
  // GcClient.fetchOnce path, so the same OS-detail leak applies. Surfaced
  // by the Phase 4 unified review on wave-p3p4-cleanup-review (security
  // HIGH escalation; not part of the original sr6 scope but fixed in-wave
  // because the bead description called for the broader sweep to be filed
  // as a sibling — peek is the same-file twin and the fix is a one-liner).
  test('POST /api/sessions/:id/peek 502 redacts raw err.message from response body', async () => {
    const gc = new GcClient({
      baseUrl: 'http://127.0.0.1:1',
      cityName: 'test',
      defaultTimeoutMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter(gc, { sessionsTimeoutMs: 500 }));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/sessions/gc-session-b/peek`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        kind?: string;
        details?: Record<string, string>;
      };
      assert.equal(body.kind, 'upstream');
      assert.equal(
        body.details?.message,
        undefined,
        'details.message must be redacted',
      );
      assert.ok(
        !text.includes('ECONNREFUSED'),
        `response leaks ECONNREFUSED: ${text}`,
      );
      assert.ok(
        !text.includes('127.0.0.1:1'),
        `response leaks upstream host:port: ${text}`,
      );
    } finally {
      await close();
    }
  });

  // gascity-dashboard-ayr: extend the sr6 redaction contract across the
  // remaining 5xx surfaces. Same rationale as the sessions tests above —
  // fetch-level failures (ECONNREFUSED, DNS) carry OS detail in
  // err.message and that must not reach the browser, even on a
  // 127.0.0.1-only deployment. details.name (Error class only) is the
  // single safe channel; server-side log retains full err.message.
  test('GET /api/mail 502 redacts raw err.message from response body', async () => {
    const gc = new GcClient({
      baseUrl: 'http://127.0.0.1:1',
      cityName: 'test',
      defaultTimeoutMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRouter(gc));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/mail?alias=stephanie&box=inbox`);
      assert.equal(res.status, 502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        kind?: string;
        details?: Record<string, string>;
      };
      assert.equal(body.kind, 'upstream');
      assert.equal(
        body.details?.message,
        undefined,
        'details.message must be redacted',
      );
      assert.ok(
        !text.includes('ECONNREFUSED'),
        `response leaks ECONNREFUSED: ${text}`,
      );
      assert.ok(
        !text.includes('127.0.0.1:1'),
        `response leaks upstream host:port: ${text}`,
      );
    } finally {
      await close();
    }
  });

  test('GET /api/mail/threads/:id 502 redacts raw err.message from response body', async () => {
    const gc = new GcClient({
      baseUrl: 'http://127.0.0.1:1',
      cityName: 'test',
      defaultTimeoutMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRouter(gc));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/mail/threads/abc?alias=stephanie`);
      assert.equal(res.status, 502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        kind?: string;
        details?: Record<string, string>;
      };
      assert.equal(body.kind, 'upstream');
      assert.equal(
        body.details?.message,
        undefined,
        'details.message must be redacted',
      );
      assert.ok(
        !text.includes('ECONNREFUSED'),
        `response leaks ECONNREFUSED: ${text}`,
      );
      assert.ok(
        !text.includes('127.0.0.1:1'),
        `response leaks upstream host:port: ${text}`,
      );
    } finally {
      await close();
    }
  });

  test('GET /api/beads 502 redacts raw err.message from response body', async () => {
    const gc = new GcClient({
      baseUrl: 'http://127.0.0.1:1',
      cityName: 'test',
      defaultTimeoutMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/beads', beadsRouter(gc, '/home/test/gas-city'));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/beads`);
      assert.equal(res.status, 502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        kind?: string;
        details?: Record<string, string>;
      };
      assert.equal(body.kind, 'upstream');
      assert.equal(
        body.details?.message,
        undefined,
        'details.message must be redacted',
      );
      assert.ok(
        !text.includes('ECONNREFUSED'),
        `response leaks ECONNREFUSED: ${text}`,
      );
      assert.ok(
        !text.includes('127.0.0.1:1'),
        `response leaks upstream host:port: ${text}`,
      );
    } finally {
      await close();
    }
  });

  test('GET /api/beads/:id 502 redacts raw err.message from response body', async () => {
    // Single-bead fallback path: on a fetch-level failure (not the 404
    // branch), the route emits the same details.message leak before the
    // ayr fix. id matches BEAD_ID_RE so the validation gate passes.
    const gc = new GcClient({
      baseUrl: 'http://127.0.0.1:1',
      cityName: 'test',
      defaultTimeoutMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/beads', beadsRouter(gc, '/home/test/gas-city'));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/beads/td-abcdef`);
      assert.equal(res.status, 502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        kind?: string;
        details?: Record<string, string>;
      };
      assert.equal(body.kind, 'upstream');
      assert.equal(
        body.details?.message,
        undefined,
        'details.message must be redacted',
      );
      assert.ok(
        !text.includes('ECONNREFUSED'),
        `response leaks ECONNREFUSED: ${text}`,
      );
      assert.ok(
        !text.includes('127.0.0.1:1'),
        `response leaks upstream host:port: ${text}`,
      );
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

  test('GET /api/mail inbox for the operator (stephanie) resolves to the wire alias `human`', async () => {
    // gc addresses the human operator as `human`; the dashboard accounts
    // for her as `stephanie`. A naive `to === stephanie` filter returns
    // nothing. The route must map the display alias to the wire alias so
    // the operator's own inbox populates (gascity-dashboard-1ik).
    const corpus = [
      { id: 'a', from: 'agent-x', to: 'human', subject: 's1', body: 'b1', created_at: '2026-05-23T10:00:00Z', read: false },
      { id: 'b', from: 'agent-y', to: 'mayor', subject: 's2', body: 'b2', created_at: '2026-05-23T11:00:00Z', read: false },
      { id: 'c', from: 'human', to: 'agent-z', subject: 's3', body: 'b3', created_at: '2026-05-23T12:00:00Z', read: true },
    ];
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: corpus }));
    });
    const { app } = buildApp(fake.baseUrl);
    const { url, close } = await startApp(app);
    try {
      const inbox = await fetch(`${url}/api/mail?alias=stephanie&box=inbox`);
      assert.equal(inbox.status, 200);
      const inboxBody = (await inbox.json()) as { items: Array<{ id: string }> };
      assert.deepEqual(inboxBody.items.map((m) => m.id), ['a']);

      const sent = await fetch(`${url}/api/mail?alias=stephanie&box=sent`);
      const sentBody = (await sent.json()) as { items: Array<{ id: string }> };
      assert.deepEqual(sentBody.items.map((m) => m.id), ['c']);
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

  test('healthRouter() captures GC_HEALTH_TIMEOUT_MS at construction; runtime env mutation has no effect', async () => {
    // Contract: the resolved timeout is read once when healthRouter() runs,
    // not per request. Set env -> build router -> mutate env -> hit /system
    // against a hanging supervisor. If the captured value wins, the route
    // returns 504 fast. If the live env wins, it would wait the larger value.
    //
    // Env mutations are wrapped in a local try/finally even though the
    // describe-level afterEach also restores: it makes the cleanup of THIS
    // test's intermediate state visible inline, matching the file's pattern
    // for resources (fake/server) created inside test bodies.
    const savedEnv = process.env.GC_HEALTH_TIMEOUT_MS;
    process.env.GC_HEALTH_TIMEOUT_MS = '80';
    try {
      const fake = await startFake();
      fake.setHandler(() => {
        /* never respond — force the supervisor probe to time out */
      });
      try {
        const gc = new GcClient({
          baseUrl: fake.baseUrl,
          cityName: 'test',
          defaultTimeoutMs: 100,
        });
        const app = express();
        app.use(express.json());
        // No opts.supervisorTimeoutMs — forces resolveHealthTimeoutMs() at
        // construction time. This is the line under test.
        app.use('/api/system', healthRouter(gc));
        // After construction: mutate the env upward. A live-read implementation
        // would now wait ~5s; a startup-capture implementation stays at 80ms.
        process.env.GC_HEALTH_TIMEOUT_MS = '5000';
        const { url, close } = await startApp(app);
        try {
          const start = Date.now();
          const res = await fetch(`${url}/api/system/system`);
          const elapsed = Date.now() - start;
          assert.equal(res.status, 504);
          const body = (await res.json()) as { kind?: string };
          assert.equal(body.kind, 'upstream-timeout');
          // Captured 80ms timeout, not the mutated 5000ms. Generous 2000ms
          // ceiling absorbs GC + scheduler jitter while still failing loud if
          // the implementation accidentally starts reading env per request.
          assert.ok(
            elapsed < 2_000,
            `expected fast 504 from captured 80ms timeout, got ${elapsed}ms (impl may be reading env per request)`,
          );
        } finally {
          await close();
        }
      } finally {
        await fake.close();
      }
    } finally {
      if (savedEnv === undefined) delete process.env.GC_HEALTH_TIMEOUT_MS;
      else process.env.GC_HEALTH_TIMEOUT_MS = savedEnv;
    }
  });
});

describe('resolveSessionsTimeoutMs', () => {
  const ORIGINAL = process.env.GC_SESSIONS_TIMEOUT_MS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GC_SESSIONS_TIMEOUT_MS;
    else process.env.GC_SESSIONS_TIMEOUT_MS = ORIGINAL;
  });

  test('falls back to 3000ms when env var is unset', () => {
    delete process.env.GC_SESSIONS_TIMEOUT_MS;
    assert.equal(resolveSessionsTimeoutMs(), 3_000);
  });

  test('honors a positive integer env var', () => {
    process.env.GC_SESSIONS_TIMEOUT_MS = '4500';
    assert.equal(resolveSessionsTimeoutMs(), 4_500);
  });

  test('falls back when env var is non-numeric', () => {
    process.env.GC_SESSIONS_TIMEOUT_MS = 'not-a-number';
    assert.equal(resolveSessionsTimeoutMs(), 3_000);
  });

  test('falls back when env var is zero or negative (typo guard)', () => {
    process.env.GC_SESSIONS_TIMEOUT_MS = '0';
    assert.equal(resolveSessionsTimeoutMs(), 3_000);
    process.env.GC_SESSIONS_TIMEOUT_MS = '-1';
    assert.equal(resolveSessionsTimeoutMs(), 3_000);
  });

  test('clamps oversize values to 30000 (typo guard)', () => {
    // A typo like '99999999999' would otherwise let /api/sessions hang
    // for the full underlying GcClient window. Cap at 30s.
    process.env.GC_SESSIONS_TIMEOUT_MS = '99999999999';
    assert.equal(resolveSessionsTimeoutMs(), 30_000);
  });
});

describe('sessionsRouter timeout bound', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  test('sessionsRouter route-level timeout fires before GcClient default when supervisor hangs', async () => {
    // The bead (gascity-dashboard-xba) is about /api/sessions taking ~15s
    // because the underlying GcClient timeout is generous (5s default, or
    // larger via GC_CLIENT_TIMEOUT_MS). The sessions route bounds its own
    // wait with a tighter window so the Mail agent panel never sits on a
    // long supervisor stall.
    fake.setHandler(() => {
      /* never respond */
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      // Deliberately generous: the test proves the sessions route bails
      // BEFORE this would fire.
      defaultTimeoutMs: 5_000,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter(gc, { sessionsTimeoutMs: 150 }));
    const { url, close } = await startApp(app);
    try {
      const start = Date.now();
      const res = await fetch(`${url}/api/sessions`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 504);
      assert.ok(
        elapsed < 1_000,
        `expected fast 504 from 150ms route timeout, got ${elapsed}ms (route may be waiting on GcClient instead)`,
      );
      const body = (await res.json()) as { kind?: string };
      assert.equal(body.kind, 'upstream-timeout');
    } finally {
      await close();
    }
  });

  test('sessionsRouter() captures GC_SESSIONS_TIMEOUT_MS at construction; runtime env mutation has no effect', async () => {
    // Same contract as healthRouter: env is resolved once when the router
    // is built. Operators restart the process to pick up a new value.
    const savedEnv = process.env.GC_SESSIONS_TIMEOUT_MS;
    process.env.GC_SESSIONS_TIMEOUT_MS = '120';
    try {
      fake.setHandler(() => {
        /* never respond */
      });
      const gc = new GcClient({
        baseUrl: fake.baseUrl,
        cityName: 'test',
        defaultTimeoutMs: 5_000,
      });
      const app = express();
      app.use(express.json());
      // No opts: forces resolveSessionsTimeoutMs() at construction time.
      app.use('/api/sessions', sessionsRouter(gc));
      // After construction: mutate env upward. A live-read implementation
      // would now wait 5s; a startup-capture implementation stays at 120ms.
      process.env.GC_SESSIONS_TIMEOUT_MS = '5000';
      const { url, close } = await startApp(app);
      try {
        const start = Date.now();
        const res = await fetch(`${url}/api/sessions`);
        const elapsed = Date.now() - start;
        assert.equal(res.status, 504);
        assert.ok(
          elapsed < 2_000,
          `expected fast 504 from captured 120ms timeout, got ${elapsed}ms`,
        );
      } finally {
        await close();
      }
    } finally {
      if (savedEnv === undefined) delete process.env.GC_SESSIONS_TIMEOUT_MS;
      else process.env.GC_SESSIONS_TIMEOUT_MS = savedEnv;
    }
  });

  test('sessionsRouter still returns 200 with items on success when route timeout is set', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 'gc-abc' }] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter(gc, { sessionsTimeoutMs: 150 }));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/sessions`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: { id: string }[] };
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0]?.id, 'gc-abc');
    } finally {
      await close();
    }
  });

  test('sessionsRouter still returns 502 for non-timeout upstream errors when route timeout is set', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter(gc, { sessionsTimeoutMs: 150 }));
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
});
