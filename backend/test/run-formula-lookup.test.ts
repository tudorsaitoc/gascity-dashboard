import express from 'express';
import type { GcRunSnapshot } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { GcClient } from '../src/gc-client.js';
import { runsRouter } from '../src/routes/runs.js';
import { activeAdoptPrGraphV2Snapshot } from './fixtures/run-snapshots.js';

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

interface FakeSupervisor {
  baseUrl: string;
  requests: string[];
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

interface RunDetailProbe {
  formula: { kind: string; name?: string; reason?: string };
  formulaDetail: {
    kind: string;
    name?: string;
    target?: string;
    reason?: string;
    failure?: string;
  };
  completeness: { kind: string; reasons?: string[] };
}

describe('run formula detail lookup reasons', () => {
  let fake: FakeSupervisor;

  beforeEach(async () => {
    fake = await startFakeSupervisor();
  });

  afterEach(async () => {
    await fake.close();
  });

  test('reports missing formula metadata separately from formula fetch failures', async () => {
    const snapshot = formulaLookupSnapshot();
    const root = rootBead(snapshot);
    delete root.metadata['gc.formula'];
    delete root.metadata['gc.formula_name'];

    fake.setHandler((req, res) => {
      json(res);
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [], total: 0 }));
        return;
      }
      res.end(JSON.stringify(supervisorRunSnapshot(snapshot)));
    });

    const body = await fetchRunDetail(fake.baseUrl);

    assert.deepEqual(body.formula, {
      kind: 'unavailable',
      reason: 'missing_formula_metadata',
    });
    assert.deepEqual(body.formulaDetail, {
      kind: 'unavailable',
      reason: 'missing_formula_metadata',
    });
    assert.deepEqual(body.completeness, {
      kind: 'partial',
      reasons: ['formula_detail_missing_formula_metadata'],
    });
    assert.equal(fake.requests.some((request) => request.includes('/formulas/')), false);
  });

  test('preserves missing run target as the formula detail failure reason', async () => {
    const snapshot = formulaLookupSnapshot();
    const root = rootBead(snapshot);
    delete root.metadata['gc.run_target'];
    delete root.metadata['gc.routed_to'];
    delete root.assignee;

    fake.setHandler((req, res) => {
      json(res);
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [], total: 0 }));
        return;
      }
      res.end(JSON.stringify(supervisorRunSnapshot(snapshot)));
    });

    const body = await fetchRunDetail(fake.baseUrl);

    assert.deepEqual(body.formula, { kind: 'known', name: 'mol-adopt-pr-v2' });
    assert.deepEqual(body.formulaDetail, {
      kind: 'unavailable',
      reason: 'missing_run_target',
      name: 'mol-adopt-pr-v2',
    });
    assert.deepEqual(body.completeness, {
      kind: 'partial',
      reasons: ['formula_detail_missing_run_target'],
    });
    assert.equal(fake.requests.some((request) => request.includes('/formulas/')), false);
  });

  test('preserves supervisor formula API failures as fetch failures', async () => {
    const snapshot = formulaLookupSnapshot();

    fake.setHandler((req, res) => {
      json(res);
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [], total: 0 }));
        return;
      }
      if (req.url?.startsWith('/v0/city/racoon-city/formulas/mol-adopt-pr-v2?')) {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: 'formula API failed' }));
        return;
      }
      res.end(JSON.stringify(supervisorRunSnapshot(snapshot)));
    });

    const body = await fetchRunDetail(fake.baseUrl);

    assert.deepEqual(body.formula, { kind: 'known', name: 'mol-adopt-pr-v2' });
    assert.deepEqual(body.formulaDetail, {
      kind: 'unavailable',
      reason: 'fetch_failed',
      name: 'mol-adopt-pr-v2',
      target: 'racoon-city/codex',
      failure: 'upstream_error',
    });
    assert.deepEqual(body.completeness, {
      kind: 'partial',
      reasons: ['formula_detail_fetch_failed'],
    });
  });

  test('fetches formula detail when the root exposes Gas City gc.formula_name metadata', async () => {
    const snapshot = formulaLookupSnapshot();
    const root = rootBead(snapshot);
    delete root.metadata['gc.formula'];
    root.metadata['gc.formula_name'] = 'mol-adopt-pr-v2';

    fake.setHandler((req, res) => {
      json(res);
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [], total: 0 }));
        return;
      }
      if (respondFormulaDetail(req, res)) return;
      res.end(JSON.stringify(supervisorRunSnapshot(snapshot)));
    });

    const body = await fetchRunDetail(fake.baseUrl);

    assert.deepEqual(body.formula, { kind: 'known', name: 'mol-adopt-pr-v2' });
    assert.deepEqual(body.formulaDetail, {
      kind: 'available',
      name: 'mol-adopt-pr-v2',
      target: 'racoon-city/codex',
    });
    assert.deepEqual(body.completeness, { kind: 'complete' });
    assert.ok(
      fake.requests.some((request) =>
        request.startsWith('/v0/city/racoon-city/formulas/mol-adopt-pr-v2?'),
      ),
      `expected formula detail request, got: ${fake.requests.join(', ')}`,
    );
  });
});

function formulaLookupSnapshot(): GcRunSnapshot {
  const snapshot = structuredClone(activeAdoptPrGraphV2Snapshot);
  snapshot.run_id = 'gc-adopt-pr-active';
  snapshot.root_bead_id = 'gc-adopt-pr-active';
  snapshot.root_store_ref = 'rig:code-quality-review';
  snapshot.resolved_root_store = 'rig:code-quality-review';
  const root = rootBead(snapshot);
  root.metadata['gc.run_target'] = 'racoon-city/codex';
  return snapshot;
}

function rootBead(snapshot: GcRunSnapshot) {
  const root = snapshot.beads?.find((bead) => bead.id === snapshot.root_bead_id);
  assert.ok(root);
  return root;
}

function supervisorRunSnapshot(snapshot: GcRunSnapshot): Omit<GcRunSnapshot, 'run_id'> & { workflow_id: string } {
  const { run_id: runId, ...rest } = snapshot;
  return { ...rest, workflow_id: runId };
}

async function fetchRunDetail(fakeUrl: string): Promise<RunDetailProbe> {
  const { url, close } = await startApp(buildApp(fakeUrl));
  try {
    const res = await fetch(`${url}/api/runs/gc-adopt-pr-active`);
    assert.equal(res.status, 200);
    return await res.json() as RunDetailProbe;
  } finally {
    await close();
  }
}

function buildApp(fakeUrl: string): express.Express {
  const gc = new GcClient({
    baseUrl: fakeUrl,
    cityName: 'racoon-city',
    defaultTimeoutMs: 500,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/runs', runsRouter(gc, {}));
  return app;
}

function startFakeSupervisor(): Promise<FakeSupervisor> {
  return new Promise((resolve) => {
    let handler: Handler = (_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    };
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
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

function json(res: http.ServerResponse): void {
  res.setHeader('content-type', 'application/json');
}

function respondFormulaDetail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!req.url?.startsWith('/v0/city/racoon-city/formulas/mol-adopt-pr-v2?')) return false;
  res.end(JSON.stringify({
    name: 'mol-adopt-pr-v2',
    description: 'Adopt PR',
    version: 'test',
    var_defs: [],
    steps: [],
    deps: [],
    preview: { nodes: [], edges: [] },
  }));
  return true;
}
