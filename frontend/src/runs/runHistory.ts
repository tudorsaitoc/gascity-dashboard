import type { RunHistory, SourceState } from 'gas-city-dashboard-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCached, setCached } from '../api/cache';
import { getActiveCity } from '../api/cityBase';
import { loadSupervisorRunHistorySource } from '../supervisor/runSummary';

// Header-first restructure: completed-run lanes load LAZILY, when the operator
// opens the /runs history section, instead of riding every run-summary refresh.
// The closed-history fan-out behind loadSupervisorRunHistorySource is the
// expensive read set (molecule all=true scan measured 9.9s; per-rig task
// all=true reads measured 10.9s on the largest rig store) — paying it per
// refresh for a section hidden by default is what chronically latched the
// "runs partial" badge. This hook owns that lifecycle: fetch on first open,
// reuse the cached payload across toggles and remounts, refresh on demand.
//
// Deliberately NOT part of the shared run-summary subscription
// (gascity-dashboard-2j8e.7): the nav attention badge counts blocked runs from
// the summary's active fan-out and has no use for completed lanes, so history
// stays a page-local concern with its own loading/partial states.

export interface RunHistorySubscription {
  /** The history source state; undefined until the first (lazy) read lands. */
  source: SourceState<RunHistory> | undefined;
  loading: boolean;
  /**
   * Refetch the history fan-out. `forceFresh: true` carries the operator's
   * explicit Refresh through to the proxy-cached molecule + feed reads
   * (gascity-dashboard-i3dz); programmatic refreshes leave it false so they
   * keep serving the proxy's amortized cache.
   */
  refresh: (options?: { forceFresh?: boolean }) => Promise<void>;
}

function historyCacheKey(cityName: string | null): string {
  return `runs:history:${cityName ?? 'no-city'}`;
}

/**
 * Own the lazy /runs history load: no fetch while `enabled` is false, one fetch
 * when the section first opens, cache-backed reopens, last-good retention on a
 * failed refresh, and an on-demand refresh for the operator's Refresh button.
 */
export function useRunHistory(enabled: boolean): RunHistorySubscription {
  const key = historyCacheKey(getActiveCity());
  const [source, setSource] = useState<SourceState<RunHistory> | undefined>(() =>
    getCached<SourceState<RunHistory>>(key),
  );
  const [loading, setLoading] = useState(false);
  const runIdRef = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(async (options?: { forceFresh?: boolean }) => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const cacheKey = keyRef.current;
    setLoading(true);
    try {
      const result = await loadSupervisorRunHistorySource({
        forceFresh: options?.forceFresh === true,
      }).catch(
        (err): SourceState<RunHistory> => ({
          source: 'runs',
          status: 'error',
          error: err instanceof Error ? err.message : 'formula run history unavailable',
        }),
      );
      if (runIdRef.current !== runId || keyRef.current !== cacheKey) return;
      // Last-good retention (mirrors the run-summary subscription): a refresh
      // that fails AFTER a good load keeps serving the last good payload,
      // re-published as 'stale', instead of blanking the open section. A
      // genuine first-load failure still surfaces the error.
      const prior = getCached<SourceState<RunHistory>>(cacheKey);
      const published =
        result.status === 'error' && prior !== undefined && prior.status !== 'error'
          ? ({ ...prior, status: 'stale' } as SourceState<RunHistory>)
          : result;
      // Error payloads are not cached: closing and reopening the section (or a
      // remount) retries the load instead of latching the error forever.
      if (published.status !== 'error') setCached(cacheKey, published);
      setSource(published);
    } finally {
      if (runIdRef.current === runId) setLoading(false);
    }
  }, []);

  // Reseed when the active city (cache key) changes, so a city switch never
  // shows another city's history.
  useEffect(() => {
    setSource(getCached<SourceState<RunHistory>>(key));
  }, [key]);

  // The lazy edge: fetch when the section opens with no cached payload for
  // this city. Reopens reuse the cache; staleness is the operator's Refresh
  // button's concern, not an automatic refetch.
  useEffect(() => {
    if (!enabled) return;
    if (getCached<SourceState<RunHistory>>(key) !== undefined) return;
    void refresh();
  }, [enabled, key, refresh]);

  return { source, loading, refresh };
}
