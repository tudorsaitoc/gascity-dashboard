import express from 'express';
import type { GcRunSnapshot } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { GcClient } from '../src/gc-client.js';
import { runsRouter } from '../src/routes/runs.js';

const execFileAsync = promisify(execFile);

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

interface FakeSupervisor {
  baseUrl: string;
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

describe('run diff route', () => {
  let fake: FakeSupervisor;

  beforeEach(async () => {
    fake = await startFakeSupervisor();
  });

  afterEach(async () => {
    await fake.close();
  });

  test('does not serve the old dashboard formula-run detail mirror', async () => {
    let called = false;
    fake.setHandler((_req, res) => {
      called = true;
      json(res, graphV2Snapshot());
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/runs/gc-root`);
      assert.equal(res.status, 404);
      assert.equal(called, false);
    } finally {
      await close();
    }
  });

  test('returns unpushed, working tree, staged, and untracked changes for the server-owned execution path', async () => {
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'run-diff-remote-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'run-diff-'));
    await execFileAsync('git', ['-C', remote, 'init', '--bare']);
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
    await fs.mkdir(path.join(repo, '.beads'));
    await fs.mkdir(path.join(repo, '.gc'));
    await fs.writeFile(path.join(repo, '.beads', 'config.yaml'), 'tracked bead config\n');
    await fs.writeFile(path.join(repo, '.gc', 'settings.json'), '{}\n');
    await execFileAsync('git', [
      '-C',
      repo,
      'add',
      'README.md',
      '.beads/config.yaml',
      '.gc/settings.json',
    ]);
    await commit(repo);
    await execFileAsync('git', ['-C', repo, 'branch', '-M', 'main']);
    await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src', 'committed.ts'), 'export const committed = true;\n');
    await execFileAsync('git', ['-C', repo, 'add', 'src/committed.ts']);
    await commit(repo, 'committed ahead');
    await fs.writeFile(path.join(repo, 'README.md'), 'base\nnext\n');
    await fs.writeFile(path.join(repo, '.beads', 'config.yaml'), 'tracked bead config changed\n');
    await fs.writeFile(path.join(repo, '.gc', 'settings.json'), '{"changed":true}\n');
    await fs.writeFile(path.join(repo, '.beads', 'identity.toml'), 'id = "local"\n');
    await fs.writeFile(path.join(repo, '.gc', 'events.jsonl'), '{}\n');
    await fs.mkdir(path.join(repo, '.runtime'));
    await fs.writeFile(path.join(repo, '.runtime', 'session_id'), 'runtime-bug-visible\n');
    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'export const run = true;\n');
    await execFileAsync('git', ['-C', repo, 'add', 'src/index.ts']);
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, 'docs', 'plan.md'), '# Plan\n\nGenerated plan.\n');

    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot(repo));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl, '/should-not-be-used'));
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff?path=/tmp/evil`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'ok');
      assert.deepEqual(body.rootPath, { kind: 'known', path: await fs.realpath(repo) });
      assert.equal(body.comparison.kind, 'upstream');
      assert.equal(body.comparison.ref, 'origin/main');
      assert.deepEqual(body.changedFiles, [
        { path: '.runtime/session_id', status: '??', kind: 'other' },
        { path: 'docs/plan.md', status: '??', kind: 'docs' },
        { path: 'README.md', status: 'M', kind: 'docs' },
        { path: 'src/committed.ts', status: 'A', kind: 'code' },
        { path: 'src/index.ts', status: 'A', kind: 'code' },
      ]);
      assert.doesNotMatch(body.status.join('\n'), /\.beads|\.gc/);
      assert.match(body.patch, /^\+next$/m);
      assert.match(body.patch, /^\+export const committed = true;$/m);
      assert.match(body.patch, /^\+export const run = true;$/m);
      assert.match(body.patch, /^\+# Plan$/m);
      assert.match(body.patch, /^\+runtime-bug-visible$/m);
      assert.doesNotMatch(body.patch, /\.beads|\.gc/);
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(remote, { recursive: true, force: true });
    }
  });

  test('reports a HEAD comparison when no upstream branch is configured', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'run-no-upstream-'));
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
    await commit(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\nnext\n');
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, 'docs', 'plan.md'), '# Plan\n');

    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot(repo));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl, '/should-not-be-used'));
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'ok');
      assert.deepEqual(body.comparison, { kind: 'head', reason: 'no_upstream' });
      assert.deepEqual(body.changedFiles, [
        { path: 'docs/plan.md', status: '??', kind: 'docs' },
        { path: 'README.md', status: 'M', kind: 'docs' },
      ]);
      assert.match(body.patch, /^\+next$/m);
      assert.match(body.patch, /^\+# Plan$/m);
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  test('reports path_unknown when supervisor data has no execution folder or rig root', async () => {
    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot());
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'path_unknown');
      assert.deepEqual(body.rootPath, { kind: 'unavailable', reason: 'path_unknown' });
      assert.deepEqual(body.comparison, { kind: 'unavailable', reason: 'path_unknown' });
      assert.deepEqual(body.changedFiles, []);
    } finally {
      await close();
    }
  });

  test('quietly reports not_git for execution folders outside git', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-not-git-'));
    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot(dir));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'not_git');
      assert.deepEqual(body.rootPath, { kind: 'unavailable', reason: 'not_git' });
      assert.deepEqual(body.comparison, { kind: 'unavailable', reason: 'not_git' });
      assert.deepEqual(body.changedFiles, []);
    } finally {
      await close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // gascity-dashboard-k2b8: when RUN_CWD_ALLOWED_ROOTS is configured, a
  // supervisor-supplied work_dir outside every sanctioned root must be
  // refused before `git -C <cwd>` runs — defense-in-depth on the dashboard's
  // last shell-read. The refusal surfaces as the existing not_git shape (the
  // cwd validation throws and the root probe is the first git call).
  test('k2b8: refuses a run cwd outside the configured allowlist', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'run-allowlist-deny-'));
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
    await commit(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\nnext\n');

    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot(repo));
    });
    // The repo is a REAL git tree, but the allowlist sanctions an unrelated
    // root, so the diff must be refused. Because the cwd is a genuine repo,
    // `not_git` can only arise from the cwd refusal (the validation throws
    // before git runs) — were enforcement absent, the paired allow-test below
    // shows this exact setup yields kind 'ok'.
    const { url, close } = await startApp(
      buildApp(fake.baseUrl, '', ['/var/empty/sanctioned-root']),
    );
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'not_git', 'an out-of-allowlist cwd must not be read');
      assert.deepEqual(body.changedFiles, []);
      assert.equal(body.patch, '');
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  test('k2b8: serves the diff when the run cwd is under a configured allowed root', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'run-allowlist-allow-'));
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
    await commit(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\nnext\n');

    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot(repo));
    });
    // The cwd equals the sanctioned root, so the read proceeds normally.
    const { url, close } = await startApp(buildApp(fake.baseUrl, '', [repo]));
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'ok', 'an in-allowlist cwd must be served');
      assert.match(body.patch, /^\+next$/m);
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  test('marks large local-change patches as truncated', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'run-large-diff-'));
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'large.txt'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'large.txt']);
    await commit(repo);
    await fs.writeFile(path.join(repo, 'large.txt'), `${'x'.repeat(700 * 1024)}\n`);

    fake.setHandler((_req, res) => {
      json(res, graphV2Snapshot(repo));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/runs/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'ok');
      assert.equal(body.truncated, true);
      assert.ok(body.patch.length <= 512 * 1024);
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

async function commit(repo: string, message = 'base'): Promise<void> {
  await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    message,
  ]);
}

