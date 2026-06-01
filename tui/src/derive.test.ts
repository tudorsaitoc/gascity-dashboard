// Unit tests for the pure view-derivation helpers. Run with the workspace's
// `npm --workspace tui test` (node's built-in runner via tsx, matching the
// `shared` workspace convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcSession } from 'gas-city-dashboard-shared';
import {
  AGENT_KINDS,
  agentKind,
  kindGlyph,
  kindLabel,
  matchesStatusFilter,
  nextStatusFilter,
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
