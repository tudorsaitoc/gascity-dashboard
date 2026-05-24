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
import { readSlungState, slungKey, writeSlungEntry } from '../src/maintainer/slung-state.js';
import type { MaintainerTriage, TriageItem } from 'gas-city-dashboard-shared';

// Tests for POST /api/maintainer/sling (gascity-dashboard-ib5).
//
// Harness shape: own app skeleton (the routes.test.ts buildApp() targets
// a fake gc-supervisor HTTP server, which doesn't apply to a route that
// shells out via execGcSling). The route accepts execGcSling via DI so
// tests can stub without module mocking; audit assertions hit a tmp file
// via setAuditLogPath.

type SlingStub = (
  target: string,
  beadText: string,
  cityPath?: string,
) => Promise<ExecResult>;

interface StubCall {
  target: string;
  beadText: string;
  cityPath?: string;
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
  triageTarget?: string;
  cityPath?: string;
}

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sling-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  setAuditLogPath(auditPath);

  const calls: StubCall[] = [];
  // gascity-dashboard-wds: modern `gc sling` stdout is a multi-line
  // envelope ending with "Slung <id> (with default formula ...) → <target>".
  // The bead_id extractor anchors on that final line, so the default stub
  // mirrors the real CLI shape.
  const defaultStub: SlingStub = async () => ({
    exitCode: 0,
    stdout: [
      'Created gc-255139 — "Please review PR https://example/pull/1"',
      'Auto-convoy gc-255141',
      'Attached wisp gc-255140 (formula "mol-focus-review") to gc-255139',
      'Slung gc-255139 (with default formula "mol-focus-review") → oversight-rig.chief-of-staff',
      '',
    ].join('\n'),
    stderr: '',
    truncated: false,
    durationMs: 42,
  });
  const sling: SlingStub = async (target, beadText, cityPath) => {
    calls.push({ target, beadText, cityPath });
    return (opts.sling ?? defaultStub)(target, beadText, cityPath);
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/maintainer',
    maintainerRouter({
      repo: 'gastownhall/gascity',
      cachePath: path.join(tmpDir, 'cache.json'),
      slingTarget: opts.slingTarget ?? 'mayor',
      triageTarget: opts.triageTarget,
      cityPath: opts.cityPath,
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

async function readSseSome(
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
    assert.equal(res.body.bead_id, 'gc-255139');

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

  test('intent=triage with no explicit target uses triageTarget over slingTarget', async () => {
    // gascity-dashboard-0nn: bulk-sling action bar fans out a batch of
    // intent='triage' requests. The route picks the triage target so the
    // frontend doesn't have to know about chief-of-staff vs mayor.
    h = await buildApp({ slingTarget: 'mayor', triageTarget: 'chief-of-staff' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'triage',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls[0]!.target, 'chief-of-staff');
  });

  test('intent=review with triageTarget set still uses slingTarget', async () => {
    // The triage override is intent-scoped; review/draft must stay on the
    // generic sling target.
    h = await buildApp({ slingTarget: 'mayor', triageTarget: 'chief-of-staff' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls[0]!.target, 'mayor');
  });

  test('intent=triage with explicit target still wins over triageTarget', async () => {
    // Explicit body.target always trumps any config default, including
    // the intent-aware one.
    h = await buildApp({ slingTarget: 'mayor', triageTarget: 'chief-of-staff' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'triage',
      target: 'project-lead',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls[0]!.target, 'project-lead');
  });

  test('intent=triage falls back to slingTarget when triageTarget option is unset', async () => {
    // Backward-compat: a caller that doesn't pass triageTarget keeps the
    // pre-0nn behaviour of single-target dispatch.
    h = await buildApp({ slingTarget: 'mayor' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'triage',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls[0]!.target, 'mayor');
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

    // gascity-dashboard-ur0: thrown ExecError still emits an audit row
    // so the forensic record is symmetric across success / non-zero / throw.
    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.sling');
    assert.equal(row.endpoint, 'POST /api/maintainer/sling');
    assert.equal(row.actor, 'stephanie');
    assert.ok(!('exit_code' in row));
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.error_kind, 'validation');
    assert.equal(parsed.kind, 'pr');
    assert.equal(parsed.intent, 'review');
    assert.equal(parsed.target, 'mayor');
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

    // gascity-dashboard-ur0: timeouts are operationally significant — must
    // leave an audit trail so the operator can diagnose silent-failure
    // patterns from events.jsonl alone.
    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.sling');
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.error_kind, 'timeout');
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

    // gascity-dashboard-ur0.
    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const parsed = rows[0]!.parsed_args as Record<string, string>;
    assert.equal(parsed.error_kind, 'spawn');
  });

  test('non-ExecError throw (unknown) still audits with error_kind=unknown', async () => {
    // gascity-dashboard-ur0: cover the catch-all branch — any unexpected
    // throw from execGcSling should still leave a forensic row, mirroring
    // the agents.ts (GET /api/agents/:alias/prime) precedent.
    h = await buildApp({
      sling: async () => {
        throw new Error('boom');
      },
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 1,
      html_url: 'https://github.com/gastownhall/gascity/pull/1',
      intent: 'review',
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.kind, 'internal');

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.sling');
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.error_kind, 'unknown');
    assert.equal(parsed.target, 'mayor');
  });

  test('threads cityPath to execGcSling stub (gascity-dashboard-f0e)', async () => {
    h = await buildApp({ cityPath: '/home/ds/gas-city' });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/pull/47',
      intent: 'review',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.cityPath, '/home/ds/gas-city');
  });

  test('omits cityPath when option is unset (default behaviour preserved)', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/pull/47',
      intent: 'review',
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.cityPath, undefined);
  });

  test('extracts modern supervisor bead-id (gc-NNN) from multi-line Slung stdout (gascity-dashboard-wds)', async () => {
    // The wave-8nj regex anchored on "created bead <id>" — a stdout shape
    // gc sling no longer emits. The modern envelope mentions the bead id
    // in three places: the "Created", "Attached wisp", and "Slung" lines.
    // We anchor on the trailing "Slung <id>" summary because it's the one
    // line that always carries the routed bead id (and nothing else) at
    // line start.
    h = await buildApp({
      sling: async () => ({
        exitCode: 0,
        stdout: [
          'Created gc-255139 — "Please review PR https://github.com/gastownhall/gascity/pull/1"',
          'Auto-convoy gc-255141',
          'Attached wisp gc-255140 (formula "mol-focus-review") to gc-255139',
          'Slung gc-255139 (with default formula "mol-focus-review") → oversight-rig.chief-of-staff',
          '',
        ].join('\n'),
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
    assert.equal(res.body.bead_id, 'gc-255139');
  });

  test('stdout without Slung line returns 200 with bead_id omitted', async () => {
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

  test('id ending in a non-word char (-/.) is captured in full, not truncated', async () => {
    // Regression guard against the `\b` word-boundary edge case. The bd id
    // alphabet permits `.` and `-` as trailing characters. With `\b` the
    // regex would backtrack and drop the trailing non-word char silently;
    // `(?!\S)` keeps it. Live IDs today end in alphanumerics, so this is
    // forward-coverage against any future id-shape change upstream.
    h = await buildApp({
      sling: async () => ({
        exitCode: 0,
        stdout: [
          'Created gc-foo-bar- — "Please review PR ..."',
          'Slung gc-foo-bar- (with default formula "mol-focus-review") → oversight-rig.chief-of-staff',
          '',
        ].join('\n'),
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
    assert.equal(res.body.bead_id, 'gc-foo-bar-');
  });

  test('stdout with only Created/Attached lines (no Slung) returns bead_id omitted', async () => {
    // gascity-dashboard-wds negative case: confirms we don't fall back to
    // "Created" lines, which appear multiple times in the modern envelope
    // (Created, Attached wisp <id>, Auto-convoy <id>). A partial run that
    // creates beads but never reaches the Slung step should not pretend a
    // routing happened.
    h = await buildApp({
      sling: async () => ({
        exitCode: 0,
        stdout: [
          'Created gc-255139 — "Please review PR https://example/pull/1"',
          'Auto-convoy gc-255141',
          'Attached wisp gc-255140 (formula "mol-focus-review") to gc-255139',
          '',
        ].join('\n'),
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

// ── Slung-state persistence (gascity-dashboard-9qs) ──────────────────
//
// Successful slings must write the active-slung-state file so the
// next GET /triage's overlay can move the One Mark + render the
// inline workflow link. Failed slings must NOT write — slung state
// means "agent has the work."

function slungStatePathFor(handle: AppHandle): string {
  // Mirrors defaultSlungStatePath in routes/maintainer.ts: sibling of
  // the envelope cache. AppHandle exposes the cache via auditPath's
  // dir (both live in the same tmpDir).
  return path.join(path.dirname(handle.auditPath), 'slung-state.json');
}

describe('POST /api/maintainer/sling — slung-state persistence', { concurrency: false }, () => {
  let h: AppHandle;
  afterEach(async () => {
    if (h !== undefined) await h.close();
  });

  test('success path writes a slung-state entry keyed by kind:number', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/pull/47',
      intent: 'triage',
    });
    assert.equal(res.status, 200);

    const state = await readSlungState(slungStatePathFor(h));
    const entry = state['pr:47'];
    assert.ok(entry, 'expected slung-state entry for pr:47');
    assert.equal(entry.target, 'mayor');
    assert.equal(entry.bead_id, 'gc-255139');
    assert.match(entry.slung_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('success path persists bead_id: null when stdout has no parseable id', async () => {
    h = await buildApp({
      sling: async () => ({
        exitCode: 0,
        stdout: 'unrelated output\n',
        stderr: '',
        truncated: false,
        durationMs: 5,
      }),
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'issue',
      number: 99,
      html_url: 'https://github.com/gastownhall/gascity/issues/99',
      intent: 'triage',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.bead_id, undefined);

    const state = await readSlungState(slungStatePathFor(h));
    const entry = state['issue:99'];
    assert.ok(entry);
    assert.equal(entry.bead_id, null);
  });

  test('non-zero exit code does NOT write slung-state (sling failed)', async () => {
    h = await buildApp({
      sling: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'gc supervisor unreachable',
        truncated: false,
        durationMs: 10,
      }),
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 12,
      html_url: 'https://github.com/gastownhall/gascity/pull/12',
      intent: 'triage',
    });
    assert.equal(res.status, 502);

    const state = await readSlungState(slungStatePathFor(h));
    assert.equal(state['pr:12'], undefined);
  });

  test('thrown ExecError (timeout) does NOT write slung-state', async () => {
    h = await buildApp({
      sling: async () => {
        throw new ExecError('gc sling timed out', 'timeout');
      },
    });
    const res = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 13,
      html_url: 'https://github.com/gastownhall/gascity/pull/13',
      intent: 'triage',
    });
    assert.equal(res.status, 504);

    const state = await readSlungState(slungStatePathFor(h));
    assert.equal(state['pr:13'], undefined);
  });

  test('re-sling to same item overwrites existing entry with newer timestamp + target', async () => {
    h = await buildApp({ triageTarget: 'chief-of-staff' });
    await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 99,
      html_url: 'https://github.com/gastownhall/gascity/pull/99',
      intent: 'triage',
    });
    const firstState = await readSlungState(slungStatePathFor(h));
    const firstAt = firstState['pr:99']?.slung_at;
    assert.ok(firstAt);
    assert.equal(firstState['pr:99']?.target, 'chief-of-staff');

    // Re-sling with explicit override target.
    await new Promise((r) => setTimeout(r, 5));
    await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 99,
      html_url: 'https://github.com/gastownhall/gascity/pull/99',
      intent: 'triage',
      target: 'project-lead',
    });
    const secondState = await readSlungState(slungStatePathFor(h));
    const second = secondState['pr:99'];
    assert.ok(second, 'expected pr:99 entry after re-sling');
    assert.equal(second.target, 'project-lead');
    assert.ok(second.slung_at >= firstAt);
    assert.equal(Object.keys(secondState).length, 1);
  });

  test('successful sling fires the maintainer SSE refreshed event so frontends refetch within ~1s', async () => {
    h = await buildApp();
    // Open the SSE stream first so we don't miss the event.
    const ctrl = new AbortController();
    const stream = await fetch(`${h.url}/api/maintainer/events`, { signal: ctrl.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');

    // Sling. The route's notifyRefresh() should push to all open clients.
    const slingRes = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/pull/47',
      intent: 'triage',
    });
    assert.equal(slingRes.status, 200);

    // Drain enough bytes to capture the refreshed event (initial `: hello`
    // comment + the `event: refreshed` line). 200 bytes is overkill for
    // both, 2s window covers slow CI.
    const body = await readSseSome(stream, 200, 2_000);
    ctrl.abort();
    assert.match(body, /event: refreshed/, 'expected an SSE refreshed event after a successful sling');
  });
});

// ── GET /api/maintainer/triage — slung overlay (gascity-dashboard-9qs) ──
//
// End-to-end: write a cached envelope where one PR is the marked
// candidate, sling that PR, then GET /triage and assert the maroon
// dot moved off the slung item onto the next candidate. This is the
// integration test that proves splice-at-read closes the regression.

function makePr(overrides: Partial<TriageItem> & { number: number }): TriageItem {
  return {
    kind: 'pr',
    title: `PR ${overrides.number}`,
    status: 'needs_review',
    author: {
      login: 'sjarmak',
      tier: 'core',
      issues_accepted: null,
      issues_opened: null,
      prs_merged: null,
      prs_opened: null,
      computed_at: null,
    },
    created_at: '2026-05-24T00:00:00Z',
    updated_at: '2026-05-24T00:00:00Z',
    labels: ['kind/bug', 'priority/p0'],
    tier: 'regression_breaking',
    triage_score: 300,
    triage_assessment: null,
    slung: null,
    cluster_id: null,
    blast_files: [],
    lines_changed: 100,
    weak_ties: [],
    linked_numbers: [],
    html_url: `https://github.com/gastownhall/gascity/pull/${overrides.number}`,
    is_marked: true,
    ...overrides,
  };
}

function envelopeWithMarkedCandidates(items: TriageItem[]): MaintainerTriage {
  return {
    computed_at: '2026-05-24T00:00:00Z',
    repo: 'gastownhall/gascity',
    tiers: [
      { tier: 'regression_breaking', clusters: [], unclustered: items },
      { tier: 'regression', clusters: [], unclustered: [] },
      { tier: 'stability', clusters: [], unclustered: [] },
    ],
    totals: { issues_open: 0, prs_open: items.length },
  };
}

async function writeEnvelope(handle: AppHandle, envelope: MaintainerTriage): Promise<void> {
  await fs.writeFile(
    path.join(path.dirname(handle.auditPath), 'cache.json'),
    JSON.stringify(envelope, null, 2),
    'utf-8',
  );
}

describe('GET /api/maintainer/triage — slung overlay', { concurrency: false }, () => {
  let h: AppHandle;
  afterEach(async () => {
    if (h !== undefined) await h.close();
  });

  test('moves the One Mark off a slung PR onto the next candidate by sortScore', async () => {
    h = await buildApp();
    // Two regression_breaking PRs: 47 scores higher, would normally win
    // the mark. After slinging 47, the mark should land on 48.
    const top = makePr({ number: 47, triage_score: 320, lines_changed: 50 });
    const next = makePr({ number: 48, triage_score: 290, lines_changed: 200 });
    await writeEnvelope(h, envelopeWithMarkedCandidates([top, next]));

    // Pre-sling: cached envelope already has both marked candidates;
    // overlay's selectOneMark winnows to the top scorer (47).
    const before = await fetch(`${h.url}/api/maintainer/triage`).then((r) => r.json()) as MaintainerTriage;
    const beforeItems = before.tiers[0]!.unclustered;
    const marked = beforeItems.filter((it) => it.is_marked).map((it) => it.number);
    assert.deepEqual(marked, [47], 'pre-sling One Mark should be on 47');

    // Sling 47.
    const slingRes = await postJson(`${h.url}/api/maintainer/sling`, {
      kind: 'pr',
      number: 47,
      html_url: 'https://github.com/gastownhall/gascity/pull/47',
      intent: 'triage',
    });
    assert.equal(slingRes.status, 200);

    // GET overlay should now exclude 47 and put the mark on 48.
    const after = await fetch(`${h.url}/api/maintainer/triage`).then((r) => r.json()) as MaintainerTriage;
    const afterItems = after.tiers[0]!.unclustered;
    const slungItem = afterItems.find((it) => it.number === 47);
    const nextMarked = afterItems.find((it) => it.number === 48);

    assert.ok(slungItem?.slung, 'item 47 should carry slung state after the sling');
    assert.equal(slungItem!.slung.target, 'mayor');
    assert.equal(slungItem!.slung.bead_id, 'gc-255139');
    assert.equal(slungItem!.is_marked, false, 'slung item should not carry the mark');
    assert.equal(nextMarked?.is_marked, true, 'mark should move to the next candidate');
  });

  test('vetted item with stale slung-state entry: overlay forces slung=null', async () => {
    h = await buildApp();
    const vettedAndSlung = makePr({
      number: 50,
      triage_score: 280,
      triage_assessment: {
        vetted_score: 290,
        source: 'agent',
        notes: '',
        vetted_at: '2026-05-24T00:00:00Z',
      },
    });
    await writeEnvelope(h, envelopeWithMarkedCandidates([vettedAndSlung]));

    // Manually plant a stale slung-state entry (e.g. the worker sweep
    // hasn't purged it yet after the agent applied triage/vetted).
    await writeSlungEntry(slungStatePathFor(h), slungKey('pr', 50), {
      slung_at: '2026-05-23T00:00:00Z',
      target: 'chief-of-staff',
      bead_id: 'gc-stale',
    });

    const env = await fetch(`${h.url}/api/maintainer/triage`).then((r) => r.json()) as MaintainerTriage;
    const item = env.tiers[0]!.unclustered.find((it) => it.number === 50)!;
    assert.equal(item.slung, null, 'vetted-overrides-slung: overlay must zero out slung even if file says otherwise');
    // And the vetted item remains a mark candidate (it's not slung in the overlay's view).
    assert.equal(item.is_marked, true);
  });

  test('slung-state entry for an item no longer in the envelope: silently dropped, no error', async () => {
    h = await buildApp();
    await writeEnvelope(h, envelopeWithMarkedCandidates([makePr({ number: 60 })]));

    await writeSlungEntry(slungStatePathFor(h), slungKey('pr', 999), {
      slung_at: '2026-05-23T00:00:00Z',
      target: 'chief-of-staff',
      bead_id: 'gc-orphan',
    });

    const res = await fetch(`${h.url}/api/maintainer/triage`);
    assert.equal(res.status, 200);
    const env = await res.json() as MaintainerTriage;
    const item = env.tiers[0]!.unclustered.find((it) => it.number === 60)!;
    assert.equal(item.is_marked, true, 'item 60 still the mark; orphan slung-state for 999 is silently ignored');
  });
});
