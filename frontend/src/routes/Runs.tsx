import {
    GC_EVENT_PREFIX,
    type DashboardSnapshot,
    type SourceStatus,
} from "gas-city-dashboard-shared";
import { useCallback, useRef, useState } from "react";
import { api } from "../api/client";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { SseIndicator } from "../components/SseIndicator";
import { RunMap } from "../components/run/RunMap";
import { formatRelative } from "../hooks/time";
import { useCachedData } from "../hooks/useCachedData";
import { useGcEventRefresh } from "../hooks/useGcEvents";
import { useVisibleInterval } from "../hooks/useVisibleInterval";

// /runs route (gascity-dashboard-0t6, made live in
// gascity-dashboard-bqn). Reads /api/snapshot via useCachedData for
// the initial cache-warm paint; explicit refresh() routes through
// /api/snapshot/refresh?sources=runs which bypasses the backend's
// 60s runs cache TTL. Both the manual Refresh button and the
// SSE-driven onMatch callback share that one bypass code path, so the
// in-memory snapshot cache and the React state always reflect the
// latest force-refresh — no last-write-wins race between concurrent
// mount-GET and event-driven POST.
//
// Live updates: useGcEventRefresh subscribes to /api/events/stream and
// fires onMatch when a bead.* event arrives. The hook coalesces its
// own bursts to ~1 fire per 2.5s; we layer a 10s in-component debounce
// floor on top because runs refresh triggers a full upstream
// gc.listBeads({ limit: 1000 }) call (architect H2 — upstream-load
// protection during slung-pipeline bursts). The callback also no-ops
// when the runs source is in fixture-fallback mode (gc down) so
// the dashboard's own host doesn't get hammered with loadFixture calls
// every coalesce tick during a gc outage (architect H1).
//
// The 5s tick refreshes only relative-time labels in lane cards; SSE
// is the path for actual data updates.

const TICK_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 10_000;
const RUN_PHASE_GRAMMAR =
  "Phase grammar: intake, implementation, review, approval, finalization.";

export function RunsPage() {
  const { data, loading, error, refresh } = useCachedData(
    "snapshot",
    () => api.snapshot(),
    { refreshFetcher: () => api.snapshotRefresh(["runs"]) },
  );
  const [now, setNow] = useState(() => Date.now());
  const runsStatusRef = useRef<SourceStatus | null>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const lastRefreshAtRef = useRef(0);
  useVisibleInterval(() => setNow(Date.now()), TICK_MS);

  const runs = data?.sources.runs ?? null;
  runsStatusRef.current = runs?.status ?? null;

  const onSseMatch = useCallback(() => {
    // Skip when supervisor is unreachable — every forced refresh under
    // fixture-fallback re-runs loadFixture(), which is wasted file IO.
    if (runsStatusRef.current !== "fresh") return;
    // Skip when an explicit refresh is already in flight. Without this
    // guard, a fast SSE event firing while a slow upstream call is
    // still resolving lets two requests race; older-completion can
    // overwrite newer data via last-write-wins in setCached.
    if (loadingRef.current) return;
    const elapsed = Date.now() - lastRefreshAtRef.current;
    if (elapsed < REFRESH_DEBOUNCE_MS) return;
    lastRefreshAtRef.current = Date.now();
    void refresh().catch(() => {
      // Reset on error so the next event retries instead of being
      // silently dropped for the rest of the 10s debounce window.
      lastRefreshAtRef.current = 0;
    });
  }, [refresh]);

  const sseState = useGcEventRefresh([GC_EVENT_PREFIX.bead], onSseMatch);

  const synopsis = runSynopsis(data);

  const freshnessLabel = runs
    ? runs.status === "fresh"
      ? null
      : runs.status === "fixture"
        ? "fixture data"
        : runs.status === "error"
          ? "live data unavailable"
          : runs.fetchedAt
            ? `stale ${formatRelative(runs.fetchedAt, now)} ago`
            : "stale"
    : null;

  return (
    <section>
      <PageHeader
        title="Formula Runs"
        synopsis={synopsis}
        meta={
          <>
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            {freshnessLabel !== null && (
              <span
                className={`text-label uppercase tracking-wider tnum ${
                  runs?.status === "error" ? "text-accent" : "text-fg-faint"
                }`}
              >
                {freshnessLabel}
              </span>
            )}
            <SseIndicator state={sseState} />
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing" : "Refresh"}
            </Button>
          </>
        }
      />

      {data === undefined || runs === null ? (
        <p className="text-body text-fg-muted italic">Loading formula runs.</p>
      ) : (
        <RunMap source={runs} now={now} />
      )}
    </section>
  );
}

function runSynopsis(data: DashboardSnapshot | undefined): string {
  if (data === undefined) return "Loading formula run lanes.";

  const metric = data.headline.activeRuns;
  if (metric.status === "available") {
    return `${metric.value} active runs across the supervisor's bead store. ${RUN_PHASE_GRAMMAR}`;
  }

  return `Run counts unavailable: ${metric.error}. ${RUN_PHASE_GRAMMAR}`;
}