function buildApp(
  fakeUrl: string,
  rigRoot = '',
  runCwdAllowedRoots: readonly string[] = [],
): express.Express {
  const gc = new GcClient({
    baseUrl: fakeUrl,
    cityName: 'racoon-city',
    defaultTimeoutMs: 500,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/runs', runsRouter(gc, { rigRoot, runCwdAllowedRoots }));
  return app;
}

function graphV2Snapshot(workDir?: string): GcRunSnapshot {
  return {
    run_id: 'gc-root',
    root_bead_id: 'gc-root',
    root_store_ref: 'city:racoon-city',
    resolved_root_store: 'city:racoon-city',
    scope_kind: 'city',
    scope_ref: 'racoon-city',
    snapshot_version: 7,
    snapshot_event_seq: 42,
    partial: false,
    stores_scanned: ['city:racoon-city'],
    logical_nodes: [],
    logical_edges: [],
    scope_groups: [],
    beads: [
      {
        id: 'gc-root',
        title: 'Adopt PR #42',
        status: 'in_progress',
        kind: 'run',
        metadata: {
          'gc.kind': 'run',
          'gc.formula_contract': 'graph.v2',
          'gc.formula': 'mol-adopt-pr-v2',
          'gc.scope_kind': 'city',
          'gc.scope_ref': 'racoon-city',
          'gc.root_store_ref': 'city:racoon-city',
          ...(workDir ? { 'gc.work_dir': workDir } : {}),
        },
      },
    ],
    deps: [],
  };
}

function startFakeSupervisor(): Promise<FakeSupervisor> {
  return new Promise((resolve) => {
    let handler: Handler = (_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    };
    const server = http.createServer((req, res) => {
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setHandler(h: Handler) {
          handler = h;
        },
        close() {
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function json(res: http.ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(supervisorWireBody(body)));
}

function supervisorWireBody(body: unknown): unknown {
  if (!isRunSnapshotBody(body)) return body;
  const { run_id: runId, ...rest } = body;
  return { ...rest, workflow_id: runId };
}

function isRunSnapshotBody(body: unknown): body is GcRunSnapshot {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as { run_id?: unknown }).run_id === 'string' &&
    typeof (body as { root_bead_id?: unknown }).root_bead_id === 'string'
  );
}
