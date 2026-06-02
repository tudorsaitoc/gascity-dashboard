// Unit tests for the pure view-derivation helpers. Run with the workspace's
// `npm --workspace tui test` (node's built-in runner via tsx, matching the
// `shared` workspace convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcMailItem, GcSession, RunLane, RunPhase } from 'gas-city-dashboard-shared';
import {
  AGENT_KINDS,
  activityPhrase,
  agentKind,
  cityBoard,
  CITY_BOARD_PHASES,
  CITY_BOARD_PHASE_LABEL,
  foldedMailCount,
  kindGlyph,
  kindLabel,
  mailSnippet,
  matchesStatusFilter,
  nextStatusFilter,
  operatorMail,
  ORCHESTRATION,
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

// ── city board (rig × in-flight phase count matrix) ──────────────────────────

function lane(over: {
  id?: string;
  /** null → city scope (buckets under orchestration); otherwise the rig name. */
  rig?: string | null;
  phase?: RunPhase;
  needsOperator?: boolean;
  /** Scope reports unavailable (the other null-rig path → orchestration bucket). */
  scopeUnavailable?: boolean;
}): RunLane {
  const rig = over.rig === undefined ? 'gascity' : over.rig;
  const scope: RunLane['scope'] = over.scopeUnavailable
    ? { status: 'unavailable', error: 'scope timeout' }
    : rig === null
      ? { status: 'available', kind: 'city', ref: 'city', rootStoreRef: 'city:gastown' }
      : { status: 'available', kind: 'rig', ref: rig, rootStoreRef: `rig:${rig}` };
  const phase = over.phase ?? 'implementation';
  return {
    id: over.id ?? 'l1',
    title: over.id ?? 'l1',
    formula: { status: 'unavailable', error: 'none' },
    scope,
    external: { status: 'unavailable', error: 'none' },
    phase,
    phaseLabel: phase,
    statusCounts: {},
    activeAssignees: [],
    updatedAt: { status: 'available', at: '2026-06-01T00:00:00Z' },
    stages: [],
    progress: { status: 'unavailable', error: 'none' },
    formulaStageResolved: false,
    health: {
      status: 'available',
      data: {
        phaseConfidence: 'known',
        needsOperator: over.needsOperator ?? false,
        stuckNode: { status: 'unavailable', error: 'none' },
        thrashingDetected: false,
        session: { status: 'unresolved', error: 'none' },
      },
    },
  };
}

test('CITY_BOARD_PHASES excludes complete and every column has a label', () => {
  assert.ok(!(CITY_BOARD_PHASES as readonly string[]).includes('complete'), 'complete is not a column');
  for (const p of CITY_BOARD_PHASES) {
    assert.ok(CITY_BOARD_PHASE_LABEL[p].length > 0, `label for ${p}`);
  }
});

test('cityBoard counts lanes per rig × in-flight phase', () => {
  const board = cityBoard([
    lane({ id: 'a', rig: 'stealth-retainers', phase: 'review' }),
    lane({ id: 'b', rig: 'stealth-retainers', phase: 'review' }),
    lane({ id: 'c', rig: 'stealth-retainers', phase: 'approval' }),
    lane({ id: 'd', rig: 'gc2', phase: 'implementation' }),
  ]);
  const sr = board.find((r) => r.rig === 'stealth-retainers');
  const gc2 = board.find((r) => r.rig === 'gc2');
  assert.ok(sr && gc2);
  assert.equal(sr.counts.review, 2);
  assert.equal(sr.counts.approval, 1);
  assert.equal(sr.total, 3);
  assert.equal(gc2.counts.implementation, 1);
  assert.equal(gc2.total, 1);
});

test('cityBoard excludes complete lanes entirely (honest-signal: history is capped)', () => {
  const board = cityBoard([
    lane({ id: 'a', rig: 'gc2', phase: 'implementation' }),
    lane({ id: 'done1', rig: 'gc2', phase: 'complete' }),
    lane({ id: 'done2', rig: 'gc2', phase: 'complete' }),
  ]);
  const gc2 = board.find((r) => r.rig === 'gc2');
  assert.ok(gc2);
  assert.equal(gc2.total, 1, 'complete lanes are not counted in the total');
  // No 'complete' key on the counts record.
  assert.deepEqual(Object.keys(gc2.counts).sort(), [...CITY_BOARD_PHASES].sort());
});

test('cityBoard counts needsOperator separately as the red-mark source', () => {
  const board = cityBoard([
    lane({ id: 'a', rig: 'gc2', phase: 'blocked', needsOperator: true }),
    lane({ id: 'b', rig: 'gc2', phase: 'review', needsOperator: false }),
  ]);
  const gc2 = board.find((r) => r.rig === 'gc2');
  assert.ok(gc2);
  assert.equal(gc2.needsOperator, 1);
  assert.equal(gc2.total, 2);
});

test('cityBoard buckets city-scoped lanes under orchestration', () => {
  const board = cityBoard([lane({ id: 'city', rig: null, phase: 'intake' })]);
  assert.equal(board.length, 1);
  assert.equal(board[0]?.rig, ORCHESTRATION);
  assert.equal(board[0]?.counts.intake, 1);
});

test('cityBoard buckets unavailable-scope lanes under orchestration too', () => {
  // laneRig returns null both for city scope and for an unavailable scope; the
  // latter must not vanish — it falls into the orchestration bucket.
  const board = cityBoard([lane({ id: 'u', scopeUnavailable: true, phase: 'review' })]);
  assert.equal(board.length, 1);
  assert.equal(board[0]?.rig, ORCHESTRATION);
  assert.equal(board[0]?.counts.review, 1);
});

test('cityBoard omits a rig whose only lanes are complete (no empty row)', () => {
  const board = cityBoard([
    lane({ id: 'd1', rig: 'done-rig', phase: 'complete' }),
    lane({ id: 'd2', rig: 'done-rig', phase: 'complete' }),
  ]);
  assert.equal(board.find((r) => r.rig === 'done-rig'), undefined);
  assert.equal(board.length, 0);
});

test('cityBoard orders attention rigs (needsOperator) first, then busiest', () => {
  const board = cityBoard([
    // calm-but-busy rig
    lane({ id: 'b1', rig: 'busy', phase: 'implementation' }),
    lane({ id: 'b2', rig: 'busy', phase: 'review' }),
    lane({ id: 'b3', rig: 'busy', phase: 'review' }),
    // attention rig, fewer lanes
    lane({ id: 'a1', rig: 'attention', phase: 'blocked', needsOperator: true }),
  ]);
  assert.deepEqual(board.map((r) => r.rig), ['attention', 'busy']);
});
