import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { GcRig, GcRigList, GcSession, GcSessionList } from 'gas-city-dashboard-shared';

import {
  aggregateSessionsByProvider,
  collectCityStatus,
} from '../src/snapshot/collectors/cityStatus.js';

// cityStatus collector coverage for gascity-dashboard-8nj /
// gascity-dashboard-19w.
//
// Per gascity-dashboard-dkb Q4 resolution (and upstream issue
// gastownhall/gascity#2508): the dashboard does NOT title-parse to infer
// provider. sessionsByProvider aggregates only over sessions where
// GcSession.provider is populated. Sessions without provider are TOLERATED
// (treated as 'unknown provider') and EXCLUDED from the breakdown.
// Demo-dash's inferProviderFromTitle is intentionally NOT ported.
//
// Per gascity-dashboard-19w: rigs are sourced from the supervisor's
// `GET /v0/city/{name}/rigs` HTTP API instead of parsing city.toml off
// the host filesystem. maxSessions is permanently 'unavailable' because
// the supervisor's HTTP API does NOT expose a city-level
// max_active_sessions field today — verified in upstream
// gastownhall/gascity@main: handler_status.go's StatusBody construction
// and handler_config.go's workspaceResponse/configAgentResponse both
// omit it. Tracked for upstream exposure in a follow-up bead.

function sess(partial: Partial<GcSession>): GcSession {
  // 6bv7 F10: running is required on the wire — default it from `state`
  // (gc supervisor marks asleep/closed sessions as running=false) so the
  // factory mirrors live data instead of forcing running=true for every
  // fixture regardless of lifecycle state.
  const state = partial.state ?? 'active';
  const running = partial.running ?? state === 'active';
  return {
    id: 't-1',
    template: 'codex',
    session_name: partial.id ?? 't-1',
    title: partial.id ?? 't-1',
    state,
    created_at: '2026-05-22T00:00:00.000Z',
    attached: false,
    running,
    provider: 'codex',
    ...partial,
  };
}

describe('aggregateSessionsByProvider', () => {
  test('aggregates active+total counts when every session has provider populated', () => {
    const sessions: GcSession[] = [
      sess({ id: 't-1', provider: 'codex', state: 'active' }),
      sess({ id: 't-2', provider: 'codex', state: 'asleep' }),
      sess({ id: 't-3', provider: 'codex', state: 'active' }),
      sess({ id: 't-4', provider: 'claude', state: 'active' }),
      sess({ id: 't-5', provider: 'claude', state: 'closed' }),
      sess({ id: 't-6', provider: 'gemini', state: 'active' }),
    ];

    const breakdown = aggregateSessionsByProvider(sessions);

    // Sorted by active desc, then provider asc.
    assert.deepEqual(breakdown, [
      { provider: 'codex', active: 2, total: 3 },
      { provider: 'claude', active: 1, total: 2 },
      { provider: 'gemini', active: 1, total: 1 },
    ]);
  });

  test('skips sessions with empty provider string and logs a single warn (6bv7.2)', () => {
    // 6bv7 F10 tightened GcSession.provider to required `string` per OpenAPI,
    // but the aggregator still skips empty-string providers as a defensive
    // guard against a degenerate supervisor response (the wire contract is
    // `string`, not "non-empty string"). Title text is NEVER consulted —
    // no inference fallback (ZFC).
    //
    // 6bv7.2: the skip is no longer silent — a single warn is emitted per
    // call with the count, so a supervisor sending `provider: ""` for all
    // sessions does not invisibly produce zero aggregated sessions.
    // Bounded by SourceCache TTL (~45s) so no log-spam risk.
    const warnMock = mock.method(console, 'warn', () => undefined);
    try {
      const sessions: GcSession[] = [
        sess({ id: 't-1', provider: 'codex', state: 'active' }),
        sess({ id: 't-2', title: 'codex/research', provider: '', state: 'active' }),
        sess({ id: 't-3', title: 'claude/triage', provider: '', state: 'active' }),
        sess({ id: 't-4', provider: 'claude', state: 'asleep' }),
      ];

      const breakdown = aggregateSessionsByProvider(sessions);

      assert.deepEqual(breakdown, [
        { provider: 'codex', active: 1, total: 1 },
        { provider: 'claude', active: 0, total: 1 },
      ]);

      const emptyWarns = warnMock.mock.calls.filter((call) =>
        String(call.arguments[0]).includes(
          'aggregateSessionsByProvider: 2 sessions skipped due to empty provider',
        ),
      );
      assert.equal(emptyWarns.length, 1, 'expected exactly one empty-provider warn per call');
    } finally {
      warnMock.mock.restore();
    }
  });

  test('returns empty array AND warns once when every provider is the empty string', () => {
    const warnMock = mock.method(console, 'warn', () => undefined);
    try {
      const sessions: GcSession[] = [
        sess({ id: 't-1', title: 'codex/x', provider: '' }),
        sess({ id: 't-2', title: 'claude/y', provider: '' }),
      ];

      assert.deepEqual(aggregateSessionsByProvider(sessions), []);

      const emptyWarns = warnMock.mock.calls.filter((call) =>
        String(call.arguments[0]).includes(
          'aggregateSessionsByProvider: 2 sessions skipped due to empty provider',
        ),
      );
      assert.equal(emptyWarns.length, 1);
    } finally {
      warnMock.mock.restore();
    }
  });

  test('does NOT warn when every session has a populated provider (happy path)', () => {
    const warnMock = mock.method(console, 'warn', () => undefined);
    try {
      const sessions: GcSession[] = [
        sess({ id: 't-1', provider: 'codex', state: 'active' }),
        sess({ id: 't-2', provider: 'claude', state: 'asleep' }),
      ];

      aggregateSessionsByProvider(sessions);

      const emptyWarns = warnMock.mock.calls.filter((call) =>
        String(call.arguments[0]).includes('aggregateSessionsByProvider:'),
      );
      assert.equal(emptyWarns.length, 0);
    } finally {
      warnMock.mock.restore();
    }
  });

  test('returns empty array on empty input', () => {
    assert.deepEqual(aggregateSessionsByProvider([]), []);
  });
});

