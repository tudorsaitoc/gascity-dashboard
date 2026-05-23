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

describe('SourceCache error sanitization (gascity-dashboard-fhj)', () => {
  // The wire-shape SourceState.error is served to the browser via
  // GET /api/snapshot. For collectors that hit local OS resources
  // (e.g. /proc/meminfo), the raw Error.message will include the
  // OS-internal path, which is a topology leak. Collectors that own
  // local IO opt in via the sanitizeErrorMessage option; upstream
  // sources whose errors are already sanitized (city via GcClient,
  // 'gc supervisor returned NNN') pass through unchanged.

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

  test('without sanitizeErrorMessage, pre-sanitized upstream errors pass through unchanged', async () => {
    // Mirrors the city-source contract: GcClient.fetchOnce already
    // throws `gc supervisor returned ${status}` and the cache should
    // not double-sanitize that.
    const cache = new SourceCache({
      source: 'city',
      ttlMs: 1_000,
      load: async () => {
        throw new Error('gc supervisor returned 503');
      },
    });

    const state = await cache.get();
    assert.equal(state.status, 'error');
    assert.equal(state.error, 'gc supervisor returned 503');
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
