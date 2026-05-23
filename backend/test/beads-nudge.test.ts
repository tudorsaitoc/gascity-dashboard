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

// Tests for POST /api/beads/:id/{claim,close,nudge} (gascity-dashboard-pf2).
//
// The bead nudge route is "agent-nudge" from the operator's POV — `gc bd
// nudge <id>` pokes the assigned agent on a bead. The router accepts
// execBeadAction via DI so tests can stub without module mocking. Mirrors
// backend/test/maintainer-sling.test.ts harness shape. concurrency:false
// because setAuditLogPath is global module state.

type BeadActionStub = (
  beadId: string,
  action: 'claim' | 'close' | 'nudge',
  reason?: string,
) => Promise<ExecResult>;

interface StubCall {
  beadId: string;
  action: 'claim' | 'close' | 'nudge';
  reason?: string;
}

interface AppHandle {
  url: string;
  close: () => Promise<void>;
  auditPath: string;
  calls: StubCall[];
}

interface BuildOpts {
  execBeadAction?: BeadActionStub;
}

// We only exercise the write routes (claim/close/nudge); the read routes
// (GET /, GET /:id) need a real GcClient, but the write paths don't touch
// it. Passing a baseUrl that we never call is fine.
const STUB_GC = new GcClient({ baseUrl: 'http://127.0.0.1:1', cityName: 'test' });

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beads-nudge-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  setAuditLogPath(auditPath);

  const calls: StubCall[] = [];
  const defaultStub: BeadActionStub = async () => ({
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    truncated: false,
    durationMs: 13,
  });
  const execBeadAction: BeadActionStub = async (beadId, action, reason) => {
    calls.push({ beadId, action, reason });
    return (opts.execBeadAction ?? defaultStub)(beadId, action, reason);
  };

  const app = express();
  app.use(express.json());
  app.use('/api/beads', beadsRouter(STUB_GC, { execBeadAction }));

  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        auditPath,
        calls,
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
      reason: undefined,
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
    assert.equal(parsed.reason, undefined);
  });

  test('happy path: claim dispatches via DI stub', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/claim`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.action, 'claim');
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

  test('gc bd nudge non-zero exit surfaces as 502 with stderr', async () => {
    h = await buildApp({
      execBeadAction: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'bead not found\n',
        truncated: false,
        durationMs: 17,
      }),
    });
    const res = await postJson(`${h.url}/api/beads/td-wisp-abc123/nudge`);
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'upstream');
    const details = res.body.details as { stderr?: string };
    assert.ok(details.stderr?.includes('bead not found'));

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
});
