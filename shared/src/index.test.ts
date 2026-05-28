// Run with: npx tsx --test shared/src/index.test.ts
//
// Regression tests for gascity-dashboard-wj8: gc supervisor emits
// context_pct against a hardcoded context_window of 200_000 even for
// sessions running with the [1m] extended-context beta header (true
// window 1_000_000). The dashboard must scale gc's value back to the
// true window so the displayed % matches what the CLI/tmux session
// reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveContextPct, errorMessage, TRUE_CONTEXT_WINDOWS } from './index.js';
import type { ClientErrorReport, GcSession, SlingIntent, SlingKind } from './index.js';

function sess(partial: Partial<GcSession>): GcSession {
  return {
    id: 'gc-test',
    template: 'mayor',
    state: 'active',
    created_at: '2026-05-19T00:00:00-04:00',
    attached: true,
    ...partial,
  };
}

test('mayor fixture: gc reports 89% against 200k, true window is 1M, effective is ~18%', () => {
  // Real shape pulled from http://127.0.0.1:8372/v0/city/ds-research/sessions
  // for the mayor session, the case the bead was filed against.
  const mayor = sess({
    id: 'gc-2568',
    title: 'mayor',
    alias: 'mayor',
    model: 'claude-opus-4-7',
    context_pct: 89,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(mayor), 18);
});

test('bead-report fixture: gc 75% against 200k -> 15% against 1M', () => {
  // The exact ratio from the bug report.
  const s = sess({
    model: 'claude-opus-4-7',
    context_pct: 75,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(s), 15);
});

test('claude-sonnet-4-5 also gets 1M scaling', () => {
  const s = sess({
    model: 'claude-sonnet-4-5',
    context_pct: 50,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(s), 10);
});

test('claude-sonnet-4-6 also gets 1M scaling', () => {
  const s = sess({
    model: 'claude-sonnet-4-6',
    context_pct: 100,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(s), 20);
});

test('unknown model falls back to gc-reported value', () => {
  const s = sess({
    model: 'some-other-model',
    context_pct: 42,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(s), 42);
});

test('missing model falls back to gc-reported value', () => {
  const s = sess({
    context_pct: 42,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(s), 42);
});

test('missing context_window falls back to gc-reported value', () => {
  // Can't compute a scale factor without knowing what gc divided by.
  // Preserve the reported value rather than guessing.
  const s = sess({
    model: 'claude-opus-4-7',
    context_pct: 89,
  });
  assert.equal(effectiveContextPct(s), 89);
});

test('missing context_pct returns undefined', () => {
  const s = sess({ model: 'claude-opus-4-7' });
  assert.equal(effectiveContextPct(s), undefined);
});

test('gc-reported window matches true window: no scaling', () => {
  // If gc upstream fixes itself and starts emitting context_window=1_000_000
  // for [1m] sessions, our scaling becomes a no-op.
  const s = sess({
    model: 'claude-opus-4-7',
    context_pct: 18,
    context_window: 1000000,
  });
  assert.equal(effectiveContextPct(s), 18);
});

test('result is capped at 100', () => {
  // Defensive: if gc ever reports >100 due to its own bug, we still
  // render a sane value.
  const s = sess({
    model: 'claude-opus-4-7',
    context_pct: 600,
    context_window: 200000,
  });
  assert.equal(effectiveContextPct(s), 100);
});

test('result rounds to integer', () => {
  // Display layer renders integers; the helper rounds so thresholds
  // and display agree.
  const s = sess({
    model: 'claude-opus-4-7',
    context_pct: 73,
    context_window: 200000,
  });
  // 73 * 200000 / 1000000 = 14.6 -> 15
  assert.equal(effectiveContextPct(s), 15);
});

test('TRUE_CONTEXT_WINDOWS includes the deployed Claude models', () => {
  // Smoke test on the model registry. If a new Claude generation lands,
  // adding it here should be the only change needed.
  assert.equal(TRUE_CONTEXT_WINDOWS['claude-opus-4-7'], 1_000_000);
  assert.equal(TRUE_CONTEXT_WINDOWS['claude-sonnet-4-5'], 1_000_000);
  assert.equal(TRUE_CONTEXT_WINDOWS['claude-sonnet-4-6'], 1_000_000);
});

test('errorMessage normalizes unknown error values for shared client/server reporting', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain failure'), 'plain failure');
  assert.equal(errorMessage({ status: 500 }), 'unknown error');
});

test('shared client-error and sling types compile as the cross-workspace contracts', () => {
  const report: ClientErrorReport = {
    component: 'AgentDetail',
    operation: 'refreshBeads',
    message: 'failed',
  };
  const intent: SlingIntent = 'triage';
  const kind: SlingKind = 'issue';

  assert.equal(report.component, 'AgentDetail');
  assert.equal(intent, 'triage');
  assert.equal(kind, 'issue');
});
