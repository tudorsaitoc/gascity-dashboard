import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SourceCache, errorMessage } from '../src/snapshot/cache.js';

// Read-side cache primitive ported from demo-dash for the snapshot series
// (gascity-dashboard-glw). Six required cases per the bead SCOPE:
//   1. TTL: fresh → stale transition at boundary
//   2. Single-flight: concurrent .get() coalesces into one load()
//   3. Stale-while-error: load() throws after a prior success → status='stale'
//      with .data preserved and .error populated
//   4. Fixture fallback: useFixture + loadFixture + load() throws → status='fixture'
//   5. Never-fetched + load() throws → synthetic status='error' state, null data
//   6. snapshot() returns last cached state without triggering a load

describe('SourceCache', () => {
  test('TTL: state transitions from fresh to stale at the boundary', async () => {
    let nowMs = Date.parse('2026-05-22T12:00:00.000Z');
    let loadCount = 0;
    const cache = new SourceCache({
      source: 'resources',
      ttlMs: 1_000,
      now: () => new Date(nowMs),
      load: () => {
        loadCount += 1;
        return { value: 'live' };
      },
    });

    const fresh = await cache.get();
    assert.equal(fresh.status, 'fresh');
    assert.deepEqual(fresh.data, { value: 'live' });
    assert.equal(fresh.fetchedAt, '2026-05-22T12:00:00.000Z');
    assert.equal(fresh.staleAt, '2026-05-22T12:00:01.000Z');
    assert.equal(fresh.error, null);

    // Inside TTL window — should still be fresh, no extra load.
    nowMs += 500;
    const stillFresh = await cache.get();
    assert.equal(stillFresh.status, 'fresh');
    assert.equal(loadCount, 1);

    // Past TTL boundary — .get() should refresh (and succeed again).
    nowMs += 600;
    const refreshed = await cache.get();
    assert.equal(refreshed.status, 'fresh');
    assert.equal(loadCount, 2);
  });

  test('single-flight: concurrent .get() calls coalesce into one load()', async () => {
    let loadCount = 0;
    let resolveLoad: ((value: { value: string }) => void) | undefined;

    const cache = new SourceCache({
      source: 'github',
      ttlMs: 1_000,
      load: () =>
        new Promise<{ value: string }>((resolve) => {
          loadCount += 1;
          resolveLoad = resolve;
        }),
    });

    // Three concurrent callers while load() is still pending. All must
    // share the same inFlight promise — this directly probes the
    // mid-flight coalescing window, not the post-settle cache-hit window.
    const first = cache.get();
    const second = cache.get();
    const third = cache.get();

    assert.equal(loadCount, 1, 'all three callers must share one load()');
    assert.ok(resolveLoad, 'load() should have started');
    resolveLoad?.({ value: 'shared' });

    const [a, b, c] = await Promise.all([first, second, third]);
    assert.deepEqual(a.data, { value: 'shared' });
    assert.deepEqual(b.data, { value: 'shared' });
    assert.deepEqual(c.data, { value: 'shared' });
    assert.equal(loadCount, 1);

    // After the promise settles and .finally() has cleared inFlight, a
    // fresh .get() finds liveEntry within TTL and returns the cached value
    // without re-entering load(). This is the post-settle cache-hit path
    // — distinct from (and weaker than) the mid-flight coalescing above.
    const fourth = await cache.get();
    assert.deepEqual(fourth.data, { value: 'shared' });
    assert.equal(loadCount, 1, 'cache-hit must not trigger a new load');
  });

  test('stale-while-error: load() throws after success → status stale with data preserved', async () => {
    let nowMs = Date.parse('2026-05-22T12:00:00.000Z');
    const loads: Array<'success' | 'failure'> = ['success', 'failure'];
    const cache = new SourceCache({
      source: 'workflows',
      ttlMs: 1_000,
      now: () => new Date(nowMs),
      load: async () => {
        const next = loads.shift();
        if (next === 'failure') {
          throw new Error('collector failed');
        }
        return { value: 'live' };
      },
      // Opt out of sanitization so the assertion below can probe the
      // raw upstream message — this test is about the stale-while-error
      // contract, not the sanitization path.
      sanitizeErrorMessage: null,
    });

    const fresh = await cache.get();
    assert.equal(fresh.status, 'fresh');
    assert.deepEqual(fresh.data, { value: 'live' });

    // Advance past TTL so the next .get() triggers a refresh.
    nowMs += 1_500;
    const stale = await cache.get();
    assert.equal(stale.status, 'stale');
    assert.equal(stale.error, 'collector failed');
    assert.deepEqual(stale.data, { value: 'live' });
    // Stale entry retains the original fetchedAt; staleAt is original + ttl.
    assert.equal(stale.fetchedAt, '2026-05-22T12:00:00.000Z');
    assert.equal(stale.staleAt, '2026-05-22T12:00:01.000Z');
  });

  test('fixture fallback: useFixture + load() throws → status fixture with fixture data', async () => {
    const cache = new SourceCache({
      source: 'city',
      ttlMs: 1_000,
      useFixture: true,
      load: async () => {
        throw new Error('live source unavailable');
      },
      loadFixture: async () => ({ activeAgents: 4 }),
      // Probe raw error passthrough — this test is about the
      // fixture-fallback contract, not sanitization.
      sanitizeErrorMessage: null,
    });

    const state = await cache.get();
    assert.equal(state.source, 'city');
    assert.equal(state.status, 'fixture');
    assert.equal(state.error, 'live source unavailable');
    assert.deepEqual(state.data, { activeAgents: 4 });
  });

  test('never-fetched + load() throws → synthetic error state with null data', async () => {
    const cache = new SourceCache({
      source: 'tokens',
      ttlMs: 1_000,
      load: async () => {
        throw new Error('upstream offline');
      },
      // Probe raw error passthrough — this test is about the
      // never-fetched-error contract, not sanitization.
      sanitizeErrorMessage: null,
    });

    const state = await cache.get();
    assert.equal(state.source, 'tokens');
    assert.equal(state.status, 'error');
    assert.equal(state.data, null);
    assert.equal(state.error, 'upstream offline');
    assert.equal(state.fetchedAt, null);
    assert.equal(state.staleAt, null);
  });

  test('snapshot() returns last cached state without triggering a load', async () => {
    let loadCount = 0;
    const cache = new SourceCache({
      source: 'aimux',
      ttlMs: 1_000,
      load: () => {
        loadCount += 1;
        return { value: 'cached' };
      },
    });

    // Before any fetch, snapshot() returns synthetic error WITHOUT calling load().
    const cold = cache.snapshot();
    assert.equal(cold.status, 'error');
    assert.equal(cold.data, null);
    assert.equal(loadCount, 0);

    // Prime with one .get(), then snapshot() must return the cached value
    // without bumping loadCount.
    await cache.get();
    assert.equal(loadCount, 1);
    const warm = cache.snapshot();
    assert.equal(warm.status, 'fresh');
    assert.deepEqual(warm.data, { value: 'cached' });
    assert.equal(loadCount, 1, 'snapshot() must not call load()');
  });

  test('get({ force: true }) bypasses cache hit and re-invokes load() within TTL', async () => {
    // Fixed clock so the TTL window never elapses on its own — the only
    // thing that can cause a second load() is the force flag itself.
    const fixedNow = new Date('2026-05-22T12:00:00.000Z');
    let loadCount = 0;
    const cache = new SourceCache({
      source: 'resources',
      ttlMs: 60_000,
      now: () => fixedNow,
      load: () => {
        loadCount += 1;
        return { value: `load-${loadCount}` };
      },
    });

    const fresh = await cache.get();
    assert.equal(fresh.status, 'fresh');
    assert.deepEqual(fresh.data, { value: 'load-1' });
    assert.equal(loadCount, 1);

    // Without force, a second .get() inside TTL must NOT re-invoke load().
    const cached = await cache.get();
    assert.deepEqual(cached.data, { value: 'load-1' });
    assert.equal(loadCount, 1, 'unforced .get() within TTL must reuse cache');

    // With force: even inside TTL, .get() must bypass the cache-hit early
    // return and trigger a fresh load().
    const forced = await cache.get({ force: true });
    assert.equal(forced.status, 'fresh');
    assert.deepEqual(forced.data, { value: 'load-2' });
    assert.equal(loadCount, 2, 'force=true must trigger a fresh load() within TTL');
  });

  test('supports synchronous load() returning T (not Promise<T>)', async () => {
    // The load type is `() => Promise<T> | T` — tests 1 and 6 use the sync
    // form implicitly. This case is the explicit, labelled contract test
    // confirming a non-Promise return resolves correctly through .get().
    let loadCount = 0;
    const cache = new SourceCache<{ value: string }>({
      source: 'tokens',
      ttlMs: 1_000,
      load: (): { value: string } => {
        loadCount += 1;
        return { value: 'sync-return' };
      },
    });

    const state = await cache.get();
    assert.equal(state.status, 'fresh');
    assert.deepEqual(state.data, { value: 'sync-return' });
    assert.equal(loadCount, 1);

    // snapshot() must also surface the synchronously-loaded entry.
    const snap = cache.snapshot();
    assert.equal(snap.status, 'fresh');
    assert.deepEqual(snap.data, { value: 'sync-return' });
  });
});

