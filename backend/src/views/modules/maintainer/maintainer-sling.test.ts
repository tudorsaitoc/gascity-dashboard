import express from 'express';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { MaintainerTriage } from 'gas-city-dashboard-shared';
import { setAuditLogPath } from '../../../audit.js';
import { ExecError } from '../../../exec.js';
import { maintainerRouter } from './router.js';
import { makePr } from './fixtures/triage-item.js';
import { readSlungState, slungKey, writeSlungEntry } from './slung-state.js';

interface AppHandle {
  readonly url: string;
  readonly auditPath: string;
  readonly cachePath: string;
  readonly slungStatePath: string;
  readonly close: () => Promise<void>;
}

interface BuildOpts {
  readonly fetchTriage?: (repo: string) => Promise<MaintainerTriage>;
}

let h: AppHandle | undefined;

afterEach(async () => {
  if (h !== undefined) {
    await h.close();
    h = undefined;
  }
});

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintainer-route-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  const cachePath = path.join(tmpDir, 'cache.json');
  const slungStatePath = path.join(tmpDir, 'slung-state.json');
  setAuditLogPath(auditPath);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/maintainer',
    maintainerRouter({
      repo: 'gastownhall/gascity',
      cachePath,
      slungStatePath,
      ...(opts.fetchTriage === undefined ? {} : { fetchTriage: opts.fetchTriage }),
    }),
  );

  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        auditPath,
        cachePath,
        slungStatePath,
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

async function writeEnvelope(handle: AppHandle, envelope: MaintainerTriage): Promise<void> {
  await fs.writeFile(handle.cachePath, JSON.stringify(envelope, null, 2), 'utf-8');
}

function envelopeWithMarkedCandidates(numbers: readonly number[]): MaintainerTriage {
  const items = numbers.map((number) =>
    makePr({
      number,
      triage_score: 300 - number,
      lines_changed: 50,
    }),
  );
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

describe('Maintainer sling route boundary', { concurrency: false }, () => {
  test('does not mount the old dashboard-supervisor sling facade', async () => {
    h = await buildApp();

    const res = await fetch(`${h.url}/api/maintainer/sling`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'pr',
        number: 47,
        html_url: 'https://github.com/gastownhall/gascity/pull/47',
        intent: 'triage',
      }),
    });

    assert.equal(res.status, 404);
    assert.deepEqual(await readAudit(h.auditPath), []);
    assert.deepEqual(await readSlungState(h.slungStatePath), {});
  });

  test('records browser-generated supervisor sling results without supervisor IO', async () => {
    h = await buildApp();

    const res = await postJson(`${h.url}/api/maintainer/sling-record`, {
      kind: 'pr',
      number: 47,
      intent: 'triage',
      target: 'chief-of-staff',
      bead_id: 'gc-255139',
      resolved_session_name: 'oversight-rig__chief-of-staff',
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, bead_id: 'gc-255139' });

    const state = await readSlungState(h.slungStatePath);
    const entry = state['pr:47'];
    assert.ok(entry);
    assert.equal(entry.target, 'chief-of-staff');
    assert.equal(entry.bead_id, 'gc-255139');
    assert.equal(entry.resolved_session_name, 'oversight-rig__chief-of-staff');

    const [audit] = await readAudit(h.auditPath);
    assert.equal(audit?.type, 'dashboard.sling');
    assert.equal(audit?.endpoint, 'POST /api/maintainer/sling-record');
  });

  test('record route rejects malformed record payloads before touching disk', async () => {
    h = await buildApp();

    const res = await postJson(`${h.url}/api/maintainer/sling-record`, {
      kind: 'pr',
      number: 47,
      intent: 'triage',
      target: '../bad',
      bead_id: 'gc-255139',
      resolved_session_name: null,
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.kind, 'validation');
    assert.deepEqual(await readSlungState(h.slungStatePath), {});
  });
});

