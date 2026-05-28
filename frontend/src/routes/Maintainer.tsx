import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from 'gas-city-dashboard-shared';
import type {
  MaintainerTriage,
  TriageItem,
  TriageTierSection,
} from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { SlungSection, TierSection } from '../components/maintainer/TriageSections';
import { useCachedData } from '../hooks/useCachedData';
import { useViewingAs } from '../contexts/ViewingAsContext';
import { readBrowserStorage, writeBrowserStorage } from '../lib/browserStorage';
import { reportClientError } from '../lib/clientErrorReporting';
import { formatDate, formatDateTime } from '../lib/format';
import {
  flattenTriageItems,
  toggleSelectionItem,
  type MaintainerSlingIntent,
  type SlingSuccess,
} from './maintainerSelection';
import {
  MAINTAINER_CACHE_KEY,
  useMaintainerEventRefresh,
  useMaintainerRefreshAction,
  useMaintainerSlingAction,
} from './maintainerActions';

export { SlungLink, TriageScore } from '../components/maintainer/TriageSignals';
export { IssueRow, SlungSection, TierSection } from '../components/maintainer/TriageSections';

// Triage route — read-only maintainer surface for gastownhall/gascity.
// Shell + tokens from gascity-dashboard-hq2; live data from
// gascity-dashboard-361 (gh ingest + JSON cache). Enrichment lands in
// 7ts (priority tiers), gtr (file clusters + blast radius), alh
// (contributor trust + ratios), and 98h (semantic weak ties).

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
    MAINTAINER_CACHE_KEY,
    () => api.maintainerTriage(),
  );
  const { viewingAs } = useViewingAs();

  useMaintainerEventRefresh(refresh);
  const { refreshing, refreshError, handleRefresh } = useMaintainerRefreshAction(refresh);
  const collapse = useCollapseState();
  // Bulk-sling selection (gascity-dashboard-0nn). Lives only in component
  // state; refresh / route change clears it. Bulk triage is a 'do it
  // now' operation, not a saved view.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
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

  const toggleSelection = useCallback((item: { kind: 'pr' | 'issue'; number: number }) => {
    setSelection((prev) => toggleSelectionItem(prev, item));
  }, []);

  // Flatten once per envelope so the bottom bar can look up html_urls
  // for every selected key in O(N) without rewalking the tier tree on
  // every render.
  const allItems = useMemo(() => (data ? flattenTriageItems(data) : []), [data]);
  const {
    slinging,
    slingError,
    slingSuccess,
    handleSend,
    clearSlingFeedback,
  } = useMaintainerSlingAction({ selection, allItems, setSelection });

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    clearSlingFeedback();
  }, [clearSlingFeedback]);

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
            <Button size="sm" onClick={toggleAwaitingOnly}>
              {awaitingOnly ? 'Show vetted too' : 'Awaiting triage only'}
            </Button>
            <Button size="sm" onClick={() => void handleRefresh()} disabled={refreshing}>
              {refreshing ? 'Refreshing' : 'Refresh from gh'}
            </Button>
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
                let view = tier;
                if (needsPrOnly) view = filterTierByNeedsPr(view);
                if (awaitingOnly) view = filterTierByAwaitingTriage(view);
                return (
                  <TierSection
                    key={tier.tier}
                    section={view}
                    counts={counts}
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
  // Inner container mirrors Layout's main column so the action line sits
  // under the page content, not above the gutters.
  return (
    <div
      className="fixed inset-x-0 bottom-0 border-t border-rule bg-surface"
      role="region"
      aria-label="bulk triage actions"
    >
      <div className="max-w-dashboard mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-baseline justify-between gap-6">
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
          <Button size="sm" onClick={onSendDraft} disabled={isSending || count === 0}>
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
      clusters computed {formatDateTime(computedAt)} · {formatRelative(computedAt)} ago
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
