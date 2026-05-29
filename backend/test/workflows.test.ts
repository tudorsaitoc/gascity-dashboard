import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { GcClient } from '../src/gc-client.js';
import { workflowsRouter } from '../src/routes/workflows.js';
import { sessionStreamRouter } from '../src/routes/session-stream.js';
import type { GcBead, GcWorkflowSnapshot } from 'gas-city-dashboard-shared';

const execFileAsync = promisify(execFile);

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

interface FakeSupervisor {
  baseUrl: string;
  requests: string[];
  setHandler(h: Handler): void;
  liveConnections(): number;
  close(): Promise<void>;
}

function startFakeSupervisor(): Promise<FakeSupervisor> {
  return new Promise((resolve) => {
    let handler: Handler = (_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    };
    const requests: string[] = [];
    const sockets = new Set<import('node:net').Socket>();
    let live = 0;
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      live++;
      res.on('close', () => {
        live--;
      });
      handler(req, res);
    });
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        setHandler(h: Handler) {
          handler = h;
        },
        liveConnections() {
          return live;
        },
        close() {
          for (const sock of sockets) sock.destroy();
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

async function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

function buildApp(fakeUrl: string, rigRoot = ''): express.Express {
  const gc = new GcClient({
    baseUrl: fakeUrl,
    cityName: 'racoon-city',
    defaultTimeoutMs: 500,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', workflowsRouter(gc, { rigRoot }));
  app.use('/api/sessions', sessionStreamRouter({
    gc,
    heartbeatMs: 10_000,
  }));
  return app;
}

function graphV2Snapshot(workDir?: string): GcWorkflowSnapshot {
  return {
    workflow_id: 'gc-root',
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
        kind: 'workflow',
        metadata: {
          'gc.kind': 'workflow',
          'gc.formula_contract': 'graph.v2',
          'gc.formula': 'mol-adopt-pr-v2',
          'gc.scope_kind': 'city',
          'gc.scope_ref': 'racoon-city',
          'gc.root_store_ref': 'city:racoon-city',
          'gc.run_target': 'racoon-city/codex',
          ...(workDir ? { 'gc.work_dir': workDir } : {}),
        },
      },
      {
        id: 'gc-loop-1',
        title: 'Review Loop',
        status: 'in_progress',
        kind: 'ralph',
        step_ref: 'mol-adopt-pr-v2.review-loop',
        metadata: {
          'gc.kind': 'ralph',
          'gc.step_ref': 'mol-adopt-pr-v2.review-loop',
          'gc.max_attempts': '3',
        },
      },
      {
        id: 'gc-codex-iter1',
        title: 'Codex Review',
        status: 'closed',
        assignee: 'gc-session-a',
        kind: 'task',
        step_ref: 'mol-adopt-pr-v2.review-loop.iteration.1.review-codex',
        attempt: 1,
        logical_bead_id: 'review-codex',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'review-codex',
          'gc.step_ref': 'mol-adopt-pr-v2.review-loop.iteration.1.review-codex',
          'gc.attempt': '1',
          session_name: 'codex-review-1',
        },
      },
      {
        id: 'gc-codex-iter2',
        title: 'Codex Review',
        status: 'in_progress',
        assignee: 'gc-session-b',
        kind: 'task',
        step_ref: 'mol-adopt-pr-v2.review-loop.iteration.2.review-codex',
        attempt: 2,
        logical_bead_id: 'review-codex',
        metadata: {
          'gc.kind': 'task',
          'gc.step_id': 'review-codex',
          'gc.step_ref': 'mol-adopt-pr-v2.review-loop.iteration.2.review-codex',
          'gc.attempt': '2',
          session_name: 'codex-review-2',
        },
      },
      {
        id: 'gc-scope-check',
        title: 'Review scope check',
        status: 'closed',
        kind: 'scope-check',
        step_ref: 'mol-adopt-pr-v2.review-loop.iteration.2.review-codex-scope-check',
        metadata: {
          'gc.kind': 'scope-check',
          'gc.step_ref': 'mol-adopt-pr-v2.review-loop.iteration.2.review-codex-scope-check',
        },
      },
    ],
    deps: [
      { from: 'gc-loop-1', to: 'gc-codex-iter2', kind: 'execution' },
    ],
  };
}

function runtimeBead(
  id: string,
  status: string,
  assignee?: string,
  metadata: Record<string, unknown> = {},
): GcBead {
  const bead: GcBead = {
    id,
    title: id,
    status,
    issue_type: 'task',
    priority: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    metadata,
  };
  if (assignee) bead.assignee = assignee;
  return bead;
}

function respondJson(
  res: http.ServerResponse,
  body: unknown,
  statusCode = 200,
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function respondMissingFormulaDetail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!req.url?.startsWith('/v0/city/racoon-city/formulas/')) return false;
  respondJson(res, { error: 'not found' }, 404);
  return true;
}

