import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mailSendRouter } from '../src/routes/mail-send.js';
import { setAuditLogPath } from '../src/audit.js';
import type { MailSendResponse } from 'gas-city-dashboard-shared';

// Tests for POST /api/mail-send.
//
// gascity-dashboard-mq2: mail send moved off the `gc mail send` subprocess to
// an HTTP POST /mail on the supervisor (injected `sendMail` fn). The route
// accepts sendMail via DI so tests can stub without module mocking; the stub
// returns the supervisor's Message shape (`id`) instead of an ExecResult.
// Audit assertions hit a tmp file via setAuditLogPath. concurrency:false
// because setAuditLogPath is global module state.

type MailSendStub = (
  to: string,
  subject: string,
  body: string,
) => Promise<MailSendResponse>;

interface StubCall {
  to: string;
  subject: string;
  body: string;
}

interface AppHandle {
  url: string;
  close: () => Promise<void>;
  auditPath: string;
  calls: StubCall[];
}

interface BuildOpts {
  mailSend?: MailSendStub;
}

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailsend-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  setAuditLogPath(auditPath);

  const calls: StubCall[] = [];
  // The supervisor's POST /mail returns the created Message; the route
  // surfaces only `id` as message_id.
  const defaultStub: MailSendStub = async () => ({
    id: 'td-wisp-abc123',
    from: 'human',
    to: 'recipient',
    subject: 'status',
    body: 'all green',
    created_at: '2026-05-26T00:00:00Z',
    read: false,
  });
  const mailSend: MailSendStub = async (to, subject, body) => {
    calls.push({ to, subject, body });
    return (opts.mailSend ?? defaultStub)(to, subject, body);
  };

  const app = express();
  app.use(express.json());
  app.use('/api/mail-send', mailSendRouter({ sendMail: mailSend }));

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

describe('POST /api/mail-send', { concurrency: false }, () => {
  let h: AppHandle | undefined;
  afterEach(async () => {
    if (h !== undefined) await h.close();
    h = undefined;
  });

  test('happy path: send dispatches via DI stub and audits without leaking body', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'status',
      body: 'all green',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.message_id, 'td-wisp-abc123');

    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.equal(call.to, 'mayor');
    assert.equal(call.subject, 'status');
    assert.equal(call.body, 'all green');

    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type, 'dashboard.send_mail');
    assert.equal(row.endpoint, 'POST /api/mail-send');
    assert.equal(row.actor, 'stephanie');
    // HTTP path no longer has a subprocess exit code; the row records
    // duration only on success.
    assert.equal(row.exit_code, undefined);
    assert.equal(typeof row.duration_ms, 'number');
    const parsed = row.parsed_args as Record<string, string>;
    assert.equal(parsed.to, 'mayor');
    assert.equal(parsed.subject_len, '6');
    assert.equal(parsed.body_len, '9');
    // Subject and body text must NEVER appear in the audit row.
    const flat = JSON.stringify(row);
    assert.ok(!flat.includes('all green'), 'audit row leaked body');
    assert.ok(!flat.includes('"subject":"status"'), 'audit row leaked subject');
    // Response carries only ok + message_id, not stdout/stderr.
    assert.equal(res.body.stdout, undefined, 'response leaked stdout');
    assert.equal(res.body.stderr, undefined, 'response leaked stderr');
    // The mail-send wire signature has no slot for `from`/`viewing_as` — by
    // design (security_researcher td-wisp-eb0pn). Make that explicit here so
    // a future refactor adding the parameter is loud.
    assert.ok(!('viewing_as' in parsed), 'audit row leaked viewing_as');
    assert.ok(!('from' in parsed), 'audit row leaked from');
  });

  test('invalid to-alias returns 400 before reaching exec', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'bad alias!!',
      subject: 'x',
      body: 'y',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('empty subject returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: '',
      body: 'y',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('oversize subject returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'x'.repeat(201),
      body: 'y',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('empty body returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'x',
      body: '',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  test('oversize body returns 400', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'x',
      body: 'y'.repeat(16 * 1024 + 1),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.equal(h.calls.length, 0);
  });

  // gascity-dashboard-mq2: an upstream failure (the supervisor returned
  // non-2xx, or a network error) surfaces as 502. GcClient throws
  // `gc supervisor returned NNN` (and fetch errors embed host:port) — the
  // wire must carry only details.name, never the raw message, mirroring the
  // maintainer sling redaction (gascity-dashboard-473/ayr).
  test('upstream failure surfaces as 502 with redacted details', async () => {
    const leakyErr = new Error('gc supervisor returned 500 at http://127.0.0.1:8372');
    leakyErr.name = 'UpstreamError';
    h = await buildApp({
      mailSend: async () => {
        throw leakyErr;
      },
    });
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'x',
      body: 'y',
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'upstream');
    const details = res.body.details as { name?: string; message?: string };
    assert.equal(details?.message, undefined, 'details.message must be redacted');
    assert.equal(details?.name, 'UpstreamError');
    const wire = JSON.stringify(res.body);
    assert.ok(!wire.includes('127.0.0.1'), `response leaks loopback: ${wire}`);
    assert.ok(!wire.includes('8372'), `response leaks supervisor port: ${wire}`);

    // The failure still leaves an audit row (forensic parity with success).
    const rows = await readAudit(h.auditPath);
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.parsed_args as Record<string, string>).error_kind, 'upstream');
  });

  test('timeout surfaces as 504', async () => {
    h = await buildApp({
      mailSend: async () => {
        // Mirror the shape GcClient produces on a per-request timeout.
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'x',
      body: 'y',
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.kind, 'timeout');
    assert.equal(h.calls.length, 1);
  });

  test('empty message id returns 200 with message_id omitted', async () => {
    h = await buildApp({
      mailSend: async () => ({
        id: '',
        from: 'human',
        to: 'recipient',
        subject: 'x',
        body: 'y',
        created_at: '2026-05-26T00:00:00Z',
        read: false,
      }),
    });
    const res = await postJson(`${h.url}/api/mail-send`, {
      to: 'mayor',
      subject: 'x',
      body: 'y',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.message_id, undefined);
  });
});