describe('SourceCache constructor validation', () => {
  test('throws when ttlMs is zero', () => {
    assert.throws(
      () =>
        new SourceCache({
          source: 'resources',
          ttlMs: 0,
          load: () => ({ value: 'noop' }),
        }),
      /ttlMs must be a positive finite number/,
    );
  });

  test('throws when ttlMs is negative', () => {
    assert.throws(
      () =>
        new SourceCache({
          source: 'resources',
          ttlMs: -1,
          load: () => ({ value: 'noop' }),
        }),
      /ttlMs must be a positive finite number/,
    );
  });

  test('throws when ttlMs is NaN', () => {
    assert.throws(
      () =>
        new SourceCache({
          source: 'resources',
          ttlMs: Number.NaN,
          load: () => ({ value: 'noop' }),
        }),
      /ttlMs must be a positive finite number/,
    );
  });

  test('throws when ttlMs is Infinity', () => {
    assert.throws(
      () =>
        new SourceCache({
          source: 'resources',
          ttlMs: Number.POSITIVE_INFINITY,
          load: () => ({ value: 'noop' }),
        }),
      /ttlMs must be a positive finite number/,
    );
  });
});

describe('errorMessage', () => {
  test('returns message for Error instances', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
  });

  test('falls back to String() for non-Error values', () => {
    assert.equal(errorMessage('plain string'), 'plain string');
    assert.equal(errorMessage(42), '42');
    assert.equal(errorMessage(null), 'null');
  });
});

