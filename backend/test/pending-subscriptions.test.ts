import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import type { PendingInteraction } from 'gas-city-dashboard-shared';

import { PendingStore } from '../src/snapshot/pending-store.js';
import {
  PendingSubscriptionManager,
  type ReconnectScheduler,
  type SessionPendingHandlers,
  type SessionStreamSubscriber,
} from '../src/snapshot/pending-subscriptions.js';

// Layer 2 orchestration (gascity-dashboard-3rm7). Deterministic via a fake
// subscriber + a captured reconnect scheduler.

const pi = (request_id: string): PendingInteraction => ({ request_id, kind: 'tool_approval' });
const NOW = () => new Date('2026-06-02T12:00:00.000Z');

class FakeSubscriber implements SessionStreamSubscriber {
  readonly handlers = new Map<string, SessionPendingHandlers>();
  readonly subscribeCalls: string[] = [];
  readonly closed: string[] = [];

  subscribe(sessionId: string, handlers: SessionPendingHandlers) {
    this.subscribeCalls.push(sessionId);
    this.handlers.set(sessionId, handlers);
    return { close: () => { this.closed.push(sessionId); } };
  }

  pending(sessionId: string, p: PendingInteraction | null): void {
    this.handlers.get(sessionId)!.onPending(p);
  }

  fail(sessionId: string): void {
    this.handlers.get(sessionId)!.onError(new Error('stream lost'));
  }
}

interface Scheduled { run: () => void; attempt: number; cancelled: boolean }

function makeScheduler(): { scheduler: ReconnectScheduler; scheduled: Scheduled[] } {
  const scheduled: Scheduled[] = [];
  const scheduler: ReconnectScheduler = (run, attempt) => {
    const entry: Scheduled = { run, attempt, cancelled: false };
    scheduled.push(entry);
    return () => { entry.cancelled = true; };
  };
  return { scheduler, scheduled };
}

describe('PendingSubscriptionManager', () => {
  let subscriber: FakeSubscriber;
  let store: PendingStore;
  let scheduled: Scheduled[];
  let manager: PendingSubscriptionManager;

  beforeEach(() => {
    subscriber = new FakeSubscriber();
    store = new PendingStore();
    const s = makeScheduler();
    scheduled = s.scheduled;
    manager = new PendingSubscriptionManager({ subscriber, store, now: NOW, scheduleReconnect: s.scheduler });
  });

  test('syncActiveSessions opens a subscription per active session', () => {
    manager.syncActiveSessions(['s1', 's2']);
    assert.deepEqual(subscriber.subscribeCalls.sort(), ['s1', 's2']);
    assert.equal(manager.subscribedCount, 2);
  });

  test('a pending frame lands in the store as a pending-decision alert', () => {
    manager.syncActiveSessions(['s1']);
    subscriber.pending('s1', pi('req-1'));
    const alerts = store.alerts('fresh');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.dedupKey, 'pending-decision:req-1');
    assert.equal(alerts[0]!.ref.sessionId, 's1');
  });

  test('a null pending frame clears the session', () => {
    manager.syncActiveSessions(['s1']);
    subscriber.pending('s1', pi('req-1'));
    subscriber.pending('s1', null);
    assert.deepEqual(store.alerts('fresh'), []);
  });

  test('removing a session tears down its subscription and drops its pending', () => {
    manager.syncActiveSessions(['s1', 's2']);
    subscriber.pending('s1', pi('a'));
    subscriber.pending('s2', pi('b'));
    manager.syncActiveSessions(['s1']);
    assert.ok(subscriber.closed.includes('s2'));
    const alerts = store.alerts('fresh');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.ref.sessionId, 's1');
  });

  test('a stream error schedules a reconnect that re-subscribes', () => {
    manager.syncActiveSessions(['s1']);
    subscriber.fail('s1');
    assert.ok(subscriber.closed.includes('s1'));
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.attempt, 0);
    scheduled[0]!.run();
    assert.equal(subscriber.subscribeCalls.filter((id) => id === 's1').length, 2);
  });

  test('backoff attempt increments across consecutive failures and resets on a live frame', () => {
    manager.syncActiveSessions(['s1']);
    subscriber.fail('s1');
    scheduled[0]!.run();           // reconnect #1 (attempt was 0 -> opens with attempt 1)
    subscriber.fail('s1');
    assert.equal(scheduled[1]!.attempt, 1);
    scheduled[1]!.run();           // reconnect #2 (attempt 2)
    subscriber.pending('s1', pi('x')); // live frame resets attempt
    subscriber.fail('s1');
    assert.equal(scheduled[2]!.attempt, 0);
  });

  test('tearing down a session mid-reconnect cancels the scheduled reconnect', () => {
    manager.syncActiveSessions(['s1']);
    subscriber.fail('s1');
    manager.syncActiveSessions([]); // s1 no longer active
    assert.ok(scheduled[0]!.cancelled);
    const before = subscriber.subscribeCalls.length;
    scheduled[0]!.run(); // stale reconnect must be a no-op
    assert.equal(subscriber.subscribeCalls.length, before);
  });

  test('closeAll closes every subscription', () => {
    manager.syncActiveSessions(['s1', 's2']);
    manager.closeAll();
    assert.deepEqual(subscriber.closed.sort(), ['s1', 's2']);
    assert.equal(manager.subscribedCount, 0);
  });
});