describe('GET /api/maintainer/triage — slung overlay', { concurrency: false }, () => {
  test('moves the One Mark off a slung PR onto the next candidate by sortScore', async () => {
    h = await buildApp();
    await writeEnvelope(h, envelopeWithMarkedCandidates([47, 48]));

    const before = (await fetch(`${h.url}/api/maintainer/triage`).then((r) =>
      r.json(),
    )) as MaintainerTriage;
    assert.deepEqual(
      before.tiers[0]?.unclustered.filter((it) => it.is_marked).map((it) => it.number),
      [47],
    );

    await writeSlungEntry(h.slungStatePath, slungKey('pr', 47), {
      slung_at: '2026-05-24T00:00:00Z',
      target: 'chief-of-staff',
      bead_id: 'gc-255139',
      resolved_session_name: 'oversight-rig__chief-of-staff',
    });

    const after = (await fetch(`${h.url}/api/maintainer/triage`).then((r) =>
      r.json(),
    )) as MaintainerTriage;
    const afterItems = after.tiers[0]?.unclustered ?? [];
    assert.equal(
      afterItems.find((it) => it.number === 47),
      undefined,
    );
    assert.equal(afterItems.find((it) => it.number === 48)?.is_marked, true);
    const slungItem = after.slung_section?.find((it) => it.number === 47);
    assert.ok(slungItem?.slung);
    assert.equal(slungItem.slung.target, 'chief-of-staff');
    assert.equal(slungItem.slung.bead_id, 'gc-255139');
    assert.equal(slungItem.slung.resolved_session_name, 'oversight-rig__chief-of-staff');
    assert.equal(slungItem.run_id, 'gc-255139');
  });

  test('corrupt triage cache returns an explicit server error, not an empty envelope', async () => {
    h = await buildApp();
    await fs.writeFile(h.cachePath, '{not-json', 'utf-8');

    const res = await fetch(`${h.url}/api/maintainer/triage`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; kind?: string };
    assert.equal(body.kind, 'internal');
    assert.equal(body.error, 'maintainer triage cache unavailable');
  });
});

describe('GET /api/maintainer/contributor/:login', { concurrency: false }, () => {
  test('corrupt cache returns a clean 500, not a hung request', async () => {
    h = await buildApp();
    await fs.writeFile(h.cachePath, '{not-json', 'utf-8');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    try {
      const res = await fetch(`${h.url}/api/maintainer/contributor/octocat`, {
        signal: ctrl.signal,
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error?: string; kind?: string };
      assert.equal(body.kind, 'internal');
      assert.equal(body.error, 'maintainer contributor cache unavailable');
    } finally {
      clearTimeout(timer);
    }
  });

  test('missing cache still returns 404 not_found', async () => {
    h = await buildApp();

    const res = await fetch(`${h.url}/api/maintainer/contributor/octocat`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string; kind?: string };
    assert.equal(body.kind, 'not_found');
    assert.equal(body.error, 'no triage cache yet');
  });
});

describe('POST /api/maintainer/refresh — redaction', { concurrency: false }, () => {
  test('502 response redacts raw err.message from non-ExecError failures', async () => {
    const leakyErr = new Error('connect ECONNREFUSED 127.0.0.1:1 (interface lo) at /var/run/sock');
    leakyErr.name = 'FetchError';
    h = await buildApp({
      fetchTriage: async () => {
        throw leakyErr;
      },
    });

    const res = await fetch(`${h.url}/api/maintainer/refresh`, {
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
    assert.equal(body.details?.message, undefined);
    assert.equal(body.details?.name, 'FetchError');
    assert.ok(!text.includes('ECONNREFUSED'), `response leaks ECONNREFUSED: ${text}`);
    assert.ok(!text.includes('127.0.0.1:1'), `response leaks upstream host:port: ${text}`);
    assert.ok(!text.includes('/var/run/sock'), `response leaks file path: ${text}`);
  });

  test('502 response redacts spawn-arm host path from ExecError', async () => {
    h = await buildApp({
      fetchTriage: async () => {
        throw new ExecError('spawn failed: spawn /home/ds/.local/bin/gh ENOENT', 'spawn');
      },
    });

    const res = await fetch(`${h.url}/api/maintainer/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    assert.equal(res.status, 502);
    const text = await res.text();
    const body = JSON.parse(text) as { kind?: string; error?: string };
    assert.equal(body.kind, 'spawn');
    assert.ok(!text.includes('/home/ds'), `response leaks operator home: ${text}`);
    assert.ok(!text.includes('.local/bin'), `response leaks binary path: ${text}`);
    assert.ok(!text.includes('ENOENT'), `response leaks spawn detail: ${text}`);
  });
});
