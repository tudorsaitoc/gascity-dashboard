import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  errorMessage,
  prepareMaintainerSlingRequest,
  resolveSessionForTarget,
  type DashboardMaintainerRuntimeConfig,
  type MaintainerTriage,
} from 'gas-city-dashboard-shared';
import { filterTierByNeedsYou, NEEDS_YOU_VIEW_PARAM } from './needsYou';
import {
  countTierByVetted,
  filterTierByAwaitingTriage,
  filterTierByNeedsPr,
} from './triageFilters';
import { useNow } from '../../../contexts/NowContext';
import { api } from '../../../api/client';
import { cityPath, getActiveCity } from '../../../api/cityBase';
import { setCached } from '../../../api/cache';
import { Button } from '../../../components/Button';
import { PageHeader } from '../../../components/PageHeader';
import { SlungSection, TierSection } from './TriageSections';
import { useCachedData } from '../../../hooks/useCachedData';
import { useViewingAs } from '../../../contexts/ViewingAsContext';
import { formatDate as formatCalendarDate } from '../../../lib/format';
import { readBrowserStorage, writeBrowserStorage } from '../../../lib/browserStorage';
import { usePersistedCollapseSet } from '../../../hooks/usePersistedCollapseSet';
import { MaintainerFooter, SelectionActionBar } from './MaintainerChrome';
import {
  buildSlingRequests,
  dispatchSlings,
  flattenTriageItems,
  selectionKey,
  toggleSelectionItem,
  useSlingSuccess,
  type MaintainerSlingIntent,
  type SlingRequest,
  type SlingSummary,
} from './maintainerSelection';
import { supervisorApi } from '../../../supervisor/client';
import { reportClientError } from '../../../lib/clientErrorReporting';

export { SlungLink, TriageScore } from './TriageSignals';
export { IssueRow, SlungSection, TierSection } from './TriageSections';

// Display labels for the two operator-facing sling intents
// (gascity-dashboard-5xw). The actual aliases the backend dispatches
// to are resolved server-side from MAINTAINER_TRIAGE_TARGET /
// MAINTAINER_SLING_TARGET; the frontend never sees them. Each label
// matches its button copy so the success line reads in the same voice.
const TRIAGE_TARGET_LABEL = 'triage agent';
const DRAFT_TARGET_LABEL = 'draft agent';

// Triage route — read-only maintainer surface for gastownhall/gascity.
// Shell + tokens from gascity-dashboard-hq2; live data from
// gascity-dashboard-361 (gh ingest + JSON cache). Enrichment lands in
// 7ts (priority tiers), gtr (file clusters + blast radius), alh
// (contributor trust + ratios), and 98h (semantic weak ties).

const CACHE_KEY = 'maintainer-triage';
const COLLAPSE_KEY = 'maintainer:collapsed';
const FOCUS_KEY = 'maintainer:focusBreaking';
const COMPONENT = 'MaintainerPage';
// gascity-dashboard-omv: persists the "Needs PR only" filter toggle so
// the operator's choice survives reloads / SSE refreshes.
const NEEDS_PR_KEY = 'maintainer:needsPrOnly';
// gascity-dashboard-x8q: persists the "Awaiting triage only" toggle so
// the operator's choice survives reloads / SSE refreshes. Sibling of
// FOCUS_KEY and NEEDS_PR_KEY; all three filters compose.
const AWAITING_KEY = 'maintainer:awaitingOnly';

