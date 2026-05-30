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
      // 6bv7 F14: every list envelope in the supervisor's OpenAPI declares
      // `total` required — include it in the default-fake response so list
      // calls don't trip the decoder before the per-test handler is wired.
      res.end(JSON.stringify({ items: [], total: 0 }));
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
      res.end(JSON.stringify({ items: [validBead('td-abc')], total: 1 }));
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

  test('rejects 200 responses with no JSON body at the transport boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listSessions(),
      /gc supervisor returned an empty response body/,
    );
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
        res.end(JSON.stringify({ items: [], total: 0 }));
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
      res.end(JSON.stringify({ items: [], total: 0 }));
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

  test('uses generated OpenAPI path and query params for workflow lookup', async () => {
    let seenUrl = '';
    fake.setHandler((req, res) => {
      seenUrl = req.url ?? '';
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(validWorkflowSnapshot('wf/one')));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'city one',
      defaultTimeoutMs: 5_000,
    });
    await gc.getWorkflow('wf/one', undefined, {
      scopeKind: 'rig',
      scopeRef: 'rig-a',
    });
    const seen = new URL(`http://example.test${seenUrl}`);
    assert.equal(seen.pathname, '/v0/city/city%20one/workflow/wf%2Fone');
    assert.equal(seen.searchParams.get('scope_kind'), 'rig');
    assert.equal(seen.searchParams.get('scope_ref'), 'rig-a');
  });

  test('fetches health through the generated city-scoped supervisor path', async () => {
    let seenUrl = '';
    fake.setHandler((req, res) => {
      seenUrl = req.url ?? '';
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        status: 'ok',
        version: 'dev',
        city: 'city one',
        uptime_sec: 12,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'city one',
      defaultTimeoutMs: 5_000,
    });
    const health = await gc.health();
    assert.deepEqual(health, {
      status: 'ok',
      version: 'dev',
      city: 'city one',
      uptime_sec: 12,
    });
    assert.equal(seenUrl, '/v0/city/city%20one/health');
  });

  test('passes filtered include-closed query when listing beads', async () => {
    let seenUrl = '';
    fake.setHandler((req, res) => {
      seenUrl = req.url ?? '';
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [], total: 0 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'city one',
      defaultTimeoutMs: 5_000,
    });
    await gc.listBeads(undefined, {
      limit: 25,
      status: 'closed',
      type: 'task',
      rig: 'todo-app',
      all: true,
    });
    const seen = new URL(`http://example.test${seenUrl}`);
    assert.equal(seen.pathname, '/v0/city/city%20one/beads');
    assert.equal(seen.searchParams.get('limit'), '25');
    assert.equal(seen.searchParams.get('status'), 'closed');
    assert.equal(seen.searchParams.get('type'), 'task');
    assert.equal(seen.searchParams.get('rig'), 'todo-app');
    assert.equal(seen.searchParams.get('all'), 'true');
  });

  test('rejects malformed session list payloads at the supervisor boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 'missing-required-fields' }] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listSessions(),
      /invalid gc supervisor listSessions payload/i,
    );
  });

  test('rejects malformed bead payloads at the supervisor boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'td-abc' }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.getBead('td-abc'),
      /invalid gc supervisor getBead payload/i,
    );
  });

  test('rejects malformed bead list payloads at the supervisor boundary', async () => {
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
    await assert.rejects(
      () => gc.listBeads(undefined, { limit: 10 }),
      /invalid gc supervisor listBeads payload/i,
    );
  });

  // gascity-dashboard-9n06: the supervisor's OpenAPI spec declares
  // `priority?: number` (optional) and in practice sends `priority: null`
  // for ~977/1000 beads (sessions, messages, etc. — issue types where
  // priority is meaningless). The decoder must accept both null and
  // missing, otherwise PR #31's Zod safeParse fails the whole bead list
  // and the workflows view shows "live data unavailable".
  test('accepts bead list payloads where priority is null', async () => {
    const beadWithNullPriority = { ...validBead('td-msg-1'), priority: null };
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [beadWithNullPriority], total: 1 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listBeads(undefined, { limit: 10 });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0]?.priority, null);
  });

  test('accepts bead list payloads where priority is omitted', async () => {
    const { priority: _omit, ...beadWithoutPriority } = validBead('td-msg-2');
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [beadWithoutPriority], total: 1 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listBeads(undefined, { limit: 10 });
    assert.equal(out.items.length, 1);
    // The decoder collapses omitted/undefined priority to `null` so the
    // typed interior (`GcBead.priority: number | null`) is never violated
    // at runtime — keeps `=== null` checks in the frontend reliable.
    assert.equal(out.items[0]?.priority, null);
  });

  // ── gascity-dashboard-izgc ───────────────────────────────────────────────
  // The supervisor's OpenAPI declares ListBody*.items as `T[] | null` for
  // partial/degraded responses (one or more backends failed during
  // aggregation), correlated with `partial: true` and `partial_errors`.
  // The decoder normalizes items to `[]` so consumers always have an array,
  // but partial + partial_errors survive on the shared list interface so
  // the degradation signal is surfaceable. Lessons-learned tests prevent
  // a future supervisor that emits the wider shape from crashing the dash.

  test('F3: listBeads with items=null + partial=true forwards the degradation signal', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: null,
        total: 12,
        partial: true,
        partial_errors: ['rig/foo down'],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listBeads(undefined, { limit: 10 });
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
    assert.deepEqual(out.partial_errors, ['rig/foo down']);
    assert.equal(out.total, 12);
  });

  test('F3: listSessions accepts items=null and normalizes to []', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // 6bv7 F14: OpenAPI ListBodySessionResponse declares total required —
      // even degraded responses must carry it.
      res.end(JSON.stringify({ items: null, total: 0, partial: true }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listSessions();
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
    assert.equal(out.total, 0);
  });

  test('F3: listMail accepts items=null and normalizes to []', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: null,
        total: 0,
        partial: true,
        partial_errors: ['provider/foo timeout'],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listMail();
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
    assert.deepEqual(out.partial_errors, ['provider/foo timeout']);
  });

  test('F3: listEvents accepts items=null and normalizes to []', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: null, total: 0 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listEvents();
    assert.deepEqual(out.items, []);
    assert.equal(out.total, 0);
  });

  test('F3: listBeads with non-array items (e.g. number) still rejects', async () => {
    // Removing the dead `Array.isArray(items)` guards in routes/* is only
    // safe if the decoder rejects every non-array shape the supervisor
    // could plausibly send. null is the new accepted shape; numbers,
    // strings, objects must still fail loud.
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: 42, total: 1 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listBeads(undefined, { limit: 10 }),
      /invalid gc supervisor listBeads payload/i,
    );
  });

  // The four list decoders share `listItemsField` — but exercise each
  // wrapper independently so a future regression in listSessions / listMail
  // / listEvents (e.g. someone wires up a permissive override) is caught
  // by its own test instead of relying on listBeads as a proxy.
  test('F3: listSessions with non-array items still rejects', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: 'not-an-array' }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listSessions(),
      /invalid gc supervisor listSessions payload/i,
    );
  });

  test('F3: listMail with non-array items still rejects', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: { not: 'array' } }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listMail(),
      /invalid gc supervisor listMail payload/i,
    );
  });

  test('F3: listEvents with non-array items still rejects', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: 7 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listEvents(),
      /invalid gc supervisor listEvents payload/i,
    );
  });

  test('F2: fetchTranscript with turns=null normalizes to [] (raw format degradation)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'gc-session-1',
        template: 'claude-haiku-4-5',
        provider: 'claude',
        format: 'raw',
        turns: null,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.fetchTranscript('gc-session-1');
    assert.deepEqual(out.turns, []);
    assert.equal(out.format, 'raw');
  });

  test('F2: fetchTranscript with turns omitted normalizes to []', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // raw format is the live data near-miss: the supervisor returns
      // {id, template, provider, format, messages} with NO turns key.
      res.end(JSON.stringify({
        id: 'gc-session-2',
        template: 'codex-1',
        provider: 'codex',
        format: 'raw',
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.fetchTranscript('gc-session-2');
    assert.deepEqual(out.turns, []);
  });

  test('F5: getFormulaDetail with steps=null decodes', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'mol-demo', steps: null, deps: [] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.getFormulaDetail('mol-demo', { scopeKind: 'rig', scopeRef: 'demo' }, 'plan');
    assert.equal(out.steps, undefined);
    assert.deepEqual(out.deps, []);
  });

  test('F6: getFormulaDetail with deps=null decodes', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'mol-demo', steps: [], deps: null }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.getFormulaDetail('mol-demo', { scopeKind: 'rig', scopeRef: 'demo' }, 'plan');
    assert.deepEqual(out.steps, []);
    assert.equal(out.deps, undefined);
  });

  test('F7/F8: health with city + version absent decodes (wire-drift, surfaceable in UI)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', uptime_sec: 12345 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.health();
    assert.equal(out.status, 'ok');
    assert.equal(out.uptime_sec, 12345);
    assert.equal(out.city, undefined);
    assert.equal(out.version, undefined);
  });

  // gascity-dashboard-ej9y: /v0/city/<city>/formulas/feed surfaces cross-rig
  // formula runs (rig-stored workflow roots that listBeads doesn't return).
  // The workflows snapshot collector uses this to bootstrap its rig set.

  test('ej9y: listFormulaRuns decodes a populated feed', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [
          {
            id: 'gc-0ioyjp',
            type: 'formula',
            status: 'pending',
            title: 'mol-focus-review',
            scope_kind: 'city',
            scope_ref: 'ds-research',
            target: '/home/ds/gascity/polecat',
            started_at: '2026-05-28T23:24:42Z',
            updated_at: '2026-05-28T23:24:42Z',
            workflow_id: 'gc-0ioyjp',
            root_bead_id: 'gc-0ioyjp',
            root_store_ref: 'rig:gascity',
            run_detail_available: true,
          },
        ],
        // mfb9: FormulaFeedBody.partial is declared `boolean` (required) in
        // the supervisor's OpenAPI — keep the fixture aligned with the wire
        // contract so the decoder's RequiredPartialField test passes.
        partial: false,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listFormulaRuns({ scopeKind: 'city', scopeRef: 'ds-research' });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0]?.workflow_id, 'gc-0ioyjp');
    assert.equal(out.items[0]?.root_store_ref, 'rig:gascity');
    assert.equal(out.items[0]?.target, '/home/ds/gascity/polecat');
  });

  test('ej9y: listFormulaRuns accepts items=null + partial signal (mirrors izgc F3 pattern)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: null,
        partial: true,
        partial_errors: ['monitor backend degraded'],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listFormulaRuns({ scopeKind: 'city', scopeRef: 'ds-research' });
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
    assert.deepEqual(out.partial_errors, ['monitor backend degraded']);
  });

  test('ej9y: listFormulaRuns rejects non-array items shape', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: 42 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listFormulaRuns({ scopeKind: 'city', scopeRef: 'ds-research' }),
      /invalid gc supervisor listFormulaRuns payload/i,
    );
  });

  test('mfb9: listFormulaRuns rejects payload missing required `partial` field', async () => {
    // The supervisor's OpenAPI declares FormulaFeedBody.partial as required
    // boolean (unlike the other List* envelopes whose partial is optional).
    // Locking the dashboard-side contract: a body with valid items but no
    // `partial` field must fail decoding, so a future supervisor regression
    // that drops the field surfaces at the decoder edge instead of leaking
    // `undefined` into consumers typed as `partial: boolean`.
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
    await assert.rejects(
      () => gc.listFormulaRuns({ scopeKind: 'city', scopeRef: 'ds-research' }),
      /invalid gc supervisor listFormulaRuns payload.*partial/i,
    );
  });

  // gascity-dashboard-19w: GET /v0/city/{cityName}/rigs replaces the
  // on-disk city.toml parse. These tests pin the GcClient.listRigs
  // boundary — the snapshot-cityStatus tests inject a pre-decoded
  // GcRigList directly, so without these the URL + decoder path is
  // untested.

  test('19w: listRigs decodes a populated rig list (name+path only)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // Supervisor's RigResponse carries more fields (agent_count, suspended,
      // git status, etc.); GcRig is intentionally narrowed to name+path.
      // RigSchema uses passthrough, so the extras are accepted but not
      // surfaced in the typed output.
      res.end(JSON.stringify({
        items: [
          { name: 'gascity', path: '/home/ds/gascity/polecat', agent_count: 3, suspended: false },
          { name: 'shared',  path: '/home/ds/shared/work',     agent_count: 0, suspended: false },
        ],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listRigs();
    assert.equal(out.items.length, 2);
    assert.equal(out.items[0]?.name, 'gascity');
    assert.equal(out.items[0]?.path, '/home/ds/gascity/polecat');
    assert.equal(out.items[1]?.name, 'shared');
    assert.equal(out.items[1]?.path, '/home/ds/shared/work');
  });

  test('19w: listRigs accepts items=null + partial signal (mirrors izgc F3 pattern)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: null,
        partial: true,
        partial_errors: ['rig backend gascity unreachable'],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listRigs();
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
    assert.deepEqual(out.partial_errors, ['rig backend gascity unreachable']);
  });

  test('19w: listRigs rejects malformed rig entries (missing required name)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ path: '/no/name' }] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listRigs(),
      /invalid gc supervisor listRigs payload/i,
    );
  });

  // gascity-dashboard-ay6: GET /v0/city/{cityName}/agents is the first-class
  // agent roster. The dashboard previously reconstructed agent identity from
  // the session list, which undercounts agents that don't have a running
  // session. These tests pin the GcClient.listAgents boundary against the
  // supervisor's `ListBodyAgentResponse` envelope.

  test('ay6: listAgents decodes a populated roster with nested session info', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // Mirror the shape from supervisor `AgentResponse` (gc-supervisor.ts:2070).
      // Required: name, available, running, suspended, state. Optional fields the
      // Agents view consumes: display_name, model, provider, pool, rig, activity,
      // context_pct, context_window, last_output, active_bead, description,
      // unavailable_reason, session.
      res.end(JSON.stringify({
        items: [
          {
            name: 'mayor',
            display_name: 'Mayor',
            available: true,
            running: true,
            suspended: false,
            state: 'active',
            provider: 'claude-code',
            model: 'claude-opus-4-7',
            pool: 'orchestration',
            rig: '',
            activity: 'thinking',
            context_pct: 18,
            context_window: 200_000,
            // Extra supervisor fields (last_output, active_bead) ride through
            // AgentSchema's .passthrough() and remain on the raw decoded
            // object, but the dashboard-side GcAgent interface intentionally
            // narrows to fields the Agents view consumes — they are not
            // exposed on the typed surface, so callers cannot read them
            // without an unsafe cast. That's the correct boundary: new
            // supervisor fields don't break decoding, but adopting them in
            // the dashboard requires an explicit shared-types change.
            last_output: 'reviewing PR',
            active_bead: 'gascity-dashboard-ay6',
            session: {
              name: 'gc-sess-mayor',
              attached: true,
              last_activity: '2026-05-29T10:00:00Z',
            },
          },
          {
            // Agent with no running session — the canonical case the
            // session-derived path under-counted.
            name: 'kb3',
            available: true,
            running: false,
            suspended: false,
            state: 'asleep',
            provider: 'codex',
          },
        ],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listAgents();
    assert.equal(out.items.length, 2);
    assert.equal(out.items[0]?.name, 'mayor');
    assert.equal(out.items[0]?.display_name, 'Mayor');
    assert.equal(out.items[0]?.running, true);
    assert.equal(out.items[0]?.state, 'active');
    assert.equal(out.items[0]?.session?.name, 'gc-sess-mayor');
    assert.equal(out.items[0]?.session?.attached, true);
    assert.equal(out.items[0]?.session?.last_activity, '2026-05-29T10:00:00Z');
    // The orphan agent's session must be absent (no silent {} fabrication).
    assert.equal(out.items[1]?.name, 'kb3');
    assert.equal(out.items[1]?.session, undefined);
    assert.equal(out.items[1]?.running, false);
  });

  test('ay6: listAgents accepts items=null + partial signal (mirrors izgc F3 pattern)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: null,
        partial: true,
        partial_errors: ['agent backend gascity unreachable'],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listAgents();
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
    assert.deepEqual(out.partial_errors, ['agent backend gascity unreachable']);
  });

  test('ay6: listAgents rejects malformed agent entries (missing required name)', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{ available: true, running: false, suspended: false, state: 'asleep' }],
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listAgents(),
      /invalid gc supervisor listAgents payload/i,
    );
  });

  test('ay6: getAgent decodes a single-agent detail response', async () => {
    fake.setHandler((req, res) => {
      assert.match(req.url ?? '', /\/v0\/city\/test\/agent\/mayor$/);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: 'mayor',
        display_name: 'Mayor',
        available: true,
        running: true,
        suspended: false,
        state: 'active',
        provider: 'claude-code',
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.getAgent('mayor');
    assert.equal(out.name, 'mayor');
    assert.equal(out.display_name, 'Mayor');
    assert.equal(out.state, 'active');
    assert.equal(out.running, true);
  });

  test('rejects malformed mail list payloads at the supervisor boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 'mail-1' }], total: 1 }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listMail(),
      /invalid gc supervisor listMail payload/i,
    );
  });

  test('rejects malformed event list payloads at the supervisor boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ type: 'session.started' }] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listEvents(),
      /invalid gc supervisor listEvents payload/i,
    );
  });

  test('rejects malformed workflow snapshots at the supervisor boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        workflow_id: 'gc-root',
        root_bead_id: 'gc-root',
        root_store_ref: 'city:test',
        resolved_root_store: 'city:test',
        scope_kind: 'city',
        scope_ref: 'test',
        snapshot_version: 1,
        partial: false,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.getWorkflow('gc-root'),
      /invalid gc supervisor getWorkflow payload/i,
    );
  });

  test('rejects malformed formula detail payloads at the supervisor boundary', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: 'mol-demo',
        preview: {
          nodes: [{ title: 'missing id' }],
          edges: [],
        },
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.getFormulaDetail('mol-demo', { scopeKind: 'rig', scopeRef: 'demo' }, 'plan'),
      /invalid gc supervisor getFormulaDetail payload/i,
    );
  });

  test('rejects transcript payloads with malformed turn shape at the supervisor boundary', async () => {
    // F2 widens absent/null turns to [] (per OpenAPI: turns?: T[] | null),
    // so the prior test that asserted absent-turns failed is obsolete. The
    // decoder must still reject genuinely malformed turns — wrong type
    // inside the array, etc.
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'gc-session-1', turns: [{ role: 123 }] }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.fetchTranscript('gc-session-1'),
      /invalid gc supervisor fetchTranscript payload/i,
    );
  });

  // ── 6bv7 wire-shape tightening regression tests ────────────────────────
  //
  // These pin the decoder edge against the OpenAPI ground truth so a future
  // change that re-loosens a required field or re-adds a phantom one fails
  // at the supervisor boundary instead of leaking past the SSOT.

  test('6bv7 F10: listSessions rejects a session missing provider', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [
          {
            id: 'gc-1',
            template: 't',
            state: 'active',
            created_at: '2026-05-29T00:00:00Z',
            attached: false,
            session_name: 'gc-1',
            title: 'gc-1',
            running: true,
            // provider missing
          },
        ],
        total: 1,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listSessions(),
      /invalid gc supervisor listSessions payload.*provider/i,
    );
  });

  test('6bv7 F12: listEvents rejects an event missing actor or payload', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{ seq: 1, type: 'bead.created', ts: '2026-05-29T00:00:00Z' }],
        total: 1,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listEvents(),
      /invalid gc supervisor listEvents payload/i,
    );
  });

  test('6bv7 F13/F14: listEvents forwards total; phantom "next" key is no longer in the typed interior', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // Supplying the old phantom `next` key must NOT crash the decoder
      // (.passthrough()), even though the typed GcEventList interface no
      // longer declares it. Any consumer that still tries to read `next`
      // through GcEventList would now fail tsc.
      res.end(JSON.stringify({
        items: [],
        next: 12345,
        total: 17,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listEvents();
    assert.equal(out.total, 17);
    // Compile-time contract: `next` is no longer on GcEventList, so the
    // following access is only valid via an explicit cast. That cast is
    // the new tripwire — any consumer using `next` will need it, and any
    // ungated `eventList.next` access fails tsc. The runtime assertion
    // pins the other half of the contract: passthrough() preserves the
    // wire value (so we don't silently drop supervisor data), but the
    // typed interior hides it behind the cast.
    assert.equal((out as unknown as { next?: number }).next, 12345);
  });

  test('6bv7 F14: listBeads rejects a payload missing total', async () => {
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
    await assert.rejects(
      () => gc.listBeads(undefined, { limit: 10 }),
      /invalid gc supervisor listBeads payload.*total/i,
    );
  });

  test('6bv7 F11: listBeads tightens metadata to Record<string,string>', async () => {
    // Non-string metadata values must fail the decoder — the prior
    // UnknownRecordSchema laundered any value type through the SSOT.
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{
          ...validBead('td-1'),
          metadata: { count: 42 },
        }],
        total: 1,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.listBeads(undefined, { limit: 10 }),
      /invalid gc supervisor listBeads payload.*metadata/i,
    );
  });

  test('6bv7 F15: listBeads surfaces parent/from/ephemeral/needs/dependencies from the wire', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{
          ...validBead('td-1'),
          parent: 'td-parent',
          from: 'mayor',
          ephemeral: true,
          needs: ['td-pre-1', 'td-pre-2'],
          dependencies: [
            { depends_on_id: 'td-pre-1', issue_id: 'td-1', type: 'blocks' },
          ],
        }],
        total: 1,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listBeads(undefined, { limit: 10 });
    const bead = out.items[0];
    assert.equal(bead?.parent, 'td-parent');
    assert.equal(bead?.from, 'mayor');
    assert.equal(bead?.ephemeral, true);
    assert.deepEqual(bead?.needs, ['td-pre-1', 'td-pre-2']);
    assert.deepEqual(bead?.dependencies, [
      { depends_on_id: 'td-pre-1', issue_id: 'td-1', type: 'blocks' },
    ]);
  });

  test('6bv7 F16: GcBead typed interior no longer declares owner/updated_at/closed_at/dependency_count/dependent_count/comment_count', async () => {
    // These fields were never in the OpenAPI Bead schema. After 6bv7 the
    // typed GcBead interface drops them, so any frontend consumer reading
    // `bead.updated_at` now fails tsc. Runtime payloads may still include
    // them (passthrough()) — that is intentional so a future supervisor
    // that DOES add one of these doesn't crash the dash before the SSOT
    // catches up. The contract that matters is the type, not the runtime
    // snapshot.
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{ ...validBead('td-1'), owner: 'phantom' }],
        total: 1,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listBeads(undefined, { limit: 10 });
    const bead = out.items[0];
    assert.ok(bead);
    // Tripwire: accessing the removed field requires an explicit cast,
    // which is the compile-time signal a future reviewer must explain.
    // @ts-expect-error owner removed from GcBead in 6bv7 (F16)
    void bead.owner;
    // @ts-expect-error updated_at removed from GcBead in 6bv7 (F16)
    void bead.updated_at;
    // @ts-expect-error closed_at removed from GcBead in 6bv7 (F16)
    void bead.closed_at;
    // @ts-expect-error dependency_count removed from GcBead in 6bv7 (F16)
    void bead.dependency_count;
    // @ts-expect-error dependent_count removed from GcBead in 6bv7 (F16)
    void bead.dependent_count;
    // @ts-expect-error comment_count removed from GcBead in 6bv7 (F16)
    void bead.comment_count;
  });

  test('6bv7 F17: listMail surfaces priority/cc/reply_to when the supervisor emits them', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{
          id: 'mail-1',
          from: 'agent',
          to: 'human',
          subject: 's',
          body: 'b',
          created_at: '2026-05-29T00:00:00Z',
          read: false,
          priority: 7,
          cc: ['cc@example.test'],
          reply_to: 'reply@example.test',
        }],
        total: 1,
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listMail();
    const item = out.items[0];
    assert.equal(item?.priority, 7);
    assert.deepEqual(item?.cc, ['cc@example.test']);
    assert.equal(item?.reply_to, 'reply@example.test');
  });

  test('6bv7 F19: getFormulaDetail rejects a preview node missing title or kind', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: 'mol-x',
        preview: {
          nodes: [{ id: 'n1' }], // title + kind missing
        },
      }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => gc.getFormulaDetail(
        'mol-x',
        { scopeKind: 'city', scopeRef: 'test' },
        '/tmp/x',
      ),
      /invalid gc supervisor getFormulaDetail payload/i,
    );
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

function validBead(id: string) {
  return {
    id,
    title: id,
    status: 'open',
    issue_type: 'task',
    priority: 0,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function validWorkflowSnapshot(workflowId: string) {
  return {
    workflow_id: workflowId,
    root_bead_id: 'gc-root',
    root_store_ref: 'city:test',
    resolved_root_store: 'city:test',
    scope_kind: 'city',
    scope_ref: 'test',
    snapshot_version: 1,
    snapshot_event_seq: null,
    partial: false,
    stores_scanned: [],
    beads: [],
    deps: [],
    logical_nodes: [],
    logical_edges: [],
    scope_groups: [],
  };
}