describe('SourceCache error sanitization (gascity-dashboard-fhj, gascity-dashboard-4r5)', () => {
  // The wire-shape SourceState.error is served to the browser via
  // GET /api/snapshot. For collectors that hit local OS resources
  // (e.g. /proc/meminfo), the raw Error.message will include the
  // OS-internal path, which is a topology leak.
  //
  // gascity-dashboard-4r5 inverted the default: sanitization is now ON
  // for every source. A collector opts OUT (raw passthrough) by passing
  // `sanitizeErrorMessage: null` explicitly — reserved for collectors
  // whose load() already throws a sanitized message (e.g. GcClient:
  // `gc supervisor returned ${status}`). Collectors that pass a custom
  // function still get their custom sanitizer applied. The pre-fhj
  // legacy where an omitted option leaked raw OS paths is gone.

  test('sanitizeErrorMessage collapses raw OS path leak to generic message', async () => {
    const cache = new SourceCache({
      source: 'resources',
      ttlMs: 1_000,
      load: async () => {
        // The exact shape of a Node fs readFile failure on a missing
        // /proc/meminfo: the absolute path is embedded in the message.
        throw new Error('ENOENT: no such file or directory, open /proc/meminfo');
      },
      sanitizeErrorMessage: () => 'resource collection failed',
    });

    const state = await cache.get();
    assert.equal(state.status, 'error');
    assert.equal(state.data, null);
    assert.equal(state.error, 'resource collection failed');
    // Regression guard: the OS path must never appear in the wire shape.
    assert.ok(!state.error?.includes('/proc/meminfo'));
    assert.ok(!state.error?.includes('ENOENT'));
  });

  test('default-on: omitting sanitizeErrorMessage collapses raw error to "<source> collection failed"', async () => {
    // gascity-dashboard-4r5 acceptance: a hypothetical new local-IO
    // collector that forgets to wire any sanitization option must NOT
    // leak its raw error to the wire shape. The default sanitizer kicks
    // in automatically.
    const cache = new SourceCache({
      source: 'resources',
      ttlMs: 1_000,
      load: async () => {
        throw new Error('ENOENT: no such file or directory, open /proc/meminfo');
      },
    });

    const state = await cache.get();
    assert.equal(state.status, 'error');
    assert.equal(state.error, 'resources collection failed');
    assert.ok(!state.error?.includes('/proc/meminfo'));
    assert.ok(!state.error?.includes('ENOENT'));
  });

  test('default-on uses the source name in the generic message', async () => {
    // Pin the message shape so the contract is observable from outside
    // the cache module (the route layer surfaces this to the operator).
    const cases: Array<{ source: 'city' | 'workflows' | 'tokens'; expected: string }> = [
      { source: 'city', expected: 'city collection failed' },
      { source: 'workflows', expected: 'workflows collection failed' },
      { source: 'tokens', expected: 'tokens collection failed' },
    ];

    for (const { source, expected } of cases) {
      const cache = new SourceCache({
        source,
        ttlMs: 1_000,
        load: async () => {
          throw new Error('whatever the raw error was');
        },
      });
      const state = await cache.get();
      assert.equal(state.error, expected, `source=${source}`);
    }
  });

  test('opt-out (sanitizeErrorMessage: null): raw upstream-sanitized message passes through unchanged', async () => {
    // Mirrors the city-source contract: GcClient.fetchOnce already
    // throws `gc supervisor returned ${status}`. The city collector
    // opts out via `sanitizeErrorMessage: null` so the operator sees
    // the upstream status code in the wire-shape error.
    const cache = new SourceCache({
      source: 'city',
      ttlMs: 1_000,
      load: async () => {
        throw new Error('gc supervisor returned 503');
      },
      sanitizeErrorMessage: null,
    });

    const state = await cache.get();
    assert.equal(state.status, 'error');
    assert.equal(state.error, 'gc supervisor returned 503');
  });

  test('opt-out applies to the fixture-failure concat path as well', async () => {
    // Symmetry: when both load() and loadFixture() throw, the cache
    // concatenates the two sanitized messages. With opt-out, both raw
    // messages pass through (the city collector's loadFixture is the
    // fixture loader, which only throws structural errors).
    const cache = new SourceCache({
      source: 'city',
      ttlMs: 1_000,
      useFixture: true,
      load: async () => {
        throw new Error('gc supervisor returned 503');
      },
      loadFixture: async () => {
        throw new Error('fixture data for source city is null');
      },
      sanitizeErrorMessage: null,
    });

    const state = await cache.get();
    assert.equal(state.status, 'error');
    assert.ok(state.error?.includes('gc supervisor returned 503'));
    assert.ok(state.error?.includes('fixture data for source city is null'));
  });

  test('onError observer fires with raw error BEFORE sanitization, so server-side logs keep fidelity', async () => {
    // The opt-in pair (sanitizeErrorMessage + onError) is meant to give
    // local-IO collectors the path-leak protection on the wire AND the
    // raw-error fidelity in server logs. A future refactor that reversed
    // the call order (sanitize first, then fire onError with the already-
    // sanitized string) would silently degrade debugging — this test
    // pins the contract.
    const observed: Array<{ source: string; phase: string; raw: string }> = [];
    const rawMessage =
      'ENOENT: no such file or directory, open /proc/meminfo';

    const cache = new SourceCache({
      source: 'resources',
      ttlMs: 1_000,
      load: async () => {
        throw new Error(rawMessage);
      },
      sanitizeErrorMessage: () => 'resource collection failed',
      onError: (source, phase, err) => {
        observed.push({
          source,
          phase,
          raw: err instanceof Error ? err.message : String(err),
        });
      },
    });

    const state = await cache.get();

    // Wire-shape stays sanitized.
    assert.equal(state.error, 'resource collection failed');

    // onError fired exactly once for the 'load' phase, with the RAW
    // pre-sanitization message — that's the server-side fidelity guarantee.
    assert.equal(observed.length, 1);
    const [first] = observed;
    assert.ok(first, 'onError should have been invoked');
    assert.equal(first.source, 'resources');
    assert.equal(first.phase, 'load');
    assert.equal(first.raw, rawMessage);
  });

  test('sanitizeErrorMessage also covers the fixture-failure concat path', async () => {
    // When the primary load() fails AND the fixture loader fails, the
    // cache concatenates both messages. A local-source collector that
    // ships fixtures from disk could leak a path through the fixture
    // error — sanitize that side too.
    const cache = new SourceCache({
      source: 'resources',
      ttlMs: 1_000,
      useFixture: true,
      load: async () => {
        throw new Error('ENOENT: open /proc/meminfo');
      },
      loadFixture: async () => {
        throw new Error(
          'ENOENT: no such file or directory, open /var/lib/dashboard/fixtures/resources.json',
        );
      },
      sanitizeErrorMessage: () => 'resource collection failed',
    });

    const state = await cache.get();
    assert.equal(state.status, 'error');
    assert.ok(!state.error?.includes('/proc/'));
    assert.ok(!state.error?.includes('/var/lib'));
    assert.ok(!state.error?.includes('ENOENT'));
    // The sanitized message appears for both halves; cache uses the
    // same sanitizer on each side so the concat result is two copies
    // of the generic string. Exact shape is an internal detail; the
    // contract is: no raw path leaked.
    assert.ok(state.error?.includes('resource collection failed'));
  });
});
