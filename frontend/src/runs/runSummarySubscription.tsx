import {
  GC_EVENT_PREFIX,
  type RunSummary,
  type SourceState,
  type SourceStatus,
} from 'gas-city-dashboard-shared';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { getActiveCity } from '../api/cityBase';
import { useCachedData } from '../hooks/useCachedData';
import { useGcEventRefresh, type GcEventConnState } from '../hooks/useGcEvents';
import {
  loadSupervisorRunSummaryPreviewSource,
  loadSupervisorRunSummarySource,
} from '../supervisor/runSummary';

// gascity-dashboard-2j8e.7: ONE shared, SSE-refreshed run-summary subscription.
//
// Before this, the /runs page and the nav attention badge each ran their OWN
// full run-summary fan-out under separate cache keys (`runs:summary:*` vs
// `attention:runs:*`), so visiting /runs fetched the supervisor twice, and the
// badge — fetched once at mount with no SSE wiring — drifted from the live page
// after any post-mount churn. This subscription is owned once at the App root
// (always mounted, so the always-visible header badge stays live) and exposed
// via context, so the badge and the page read literally the SAME source object:
// one fan-out, by-construction parity, and a single SSE refresh path feeding
// both. The page reads it through useRunSummary(); the badge reads its `source`
// through the attention layer (liveContributors `runsFactsFromSource`).
//
// The fetch contract is unchanged from the page's prior implementation: the
// cheap preview (2.5s budget) paints first, a one-time full refresh (30s,
// session-enriched) upgrades the snapshot to the page-complete one, a bounded
// backoff recovers a degraded first load, and SSE-driven refetches are gated by
// an in-component debounce floor on top of useGcEventRefresh's own coalescing
// (architect H1/H2 upstream-load protection during slung-pipeline bursts).

const REFRESH_DEBOUNCE_MS = 10_000;
// gascity-dashboard-4xcv: bounded retry backoff for a degraded first load (error
// source, or a partial fetch that produced zero lanes). After the budget is
// spent, SSE events and the manual Refresh button take over.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export interface RunSummarySubscription {
  /** The shared run-summary source state; undefined until the first read lands. */
  source: SourceState<RunSummary> | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sseState: GcEventConnState;
}

/**
 * Own the single run-summary subscription: cache-warm preview paint, one-time
 * full-source upgrade, bounded degraded-load retry, and SSE-driven refresh. Call
 * once near the App root via {@link RunSummaryProvider}; everything else reads
 * the result through {@link useRunSummary}.
 */
export function useRunSummarySubscription(): RunSummarySubscription {
  const cityName = getActiveCity();
  const { data, loading, error, refresh } = useCachedData(
    `runs:summary:${cityName ?? 'no-city'}`,
    loadSupervisorRunSummaryPreviewSource,
    { refreshFetcher: loadSupervisorRunSummarySource },
  );
  const runs = data ?? null;
  const runsStatusRef = useRef<SourceStatus | null>(null);
  runsStatusRef.current = runs?.status ?? null;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const lastRefreshAtRef = useRef(0);

  // Upgrade the cheap first-paint preview to the full session-enriched snapshot
  // exactly once per city — the snapshot the page renders and the badge counts.
  const fullRefreshKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (runs === null || runs.status === 'error') return;
    const refreshKey = cityName ?? 'no-city';
    if (fullRefreshKeyRef.current === refreshKey) return;
    fullRefreshKeyRef.current = refreshKey;
    void refresh().catch(() => {
      fullRefreshKeyRef.current = null;
    });
  }, [cityName, refresh, runs]);

  // gascity-dashboard-4xcv: bounded auto-retry on a degraded load. An error
  // source (or a partial fetch with zero lanes) used to latch the page dead;
  // retry a few times with backoff and reset once a healthy load lands.
  const retryAttemptRef = useRef(0);
  useEffect(() => {
    if (runs === null) return;
    const degraded =
      runs.status === 'error'
        ? true
        : runs.data.lanesPartial === true &&
          runs.data.lanes.length === 0 &&
          runs.data.blockedLanes.length === 0;
    if (!degraded) {
      retryAttemptRef.current = 0;
      return;
    }
    const delay = RETRY_DELAYS_MS[retryAttemptRef.current];
    if (delay === undefined) return;
    retryAttemptRef.current += 1;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [runs, refresh]);

  const onSseMatch = useCallback(() => {
    // Skip when fixtures are serving (supervisor down) — every forced refresh
    // under fixture-fallback re-runs loadFixture(), wasted file IO. An 'error'
    // or 'stale' source is the opposite case: a bead event is exactly the cue
    // to try loading live data again (gascity-dashboard-4xcv).
    if (runsStatusRef.current === null || runsStatusRef.current === 'fixture') return;
    // Skip when an explicit refresh is already in flight, so a fast SSE event
    // can't race a slow upstream call into a last-write-wins overwrite.
    if (loadingRef.current) return;
    const elapsed = Date.now() - lastRefreshAtRef.current;
    if (elapsed < REFRESH_DEBOUNCE_MS) return;
    lastRefreshAtRef.current = Date.now();
    void refresh().catch(() => {
      // Reset on error so the next event retries instead of being silently
      // dropped for the rest of the debounce window.
      lastRefreshAtRef.current = 0;
    });
  }, [refresh]);

  const sseState = useGcEventRefresh([GC_EVENT_PREFIX.bead], onSseMatch);

  return { source: data, loading, error, refresh, sseState };
}

const RunSummaryContext = createContext<RunSummarySubscription | null>(null);

export function RunSummaryProvider({ children }: { children: ReactNode }) {
  const subscription = useRunSummarySubscription();
  return <RunSummaryContext.Provider value={subscription}>{children}</RunSummaryContext.Provider>;
}

export function useRunSummary(): RunSummarySubscription {
  const subscription = useContext(RunSummaryContext);
  if (subscription === null) {
    throw new Error('useRunSummary must be used within a RunSummaryProvider');
  }
  return subscription;
}
