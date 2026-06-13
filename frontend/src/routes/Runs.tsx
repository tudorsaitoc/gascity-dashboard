import { type RunLane, type RunSummary, type SourceState } from 'gas-city-dashboard-shared';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAttentionModel } from '../attention/context';
import { resourceAttentionSeverity } from '../attention/routeHighlight';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { PartialDataNotice } from '../components/PartialDataNotice';
import { SseIndicator } from '../components/SseIndicator';
import { RunMap, RUNS_HISTORICAL_SECTION_ID } from '../components/run/RunMap';
import { useNow } from '../contexts/NowContext';
import { formatRelative } from '../hooks/time';
import { useRunHistory } from '../runs/runHistory';
import { useRunSummary } from '../runs/runSummarySubscription';

// /runs route (gascity-dashboard-0t6, made live in gascity-dashboard-bqn). The
// fetch, SSE refresh, and degraded-load retry now live in the shared
// run-summary subscription (gascity-dashboard-2j8e.7), which the nav badge reads
// too — so the page and the badge render the same source by construction. This
// component is the source's renderer: it owns the ?history=1 toggle (which now
// drives the LAZY history load, header-first), freshness label, and lane layout.
//
// The app-level NowProvider refreshes relative-time labels in lane cards; the
// shared subscription's SSE path drives actual data updates.

const RUN_PHASE_GRAMMAR = 'Phase grammar: intake, implementation, review, approval, finalization.';
const HISTORY_QUERY_PARAM = 'history';
const HISTORY_QUERY_VALUE = '1';

