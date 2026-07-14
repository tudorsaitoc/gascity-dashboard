import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RefineryModuleConfig } from '../../../config.js';
import type { ExecResult } from '../../../exec.js';
import { RefinerySummaryState } from './state.js';

// Fixture river: one immutable "yesterday" file and one growing "today"
// file, exercising the score/publish/merge kinds plus heartbeat noise the
// probe must skip without parsing.

const T0 = Date.parse('2026-07-13T10:00:00Z');
const NOW = Date.parse('2026-07-14T12:00:00Z');

function ev(ts: string, kind: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts, kind, agent: 'test', data });
}

const YESTERDAY_LINES = [
  ev('2026-07-13T10:00:00Z', 'state.heartbeat', {}),
  ev('2026-07-13T10:00:00Z', 'refinery.score', { bead_id: 'x-aaa', rig: 'x' }),
  ev('2026-07-13T11:00:00Z', 'refinery.publish.completed', {
    rig: 'x',
    counts: { merged: 1, closed_on_merge: 1, blocked_required_checks: 2, ci_failed: 1 },
  }),
  'not json at all',
];

const TODAY_LINES = [
  ev('2026-07-14T09:00:00Z', 'pr.merged', {
    bead_id: 'x-aaa',
    pr: 42,
    pr_url: 'https://example.test/pull/42',
    title: 'fix: aaa',
    merged_at: '2026-07-14T09:00:00Z',
  }),
  ev('2026-07-14T09:30:00Z', 'refinery.bead.closed_on_merge', {
    bead: 'x-bbb',
    pr: 43,
    pr_url: 'https://example.test/pull/43',
    merged_at: '2026-07-14T09:30:00Z',
  }),
  ev('2026-07-14T10:00:00Z', 'refinery.score', { bead_id: 'x-ccc', rig: 'x' }),
];

const POOL_ROWS = [
  {
    id: 'x-ccc',
    title: 'stuck thing',
    status: 'blocked',
    updated_at: '2026-07-12T00:00:00Z',
    metadata: {
      branch: 'auto/x-ccc',
      existing_pr: 'https://example.test/pull/44',
      blocked_reason: 'required checks failing',
    },
  },
  {
    id: 'x-ddd',
    title: 'fresh thing',
    status: 'open',
    updated_at: '2026-07-14T11:30:00Z',
    metadata: { branch: 'auto/x-ddd' },
  },
];

function fakePool(rows: unknown): (beadsPath: string, routedTo: string) => Promise<ExecResult> {
  return () => Promise.resolve({ stdout: JSON.stringify(rows), stderr: '' } as ExecResult);
}

