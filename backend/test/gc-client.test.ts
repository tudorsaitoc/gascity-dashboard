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
      res.end(JSON.stringify({ items: null, partial: true }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listSessions();
    assert.deepEqual(out.items, []);
    assert.equal(out.partial, true);
  });

  test('F3: listMail accepts items=null and normalizes to []', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: null, partial: true, partial_errors: ['provider/foo timeout'] }));
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
      res.end(JSON.stringify({ items: null }));
    });
    const gc = new GcClient({
      baseUrl: fake.baseUrl,
      cityName: 'test',
      defaultTimeoutMs: 5_000,
    });
    const out = await gc.listEvents();
    assert.deepEqual(out.items, []);
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
