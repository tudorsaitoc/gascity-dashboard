// Unit tests for the pure view-derivation helpers. Run with the workspace's
// `npm --workspace tui test` (node's built-in runner via tsx, matching the
// `shared` workspace convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcMailItem, GcSession } from 'gas-city-dashboard-shared';
import {
  AGENT_KINDS,
  activityPhrase,
  agentKind,
  foldedMailCount,
  kindGlyph,
  kindLabel,
  mailSnippet,
  matchesStatusFilter,
  nextStatusFilter,
  operatorMail,
  runningSessions,
  type StatusFilter,
} from './derive.ts';

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

test('agentKind: pool worker detected by pool field', () => {
  assert.equal(agentKind(session({ pool: 'polecat', rig: 'gascity' })), 'pool');
});

test('agentKind: pool worker detected by polecat template even without pool field', () => {
  // No `pool` field set — detection falls back to the polecat template.
  assert.equal(agentKind(session({ template: 'gastown/polecat', rig: 'gascity' })), 'pool');
});

test('agentKind: named role agent (no pool, rig-scoped) is role', () => {
  assert.equal(
    agentKind(session({ template: 'gascity/project-lead', title: 'project-lead', rig: 'gascity' })),
    'role',
  );
});

test('agentKind: empty rig is orchestration (mayor)', () => {
  // Mayor carries no rig and no pool — rig-less reads as orchestration.
  assert.equal(agentKind(session({ template: 'mayor', title: 'mayor' })), 'orch');
});

test('agentKind: control-dispatcher is orchestration even when rig-scoped', () => {
  assert.equal(
    agentKind(
      session({ template: 'gascity/control-dispatcher', title: 'control-dispatcher', rig: 'gascity' }),
    ),
    'orch',
  );
});

test('agentKind: orchestration takes precedence over a pool field', () => {
  // A control-dispatcher must read as orch regardless of any pool bucket.
  assert.equal(
    agentKind(session({ template: 'control-dispatcher', rig: '', pool: 'orchestration' })),
    'orch',
  );
});

test('kindGlyph / kindLabel cover every kind and are distinct', () => {
  const glyphs = new Set<string>();
  const labels = new Set<string>();
  for (const k of AGENT_KINDS) {
    const g = kindGlyph(k);
    const l = kindLabel(k);
    assert.ok(g.length > 0, `glyph for ${k}`);
    assert.ok(l.length > 0, `label for ${k}`);
    glyphs.add(g);
    labels.add(l);
  }
  assert.equal(glyphs.size, AGENT_KINDS.length, 'glyphs distinct per kind');
  assert.equal(labels.size, AGENT_KINDS.length, 'labels distinct per kind');
});

test('matchesStatusFilter: failed always shown regardless of filter', () => {
  const filters: StatusFilter[] = ['active+idle', 'active', 'idle'];
  for (const f of filters) {
    assert.equal(matchesStatusFilter('failed', f), true, `failed under ${f}`);
  }
});

test('matchesStatusFilter: active+idle keeps active and idle', () => {
  assert.equal(matchesStatusFilter('active', 'active+idle'), true);
  assert.equal(matchesStatusFilter('idle', 'active+idle'), true);
});

test('matchesStatusFilter: active hides idle', () => {
  assert.equal(matchesStatusFilter('active', 'active'), true);
  assert.equal(matchesStatusFilter('idle', 'active'), false);
});

test('matchesStatusFilter: idle hides active', () => {
  assert.equal(matchesStatusFilter('idle', 'idle'), true);
  assert.equal(matchesStatusFilter('active', 'idle'), false);
});

test('nextStatusFilter cycles active+idle -> active -> idle -> active+idle', () => {
  assert.equal(nextStatusFilter('active+idle'), 'active');
  assert.equal(nextStatusFilter('active'), 'idle');
  assert.equal(nextStatusFilter('idle'), 'active+idle');
});