export function RunsPage() {
  const attention = useAttentionModel();
  const { source: data, loading, error, manualRefresh, sseState } = useRunSummary();
  const [searchParams, setSearchParams] = useSearchParams();
  // gascity-dashboard-yh5i: ?history=1 toggles the historical lane section.
  // Header-first restructure: the summary no longer carries historical lanes,
  // so the toggle is also the LAZY trigger — opening the section fires the
  // closed-history fan-out (useRunHistory) the first time, while the shared
  // run-summary subscription stays untouched across modes.
  const showHistory = searchParams.get(HISTORY_QUERY_PARAM) === HISTORY_QUERY_VALUE;
  const history = useRunHistory(showHistory);
  const now = useNow();
  const runs = data ?? null;
  const runsData =
    runs?.status === 'fresh' || runs?.status === 'fixture' || runs?.status === 'stale'
      ? runs.data
      : null;
  const historyData =
    history.source !== undefined && history.source.status !== 'error' ? history.source.data : null;
  // Known only after the lazy history read lands; null keeps the toggle label
  // honest ("Show history", no fabricated zero) before that.
  const totalHistorical = historyData?.totalHistorical ?? null;
  // gascity-dashboard-n6f1: the summary degrades (not collapses) when an
  // active-set read fails or truncates, flagging lanesPartial. Surface it so
  // the operator reads a short lane set as "sources unavailable" rather than
  // "everything's done." Mirrors the roster-partial signal in Agents.tsx.
  // Header-first: this flags ONLY the active fan-out (core read truncation, a
  // failed feed); the lazy history payload carries its own partial signal,
  // rendered inside the historical section.
  const lanesPartial = runsData?.lanesPartial === true;

  const toggleHistory = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (showHistory) {
          next.delete(HISTORY_QUERY_PARAM);
        } else {
          next.set(HISTORY_QUERY_PARAM, HISTORY_QUERY_VALUE);
        }
        return next;
      },
      { replace: false },
    );
  }, [showHistory, setSearchParams]);

  const runAttentionSeverity = useCallback(
    (lane: RunLane) => resourceAttentionSeverity(attention, 'runs', lane.id),
    [attention],
  );

  // The operator's explicit Refresh re-fetches the summary fan-out, and — when
  // the history section is open — the lazy history fan-out too, both with the
  // proxy cache bypass (gascity-dashboard-i3dz). A closed history section costs
  // nothing. With history open the two fan-outs overlap: each issues the core
  // active read and the city feed, and under forceFresh both feed reads carry
  // cacheBypass so the proxy cannot dedupe them. That bounded, operator-
  // initiated duplicate burst is the deliberate cost of decoupling the summary
  // and history sources (intentional, not accidental); a future optimization
  // could let the history source reuse the summary's just-fetched active/feed.
  const historyRefresh = history.refresh;
  const refreshAll = useCallback(() => {
    void manualRefresh();
    if (showHistory) void historyRefresh({ forceFresh: true });
  }, [manualRefresh, historyRefresh, showHistory]);

  // Opening history fires the heaviest fan-out in the view, and (unlike the
  // summary) it does not raise the summary `loading` flag — so gate the Refresh
  // button on the open-history read too. Without this, the button stays enabled
  // through the ~10-20s closed-history scan and each impatient click stacks
  // another concurrent fan-out, the exact connection-pool saturation this view
  // removed. Closed history can't be refreshed by this button, so it never gates.
  const refreshing = loading || (showHistory && history.loading);

  const synopsis = runSynopsis(data);

  const freshnessLabel = runs
    ? runs.status === 'fresh'
      ? null
      : runs.status === 'fixture'
        ? 'fixture data'
        : runs.status === 'error'
          ? 'live data unavailable'
          : runs.fetchedAt
            ? `stale ${formatRelative(runs.fetchedAt, now)} ago`
            : 'stale'
    : null;

  return (
    <section>
      <PageHeader
        title="Formula Runs"
        synopsis={synopsis}
        className="md:items-start"
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
                  runs?.status === 'error' ? 'text-accent' : 'text-fg-faint'
                }`}
              >
                {freshnessLabel}
              </span>
            )}
            <div className="grid w-full min-w-[18rem] grid-cols-[7rem_minmax(6.5rem,1fr)] items-center gap-x-4 gap-y-3 sm:w-[34rem] sm:grid-cols-[7rem_6.5rem_10rem_7rem]">
              <SseIndicator state={sseState} />
              <span>
                {lanesPartial ? (
                  <PartialDataNotice
                    glyph="◐"
                    label="runs partial"
                    title="one or more run sources were unavailable or truncated; the lane set may be incomplete"
                  />
                ) : (
                  <span aria-hidden="true" className="invisible normal-case text-body text-warn">
                    runs partial
                  </span>
                )}
              </span>
              <Button
                size="sm"
                className="w-full justify-center"
                onClick={toggleHistory}
                // Header-first: completed runs load lazily on open, so the
                // count is unknown until then and the toggle must always be
                // actionable — opening IS the fetch. Once history has loaded,
                // the label carries the known count.
                aria-expanded={showHistory}
                // aria-controls only references the historical section's id
                // when that element is actually in the DOM; the WAI-ARIA
                // spec requires referenced ids to exist.
                {...(showHistory ? { 'aria-controls': RUNS_HISTORICAL_SECTION_ID } : {})}
                aria-label={
                  showHistory
                    ? 'Hide historical formula runs.'
                    : totalHistorical === null
                      ? 'Show completed formula runs.'
                      : totalHistorical === 0
                        ? 'Show completed formula runs (none in the current window).'
                        : `Show ${totalHistorical} completed formula runs.`
                }
              >
                {showHistory
                  ? 'Hide history'
                  : totalHistorical !== null && totalHistorical > 0
                    ? `Show history (${totalHistorical})`
                    : 'Show history'}
              </Button>
              <Button
                size="sm"
                className="w-full justify-center"
                onClick={refreshAll}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing' : 'Refresh'}
              </Button>
            </div>
          </>
        }
      />

      {data === undefined || runs === null ? (
        <p className="text-body text-fg-muted italic">Loading formula runs.</p>
      ) : (
        <RunMap
          source={runs}
          now={now}
          showHistory={showHistory}
          history={history.source}
          historyLoading={history.loading}
          attentionSeverity={runAttentionSeverity}
        />
      )}
    </section>
  );
}

function runSynopsis(data: SourceState<RunSummary> | undefined): string {
  if (data === undefined) return 'Loading formula run lanes.';

  if (data.status !== 'error') {
    return `${data.data.totalActive} active runs across the supervisor's bead store. ${RUN_PHASE_GRAMMAR}`;
  }

  return `Run counts unavailable: ${data.error}. ${RUN_PHASE_GRAMMAR}`;
}