export function MaintainerPage() {
  const { data, loading, error, refresh } = useCachedData<MaintainerTriage>(
    CACHE_KEY,
    () => api.maintainerTriage(),
  );
  const { viewingAs } = useViewingAs();
  // dw8 — `?view=needs-you` activates the Needs-You composite filter
  // mode. The query param is the activation surface (R13: no new
  // route); the mode itself short-circuits some chip rendering and
  // composes with the surviving chips at filter time.
  const [searchParams] = useSearchParams();
  const needsYouMode = searchParams.get('view') === NEEDS_YOU_VIEW_PARAM;
  const nowMs = useNow();

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const collapse = usePersistedCollapseSet({ key: COLLAPSE_KEY, component: COMPONENT });
  // Bulk-sling selection (gascity-dashboard-0nn). Lives only in component
  // state; refresh / route change clears it. Bulk triage is a 'do it
  // now' operation, not a saved view.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  // Which intent (if any) is currently in flight. null = idle. Drives both
  // the disabled state on both buttons AND which button's label flips to
  // 'Sending' — a plain boolean would attach 'Sending' to the wrong button
  // when the operator clicks the draft action (gascity-dashboard-5xw ts MED-1).
  const [slinging, setSlinging] = useState<MaintainerSlingIntent | null>(null);
  const [slingError, setSlingError] = useState<string | null>(null);
  // Post-sling success acknowledgement (gascity-dashboard-5ly). Hook
  // owns the auto-clear timer + unmount cleanup so this component just
  // calls setSuccess on the happy path.
  const { success: slingSuccess, setSuccess: setSlingSuccess, clearSuccess: clearSlingSuccess } =
    useSlingSuccess();
  const [slingSkippedCount, setSlingSkippedCount] = useState(0);
  const [focusBreaking, setFocusBreaking] = useState<boolean>(() => {
    return readStorageFlag(FOCUS_KEY);
  });
  const toggleFocus = useCallback(() => {
    setFocusBreaking((prev) => {
      const next = !prev;
      writeStorageFlag(FOCUS_KEY, next);
      return next;
    });
  }, []);

  // gascity-dashboard-omv: "Needs PR only" toggle. Sibling of
  // focusBreaking; both compose so an operator can ask for
  // "breaking-tier issues that need a PR" in one view.
  const [needsPrOnly, setNeedsPrOnly] = useState<boolean>(() => {
    return readStorageFlag(NEEDS_PR_KEY);
  });
  const toggleNeedsPrOnly = useCallback(() => {
    setNeedsPrOnly((prev) => {
      const next = !prev;
      writeStorageFlag(NEEDS_PR_KEY, next);
      return next;
    });
  }, []);

  // gascity-dashboard-x8q: "Awaiting triage only" toggle. Sibling of
  // focusBreaking + needsPrOnly; all three compose. When on, every
  // tier section is restricted to items whose triage_assessment is
  // still null — the unvetted backlog the operator wants to batch.
  const [awaitingOnly, setAwaitingOnly] = useState<boolean>(() => {
    return readStorageFlag(AWAITING_KEY);
  });
  const toggleAwaitingOnly = useCallback(() => {
    setAwaitingOnly((prev) => {
      const next = !prev;
      writeStorageFlag(AWAITING_KEY, next);
      return next;
    });
  }, []);

  // Live updates: subscribe to the city-scoped maintainer events stream.
  // Whenever the nightly worker (or anyone else's manual refresh) rewrites
  // the cache, the server fires a 'refreshed' event and we refetch. The
  // EventSource browser API auto-reconnects with backoff; only the
  // mount/unmount lifecycle needs manual handling here.
  useEffect(() => {
    const es = new EventSource(cityPath('/maintainer/events'));
    const onRefresh = () => {
      void refresh();
    };
    es.addEventListener('refreshed', onRefresh);
    return () => {
      es.removeEventListener('refreshed', onRefresh);
      es.close();
    };
  }, [refresh]);

  // POST /maintainer/refresh runs the full gh fetch on the host and
  // rewrites the JSON cache. This is the dev-time path; the nightly
  // worker (bead ar9) will replace the manual button as the primary
  // cache writer.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await api.maintainerRefresh();
      setCached(CACHE_KEY, fresh);
      await refresh();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const toggleSelection = useCallback((item: { kind: 'pr' | 'issue'; number: number }) => {
    setSelection((prev) => toggleSelectionItem(prev, item));
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setSlingError(null);
    setSlingSkippedCount(0);
    // Operator's 'Clear' is a deliberate action: drop the success line
    // too so the bar exits cleanly instead of lingering on a stale ack.
    clearSlingSuccess();
  }, [clearSlingSuccess]);

  // Flatten once per envelope so the bottom bar can look up html_urls
  // for every selected key in O(N) without rewalking the tier tree on
  // every render.
  const allItems = useMemo(() => (data ? flattenTriageItems(data) : []), [data]);

  // Single dispatch path, parameterised on intent (gascity-dashboard-5xw).
  // intent='triage' → frontend resolves to MAINTAINER_TRIAGE_TARGET
  // (default 'chief-of-staff'); intent='draft' → MAINTAINER_SLING_TARGET
  // (default 'mayor'). The browser then calls the generated supervisor sling
  // endpoint directly; the dashboard service records only local slung state.
  const handleSend = useCallback(async (intent: MaintainerSlingIntent) => {
    const successLabel =
      intent === 'triage' ? TRIAGE_TARGET_LABEL : DRAFT_TARGET_LABEL;
    setSlinging(intent);
    setSlingError(null);
    setSlingSkippedCount(0);
    // New dispatch supersedes any prior success line. The TTL would also
    // clear it eventually, but clearing now avoids a stale 'Slung 3 to X'
    // lingering next to 'Sending' on the next batch.
    clearSlingSuccess();
    try {
      const batch = buildSlingRequests(selection, allItems, intent);
      let summary: SlingSummary = { outcomes: [], succeeded: 0, failed: 0 };
      if (batch.requests.length > 0) {
        const defaults = await loadMaintainerSlingDefaults();
        summary = await dispatchSlings(
          batch.requests,
          (req) => dispatchMaintainerSupervisorSling(req, defaults),
        );
      }
      setSlingSkippedCount(batch.skippedKeys.length);
      if (summary.failed === 0) {
        setSelection(new Set());
        if (summary.succeeded > 0) {
          // Abstract label, not the resolved alias: the actual server-side
          // target is invisible to the frontend and the label matches its
          // button copy so the success line reads in one voice.
          setSlingSuccess({ count: summary.succeeded, target: successLabel });
        }
      } else {
        // Keep the failed subset selected so the operator can retry. The
        // succeeded ones get dropped so the next click doesn't redispatch them.
        const remaining = new Set<string>();
        for (const o of summary.outcomes) {
          if (!o.ok) remaining.add(selectionKey(o.request));
        }
        setSelection(remaining);
        setSlingError(
          `${summary.failed} of ${summary.outcomes.length} failed: ${summary.outcomes.find((o) => !o.ok)?.error ?? 'unknown error'}`,
        );
        // Partial success: surface what landed even though the line
        // shares space with the error. The operator's next action will
        // clear both via clearSlingSuccess + setSlingError(null).
        if (summary.succeeded > 0) {
          setSlingSuccess({ count: summary.succeeded, target: successLabel });
        }
      }
    } catch (err) {
      setSlingError(err instanceof Error ? err.message : 'send failed');
    } finally {
      setSlinging(null);
    }
  }, [selection, allItems, setSlingSuccess, clearSlingSuccess]);

  return (
    <section>
      <PageHeader
        title="Triage"
        synopsis={data ? buildSynopsis(data) : 'Reading triage from cache.'}
        meta={
          <>
            {(error || refreshError) && (
              <span className="normal-case text-body text-accent" role="alert">
                {refreshError ?? error}
              </span>
            )}
            <Button size="sm" onClick={toggleFocus}>
              {focusBreaking ? 'Show all tiers' : 'Breaking only'}
            </Button>
            <Button size="sm" onClick={toggleNeedsPrOnly}>
              {needsPrOnly ? 'Show all items' : 'Needs PR only'}
            </Button>
            {/* dw8 — hide the "Awaiting triage only" chip in needs-you
                mode. Its intersection with the needs-you predicate is
                ~empty by PR lifecycle: changes-requested / approved /
                vetted PRs are all post-vetting, so the chip would
                routinely produce empty tier sections and confuse the
                operator. */}
            {!needsYouMode && (
              <Button size="sm" onClick={toggleAwaitingOnly}>
                {awaitingOnly ? 'Show vetted too' : 'Awaiting triage only'}
              </Button>
            )}
            <Button size="sm" onClick={() => void handleRefresh()} disabled={refreshing}>
              {refreshing ? 'Refreshing' : 'Refresh from gh'}
            </Button>
            {needsYouMode && (
              <Link
                to="/runs"
                className="text-body text-fg-muted normal-case tracking-normal hover:text-fg focus-mark"
              >
                ↗ runs
              </Link>
            )}
            {needsYouMode && (
              <span
                role="status"
                aria-label="Needs you mode"
                className="text-body text-accent normal-case tracking-normal"
              >
                Needs you ·{' '}
                <Link to="/maintainer" className="underline hover:text-fg focus-mark">
                  Show all
                </Link>
              </span>
            )}
            <span className="text-fg-muted tnum normal-case tracking-normal">
              {formatCalendarDate(new Date(nowMs))}
            </span>
          </>
        }
      />

      {data ? (
        <>
          <div className="space-y-14">
            {data.slung_section !== undefined && data.slung_section.length > 0 && (
              <SlungSection
                items={data.slung_section}
                collapsed={collapse.isCollapsed('slung')}
                onToggle={() => collapse.toggle('slung')}
              />
            )}
            {data.tiers
              .filter((tier) => !focusBreaking || tier.tier === 'regression_breaking')
              .map((tier) => {
                // Counts are derived from the UNFILTERED tier so the
                // 'N vetted · M awaiting' line in the header reflects the
                // tier's actual shape, not the current filter view
                // (gascity-dashboard-x8q).
                const counts = countTierByVetted(tier);
                // dw8 — needs-you predicate applies FIRST so the chip
                // filters intersect against the already-narrowed set.
                // The `awaitingOnly` chip is hidden in this mode, but
                // `needsPrOnly` and `focusBreaking` still compose.
                const awaitingActive = awaitingOnly && !needsYouMode;
                let view = tier;
                if (needsYouMode) view = filterTierByNeedsYou(view, nowMs);
                if (needsPrOnly) view = filterTierByNeedsPr(view);
                if (awaitingActive) view = filterTierByAwaitingTriage(view);
                // When any filter chip is active the rendered tier is a
                // subset of the original; surface the unfiltered total so
                // the header reads "N of M items" rather than an ambiguous
                // "N items" (gascity-dashboard-3lf). Spread the prop only
                // when the filter is on — exactOptionalPropertyTypes
                // forbids passing `undefined` directly.
                const filterActive = needsYouMode || needsPrOnly || awaitingActive;
                const filterProps = filterActive
                  ? {
                      unfilteredItemCount:
                        tier.clusters.reduce((n, c) => n + c.items.length, 0) +
                        tier.unclustered.length,
                    }
                  : {};
                return (
                  <TierSection
                    key={tier.tier}
                    section={view}
                    counts={counts}
                    {...filterProps}
                    collapsed={collapse.isCollapsed(`tier:${tier.tier}`)}
                    onToggle={() => collapse.toggle(`tier:${tier.tier}`)}
                    isCollapsed={collapse.isCollapsed}
                    toggleCluster={collapse.toggle}
                    selection={selection}
                    onToggleSelect={viewingAs.isOperator ? toggleSelection : null}
                  />
                );
              })}
          </div>
          <MaintainerFooter computedAt={data.computed_at} now={nowMs} />
          {viewingAs.isOperator &&
            (selection.size > 0 || slingSuccess !== null || slingSkippedCount > 0) && (
            <SelectionActionBar
              count={selection.size}
              skippedCount={slingSkippedCount}
              onSend={() => void handleSend('triage')}
              onSendDraft={() => void handleSend('draft')}
              onClear={clearSelection}
              sending={slinging}
              error={slingError}
              success={slingSuccess}
            />
          )}
        </>
      ) : loading ? (
        <p className="text-body text-fg-muted italic">Loading.</p>
      ) : (
        <p className="text-body text-fg-faint italic">
          No triage cache yet. Click <span className="text-fg">Refresh from gh</span> to fetch.
        </p>
      )}
    </section>
  );
}

