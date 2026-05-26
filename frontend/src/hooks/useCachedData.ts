import { useCallback, useEffect, useRef, useState } from 'react';
import { getCached, setCached } from '../api/cache';

interface UseCachedDataResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export interface UseCachedDataOptions<T> {
  /**
   * When provided, explicit refresh() calls route through this fetcher
   * instead of the primary one. The mount-effect always uses the
   * primary `fetcher` so initial paint stays cache-warm. Useful when
   * the same source has a cheap GET and a TTL-bypassing POST: pass
   * the GET as `fetcher` and the POST as `refreshFetcher`.
   */
  refreshFetcher?: () => Promise<T>;
}

/**
 * Stale-while-revalidate fetch hook. On mount:
 *   - If the cache has the key: seed state with cached data and
 *     render synchronously, then kick off a background refresh.
 *   - Otherwise: render loading=true and fetch.
 *
 * `key` changes (e.g. params shift) reseed from cache for the new
 * key and refetch. `fetcher` is captured in a ref so callers don't
 * need to memoize it to avoid refetch loops — refetches only fire
 * on key change or explicit refresh().
 */
export function useCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: UseCachedDataOptions<T>,
): UseCachedDataResult<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const refreshFetcherRef = useRef(options?.refreshFetcher);
  refreshFetcherRef.current = options?.refreshFetcher;
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;
  const runIdRef = useRef(0);

  const [data, setData] = useState<T | undefined>(() => getCached<T>(key));
  const [loading, setLoading] = useState<boolean>(() => getCached<T>(key) === undefined);
  const [error, setError] = useState<string | null>(null);

  const runFetcher = useCallback(
    async (fetch: () => Promise<T>) => {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const cacheKey = key;
      setLoading(true);
      setError(null);
      try {
        const fresh = await fetch();
        const isLatestRun = runIdRef.current === runId;
        const isInactiveKey = currentKeyRef.current !== cacheKey;
        if (isLatestRun || isInactiveKey) setCached(cacheKey, fresh);
        if (isLatestRun) setData(fresh);
      } catch (err) {
        if (runIdRef.current === runId) {
          setError(err instanceof Error ? err.message : 'failed to load');
        }
      } finally {
        if (runIdRef.current === runId) setLoading(false);
      }
    },
    [key],
  );

  // Explicit refresh prefers the bypass fetcher when configured;
  // mount-effect always uses the cheap primary fetcher.
  const refresh = useCallback(
    () => runFetcher(refreshFetcherRef.current ?? fetcherRef.current),
    [runFetcher],
  );

  useEffect(() => {
    const cached = getCached<T>(key);
    setData(cached);
    setLoading(cached === undefined);
    void runFetcher(fetcherRef.current);
  }, [key, runFetcher]);

  return { data, loading, error, refresh };
}
