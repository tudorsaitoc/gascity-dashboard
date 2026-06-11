// Short-TTL + single-flight cache for a tiny, fixed key space (gascity-dashboard).
//
// The supervisor transport proxy fans every request straight upstream and
// streams the body, so N concurrent identical city-wide reads (the
// molecule(all=true) history scan and the city formula feed) become N upstream
// calls — each a multi-second full-store scan that saturates the browser
// connection pool. This collapses concurrent identical reads into ONE upstream
// call (single-flight) and serves a short-TTL ready value for the closely-spaced
// re-fires that arrive just after the first resolves.
//
// Failures and non-2xx upstreams are NEVER cached: the loader throws, the entry
// is deleted, and the rejection propagates to every coalesced caller — a
// transient upstream failure must not be pinned and served for the TTL. The next
// request retries upstream.

export interface CachedResponse {
  status: number;
  headers: ReadonlyArray<readonly [string, string]>;
  body: Buffer;
}

type Entry =
  // `token` identifies WHICH load owns the slot: a concurrent forceFresh can
  // replace an in-flight entry, so a load only writes back (or deletes on error)
  // when it still owns the slot, never clobbering a newer load's value.
  | { state: 'inflight'; promise: Promise<CachedResponse>; token: object }
  | { state: 'ready'; value: CachedResponse; expiresAt: number };

export interface TtlSingleFlightCacheOptions {
  ttlMs: number;
  now?: () => number;
}

export interface GetOrFetchOptions {
  /**
   * Force a fresh upstream load, ignoring any ready/in-flight entry, and store
   * its result (resetting the TTL). For the operator's explicit Refresh, which
   * must re-scan upstream within the TTL window while preview/SSE reads keep
   * serving the amortized cache (gascity-dashboard-i3dz).
   */
  forceFresh?: boolean;
}

export interface TtlSingleFlightCache {
  getOrFetch(
    key: string,
    loader: () => Promise<CachedResponse>,
    options?: GetOrFetchOptions,
  ): Promise<CachedResponse>;
}

export function createTtlSingleFlightCache(
  options: TtlSingleFlightCacheOptions,
): TtlSingleFlightCache {
  const { ttlMs } = options;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  // Lazy expiry sweep: a ready entry is only refreshed when ITS key is touched,
  // so distinct expired variants (different param sets / cities) would otherwise
  // accumulate forever. On each getOrFetch, drop every ready entry whose TTL has
  // passed. Inflight entries are left alone — they self-resolve or self-delete.
  function sweepExpired(): void {
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.state === 'ready' && t >= entry.expiresAt) {
        entries.delete(key);
      }
    }
  }

  return {
    async getOrFetch(key, loader, options) {
      sweepExpired();
      // forceFresh skips BOTH a warm ready value and coalescing onto an
      // in-flight load: an explicit Refresh must observe genuinely fresh
      // upstream data, not a value that may predate the operator's intent.
      if (options?.forceFresh !== true) {
        const existing = entries.get(key);
        if (existing !== undefined) {
          if (existing.state === 'ready' && now() < existing.expiresAt) {
            return existing.value;
          }
          if (existing.state === 'inflight') {
            return existing.promise;
          }
        }
      }

      const token = {};
      const promise = (async () => {
        const value = await loader();
        // Repopulate only if this load still owns the inflight slot. A concurrent
        // forceFresh may have superseded it; the newer load's value must win, so a
        // slower predecessor resolving afterward must not re-pin its stale body.
        const current = entries.get(key);
        if (current?.state === 'inflight' && current.token === token) {
          entries.set(key, { state: 'ready', value, expiresAt: now() + ttlMs });
        }
        return value;
      })();
      entries.set(key, { state: 'inflight', promise, token });

      try {
        return await promise;
      } catch (err) {
        // Never cache a failure: drop the inflight entry so the next caller
        // retries upstream instead of being served the rejection for the TTL.
        // Same ownership guard — only the load that still owns the slot deletes it.
        const current = entries.get(key);
        if (current?.state === 'inflight' && current.token === token) {
          entries.delete(key);
        }
        throw err;
      }
    },
  };
}
