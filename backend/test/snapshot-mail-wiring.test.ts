import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  CityStatusSummary,
  GcMailItem,
  GcMailList,
  GcSession,
  GcSessionList,
  ResourceSummary,
  RunSummary,
  WorkSummary,
} from 'gas-city-dashboard-shared';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  createSnapshotService,
  type CreateSnapshotServiceOptions,
  type SourceCacheMap,
} from '../src/snapshot/service.js';

// Operator-mail wiring (gascity-dashboard-mpfx, R4): the read path fetches mail
// off-wire, derives operator-mail AlertItems into snapshot.alerts, and surfaces
// the fold count + mail provenance out-of-band on snapshot.mail. A mail-source
// failure degrades to no items and never 500s the snapshot. The derivation
// itself is unit-pinned in mail-alerts.test.ts; this pins the service seam.

const CITY: CityStatusSummary = {
  activeAgents: 1, totalAgents: 1, activeSessions: 1, suspendedSessions: 0,
  maxSessions: { status: 'available', value: 10 }, sessionsByProvider: [], rigs: [],
};
const RESOURCES: ResourceSummary = {
  vcpuCount: 1, loadAverage: [0, 0, 0], loadPerVcpu: 0,
  memory: { totalBytes: 1, usedBytes: 0, availableBytes: 1, utilization: 0 },
  uptimeSeconds: 1, samples: [],
};
const RUNS: RunSummary = {
  totalActive: 0, totalHistorical: 0,
  runCounts: { total: 0, visible: 0, prReview: 0, designReview: 0, bugfix: 0, blocked: 0, other: 0 },
  lanes: [], historicalLanes: [], recentChanges: [],
  census: { status: 'unavailable', error: 'derived in read path' },
};
const WORK: WorkSummary = { open: 0, ready: 0, inProgress: 0 };

function caches(): SourceCacheMap {
  return {
    city: new SourceCache({ source: 'city', ttlMs: 45_000, load: async () => CITY }),
    resources: new SourceCache({ source: 'resources', ttlMs: 30_000, load: async () => RESOURCES }),
    runs: new SourceCache({ source: 'runs', ttlMs: 60_000, load: async () => RUNS }),
    work: new SourceCache({ source: 'work', ttlMs: 45_000, load: async () => WORK }),
  };
}

function session(id: string, overrides: Partial<GcSession>): GcSession {
  return {
    id,
    template: 't',
    session_name: id,
    title: id,
    state: 'active',
    created_at: '2026-06-02T12:00:00.000Z',
    attached: false,
    running: true,
    provider: 'codex',
    ...overrides,
  } as GcSession;
}

function mail(id: string, from: string, overrides: Partial<GcMailItem> = {}): GcMailItem {
  return {
    id, from, to: 'human', subject: id, body: 'b',
    created_at: '2026-06-02T12:00:00.000Z', read: false, ...overrides,
  };
}

function sessionsCacheOf(items: GcSession[]): SourceCache<GcSessionList> {
  return new SourceCache<GcSessionList>({
    source: 'city', ttlMs: 45_000, load: async () => ({ items, total: items.length }),
  });
}

function mailCacheOf(items: GcMailItem[]): SourceCache<GcMailList> {
  return new SourceCache<GcMailList>({
    source: 'city', ttlMs: 45_000, load: async () => ({ items, total: items.length }),
  });
}

function failingMailCache(): SourceCache<GcMailList> {
  return new SourceCache<GcMailList>({
    source: 'city', ttlMs: 45_000, sanitizeErrorMessage: null,
    load: async () => { throw new Error('mail backend down'); },
  });
}

function baseOptions(): CreateSnapshotServiceOptions {
  return {
    caches: caches(),
    config: { cityName: 'c', cityRoot: '/tmp/c', useFixtures: false, enabledModules: null, defaultView: null },
  };
}

describe('snapshot service — operator-mail wiring', () => {
  test('operator-mail alerts flow into snapshot.alerts; fold + provenance on snapshot.mail', async () => {
    const service = createSnapshotService({
      ...baseOptions(),
      sessions: sessionsCacheOf([session('mayor', { title: 'mayor' })]),
      mail: mailCacheOf([
        mail('esc', 'mayor'),
        mail('chatter', '/home/ds/gascity/polecat-2'),
      ]),
    });
    const snap = await service.getSnapshot();
    const mailAlerts = snap.alerts.filter((a) => a.kind === 'operator-mail');
    assert.equal(mailAlerts.length, 1, 'only the mayor escalation surfaces');
    assert.equal(mailAlerts[0]!.ref.mailId, 'esc');
    assert.equal(snap.mail.status, 'fresh');
    assert.equal(snap.mail.folded, 1, 'one worker mail folded, reported out-of-band');
  });

  test('a mail-source failure degrades to no mail alerts and does NOT 500', async () => {
    const service = createSnapshotService({
      ...baseOptions(),
      sessions: sessionsCacheOf([session('mayor', { title: 'mayor' })]),
      mail: failingMailCache(),
    });
    const snap = await service.getSnapshot(); // must resolve, not throw
    assert.equal(snap.alerts.filter((a) => a.kind === 'operator-mail').length, 0);
    assert.equal(snap.mail.status, 'error', 'signal-unavailable carried on the digest (035r tri-state)');
    assert.equal(snap.mail.folded, 0);
  });

  test('no-gc path is a no-op: default empty mail cache yields no operator-mail alerts', async () => {
    const service = createSnapshotService(baseOptions()); // no gc, no injected mail/sessions
    const snap = await service.getSnapshot();
    assert.equal(snap.alerts.filter((a) => a.kind === 'operator-mail').length, 0);
    assert.equal(snap.mail.folded, 0);
  });
});
