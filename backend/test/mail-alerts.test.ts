import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  AlertItem,
  GcMailItem,
  GcMailList,
  GcSession,
  SourceState,
} from 'gas-city-dashboard-shared';

import { deriveOperatorMailAlerts } from '../src/snapshot/mail-alerts.js';

// Operator-mail alert derivation (gascity-dashboard-mpfx, R4): the snapshot read
// path turns mayor/orchestration-sender mail into 'operator-mail' AlertItems,
// folds the worker firehose away, and inherits the mail source's provenance.
// The sender-role filter itself lives in shared/operator-mail.ts (one owner with
// the TUI ledger); this pins the alert-shape + provenance + fold accounting.

function session(overrides: Partial<GcSession>): GcSession {
  return {
    id: 's1',
    template: 'gastown/polecat',
    session_name: 's1.tmux',
    title: 'polecat-4',
    state: 'active',
    created_at: '2026-06-01T00:00:00Z',
    attached: false,
    running: true,
    provider: 'claude',
    ...overrides,
  };
}

function mail(overrides: Partial<GcMailItem>): GcMailItem {
  return {
    id: 'm1',
    from: 'mayor',
    to: 'human',
    subject: 'subject',
    body: 'body',
    created_at: '2026-06-01T00:00:00Z',
    read: false,
    ...overrides,
  };
}

function mailState(
  items: GcMailItem[],
  status: 'fresh' | 'stale' | 'fixture' = 'fresh',
  fetchedAt = '2026-06-02T00:00:00.000Z',
): SourceState<GcMailList> {
  return {
    source: 'city',
    status,
    fetchedAt,
    staleAt: '2026-06-02T00:01:00.000Z',
    error: { kind: 'none' },
    data: { items, total: items.length },
  };
}

function errorMailState(): SourceState<GcMailList> {
  return { source: 'city', status: 'error', error: 'mail fetch failed' };
}

test('keeps mayor escalation, folds pool-worker chatter (the AC core)', () => {
  const sessions = [
    session({ id: 'm', title: 'mayor' }), // rig-less → orch
    session({ id: 'p', title: 'polecat-2', rig: 'gascity', pool: 'polecat' }),
  ];
  // All priority:null / read:false — the dead wire signals must not be ranked on.
  const items = [
    mail({ id: 'worker', from: '/home/ds/gascity/polecat-2', created_at: '2026-06-01T00:09:00Z' }),
    mail({ id: 'esc', from: 'mayor', subject: 'needs your call', created_at: '2026-06-01T00:05:00Z' }),
  ];
  const { alerts, folded } = deriveOperatorMailAlerts(mailState(items), sessions);

  assert.equal(alerts.length, 1, 'only the mayor escalation is kept');
  const a = alerts[0]!;
  assert.equal(a.kind, 'operator-mail');
  assert.equal(a.source, 'mail');
  assert.equal(a.ref.mailId, 'esc');
  assert.equal(a.dedupKey, 'operator-mail:esc');
  assert.equal(a.severity, 'attention');
  assert.equal(a.occurredAt, '2026-06-01T00:05:00Z');
  assert.equal(a.title, 'needs your call');
  assert.equal(folded, 1, 'one worker mail folded');
  assert.equal(a.foldedCount, 1, 'fold count carried on the (top) kept item');
});

test('mayor fallback is kept even with no live mayor session', () => {
  const items = [mail({ id: 'esc', from: '/some/path/mayor' })];
  const { alerts } = deriveOperatorMailAlerts(mailState(items), []);
  assert.deepEqual(alerts.map((a) => a.ref.mailId), ['esc']);
});

test('zero kept / N folded: the fold is still reported (never silent)', () => {
  // Steady state — mayor digests the firehose, nothing reaches the operator.
  const items = [
    mail({ id: 'w1', from: 'polecat-1' }),
    mail({ id: 'w2', from: 'polecat-2' }),
    mail({ id: 'read', from: 'polecat-3', read: true }), // read → not unread → not folded
  ];
  const { alerts, folded } = deriveOperatorMailAlerts(mailState(items), []);
  assert.equal(alerts.length, 0, 'nothing kept');
  assert.equal(folded, 2, 'two unread worker mails folded; the read one is not counted');
});

test('mail source error degrades to empty (signal-unavailable lives on the SourceState)', () => {
  const { alerts, folded } = deriveOperatorMailAlerts(errorMailState(), [
    session({ id: 'm', title: 'mayor' }),
  ]);
  assert.deepEqual(alerts, []);
  assert.equal(folded, 0);
});

test('provenance is inherited from the mail source status', () => {
  const items = [mail({ id: 'esc', from: 'mayor' })];
  assert.equal(deriveOperatorMailAlerts(mailState(items, 'fresh'), []).alerts[0]?.provenance, 'fresh');
  assert.equal(deriveOperatorMailAlerts(mailState(items, 'stale'), []).alerts[0]?.provenance, 'stale');
  assert.equal(deriveOperatorMailAlerts(mailState(items, 'fixture'), []).alerts[0]?.provenance, 'fixture');
});

test('version is the mail source generation (R17), not created_at', () => {
  const items = [mail({ id: 'esc', from: 'mayor', created_at: '2020-01-01T00:00:00Z' })];
  const older = deriveOperatorMailAlerts(mailState(items, 'fresh', '2026-06-02T00:00:00.000Z'), []);
  const newer = deriveOperatorMailAlerts(mailState(items, 'stale', '2026-06-02T00:05:00.000Z'), []);
  // Same immutable mail, two fetches: a newer fetch must produce a strictly
  // higher version so R17 last-write-wins can supersede the stale envelope.
  assert.ok(
    (newer.alerts[0]!.version) > (older.alerts[0]!.version),
    'version tracks fetchedAt, so created_at cannot freeze it',
  );
  assert.equal(older.alerts[0]!.version, Date.parse('2026-06-02T00:00:00.000Z'));
});

test('ordering is newest-first by occurredAt, never by priority/read', () => {
  const sessions = [session({ id: 'm', title: 'mayor' })];
  const items = [
    mail({ id: 'old', from: 'mayor', created_at: '2026-06-01T00:01:00Z', priority: 0 }),
    mail({ id: 'new', from: 'mayor', created_at: '2026-06-01T00:09:00Z', priority: 4 }),
  ];
  const { alerts } = deriveOperatorMailAlerts(mailState(items), sessions);
  // Despite the older mail having the "higher" priority, order is purely recency.
  assert.deepEqual(alerts.map((a) => a.ref.mailId), ['new', 'old']);
});

describe('fold accounting', () => {
  test('foldedCount is attached only to the top item, and only when > 0', () => {
    const sessions = [session({ id: 'm', title: 'mayor' })];
    const items = [
      mail({ id: 'a', from: 'mayor', created_at: '2026-06-01T00:09:00Z' }),
      mail({ id: 'b', from: 'mayor', created_at: '2026-06-01T00:01:00Z' }),
    ];
    const { alerts }: { alerts: readonly AlertItem[] } = deriveOperatorMailAlerts(
      mailState(items),
      sessions,
    );
    assert.equal(alerts[0]?.foldedCount, undefined, 'no chatter to fold → no count');
    assert.equal(alerts[1]?.foldedCount, undefined);
  });
});
