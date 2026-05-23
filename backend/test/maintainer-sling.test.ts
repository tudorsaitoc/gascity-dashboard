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
    assert.equal(row.exit_code, undefined);
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
