import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  MaintainerTriage,
  TriageItem,
  TriageTierSection,
} from 'gas-city-dashboard-shared';
import { filterTierByNeedsYou, NEEDS_YOU_VIEW_PARAM } from './needsYou';
import { useNow } from '../../../contexts/NowContext';
import { api } from '../../../api/client';
import { cityPath } from '../../../api/cityBase';
import { setCached } from '../../../api/cache';
import { Button } from '../../../components/Button';
import { PageHeader } from '../../../components/PageHeader';
import { SlungSection, TierSection } from './TriageSections';
import { useCachedData } from '../../../hooks/useCachedData';
import { useViewingAs } from '../../../contexts/ViewingAsContext';
import { readBrowserStorage, writeBrowserStorage } from '../../../lib/browserStorage';
import { reportClientError } from '../../../lib/clientErrorReporting';
import {
  buildSlingRequests,
  dispatchSlings,
  flattenTriageItems,
  selectionKey,
  toggleSelectionItem,
  useSlingSuccess,
  type MaintainerSlingIntent,
  type SlingSuccess,
} from './maintainerSelection';

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

/**
 * Pure filter helper for the "Needs PR only" toggle
 * (gascity-dashboard-omv). Returns a new TriageTierSection containing
 * only issue items where `has_in_flight_pr === false`. PR items are
 * dropped entirely — the filter is issue-focused ("show me work that
 * needs someone to write a fix") per the bead. Clusters that become
 * empty after the filter are dropped from the result.
 */
export function filterTierByNeedsPr(section: TriageTierSection): TriageTierSection {
  const needsPr = (item: TriageItem): boolean =>
    item.kind === 'issue' && item.has_in_flight_pr === false;
  const filteredClusters = section.clusters
    .map((cluster) => ({
      ...cluster,
      items: cluster.items.filter(needsPr),
    }))
    .filter((cluster) => cluster.items.length > 0);
  return {
    ...section,
    clusters: filteredClusters,
    unclustered: section.unclustered.filter(needsPr),
  };
}

/**
 * Pure filter helper for the "Awaiting triage only" toggle
 * (gascity-dashboard-x8q). Returns a new TriageTierSection containing
 * only items whose `triage_assessment` is null — i.e. the unvetted
 * backlog the operator wants to focus on. Both kinds (issue, PR) are
 * kept; vetted-ness, not item type, is the filter axis. Clusters that
 * become empty are dropped.
 */
export function filterTierByAwaitingTriage(
  section: TriageTierSection,
): TriageTierSection {
  const awaiting = (item: TriageItem): boolean => item.triage_assessment === null;
  const filteredClusters = section.clusters
    .map((cluster) => ({
      ...cluster,
      items: cluster.items.filter(awaiting),
    }))
    .filter((cluster) => cluster.items.length > 0);
  return {
    ...section,
    clusters: filteredClusters,
    unclustered: section.unclustered.filter(awaiting),
  };
}

/**
 * Per-tier vetted / awaiting tally (gascity-dashboard-x8q). Drives the
 * "N vetted · M awaiting" line in each tier header so the operator
 * sees the size of the unvetted backlog without scanning rows.
 *
 * `vetted` counts items with a non-null `triage_assessment`; `awaiting`
 * counts the rest.
 *
 * Callers should compute this from the UNFILTERED tier and pass it
 * into `TierSection` as a prop — toggling the awaiting-only chip must
 * not rewrite the tally, it just hides vetted rows.
 */
export function countTierByVetted(
  section: TriageTierSection,
): { vetted: number; awaiting: number } {
  let vetted = 0;
  let awaiting = 0;
  const tally = (item: TriageItem): void => {
    if (item.triage_assessment !== null) vetted += 1;
    else awaiting += 1;
  };
  for (const item of section.unclustered) tally(item);
  for (const cluster of section.clusters) {
    for (const item of cluster.items) tally(item);
  }
  return { vetted, awaiting };
}

