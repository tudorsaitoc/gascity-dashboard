import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ExecResult } from '../src/exec.js';
import { ExecError } from '../src/exec.js';
import { maintainerRouter } from '../src/routes/maintainer.js';
import { setAuditLogPath } from '../src/audit.js';

// Tests for POST /api/maintainer/sling (gascity-dashboard-ib5).
//
// Harness shape: own app skeleton (the routes.test.ts buildApp() targets
// a fake gc-supervisor HTTP server, which doesn't apply to a route that
// shells out via execGcSling). The route accepts execGcSling via DI so
// tests can stub without module mocking; audit assertions hit a tmp file
// via setAuditLogPath.

type SlingStub = (target: string, beadText: string) => Promise<ExecResult>;

interface StubCall {
  target: string;
  beadText: string;
}

interface AppHandle {
  url: string;
  close: () => Promise<void>;
  auditPath: string;
  calls: StubCall[];
}

interface BuildOpts {
  sling?: SlingStub;
  slingTarget?: string;
}

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sling-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  setAuditLogPath(auditPath);

  const calls: StubCall[] = [];
  const defaultStub: SlingStub = async () => ({
    exitCode: 0,
    stdout: 'created bead td-wisp-abc123\n',
    stderr: '',
    truncated: false,
    durationMs: 42,
  });
  const sling: SlingStub = async (target, beadText) => {
    calls.push({ target, beadText });
    return (opts.sling ?? defaultStub)(target, beadText);
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/maintainer',
    maintainerRouter({
      repo: 'gastownhall/gascity',
      cachePath: path.join(tmpDir, 'cache.json'),
      slingTarget: opts.slingTarget ?? 'mayor',
      execGcSling: sling,
    }),
  );

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
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

describe('POST /api/maintainer/sling', { concurrency: false }, () => {
  let h: AppHandle;
  afterEach(async () => {
    if (h !== undefined) await h.close();
  });

  test('happy path: review intent dispatches and audits', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/pull/47',
      intent: 'review',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.bead_id, 'td-wisp-abc123');

    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.equal(call.target, 'mayor');
    assert.equal(
      call.beadText,
      'Please review PR https://github.com/gastownhall/gascity/pull/47',
    );

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.sling');
    assert.equal(row.endpoint, 'POST /api/maintainer/sling');
    assert.equal(row.actor, 'stephanie');
    assert.equal(row.exit_code, 0);
    assert.equal(typeof row.duration_ms, 'number');
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.kind, 'pr');
    assert.equal(parsed.number, '47');
    assert.equal(parsed.intent, 'review');
    assert.equal(parsed.target, 'mayor');
    assert.ok(Number(parsed.text_len) > 0, 'text_len should be positive');
    // Audit must NEVER carry the full bead text.
    const flat = JSON.stringify(row);
    assert.ok(!flat.includes('Please review PR'), 'audit row leaked full text');
    // Response must NOT carry the full stdout (mail-send precedent: id only).
    assert.equal(res.body.stdout, undefined, 'response leaked stdout');
    assert.equal(res.body.stderr, undefined, 'response leaked stderr');
  });

  test('draft intent composes draft template', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'issue',
      number: 12,
      html_url: 'https://github.com/gastownhall/gascity/issues/12',
      intent: 'draft',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls.length, 1);
    assert.equal(
      h.calls[0]!.beadText,
      'Please draft a PR addressing https://github.com/gastownhall/gascity/issues/12',
    );
  });

  test('triage intent composes triage template', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 99,
      html_url: 'https://github.com/gastownhall/gascity/pull/99',
      intent: 'triage',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls.length, 1);
    assert.equal(
      h.calls[0]!.beadText,
      'Please triage https://github.com/gastownhall/gascity/pull/99',
    );
  });

  test('target falls back to configured slingTarget', async () => {
    h = await buildApp({ slingTarget: 'chief-of-staff' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls[0]!.target, 'chief-of-staff');
  });

  test('explicit target overrides slingTarget', async () => {
    h = await buildApp({ slingTarget: 'mayor' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
      target: 'project-lead',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls[0]!.target, 'project-lead');
  });

  test('invalid intent returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'destroy',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('invalid kind returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'epic',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('invalid target alias returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
      target: 'bad target!!',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('non-positive number returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 0,
      html_url: 'https://github.com/gastownhall/gascity/pull/0',
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('float number returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1.5,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('kind=pr with /issues/ URL returns 400 mismatch', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/issues/47',
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('kind=issue with /pull/ URL returns 400 mismatch', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'issue',
      number: 12,
      html_url: 'https://github.com/gastownhall/gascity/pull/12',
      intent: 'draft',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('non-github html_url returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://evil.example.com/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('oversized html_url returns 400', async () => {
    h = await buildApp();
    const longSegment = 'a'.repeat(2_100);
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: `https://github.com/gastownhall/gascity/pull/${longSegment}`,
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('gc sling non-zero exit surfaces as 502 with stderr', async () => {
    h = await buildApp({
      sling: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'gc: agent not found\n',
        truncated: false,
        durationMs: 17,
      }),
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'upstream');
    const details = res.body.details as { stderr?: string };
    assert.ok(details.stderr?.includes('agent not found'));

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.exit_code, 1);
  });

  test('ExecError validation (from exec) surfaces as 400 — post-dispatch boundary', async () => {
    h = await buildApp({
      sling: async () => {
        throw new ExecError('invalid target', 'validation');
      },
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    // Came from exec, not from body validation — wrapper recorded the call.
    assert.equal(h.calls.length, 1);
  });

  test('ExecError timeout surfaces as 504', async () => {
    h = await buildApp({
      sling: async () => {
        throw new ExecError('sling timed out', 'timeout');
      },
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.kind, 'timeout');
    assert.equal(h.calls.length, 1);
  });

  test('ExecError spawn surfaces as 502', async () => {
    h = await buildApp({
      sling: async () => {
        throw new ExecError('spawn failed: ENOENT', 'spawn');
      },
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'spawn');
    assert.equal(h.calls.length, 1);
  });

  test('stdout without bead-id still returns 200 with bead_id omitted', async () => {
    h = await buildApp({
      sling: async () => ({
        exitCode: 0,
        stdout: 'dispatched\n',
        stderr: '',
        truncated: false,
        durationMs: 10,
      }),
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.bead_id, undefined);
  });
});