describe('RefinerySummaryState', () => {
  let dir: string;
  let config: RefineryModuleConfig;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refinery-state-'));
    fs.writeFileSync(path.join(dir, 'events-2026-07-13.jsonl'), YESTERDAY_LINES.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'events-2026-07-14.jsonl'), TODAY_LINES.join('\n') + '\n');
    config = {
      repoPath: '/tmp/fake-repo',
      riverLogDir: dir,
      routedTo: 'x/refinery',
      windowDays: 7,
      stuckHours: 24,
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('aggregates gate counts, merges, lead times, pool + stuck flags', async () => {
    const state = new RefinerySummaryState(config, () => NOW, fakePool(POOL_ROWS));
    const summary = await state.summary();

    assert.equal(summary.poolSource.status, 'ok');
    assert.equal(summary.riverSource.status, 'ok');

    // Gate counts summed from publish.completed.
    assert.equal(summary.gate.merged, 1);
    assert.equal(summary.gate.closedOnMerge, 1);
    assert.equal(summary.gate.blockedRequiredChecks, 2);
    assert.equal(summary.gate.ciFailed, 1);
    // pass = (1+1) / (1+1+1 hard failures)
    assert.ok(summary.gate.passRate !== null);
    assert.ok(Math.abs(summary.gate.passRate - 2 / 3) < 1e-9);

    // Two merges, newest first; x-aaa has a first-seen event 23h before merge.
    assert.equal(summary.merges.length, 2);
    assert.equal(summary.merges[0]?.beadId, 'x-bbb');
    assert.equal(summary.merges[1]?.beadId, 'x-aaa');
    assert.equal(summary.merges[1]?.leadTimeMs, Date.parse('2026-07-14T09:00:00Z') - T0);
    // x-bbb never appeared before its merge event → lead time from its own
    // first sighting (the merge event itself) = 0.
    assert.equal(summary.merges[0]?.leadTimeMs, 0);

    // Pool: x-ccc last moved 2.5 days ago → stuck; x-ddd fresh → not.
    const stuck = summary.pool.find((p) => p.beadId === 'x-ccc');
    const fresh = summary.pool.find((p) => p.beadId === 'x-ddd');
    assert.equal(stuck?.stuck, true);
    assert.equal(stuck?.prUrl, 'https://example.test/pull/44');
    assert.equal(stuck?.blockedReason, 'required checks failing');
    assert.equal(fresh?.stuck, false);

    assert.equal(summary.lastPatrolAt, '2026-07-14T10:00:00Z');
  });

  test('incremental scan picks up appended events without rescanning old files', async () => {
    const state = new RefinerySummaryState(config, () => NOW, fakePool([]));
    const first = await state.summary();
    assert.equal(first.merges.length, 2);

    fs.appendFileSync(
      path.join(dir, 'events-2026-07-14.jsonl'),
      ev('2026-07-14T11:00:00Z', 'pr.merged', {
        bead_id: 'x-eee',
        pr: 45,
        pr_url: 'https://example.test/pull/45',
        title: 'feat: eee',
        merged_at: '2026-07-14T11:00:00Z',
      }) + '\n',
    );

    // Fresh state instance (TTL would otherwise serve the cache) — the
    // incremental path is exercised via the same instance below.
    let t = NOW;
    const ticking = new RefinerySummaryState(config, () => t, fakePool([]));
    const before = await ticking.summary();
    assert.equal(before.merges.length, 3);

    fs.appendFileSync(
      path.join(dir, 'events-2026-07-14.jsonl'),
      ev('2026-07-14T11:30:00Z', 'pr.merged', {
        bead_id: 'x-fff',
        pr: 46,
        pr_url: 'https://example.test/pull/46',
        title: 'feat: fff',
        merged_at: '2026-07-14T11:30:00Z',
      }) + '\n',
    );
    t = NOW + 31_000; // past the summary TTL → re-stat, tail from offset
    const after = await ticking.summary();
    assert.equal(after.merges.length, 4);
    assert.ok(after.merges.some((m) => m.beadId === 'x-fff'));
  });

  test('degrades per source: bad bd JSON and missing river dir stay explicit', async () => {
    const badPool: typeof fakePool = () => () =>
      Promise.resolve({ stdout: 'not json', stderr: '' } as ExecResult);
    const state = new RefinerySummaryState(
      { ...config, riverLogDir: path.join(dir, 'does-not-exist') },
      () => NOW,
      badPool([]),
    );
    const summary = await state.summary();
    assert.equal(summary.poolSource.status, 'unavailable');
    assert.equal(summary.riverSource.status, 'unavailable');
    assert.equal(summary.pool.length, 0);
    assert.equal(summary.merges.length, 0);
    assert.equal(summary.gate.passRate, null);
  });

  test('unconfigured sources degrade with the configuration reason', async () => {
    const state = new RefinerySummaryState(
      { ...config, repoPath: '', riverLogDir: '' },
      () => NOW,
      fakePool([]),
    );
    const summary = await state.summary();
    assert.equal(summary.poolSource.status, 'unavailable');
    assert.equal(summary.riverSource.status, 'unavailable');
    if (summary.poolSource.status === 'unavailable') {
      assert.match(summary.poolSource.reason, /not configured/);
    }
  });
});