describe('workflows detail route', () => {
  let fake: FakeSupervisor;

  beforeEach(async () => {
    fake = await startFakeSupervisor();
  });

  afterEach(async () => {
    await fake.close();
  });

  test('returns graph.v2 display nodes without exposing internal ralph terminology', async () => {
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (respondMissingFormulaDetail(req, res)) return;
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.end(JSON.stringify(graphV2Snapshot()));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root?scope_kind=city&scope_ref=racoon-city`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.workflowId, 'gc-root');
      assert.deepEqual(body.formula, { kind: 'known', name: 'mol-adopt-pr-v2', source: 'metadata' });
      assert.equal(body.snapshotVersion, 7);
      assert.ok(
        fake.requests.includes('/v0/city/racoon-city/workflow/gc-root?scope_kind=city&scope_ref=racoon-city'),
        `unexpected upstream requests: ${fake.requests.join(', ')}`,
      );

      const wire = JSON.stringify(body).toLowerCase();
      assert.equal(wire.includes('ralph'), false);

      const loopNode = body.nodes.find((node: { constructKind?: string }) => node.constructKind === 'check-loop');
      assert.ok(loopNode, 'expected check-loop display node');

      const codexNode = body.nodes.find((node: { semanticNodeId?: string }) => node.semanticNodeId === 'review-codex');
      assert.ok(codexNode, 'expected semantic review-codex node');
      assert.deepEqual(codexNode.iterationSummary, {
        kind: 'stacked',
        visibleIteration: 2,
        iterationCount: 2,
        control: { kind: 'known', id: 'review-loop' },
      });
      assert.equal(codexNode.executionInstances.length, 2);
      assert.equal(codexNode.executionInstances[0].historical, true);
      assert.equal(codexNode.executionInstances[1].currentIteration, true);
      assert.equal(codexNode.executionInstances[1].session.kind, 'attached');
      assert.equal(codexNode.executionInstances[1].session.streamable, true);
      assert.equal(codexNode.executionInstances[1].session.link.sessionId, 'gc-session-b');
      assert.ok(
        codexNode.controlBadges.some((badge: { label?: string }) => badge.label === 'scope check'),
        'expected scope-check to collapse into a badge',
      );
    } finally {
      await close();
    }
  });

  test('rejects invalid workflow ids before calling supervisor', async () => {
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/../../etc/passwd`);
      assert.equal(res.status, 404);
      assert.equal(fake.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('rejects invalid workflow ids and scope params before calling supervisor', async () => {
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      for (const path of [
        '/api/workflows/bad$id',
        '/api/workflows/gc-root?scope_kind=workspace&scope_ref=racoon-city',
        '/api/workflows/gc-root?scope_kind=city&scope_ref=../racoon-city',
        '/api/workflows/gc-root?scope_kind=city',
        '/api/workflows/gc-root?scope_ref=racoon-city',
        '/api/workflows/gc-root?scope_kind=city&scope_kind=rig&scope_ref=racoon-city',
        '/api/workflows/gc-root?scope_kind=city&scope_ref=racoon-city&scope_ref=other',
        '/api/workflows/gc-root?scope_kind=city&scope_kind=rig&scope_ref=racoon-city&scope_ref=other',
      ]) {
        const res = await fetch(`${url}${path}`);
        assert.equal(res.status, 400, path);
        const body = await res.json();
        assert.equal(body.kind, 'validation', path);
      }
      assert.equal(fake.requests.length, 0);
    } finally {
      await close();
    }
  });

  test('defaults unscoped detail requests to the dashboard city scope', async () => {
    fake.setHandler((req, res) => {
      if (respondMissingFormulaDetail(req, res)) return;
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        res.setHeader('content-type', 'application/json');
        const id = req.url.split('/').pop() ?? 'gc-root';
        res.end(JSON.stringify(runtimeBead(id, 'pending')));
        return;
      }
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      assert.equal(req.url, '/v0/city/racoon-city/workflow/gc-root?scope_kind=city&scope_ref=racoon-city');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(graphV2Snapshot()));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root`);
      assert.equal(res.status, 200);
      assert.ok(fake.requests.includes('/v0/city/racoon-city/workflow/gc-root?scope_kind=city&scope_ref=racoon-city'));
      assert.ok(fake.requests.some((request) => request === '/v0/city/racoon-city/bead/gc-root'));
    } finally {
      await close();
    }
  });

  test('orders detail nodes by supervisor formula preview when the run exposes its formula', async () => {
    const snapshot = graphV2Snapshot();
    snapshot.beads = [
      snapshot.beads?.[0],
      {
        id: 'review-attempt-1',
        title: 'Review plan iteration 1',
        status: 'pending',
        kind: 'task',
        step_ref: 'mol-demo-plan-review.plan-cycle.iter1.review.iteration.1',
        logical_bead_id: 'review-control-1',
        metadata: {
          'gc.logical_bead_id': 'review-control-1',
          'gc.step_ref': 'mol-demo-plan-review.plan-cycle.iter1.review.iteration.1',
        },
      },
      {
        id: 'inspect-bead',
        title: 'Inspect scaffold',
        status: 'pending',
        kind: 'task',
        step_ref: 'mol-demo-plan-review.inspect',
        metadata: {
          'gc.step_ref': 'mol-demo-plan-review.inspect',
        },
      },
      {
        id: 'review-control-1',
        title: 'Review plan iteration 1',
        status: 'pending',
        kind: 'ralph',
        step_ref: 'mol-demo-plan-review.plan-cycle.iter1.review',
        metadata: {
          'gc.kind': 'ralph',
          'gc.step_ref': 'mol-demo-plan-review.plan-cycle.iter1.review',
        },
      },
      {
        id: 'draft-bead',
        title: 'Draft plan iteration 1',
        status: 'pending',
        kind: 'task',
        step_ref: 'mol-demo-plan-review.plan-cycle.iter1.draft',
        metadata: {
          'gc.step_ref': 'mol-demo-plan-review.plan-cycle.iter1.draft',
        },
      },
    ].filter((bead): bead is NonNullable<typeof bead> => bead !== undefined);
    const root = snapshot.beads[0];
    assert.ok(root);
    root.title = 'Plan demo';
    root.metadata = {
      ...root.metadata,
      'gc.formula': 'mol-demo-plan-review',
      'gc.run_target': 'racoon-city/codex',
    };
    snapshot.deps = [];
    const beadById = new Map(snapshot.beads.map((bead) => [bead.id, bead]));

    fake.setHandler((req, res) => {
      if (req.url === '/v0/city/racoon-city/sessions') {
        respondJson(res, { items: [] });
        return;
      }
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        const id = req.url.split('/').pop() ?? '';
        respondJson(res, beadById.get(id) ?? runtimeBead(id, 'pending'));
        return;
      }
      if (
        req.url ===
        '/v0/city/racoon-city/formulas/mol-demo-plan-review?scope_kind=city&scope_ref=racoon-city&target=racoon-city%2Fcodex'
      ) {
        respondJson(res, {
          name: 'mol-demo-plan-review',
          preview: {
            nodes: [
              { id: 'mol-demo-plan-review.inspect', title: 'Inspect scaffold', kind: 'task' },
              { id: 'mol-demo-plan-review.plan-cycle.iter1.draft', title: 'Draft plan iteration 1', kind: 'task' },
              { id: 'mol-demo-plan-review.plan-cycle.iter1.review.iteration.1', title: 'Review plan iteration 1', kind: 'task' },
              { id: 'mol-demo-plan-review.plan-cycle.iter1.review', title: 'Review plan iteration 1', kind: 'ralph' },
            ],
            edges: [],
          },
        });
        return;
      }
      assert.equal(req.url, '/v0/city/racoon-city/workflow/gc-root?scope_kind=city&scope_ref=racoon-city');
      respondJson(res, snapshot);
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(
        body.nodes.map((node: { semanticNodeId?: string }) => node.semanticNodeId),
        ['gc-root', 'inspect', 'draft', 'review-control-1'],
      );
    } finally {
      await close();
    }
  });

  test('overlays stale workflow snapshot statuses with live supervisor bead state', async () => {
    const staleSnapshot = graphV2Snapshot();
    staleSnapshot.beads = staleSnapshot.beads?.map((bead) => ({
      ...bead,
      status: 'pending',
    })) ?? [];
    const runtimeById = new Map([
      ['gc-root', runtimeBead('gc-root', 'in_progress')],
      [
        'gc-codex-iter1',
        runtimeBead('gc-codex-iter1', 'closed', 'gc-session-a', {
          session_name: 'codex-review-1',
        }),
      ],
      [
        'gc-codex-iter2',
        runtimeBead('gc-codex-iter2', 'in_progress', 'gc-session-b', {
          session_name: 'codex-review-2',
          'gc.step_ref': 'runtime.metadata.must.not.replace.graph.shape',
        }),
      ],
    ]);
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        const id = req.url.split('/').pop() ?? '';
        res.end(JSON.stringify(runtimeById.get(id) ?? runtimeBead(id, 'pending')));
        return;
      }
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.end(JSON.stringify(staleSnapshot));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root?scope_kind=city&scope_ref=racoon-city`);
      assert.equal(res.status, 200);
      const body = await res.json();

      const rootNode = body.nodes.find((node: { id?: string }) => node.id === 'gc-root');
      assert.equal(rootNode?.status, 'ready');

      const codexNode = body.nodes.find((node: { semanticNodeId?: string }) => node.semanticNodeId === 'review-codex');
      assert.equal(codexNode?.status, 'active');
      assert.equal(codexNode?.executionInstances[0].status, 'completed');
      assert.equal(codexNode?.executionInstances[1].status, 'active');
      assert.equal(codexNode?.executionInstances[1].session.kind, 'attached');
      assert.equal(codexNode?.executionInstances[1].session.streamable, true);
      assert.equal(codexNode?.executionInstances[1].session.link.sessionId, 'gc-session-b');
    } finally {
      await close();
    }
  });

  test('does not mark an unassigned workflow root active or attach a dispatcher transcript', async () => {
    const snapshot = graphV2Snapshot();
    snapshot.scope_kind = 'rig';
    snapshot.scope_ref = 'tic-tac-toe-app';
    // rig SCOPE with a city STORE: the workflow is resolved under the rig scope
    // but its beads live in the city store, so they remain refreshable via
    // /v0/city/{city}/bead/{id}. Scope and store are independent dimensions
    // (gascity-dashboard-sd9). This test exercises rig-scope session resolution
    // over the live per-bead refresh path; the non-city-store skip is covered
    // by its own dedicated tests below.
    snapshot.root_store_ref = 'city:racoon-city';
    snapshot.resolved_root_store = 'city:racoon-city';
    snapshot.stores_scanned = ['city:racoon-city'];
    snapshot.beads = snapshot.beads?.map((bead) =>
      bead.id === 'gc-root'
        ? {
            ...bead,
            status: 'pending',
            metadata: {
              ...bead.metadata,
              'gc.scope_kind': 'rig',
              'gc.scope_ref': 'tic-tac-toe-app',
              'gc.root_store_ref': 'city:racoon-city',
              'gc.run_target': 'tic-tac-toe-app/codex',
            },
          }
        : bead,
    ) ?? [];
    const runtimeById = new Map([
      [
        'gc-root',
        runtimeBead('gc-root', 'in_progress', undefined, {
          'gc.scope_kind': 'rig',
          'gc.scope_ref': 'tic-tac-toe-app',
          'gc.root_store_ref': 'rig:tic-tac-toe-app',
          'gc.run_target': 'tic-tac-toe-app/codex',
        }),
      ],
    ]);
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({
          items: [
            {
              id: 'fddc-g3v',
              template: 'tic-tac-toe-app/codex',
              alias: 'tic-tac-toe-app/codex-1',
              title: 'tic-tac-toe-app/codex-1',
              state: 'active',
              session_name: 'codex-fddc-g3v',
              created_at: '2026-05-26T02:50:29Z',
              attached: false,
              rig: 'tic-tac-toe-app',
              pool: 'codex',
              agent_kind: 'pool',
              running: true,
            },
            {
              id: 'fddc-pe6',
              template: 'tic-tac-toe-app/control-dispatcher',
              alias: 'tic-tac-toe-app/control-dispatcher',
              title: 'tic-tac-toe-app/control-dispatcher',
              state: 'active',
              session_name: 'tic-tac-toe-app--control-dispatcher',
              created_at: '2026-05-26T02:47:19Z',
              attached: false,
              rig: 'tic-tac-toe-app',
              agent_kind: 'role',
              running: true,
            },
          ],
        }));
        return;
      }
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        const id = req.url.split('/').pop() ?? '';
        res.end(JSON.stringify(runtimeById.get(id) ?? runtimeBead(id, 'pending')));
        return;
      }
      res.end(JSON.stringify(snapshot));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root?scope_kind=rig&scope_ref=tic-tac-toe-app`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const rootNode = body.nodes.find((node: { id?: string }) => node.id === 'gc-root');
      assert.equal(rootNode?.status, 'ready');
      assert.deepEqual(rootNode?.executionInstances[0].session, {
        kind: 'none',
        reason: 'not_started',
      });
    } finally {
      await close();
    }
  });

  test('resolves a running node assignee to the concrete supervisor session id', async () => {
    const snapshot = graphV2Snapshot();
    snapshot.scope_kind = 'rig';
    snapshot.scope_ref = 'tic-tac-toe-app';
    // rig SCOPE, city STORE — beads stay refreshable (see the note above).
    snapshot.root_store_ref = 'city:racoon-city';
    snapshot.resolved_root_store = 'city:racoon-city';
    snapshot.stores_scanned = ['city:racoon-city'];
    snapshot.beads = snapshot.beads?.map((bead) => {
      if (bead.id !== 'gc-codex-iter2') return bead;
      const { assignee: _assignee, metadata: beadMetadata, ...rest } = bead;
      const { session_name: _sessionName, ...metadata } = beadMetadata;
      return {
        ...rest,
        status: 'pending',
        metadata: {
          ...metadata,
          'gc.run_target': 'tic-tac-toe-app/codex',
        },
      };
    }) ?? [];
    const runtimeById = new Map([
      [
        'gc-codex-iter2',
        runtimeBead('gc-codex-iter2', 'in_progress', 'tic-tac-toe-app/codex-1', {
          'gc.run_target': 'tic-tac-toe-app/codex',
        }),
      ],
    ]);
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({
          items: [
            {
              id: 'fddc-g3v',
              template: 'tic-tac-toe-app/codex',
              alias: 'tic-tac-toe-app/codex-1',
              title: 'tic-tac-toe-app/codex-1',
              state: 'active',
              created_at: '2026-05-26T02:50:29Z',
              attached: false,
              rig: 'tic-tac-toe-app',
              pool: 'codex',
              agent_kind: 'pool',
              running: true,
            },
          ],
        }));
        return;
      }
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        const id = req.url.split('/').pop() ?? '';
        res.end(JSON.stringify(runtimeById.get(id) ?? runtimeBead(id, 'pending')));
        return;
      }
      res.end(JSON.stringify(snapshot));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root?scope_kind=rig&scope_ref=tic-tac-toe-app`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const codexNode = body.nodes.find((node: { semanticNodeId?: string }) => node.semanticNodeId === 'review-codex');
      const currentInstance = codexNode?.executionInstances.find(
        (instance: { currentIteration?: boolean }) => instance.currentIteration,
      );
      assert.equal(currentInstance?.status, 'active');
      assert.deepEqual(currentInstance?.session, {
        kind: 'attached',
        streamable: true,
        link: {
          sessionId: 'fddc-g3v',
          sessionName: 'tic-tac-toe-app/codex-1',
          assignee: 'tic-tac-toe-app/codex-1',
        },
      });
      assert.deepEqual(body.progress, {
        snapshotVersion: 7,
        snapshotEventSeq: { kind: 'known', seq: 42 },
        partial: false,
        totalNodeCount: 3,
        visibleNodeCount: 3,
        edgeCount: 1,
        executionInstanceCount: 4,
        sessionLinkCount: 1,
        streamableSessionCount: 1,
        streamableSessionIds: ['fddc-g3v'],
        statusCounts: {
          active: 1,
          ready: 2,
        },
        allStatusCounts: {
          active: 1,
          ready: 2,
        },
      });
    } finally {
      await close();
    }
  });

  test('skips per-bead refresh for a non-city-store workflow and does not flag partial', async () => {
    // Regression for gascity-dashboard-6zz: a rig-store-backed workflow's beads
    // are NOT addressable via /v0/city/{city}/bead/{id} (the supervisor exposes
    // no rig bead endpoint), so the old code fired N /bead reads that all 404'd
    // and flagged the run permanently 'partial'. The fix treats the embedded
    // snapshot rows as authoritative and skips the refresh entirely.
    const snapshot = graphV2Snapshot();
    snapshot.scope_kind = 'city';
    snapshot.scope_ref = 'racoon-city';
    snapshot.root_store_ref = 'rig:codeprobe';
    snapshot.resolved_root_store = 'rig:codeprobe';
    snapshot.stores_scanned = ['rig:codeprobe'];
    snapshot.beads = snapshot.beads?.map((bead) =>
      bead.id === 'gc-root'
        ? { ...bead, metadata: { ...bead.metadata, 'gc.root_store_ref': 'rig:codeprobe' } }
        : bead,
    ) ?? [];
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (respondMissingFormulaDetail(req, res)) return;
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        // No rig bead endpoint exists upstream; the supervisor 404s these.
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: 'bead not found' }));
        return;
      }
      res.end(JSON.stringify(snapshot));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root`);
      assert.equal(res.status, 200);
      const body = await res.json();
      // Not degraded: the embedded rows are the intended source for a
      // non-city-store run, so the route must not raise the partial badge
      // (the snapshot's own partial:false flows through unchanged).
      assert.notEqual(body.partial, true);
      // Crucially, the route must not have attempted ANY /bead read.
      assert.equal(
        fake.requests.some((request) => request.startsWith('/v0/city/racoon-city/bead/')),
        false,
        `expected no /bead reads, got: ${fake.requests.join(', ')}`,
      );
      // Embedded status still drives the view: gc-codex-iter2 carries
      // status=in_progress + assignee in the snapshot, so its node is active
      // even though no /bead refresh ran.
      const codexNode = body.nodes.find(
        (node: { semanticNodeId?: string }) => node.semanticNodeId === 'review-codex',
      );
      assert.equal(codexNode?.status, 'active');
    } finally {
      await close();
    }
  });

  test('still refreshes per-bead and flags partial when a city-store bead read fails', async () => {
    // Counterpart to the skip above: genuine city workflows keep the
    // allSettled refresh, so a transient subset failure still surfaces partial.
    const snapshot = graphV2Snapshot();
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (respondMissingFormulaDetail(req, res)) return;
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      if (req.url?.startsWith('/v0/city/racoon-city/bead/')) {
        const id = req.url.split('/').pop() ?? '';
        if (id === 'gc-codex-iter2') {
          res.statusCode = 500;
          res.end(JSON.stringify({ detail: 'transient' }));
          return;
        }
        res.end(JSON.stringify(runtimeBead(id, 'pending')));
        return;
      }
      res.end(JSON.stringify(snapshot));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.partial, true);
      // The refresh was attempted for city-store beads.
      assert.ok(
        fake.requests.some((request) => request.startsWith('/v0/city/racoon-city/bead/')),
        `expected /bead reads, got: ${fake.requests.join(', ')}`,
      );
    } finally {
      await close();
    }
  });

  test('returns unsupported for non graph.v2 workflow snapshots', async () => {
    fake.setHandler((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v0/city/racoon-city/sessions') {
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.end(JSON.stringify({
        workflow_id: 'gc-root',
        root_bead_id: 'gc-root',
        root_store_ref: 'city:racoon-city',
        resolved_root_store: 'city:racoon-city',
        scope_kind: 'city',
        scope_ref: 'racoon-city',
        snapshot_version: 1,
        partial: false,
        stores_scanned: ['city:racoon-city'],
        beads: [{
          id: 'gc-root',
          title: 'Legacy workflow',
          status: 'in_progress',
          kind: 'workflow',
          metadata: { 'gc.formula_contract': 'legacy' },
        }],
        deps: [],
        logical_nodes: [],
        logical_edges: [],
        scope_groups: [],
      }));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root`);
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.kind, 'unsupported');
      assert.match(body.error, /graph\.v2/);
    } finally {
      await close();
    }
  });

  test('maps supervisor 404 without leaking supervisor topology', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-missing`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.kind, 'not_found');
      assert.equal(body.error, 'workflow not found');
      assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|racoon-city/);
    } finally {
      await close();
    }
  });

  test('maps unknown supervisor failures to generic upstream errors', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('database path /Users/csells/racoon-city/.beads failed');
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.kind, 'upstream');
      assert.equal(body.error, 'failed to fetch workflow');
      assert.deepEqual(body.details, { name: 'Error' });
      assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|\/Users\/csells|racoon-city/);
    } finally {
      await close();
    }
  });

  test('returns current git working tree diff for the server-owned execution path', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-diff-'));
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'base',
    ]);
    await fs.writeFile(path.join(repo, 'README.md'), 'base\nnext\n');
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'export const workflow = true;\n');
    await execFileAsync('git', ['-C', repo, 'add', 'src/index.ts']);

    fake.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(graphV2Snapshot(repo)));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl, '/should-not-be-used'));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root/diff?path=/tmp/evil`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'ok');
      assert.deepEqual(body.rootPath, { kind: 'known', path: await fs.realpath(repo) });
      assert.deepEqual(body.changedFiles, [
        { path: 'README.md', status: 'M', kind: 'docs' },
        { path: 'src/index.ts', status: 'A', kind: 'code' },
      ]);
      assert.match(body.unstagedDiff, /^\+next$/m);
      assert.match(body.stagedDiff, /^\+export const workflow = true;$/m);
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  test('diff endpoint reports path_unknown when supervisor data has no execution folder or rig root', async () => {
    fake.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(graphV2Snapshot()));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'path_unknown');
      assert.deepEqual(body.rootPath, { kind: 'unavailable', reason: 'path_unknown' });
      assert.deepEqual(body.changedFiles, []);
    } finally {
      await close();
    }
  });

  test('diff endpoint quietly reports not_git for execution folders outside git', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-not-git-'));
    fake.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(graphV2Snapshot(dir)));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'not_git');
      assert.deepEqual(body.rootPath, { kind: 'unavailable', reason: 'not_git' });
      assert.deepEqual(body.changedFiles, []);
    } finally {
      await close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('diff endpoint marks large current working tree diffs as truncated', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-large-diff-'));
    await execFileAsync('git', ['-C', repo, 'init']);
    await fs.writeFile(path.join(repo, 'large.txt'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'large.txt']);
    await execFileAsync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'base',
    ]);
    await fs.writeFile(path.join(repo, 'large.txt'), `${'x'.repeat(700 * 1024)}\n`);

    fake.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(graphV2Snapshot(repo)));
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/workflows/gc-root/diff`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'ok');
      assert.equal(body.truncated, true);
      assert.ok(body.unstagedDiff.length <= 512 * 1024);
    } finally {
      await close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('session stream route', () => {
  let fake: FakeSupervisor;

  beforeEach(async () => {
    fake = await startFakeSupervisor();
  });

  afterEach(async () => {
    await fake.close();
  });

  test('proxies supervisor session SSE and forwards Last-Event-ID', async () => {
    fake.setHandler((req, res) => {
      assert.equal(req.url, '/v0/city/racoon-city/session/gc-session-b/stream?after=41');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.end('id: 42\nevent: turn\ndata: {"role":"assistant","text":"still working"}\n\n');
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/sessions/gc-session-b/stream`, {
        headers: { 'Last-Event-ID': '41' },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const text = await res.text();
      assert.match(text, /event: turn/);
      assert.match(text, /still working/);
    } finally {
      await close();
    }
  });

  test('client disconnect closes the upstream supervisor session stream', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write('event: turn\ndata: {"role":"assistant","text":"open"}\n\n');
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/sessions/gc-session-b/stream`, {
        signal: ctrl.signal,
      });
      assert.equal(res.status, 200);
      assert.ok(fake.liveConnections() >= 1, 'upstream connection should be open');
      ctrl.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        fake.liveConnections(),
        0,
        'upstream should be closed after client disconnect',
      );
    } finally {
      await close();
    }
  });

  test('rejects invalid stream session ids before calling supervisor', async () => {
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/sessions/bad$id/stream`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.kind, 'validation');
      assert.equal(fake.requests.length, 0);
    } finally {
      await close();
    }
  });
});