// ── sessions live feed ───────────────────────────────────────────────────────

test('runningSessions keeps only active/creating, newest activity first', () => {
  const list = [
    session({ id: 'idle', state: 'asleep', last_active: '2026-06-01T00:05:00Z' }),
    session({ id: 'old', state: 'active', last_active: '2026-06-01T00:01:00Z' }),
    session({ id: 'new', state: 'active', last_active: '2026-06-01T00:03:00Z' }),
    session({ id: 'creating', state: 'creating', last_active: '2026-06-01T00:02:00Z' }),
    session({ id: 'failed', state: 'failed', last_active: '2026-06-01T00:09:00Z' }),
  ];
  const ids = runningSessions(list).map((s) => s.id);
  assert.deepEqual(ids, ['new', 'creating', 'old']);
});

test('activityPhrase: active session maps the coarse activity hint to a phrase', () => {
  assert.equal(activityPhrase(session({ state: 'active', activity: 'tool_use' })), 'running a tool');
  assert.equal(activityPhrase(session({ state: 'active', activity: 'thinking' })), 'thinking');
  assert.equal(activityPhrase(session({ state: 'active', activity: 'idle' })), 'active, between steps');
});

test('activityPhrase: unknown activity falls through verbatim, blank reads "active"', () => {
  assert.equal(activityPhrase(session({ state: 'active', activity: 'compacting' })), 'compacting');
  assert.equal(activityPhrase(session({ state: 'active' })), 'active');
});

test('activityPhrase: dormant session shows its transition reason, not a fake', () => {
  assert.equal(
    activityPhrase(session({ state: 'asleep', reason: 'city-stop' })),
    'city-stop',
  );
  assert.equal(activityPhrase(session({ state: 'asleep', attached: true })), 'attached');
});

// ── operator ledger ──────────────────────────────────────────────────────────

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

test('operatorMail keeps only orchestration-sender mail, worker chatter folded, newest first', () => {
  const sessions = [
    // No rig → classified orch (the mayor); polecat-2 is a rig-scoped pool worker.
    session({ id: 'm', title: 'mayor' }),
    session({ id: 'p', title: 'polecat-2', rig: 'gascity', pool: 'polecat' }),
  ];
  const items = [
    mail({ id: 'worker', from: '/home/ds/gascity/polecat-2', created_at: '2026-06-01T00:09:00Z' }),
    mail({ id: 'mayor-old', from: '/home/ds/gascity/mayor', created_at: '2026-06-01T00:01:00Z' }),
    mail({ id: 'mayor-new', from: 'mayor', created_at: '2026-06-01T00:05:00Z' }),
    mail({ id: 'read-mayor', from: 'mayor', read: true }),
  ];
  const ids = operatorMail(items, sessions).map((m) => m.id);
  assert.deepEqual(ids, ['mayor-new', 'mayor-old']);
});

test('operatorMail falls back to the mayor role even with no live mayor session', () => {
  const items = [mail({ id: 'esc', from: '/some/path/mayor' })];
  assert.deepEqual(operatorMail(items, []).map((m) => m.id), ['esc']);
});

test('foldedMailCount reports how many unread were folded away', () => {
  const items = [
    mail({ id: 'a', from: 'polecat-1' }),
    mail({ id: 'b', from: 'polecat-2' }),
    mail({ id: 'm', from: 'mayor' }),
    mail({ id: 'read', from: 'polecat-3', read: true }),
  ];
  const shown = operatorMail(items, []);
  assert.equal(shown.length, 1);
  // 3 unread total, 1 shown → 2 folded (the read one isn't counted).
  assert.equal(foldedMailCount(items, shown), 2);
});

test('mailSnippet collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(mailSnippet('  hello\n\n  world  '), 'hello world');
  const long = 'x'.repeat(200);
  const snip = mailSnippet(long, 10);
  assert.equal(snip.length, 10);
  assert.ok(snip.endsWith('…'));
});
