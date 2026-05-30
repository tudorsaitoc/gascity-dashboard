import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ExecResult } from '../src/exec.js';
import { ExecError } from '../src/exec.js';
import { beadsRouter } from '../src/routes/beads.js';
import { setAuditLogPath } from '../src/audit.js';
import { GcClient } from '../src/gc-client.js';
import type { BeadUpdateInput } from 'gas-city-dashboard-shared';
import { assertWireDetails } from './helpers/wire.js';

// Tests for POST /api/beads/:id/{claim,close,nudge}.
//
// gascity-dashboard-mq2: CLAIM moved to an HTTP POST /bead/{id}/update on the
// supervisor (injected `updateBead` fn). CLOSE + NUDGE stay on the gc CLI —
// close because the HTTP /bead/{id}/close endpoint has no reason field, nudge
// because no HTTP route exists for it — so they keep flowing through the
// injected `execBeadAction` stub. The router accepts both via DI so tests
// can stub without module mocking. concurrency:false because setAuditLogPath
// is global module state.

type BeadActionStub = (
  beadId: string,
  action: 'close' | 'nudge',
  reason?: string,
  cityPath?: string,
) => Promise<ExecResult>;

type UpdateBeadStub = (
  id: string,
  body: BeadUpdateInput,
) => Promise<void>;

interface StubCall {
  beadId: string;
  action: 'close' | 'nudge';
  reason?: string;
  cityPath?: string;
}

interface UpdateCall {
  id: string;
  body: BeadUpdateInput;
}

interface AppHandle {
  url: string;
  close: () => Promise<void>;
  auditPath: string;
  calls: StubCall[];
  updateCalls: UpdateCall[];
}

interface BuildOpts {
  execBeadAction?: BeadActionStub;
  updateBead?: UpdateBeadStub;
}

// We only exercise the write routes (claim/close/nudge); the read routes
// (GET /, GET /:id) need a real GcClient, but the write paths don't touch
// it. Passing a baseUrl that we never call is fine.
const STUB_GC = new GcClient({ baseUrl: 'http://127.0.0.1:1', cityName: 'test' });
const TEST_CITY_PATH = '/home/test/gas-city';

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beads-nudge-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  setAuditLogPath(auditPath);

  const calls: StubCall[] = [];
  const updateCalls: UpdateCall[] = [];
  const defaultStub: BeadActionStub = async () => ({
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    truncated: false,
    durationMs: 13,
  });
  const execBeadAction: BeadActionStub = async (beadId, action, reason, cityPath) => {
    const call: StubCall = { beadId, action };
    if (reason !== undefined) call.reason = reason;
    if (cityPath !== undefined) call.cityPath = cityPath;
    calls.push(call);
    return (opts.execBeadAction ?? defaultStub)(beadId, action, reason, cityPath);
  };
  const defaultUpdate: UpdateBeadStub = async () => {};
  const updateBead: UpdateBeadStub = async (id, body) => {
    updateCalls.push({ id, body });
    return (opts.updateBead ?? defaultUpdate)(id, body);
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/beads',
    beadsRouter(STUB_GC, TEST_CITY_PATH, { execBeadAction, updateBead }),
  );

  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        auditPath,
        calls,
        updateCalls,
        close: () =>
          new Promise<void>((r) =>
            srv.close(async () => {
              await fs.rm(tmpDir, { recursive: true, force: true });
              r();
            }),
          ),
      });
    });
  });
}

async function postJson(
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: data };
}

