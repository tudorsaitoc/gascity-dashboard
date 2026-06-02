import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { GcBead, GcBeadList } from 'gas-city-dashboard-shared';
import { beadsRouter, ENG_BEAD_TYPES } from '../src/routes/beads.js';
import { GcClient } from '../src/gc-client.js';

// gascity-dashboard-oh19: GET /api/beads fetches the engineering working set
// server-side (one supervisor query per eng type — the `type` param is
// single-valued), merges the results, and drops gc:-labelled noise
// client-side. These tests pin that the route issues per-type queries (not a
// single unfiltered firehose), that the gc: label exclusion still applies to
// type-matched beads (e.g. gc:extmsg-* task beads), and that the upstream
// coverage counters are summed from the eng-type totals so the truncation
// warning only fires on genuine engineering-work truncation.

function bead(overrides: Partial<GcBead>): GcBead {
  return {
    id: 'gascity-0001',
    title: 'sample',
    status: 'open',
    priority: 0,
    issue_type: 'task',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface ListCall {
  type: string | undefined;
  limit: number | undefined;
}

interface AppHandle {
  url: string;
  close: () => Promise<void>;
  calls: ListCall[];
}

// Per-type fixtures keyed by the `type` query param the route passes. The
// stub records every call so a test can assert the route fans out by type.
async function buildApp(
  byType: Record<string, GcBeadList>,
): Promise<AppHandle> {
  const gc = new GcClient({ baseUrl: 'http://127.0.0.1:1', cityName: 'test' });
  const calls: ListCall[] = [];
  // Override the upstream list call with a recording stub. The route only
  // depends on the public listBeads contract, so this isolates the route's
  // fan-out/merge logic from the HTTP client.
  gc.listBeads = async (_signal, params) => {
    calls.push({ type: params?.type, limit: params?.limit });
    const key = params?.type ?? '__all__';
    return byType[key] ?? { items: [], total: 0 };
  };

  const app = express();
  app.use('/api/beads', beadsRouter(gc, '/home/test/gas-city'));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('GET /api/beads (server-side type-filtered fetch)', () => {
  let handle: AppHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  test('fans out one query per engineering type, never an unfiltered fetch', async () => {
    handle = await buildApp({
      feature: { items: [bead({ id: 'app-1', issue_type: 'feature' })], total: 1 },
      bug: { items: [bead({ id: 'app-2', issue_type: 'bug' })], total: 1 },
      task: { items: [bead({ id: 'app-3', issue_type: 'task' })], total: 1 },
      docs: { items: [], total: 0 },
    });
    const res = await fetch(`${handle.url}/api/beads`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const typesQueried = handle.calls.map((c) => c.type).sort();
    assert.deepEqual(typesQueried, [...ENG_BEAD_TYPES].sort());
    // No call may omit the type param (that would be the old firehose).
    assert.ok(handle.calls.every((c) => typeof c.type === 'string'));
    assert.equal(body.items.length, 3);
    assert.deepEqual(
      body.items.map((b: GcBead) => b.id).sort(),
      ['app-1', 'app-2', 'app-3'],
    );
  });

  test('drops gc:-labelled noise returned by a type query (gc:extmsg-* tasks)', async () => {
    handle = await buildApp({
      feature: { items: [], total: 0 },
      bug: { items: [], total: 0 },
      task: {
        items: [
          bead({ id: 'real-1', issue_type: 'task' }),
          bead({ id: 'noise-1', issue_type: 'task', labels: ['gc:extmsg-transcript'] }),
        ],
        total: 2,
      },
      docs: { items: [], total: 0 },
    });
    const res = await fetch(`${handle.url}/api/beads`);
    const body = await res.json();
    assert.deepEqual(body.items.map((b: GcBead) => b.id), ['real-1']);
    assert.equal(body.total, 1);
  });

  test('upstream counters sum eng-type totals; warning does not fire when each type is covered', async () => {
    handle = await buildApp({
      feature: { items: [bead({ id: 'f1', issue_type: 'feature' })], total: 20 },
      bug: { items: [bead({ id: 'b1', issue_type: 'bug' })], total: 14 },
      task: { items: [bead({ id: 't1', issue_type: 'task' })], total: 935 },
      docs: { items: [], total: 0 },
    });
    const res = await fetch(`${handle.url}/api/beads`);
    const body = await res.json();
    // Sum of per-type totals = the engineering working set, NOT the whole
    // store (~1604). fetched is the merged item count (3 here).
    assert.equal(body.upstream_total, 969);
    assert.equal(body.upstream_fetched, 3);
    assert.ok(typeof body.fetch_limit === 'number');
  });

  test('showAll=1 keeps the wide unfiltered diagnostic fetch (single call, no type)', async () => {
    handle = await buildApp({
      __all__: {
        items: [
          bead({ id: 'eng-1', issue_type: 'task' }),
          bead({ id: 'msg-1', issue_type: 'message' }),
        ],
        total: 1604,
      },
    });
    const res = await fetch(`${handle.url}/api/beads?showAll=1`);
    const body = await res.json();
    assert.equal(handle.calls.length, 1);
    assert.equal(handle.calls[0]?.type, undefined);
    // showAll bypasses the real-work filter — bookkeeping beads pass through.
    assert.equal(body.items.length, 2);
    assert.equal(body.upstream_total, 1604);
  });
});