// Persists which tier / cluster headings the operator has collapsed.
// Set of ids; default empty (all expanded). LocalStorage-backed so the
// preference holds across the page being open in an ambient tab.
function useCollapseState() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const stored = readBrowserStorage('localStorage', COLLAPSE_KEY, COMPONENT);
    if (stored.status !== 'found') return new Set();
    try {
      const parsed = JSON.parse(stored.value);
      return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
    } catch (err) {
      reportStorageParseFailure(COLLAPSE_KEY, err);
      return new Set<string>();
    }
  });

  const persist = useCallback((next: Set<string>) => {
    writeBrowserStorage('localStorage', COLLAPSE_KEY, JSON.stringify(Array.from(next)), COMPONENT);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const setExact = useCallback(
    (ids: Iterable<string>) => {
      const next = new Set(ids);
      persist(next);
      setCollapsed(next);
    },
    [persist],
  );

  return { isCollapsed: (id: string) => collapsed.has(id), toggle, setExact };
}

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
  const collapse = useCollapseState();
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
    // Operator's 'Clear' is a deliberate action: drop the success line
    // too so the bar exits cleanly instead of lingering on a stale ack.
    clearSlingSuccess();
  }, [clearSlingSuccess]);

  // Flatten once per envelope so the bottom bar can look up html_urls
  // for every selected key in O(N) without rewalking the tier tree on
  // every render.
  const allItems = useMemo(() => (data ? flattenTriageItems(data) : []), [data]);

  // Single dispatch path, parameterised on intent (gascity-dashboard-5xw).
  // intent='triage' → backend resolves to MAINTAINER_TRIAGE_TARGET
  // (default 'chief-of-staff'); intent='draft' → MAINTAINER_SLING_TARGET
  // (default 'mayor'). Target omitted from each request so the backend
  // owns the routing decision.
  const handleSend = useCallback(async (intent: MaintainerSlingIntent) => {
    const successLabel =
      intent === 'triage' ? TRIAGE_TARGET_LABEL : DRAFT_TARGET_LABEL;
    setSlinging(intent);
    setSlingError(null);
    // New dispatch supersedes any prior success line. The TTL would also
    // clear it eventually, but clearing now avoids a stale 'Slung 3 to X'
    // lingering next to 'Sending' on the next batch.
    clearSlingSuccess();
    try {
      const requests = buildSlingRequests(selection, allItems, intent);
      const summary = await dispatchSlings(requests, (req) => api.maintainerSling(req));
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
                to="/workflows"
                className="text-body text-fg-muted normal-case tracking-normal hover:text-fg focus-mark"
              >
                ↗ workflows
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
              {formatDate(new Date())}
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
          <Footer computedAt={data.computed_at} />
          {viewingAs.isOperator && (selection.size > 0 || slingSuccess !== null) && (
            <SelectionActionBar
              count={selection.size}
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

// Bottom-pinned action bar (gascity-dashboard-0nn). Renders when
// selection > 0 OR a post-sling success line is currently visible
// (gascity-dashboard-5ly). Editorial register, NOT a sticky toolbar
// with chrome: single line of type with a hairline top rule, on the
// page's surface color. No card, no rounded panel, no drop-shadow.
// Per the Flat Page Rule, the separator is space + type + a single
// 1px rule, not a container.
//
// Exported so vitest can render it in isolation without standing up
// the full MaintainerPage (useCachedData / EventSource / context
// providers). The success-state lifecycle is owned by useSlingSuccess
// in maintainerSelection.ts and tested there.
export function SelectionActionBar({
  count,
  onSend,
  onSendDraft,
  onClear,
  sending,
  error,
  success,
}: {
  count: number;
  /** Dispatch with intent='triage' (asks an agent to assess prioritisation). */
  onSend: () => void;
  /** Dispatch with intent='draft' (asks an agent to write a PR). */
  onSendDraft: () => void;
  onClear: () => void;
  /** Which intent is mid-flight, or null when idle. */
  sending: MaintainerSlingIntent | null;
  error: string | null;
  success: SlingSuccess | null;
}) {
  const isSending = sending !== null;
  // Inner container mirrors Layout's main column (max-w-[1280px] + the
  // same horizontal padding) so the action line sits under the page
  // content, not above the gutters.
  return (
    <div
      className="fixed inset-x-0 bottom-0 border-t border-rule bg-surface"
      role="region"
      aria-label="bulk triage actions"
    >
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-baseline justify-between gap-6">
        <div className="flex items-baseline gap-3 text-body text-fg-muted">
          {/*
            Suppress "0 selected" when only the success line is visible
            (count == 0 happens right after a fully successful dispatch
            when the selection set is cleared but the success banner is
            still up). Reads as a quiet acknowledgement instead of a
            confusing "0 selected · Slung N ...".
          */}
          {count > 0 && (
            <>
              <span className="tnum text-fg">{count}</span>
              <span>selected</span>
            </>
          )}
          {error !== null && (
            <>
              {count > 0 && <span aria-hidden>·</span>}
              <span className="text-accent" role="alert">
                {error}
              </span>
            </>
          )}
          {success !== null && (
            <>
              {(count > 0 || error !== null) && <span aria-hidden>·</span>}
              {/*
                Success copy stays in the neutral text-fg register, not
                the maroon accent: the One Mark Rule reserves accent for
                anomalies and destructive moments. A successful dispatch
                is a quiet acknowledgement, not a celebration.
              */}
              <span className="text-fg" role="status">
                Slung <span className="tnum">{success.count}</span> to {success.target}.{' '}
                <Link
                  to="/agents"
                  className="text-fg hover:text-accent focus-mark underline-offset-2 hover:underline"
                >
                  View in Agents <span aria-hidden>→</span>
                </Link>
              </span>
            </>
          )}
        </div>
        <div className="flex items-baseline gap-3">
          <Button size="sm" onClick={onSend} disabled={isSending || count === 0}>
            {sending === 'triage' ? 'Sending' : 'Send to triage agent'}
          </Button>
          {/*
            Draft is the secondary intent in this dual-action bar
            (gascity-dashboard-4co). Triage is what the operator
            reaches for first — vetting a batch before any PR work.
            Drop draft to tone='quiet' so the visual weight matches
            the intent hierarchy; both buttons sharing the default
            border made them read as equal-weight choices.
          */}
          <Button
            size="sm"
            tone="quiet"
            onClick={onSendDraft}
            disabled={isSending || count === 0}
          >
            {sending === 'draft' ? 'Sending' : 'Send to draft agent'}
          </Button>
          <Button size="sm" tone="quiet" onClick={onClear} disabled={isSending}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function Footer({ computedAt }: { computedAt: string | null }) {
  if (computedAt === null) {
    return (
      <p className="mt-16 text-label uppercase tracking-wider text-fg-faint">
        enrichment not yet computed · status data is live
      </p>
    );
  }
  return (
    <p className="mt-16 text-label uppercase tracking-wider text-fg-faint tnum">
      clusters computed {formatTimestamp(computedAt)} · {formatRelative(computedAt)} ago
    </p>
  );
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

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function readStorageFlag(key: string): boolean {
  const stored = readBrowserStorage('localStorage', key, COMPONENT);
  return stored.status === 'found' && stored.value === '1';
}

function writeStorageFlag(key: string, value: boolean): void {
  writeBrowserStorage('localStorage', key, value ? '1' : '0', COMPONENT);
}

function reportStorageParseFailure(key: string, err: unknown): void {
  void reportClientError({
    component: COMPONENT,
    operation: 'localStorage.parse',
    message: `${key}: ${errorMessage(err)}`,
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