describe('collectCityStatus', () => {
  test('builds CityStatusSummary from sessions + rigs HTTP responses; maxSessions stays unavailable', async () => {
    const sessionList: GcSessionList = {
      items: [
        sess({ id: 't-1', provider: 'codex', state: 'active' }),
        sess({ id: 't-2', provider: 'codex', state: 'asleep' }),
        sess({ id: 't-3', provider: 'claude', state: 'active' }),
      ],
      total: 3,
    };
    const rigList: GcRigList = {
      items: [
        { name: 'rig-a', path: '/data/rig-a' },
        { name: 'rig-b', path: '/data/rig-b' },
      ],
    };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      listRigs: async () => rigList,
    });

    assert.equal(summary.activeAgents, 2);
    assert.equal(summary.totalAgents, 3);
    assert.equal(summary.activeSessions, 2);
    assert.equal(summary.suspendedSessions, 1);
    assert.deepEqual(summary.maxSessions, {
      status: 'unavailable',
      source: 'city',
      error: 'supervisor HTTP API does not expose city-level max_active_sessions',
    });
    assert.deepEqual(summary.rigs, [
      { name: 'rig-a', path: '/data/rig-a' },
      { name: 'rig-b', path: '/data/rig-b' },
    ]);
    // Sort: active desc, then provider asc. codex and claude both have
    // active=1, so alpha tiebreak puts claude first.
    assert.deepEqual(summary.sessionsByProvider, [
      { provider: 'claude', active: 1, total: 1 },
      { provider: 'codex', active: 1, total: 2 },
    ]);
  });

  test('empty sessions and empty rigs remain zero counts; maxSessions still unavailable', async () => {
    const summary = await collectCityStatus({
      listSessions: async () => ({ items: [], total: 0 }),
      listRigs: async () => ({ items: [] }),
    });

    assert.equal(summary.activeAgents, 0);
    assert.equal(summary.totalAgents, 0);
    assert.equal(summary.activeSessions, 0);
    assert.equal(summary.suspendedSessions, 0);
    assert.deepEqual(summary.maxSessions, {
      status: 'unavailable',
      source: 'city',
      error: 'supervisor HTTP API does not expose city-level max_active_sessions',
    });
    assert.deepEqual(summary.rigs, []);
  });

  test('rigs collector failure surfaces — no swallow', async () => {
    // gascity-dashboard-19w: listRigs is awaited; if the supervisor 5xx's,
    // the collector throws so the city source goes to status='error' per
    // the failure-isolation contract. We do NOT silently aggregate an
    // empty rigs list, which would mask the upstream outage.
    await assert.rejects(
      collectCityStatus({
        listSessions: async () => ({ items: [], total: 0 }),
        listRigs: async () => {
          throw new Error('gc supervisor returned 502');
        },
      }),
      /gc supervisor returned 502/,
    );
  });

  test('rigs partial: true surfaces degradation via rigsPartial — does not silently report empty', async () => {
    // gascity-dashboard-19w.1: when the supervisor returns
    // `partial: true` with `items` normalized to `[]` (one or more rig
    // backends failed during aggregation), the collector MUST surface
    // the degradation signal so the operator sees "rigs degraded"
    // rather than "no rigs configured." Convention mirrors
    // backend/src/routes/links.ts:118 and routes/mail.ts:62.
    const rigList: GcRigList = {
      items: [],
      partial: true,
      partial_errors: ['backend A: connection refused', 'backend B: 502'],
    };

    const summary = await collectCityStatus({
      listSessions: async () => ({ items: [], total: 0 }),
      listRigs: async () => rigList,
    });

    assert.equal(summary.rigsPartial, true);
    assert.deepEqual(summary.rigs, []);
  });

  test('rigs partial: true with some items still surfaces degradation AND retains items', async () => {
    // Supervisor can return both: some backends succeeded (items present)
    // AND some backends failed (partial: true). Both signals must reach
    // the operator — we keep the items we got AND mark degradation.
    const rigList: GcRigList = {
      items: [{ name: 'rig-a', path: '/data/rig-a' }],
      partial: true,
    };

    const summary = await collectCityStatus({
      listSessions: async () => ({ items: [], total: 0 }),
      listRigs: async () => rigList,
    });

    assert.equal(summary.rigsPartial, true);
    assert.deepEqual(summary.rigs, [{ name: 'rig-a', path: '/data/rig-a' }]);
  });

  test('rigs partial_errors non-empty without partial: true still surfaces degradation', async () => {
    // Defensive parity with links.ts:118 / mail.ts:62: either signal
    // (partial===true OR partial_errors non-empty) is sufficient.
    const rigList: GcRigList = {
      items: [{ name: 'rig-a', path: '/data/rig-a' }],
      partial_errors: ['backend X: timeout'],
    };

    const summary = await collectCityStatus({
      listSessions: async () => ({ items: [], total: 0 }),
      listRigs: async () => rigList,
    });

    assert.equal(summary.rigsPartial, true);
  });

  test('GcRig fixture projects to CityRig with name+path only (19w.2 regression guard)', async () => {
    // 19w.2: toCityRig delegation-only mapper was dropped in favor of an
    // inline projection at the call site. GcRig and CityRig are structurally
    // equivalent ({ name: string; path: string }); the inline projection
    // preserves the explicit field-strip so a future widening of GcRig
    // upstream cannot silently leak new fields into the snapshot wire shape.
    // This test pins that contract.
    const fixture: GcRig = { name: 'rig-a', path: '/data/rig-a' };
    // Cast to a wider shape to simulate GcRig being widened upstream with
    // a field that has not yet been exposed in CityRig — the inline
    // projection must drop it.
    const widened = { ...fixture, agent_count: 7, running_count: 3 } as GcRig;
    const rigList: GcRigList = { items: [widened] };

    const summary = await collectCityStatus({
      listSessions: async () => ({ items: [], total: 0 }),
      listRigs: async () => rigList,
    });

    assert.deepEqual(summary.rigs, [{ name: 'rig-a', path: '/data/rig-a' }]);
    assert.equal(Object.keys(summary.rigs[0]!).length, 2);
  });

  test('rigs without partial signal — rigsPartial omitted', async () => {
    // Happy path: clean response has no rigsPartial in the summary
    // (the field is optional so callers can use truthy checks).
    const summary = await collectCityStatus({
      listSessions: async () => ({ items: [], total: 0 }),
      listRigs: async () => ({ items: [{ name: 'rig-a', path: '/data/rig-a' }] }),
    });

    assert.equal(summary.rigsPartial, undefined);
  });
});