async function loadMaintainerSlingDefaults(): Promise<DashboardMaintainerRuntimeConfig> {
  const config = await api.config();
  if (config.maintainer === undefined) {
    throw new Error('maintainer sling config unavailable');
  }
  return config.maintainer;
}

async function dispatchMaintainerSupervisorSling(
  req: SlingRequest,
  defaults: DashboardMaintainerRuntimeConfig,
): Promise<void> {
  const prepared = prepareMaintainerSlingRequest(req, defaults);
  if (prepared.status === 'error') {
    throw new Error(prepared.message);
  }
  const cityName = getActiveCity();
  if (cityName === null) {
    throw new Error('maintainer sling called before an active city was resolved');
  }
  const request = prepared.request;
  const result = await supervisorApi().sling(cityName, {
    target: request.target,
    bead: request.beadText,
  });
  const resolvedSessionName = await resolveMaintainerSlingTarget(cityName, request.target);
  await api.maintainerSlingRecord({
    kind: request.kind,
    number: request.number,
    intent: request.intent,
    target: request.target,
    bead_id: result.root_bead_id ?? null,
    resolved_session_name: resolvedSessionName,
  });
}

async function resolveMaintainerSlingTarget(
  cityName: string,
  target: string,
): Promise<string | null> {
  try {
    const sessions = await supervisorApi().listSessions(cityName);
    return resolveSessionForTarget(target, sessions.items ?? [])?.session_name ?? null;
  } catch (err) {
    void reportClientError({
      component: 'maintainer',
      operation: 'resolve maintainer sling target',
      message: errorMessage(err),
    });
    return null;
  }
}

function buildSynopsis(data: MaintainerTriage): string {
  const breaking = data.tiers.find((t) => t.tier === 'regression_breaking');
  const breakingCount = breaking
    ? breaking.clusters.reduce((n, c) => n + c.items.length, 0) +
      breaking.unclustered.length
    : 0;
  if (breakingCount > 0) {
    return `${breakingCount} item${breakingCount === 1 ? '' : 's'} in regression+breaking. ${data.totals.issues_open} issues, ${data.totals.prs_open} PRs open across ${data.repo}.`;
  }
  if (data.totals.issues_open + data.totals.prs_open === 0) {
    return `Quiet across ${data.repo}.`;
  }
  return `${data.totals.issues_open} issues, ${data.totals.prs_open} PRs open across ${data.repo}. Awaiting tier classification.`;
}

function readStorageFlag(key: string): boolean {
  const stored = readBrowserStorage('localStorage', key, COMPONENT);
  return stored.status === 'found' && stored.value === '1';
}

function writeStorageFlag(key: string, value: boolean): void {
  writeBrowserStorage('localStorage', key, value ? '1' : '0', COMPONENT);
}
