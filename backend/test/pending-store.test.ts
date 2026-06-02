import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PendingInteraction } from 'gas-city-dashboard-shared';

import { PendingStore } from '../src/snapshot/pending-store.js';

// City-wide pending aggregator core (gascity-dashboard-3rm7, PRD R3/R16).
// These pin the premortem Theme-A invariants: supersede-on-reobserve, drop
// pending for gone sessions, and never silently misorder the top tier.

const pi = (request_id: string, kind = 'tool_approval'): PendingInteraction => ({ request_id, kind });
const T1 = '2026-06-02T12:00:00.000Z';
const T2 = '2026-06-02T12:00:05.000Z';

describe('PendingStore', () => {
  test('observe surfaces a pending-decision alert keyed by request_id', () => {
    const store = new PendingStore();
    store.observe('s1', pi('req-1'), T1);
    const alerts = store.alerts('fresh');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'pending-decision');
    assert.equal(alerts[0]!.dedupKey, 'pending-decision:req-1');
    assert.equal(alerts[0]!.ref.sessionId, 's1');
    assert.equal(alerts[0]!.provenance, 'fresh');
  });

  test('re-observing a session supersedes with a higher version (R17 last-write-wins)', () => {
    const store = new PendingStore();
    store.observe('s1', pi('req-1'), T1);
    const v1 = store.alerts('fresh')[0]!.version;
    store.observe('s1', pi('req-2'), T2);
    const after = store.alerts('fresh');
    assert.equal(after.length, 1); // one session, one pending
    assert.equal(after[0]!.dedupKey, 'pending-decision:req-2');
    assert.ok(after[0]!.version > v1);
  });

  test('clear removes a resolved pending', () => {
    const store = new PendingStore();
    store.observe('s1', pi('req-1'), T1);
    store.clear('s1');
    assert.deepEqual(store.alerts('fresh'), []);
    assert.equal(store.size, 0);
  });

  test('retainActive drops pending for sessions no longer active (cannot still need the operator)', () => {
    const store = new PendingStore();
    store.observe('s1', pi('req-1'), T1);
    store.observe('s2', pi('req-2'), T2);
    const dropped = store.retainActive(['s2']);
    assert.equal(dropped, 1);
    const alerts = store.alerts('fresh');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.ref.sessionId, 's2');
  });

  test('retainActive is a no-op when all entries are still active', () => {
    const store = new PendingStore();
    store.observe('s1', pi('req-1'), T1);
    assert.equal(store.retainActive(new Set(['s1'])), 0);
    assert.equal(store.size, 1);
  });

  test('alerts are ordered oldest-first, then by dedupKey (deterministic, stable)', () => {
    const store = new PendingStore();
    store.observe('s2', pi('req-2'), T2);
    store.observe('s1', pi('req-1'), T1);
    const a = store.alerts('fresh').map((x) => x.dedupKey);
    const b = store.alerts('fresh').map((x) => x.dedupKey);
    assert.deepEqual(a, ['pending-decision:req-1', 'pending-decision:req-2']); // T1 before T2
    assert.deepEqual(a, b);
  });

  test('provenance threads through so a dark aggregator can render signal-unavailable', () => {
    const store = new PendingStore();
    store.observe('s1', pi('req-1'), T1);
    assert.equal(store.alerts('stale')[0]!.provenance, 'stale');
  });

  test('an empty store yields no alerts', () => {
    assert.deepEqual(new PendingStore().alerts('fresh'), []);
  });
});
