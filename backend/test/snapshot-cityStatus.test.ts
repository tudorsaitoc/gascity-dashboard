import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { GcSession, GcSessionList } from 'gas-city-dashboard-shared';

import {
  aggregateSessionsByProvider,
  collectCityStatus,
  parseCityToml,
  quotedTomlValue,
} from '../src/snapshot/collectors/cityStatus.js';

// cityStatus collector coverage for gascity-dashboard-8nj.
//
// Per gascity-dashboard-dkb Q4 resolution (and upstream issue
// gastownhall/gascity#2508): the dashboard does NOT title-parse to infer
// provider. sessionsByProvider aggregates only over sessions where
// GcSession.provider is populated. Sessions without provider are TOLERATED
// (treated as 'unknown provider') and EXCLUDED from the breakdown.
// Demo-dash's inferProviderFromTitle is intentionally NOT ported.

function sess(partial: Partial<GcSession>): GcSession {
  return {
    id: 't-1',
    template: 'codex',
    state: 'active',
    created_at: '2026-05-22T00:00:00.000Z',
    attached: false,
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

  test('excludes sessions without provider (no title-parsing fallback)', () => {
    // Mix: some with provider, some without. Sessions without provider
    // are silently dropped from the aggregation — they are NOT inferred
    // from title even when title text contains 'codex'/'claude'/'gemini'.
    const sessions: GcSession[] = [
      sess({ id: 't-1', provider: 'codex', state: 'active' }),
      sess({ id: 't-2', title: 'codex/research', state: 'active' }), // no provider
      sess({ id: 't-3', title: 'claude/triage', state: 'active' }), // no provider
      sess({ id: 't-4', provider: 'claude', state: 'asleep' }),
    ];

    const breakdown = aggregateSessionsByProvider(sessions);

    assert.deepEqual(breakdown, [
      { provider: 'codex', active: 1, total: 1 },
      { provider: 'claude', active: 0, total: 1 },
    ]);
  });

  test('returns empty array when no session has provider', () => {
    const sessions: GcSession[] = [
      sess({ id: 't-1', title: 'codex/x' }),
      sess({ id: 't-2', title: 'claude/y' }),
    ];

    assert.deepEqual(aggregateSessionsByProvider(sessions), []);
  });

  test('returns empty array on empty input', () => {
    assert.deepEqual(aggregateSessionsByProvider([]), []);
  });
});

describe('collectCityStatus', () => {
  test('builds CityStatusSummary from sessions + null city.toml when cityPath unset', async () => {
    const sessionList: GcSessionList = {
      items: [
        sess({ id: 't-1', provider: 'codex', state: 'active' }),
        sess({ id: 't-2', provider: 'codex', state: 'asleep' }),
        sess({ id: 't-3', provider: 'claude', state: 'active' }),
      ],
    };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      cityPath: '',
    });

    assert.equal(summary.activeAgents, 2);
    assert.equal(summary.totalAgents, 3);
    assert.equal(summary.activeSessions, 2);
    assert.equal(summary.suspendedSessions, 1);
    assert.equal(summary.maxSessions, null);
    assert.deepEqual(summary.rigs, []);
    // Sort: active desc, then provider asc. codex and claude both have
    // active=1, so alpha tiebreak puts claude first.
    assert.deepEqual(summary.sessionsByProvider, [
      { provider: 'claude', active: 1, total: 1 },
      { provider: 'codex', active: 1, total: 2 },
    ]);
  });

  test('parses max_active_sessions and rigs from city.toml when reader returns one', async () => {
    const sessionList: GcSessionList = {
      items: [sess({ id: 't-1', provider: 'codex', state: 'active' })],
    };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      cityPath: '/fake/city',
      readCityToml: async () => ({
        maxSessions: 100,
        rigs: [{ name: 'rig-a', path: '/data/rig-a' }],
      }),
    });

    assert.equal(summary.maxSessions, 100);
    assert.deepEqual(summary.rigs, [{ name: 'rig-a', path: '/data/rig-a' }]);
  });

  test('tolerates missing city.toml: maxSessions=null, rigs=[]', async () => {
    const sessionList: GcSessionList = { items: [] };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      cityPath: '/fake/city',
      readCityToml: async () => null,
    });

    assert.equal(summary.maxSessions, null);
    assert.deepEqual(summary.rigs, []);
  });
});

describe('quotedTomlValue (gascity-dashboard-ddz)', () => {
  test('extracts value for a simple key', () => {
    assert.equal(quotedTomlValue('name = "rig-a"', 'name'), 'rig-a');
    assert.equal(quotedTomlValue('path = "/data/rig-a"', 'path'), '/data/rig-a');
  });

  test('returns null when key does not match the line', () => {
    assert.equal(quotedTomlValue('path = "/data"', 'name'), null);
  });

  test('does not match when key is a prefix of the line key', () => {
    // 'nameX = ...' must NOT match key='name'.
    assert.equal(quotedTomlValue('nameX = "x"', 'name'), null);
  });

  test('preserves greedy last-quote semantics for values with embedded quotes', () => {
    // The original regex used /(.*)/ which greedily matches to the last
    // double-quote. We preserve that — embedded escaped quotes are not
    // de-escaped, but they are kept inside the captured value.
    assert.equal(quotedTomlValue('name = "a\\"b"', 'name'), 'a\\"b');
  });

  test('does not treat regex metacharacters in the key as wildcards', () => {
    // REGRESSION (gascity-dashboard-ddz): the previous implementation
    // built `new RegExp(\`^${key}...\`)` from the raw key string. A key
    // containing a regex metachar like '.' would silently match unintended
    // lines. With the non-regex parser, dots are treated literally.

    // The dotted key 'max.sessions' must only match a line whose literal
    // key text is 'max.sessions', not lines like 'maxXsessions'.
    assert.equal(quotedTomlValue('maxXsessions = "10"', 'max.sessions'), null);
    assert.equal(quotedTomlValue('max.sessions = "10"', 'max.sessions'), '10');
  });

  test('returns null for lines without a quoted value', () => {
    assert.equal(quotedTomlValue('name = 10', 'name'), null);
    assert.equal(quotedTomlValue('name =', 'name'), null);
    assert.equal(quotedTomlValue('# comment', 'name'), null);
  });

  test('returns null for empty quoted value (pinned contract)', () => {
    // `name = ""` is syntactically valid TOML but semantically useless for
    // rig name/path. Contract pinned in wave-p3p4-clean Phase 4: return
    // null so the exported API matches parseCityToml's truthy guard.
    assert.equal(quotedTomlValue('name = ""', 'name'), null);
    assert.equal(quotedTomlValue('path = ""', 'path'), null);
  });
});

describe('parseCityToml (regression for ddz)', () => {
  test('parses [[rigs]] name and path correctly after quotedTomlValue rewrite', () => {
    const toml = `
max_active_sessions = 50

[[rigs]]
name = "rig-a"
path = "/data/rig-a"

[[rigs]]
name = "rig-b"
path = "/data/rig-b"
`;
    const summary = parseCityToml(toml);
    assert.equal(summary.maxSessions, 50);
    assert.deepEqual(summary.rigs, [
      { name: 'rig-a', path: '/data/rig-a' },
      { name: 'rig-b', path: '/data/rig-b' },
    ]);
  });
});