async function readAudit(p: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('POST /api/beads/:id/{claim,close,nudge}', { concurrency: false }, () => {
  let h: AppHandle | undefined;
  afterEach(async () => {
    if (h !== undefined) await h.close();
    h = undefined;
  });

  test('happy path: nudge dispatches via DI stub and audits', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], {
      beadId: 'td-wisp-abc123',
      action: 'nudge',
      cityPath: TEST_CITY_PATH,
    });

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.exec');
    assert.equal(row.endpoint, 'POST /api/beads/:id/nudge');
    assert.equal(row.actor, 'stephanie');
    assert.equal(row.exit_code, 0);
    assert.equal(typeof row.duration_ms, 'number');
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.bead_id, 'td-wisp-abc123');
    assert.ok(!('reason' in parsed));
  });

  // gascity-dashboard-mq2: claim is now an HTTP POST /bead/{id}/update via
  // the injected updateBead fn, NOT a gc CLI subprocess. It must set
  // status:'in_progress' + assignee:'stephanie' and never touch
  // execBeadAction (which is now close/nudge only).
  test('happy path: claim dispatches via HTTP updateBead and audits', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/claim`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // No CLI subprocess on the claim path.
    assert.equal(h.calls.length, 0);
    assert.equal(h.updateCalls.length, 1);
    assert.deepEqual(h.updateCalls[0], {
      id: 'td-wisp-abc123',
      body: { status: 'in_progress', assignee: 'stephanie' },
    });

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.exec');
    assert.equal(row.endpoint, 'POST /api/beads/:id/claim');
    assert.equal(row.actor, 'stephanie');
    assert.equal(typeof row.duration_ms, 'number');
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.bead_id, 'td-wisp-abc123');
  });

  test('claim invalid bead id returns 400 before reaching updateBead', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/beads/bad%20id%20!!/claim`);
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.updateCalls.length, 0);
  });

  test('claim upstream failure surfaces as 502 with redacted details', async () => {
    const leakyErr = new Error('gc supervisor returned 500 at http://127.0.0.1:8372');
    leakyErr.name = 'UpstreamError';
    h = await buildApp({
      updateBead: async () => {
        throw leakyErr;
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/claim`);
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'upstream');
    assertWireDetails(res.body.details);
    assert.equal(res.body.details.message, undefined, 'details.message must be redacted');
    assert.equal(res.body.details.name, 'UpstreamError');
    const wire = JSON.stringify(res.body);
    assert.ok(!wire.includes('127.0.0.1'), `response leaks loopback: ${wire}`);
    assert.ok(!wire.includes('8372'), `response leaks supervisor port: ${wire}`);
  });

  test('claim timeout surfaces as 504', async () => {
    h = await buildApp({
      updateBead: async () => {
        // Mirror the shape GcClient produces on a per-request timeout: a
        // TimeoutError whose name isTimeoutError() recognises.
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/claim`);
    assert.equal(res.status, 504);
    assert.equal(res.body.kind, 'upstream-timeout');
  });

  test('happy path: close with reason threads reason to exec', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/close`, {
      reason: 'shipped via pf2',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.action, 'close');
    assert.equal(h.calls[0]!.reason, 'shipped via pf2');
    // cityPath is threaded so `gc bd close` pins the store instead of
    // relying on the backend's cwd (regression: "not in a city directory").
    assert.equal(h.calls[0]!.cityPath, TEST_CITY_PATH);

    const rows = await readAudit(h.auditPath);
    const parsed = rows[0]!.parsed_args as Record<string, string>;
    assert.equal(parsed.reason, 'shipped via pf2');
  });

  test('invalid bead id returns 400 before reaching exec', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/beads/bad%20id%20!!/nudge`);
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  // gascity-dashboard-i0b: the non-zero-exit SUCCESS-path branch (the exec
  // call resolved, but `gc` returned a non-zero code) used to echo raw
  // stderr on the wire — same threat-family as the 473 catch-arms. gc's
  // stderr can embed host paths / socket paths / ENOENT. The wire must
  // carry only the fixed details:{name:'NonZeroExit'} shape (mirroring
  // agents.ts i53); full stderr is retained server-side via console.warn
  // for journalctl (log channel, not asserted here).
  test('gc bd nudge non-zero exit surfaces as 502 with redacted details', async () => {
    h = await buildApp({
      execBeadAction: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'gc: open /home/ds/.local/share/gc/city.sock: ENOENT\n',
        truncated: false,
        durationMs: 17,
      }),
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'upstream');
    assertWireDetails(res.body.details);
    assert.equal(res.body.details.stderr, undefined, 'wire must not carry raw stderr');
    assert.equal(
      res.body.details.name,
      'NonZeroExit',
      'wire must carry the fixed details discriminator only',
    );
    const wire = JSON.stringify(res.body);
    assert.ok(!wire.includes('/home/ds'), `response leaks operator home: ${wire}`);
    assert.ok(!wire.includes('.sock'), `response leaks socket path: ${wire}`);
    assert.ok(!wire.includes('ENOENT'), `response leaks OS errno: ${wire}`);

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.exit_code, 1);
  });

  test('ExecError validation surfaces as 400', async () => {
    h = await buildApp({
      execBeadAction: async () => {
        throw new ExecError('invalid bead id', 'validation');
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 1);
  });

  test('ExecError timeout surfaces as 504', async () => {
    h = await buildApp({
      execBeadAction: async () => {
        throw new ExecError('exec timed out', 'timeout');
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 504);
    assert.equal(res.body.kind, 'timeout');
    assert.equal(h.calls.length, 1);
  });

  test('non-ExecError throw surfaces as 500 internal', async () => {
    h = await buildApp({
      execBeadAction: async () => {
        throw new Error('boom');
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 500);
    assert.equal(res.body.kind, 'internal');
    assert.equal(h.calls.length, 1);
  });

  // gascity-dashboard-473: complete the ayr/sr6 redaction sweep on the
  // runBeadAction catch arms. Two distinct fix patterns:
  //
  //   - ExecError kind='spawn' wraps "spawn /home/ds/.local/bin/gc ENOENT"
  //     style messages exposing the operator's binary path. The wire
  //     message must collapse to a static string; the kind tag still
  //     surfaces 'spawn' so the client can branch on it.
  //   - Non-ExecError 500 fallback embeds whatever the unexpected error
  //     reported (could carry OS detail). Replace with a static 'internal
  //     error' + details.name carrying the Error class discriminator,
  //     mirroring the sessions/mail/beads 5xx redaction contract from ayr.
  //
  // Server-side journalctl retains full message fidelity via console.warn
  // at the source (not asserted here — log channel, not wire channel).
  test('ExecError spawn arm redacts host path from response body', async () => {
    h = await buildApp({
      execBeadAction: async () => {
        throw new ExecError(
          'spawn failed: spawn /home/ds/.local/bin/gc ENOENT',
          'spawn',
        );
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 500);
    assert.equal(res.body.kind, 'spawn');
    const wire = JSON.stringify(res.body);
    assert.ok(
      !wire.includes('/home/ds'),
      `response leaks operator home: ${wire}`,
    );
    assert.ok(
      !wire.includes('.local/bin'),
      `response leaks binary path: ${wire}`,
    );
    assert.ok(
      !wire.includes('ENOENT'),
      `response leaks OS errno: ${wire}`,
    );
  });

  test('non-ExecError 500 fallback redacts raw err.message', async () => {
    const leakyErr = new Error(
      'connect ECONNREFUSED 127.0.0.1:1 (interface lo) at /var/run/sock',
    );
    leakyErr.name = 'NetworkError';
    h = await buildApp({
      execBeadAction: async () => {
        throw leakyErr;
      },
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 500);
    assert.equal(res.body.kind, 'internal');
    assertWireDetails(res.body.details);
    assert.equal(
      res.body.details.message,
      undefined,
      'details.message must be redacted',
    );
    assert.equal(
      res.body.details.name,
      'NetworkError',
      'details.name must carry the Error class discriminator',
    );
    const wire = JSON.stringify(res.body);
    assert.ok(
      !wire.includes('ECONNREFUSED'),
      `response leaks ECONNREFUSED: ${wire}`,
    );
    assert.ok(
      !wire.includes('/var/run/sock'),
      `response leaks file path: ${wire}`,
    );
  });
});
