import type { SourceStatus } from 'gas-city-dashboard-shared';

export const ATTENTION_DOMAINS = [
  'agents',
  'beads',
  'runs',
  'mail',
  'activity',
  'health',
  'maintainer',
] as const;

/**
 * Severity tiers. `attention` and `watch` are operator-actionable signals that
 * count toward a domain's nav badge. `unavailable` is the data-degradation tier
 * (gascity-dashboard issue-88 follow-up): a slice of a source could not be read,
 * so the item must surface the degradation WITHOUT inflating the badge count or
 * recoloring it. Only attention/watch drive `AttentionDomainSummary.severity`.
 */
export type AttentionSeverity = 'attention' | 'watch' | 'unavailable';

/** The badge-driving tiers — the subset of severities that color/count a badge. */
export type BadgeSeverity = Exclude<AttentionSeverity, 'unavailable'>;
export type AttentionDomain = (typeof ATTENTION_DOMAINS)[number];

export interface AttentionItem {
  id: string;
  domain: AttentionDomain;
  severity: AttentionSeverity;
  title: string;
  href?: string;
  summary?: string;
  current?: boolean;
  actionable?: boolean;
  updatedAt?: string;
  /**
   * Freshness of the source this item was derived from. Carried on
   * `unavailable` items so a badge fed from a stale cache read can be marked
   * stale rather than rendered as live truth.
   */
  provenance?: SourceStatus;
  /**
   * ISO timestamp of the cache read this item was derived from (the
   * useCachedData/cache fetch primitive). Pairs with `provenance` so a consumer
   * can age a degradation signal — "as of <fetchedAt>, this slice was
   * unavailable" — instead of treating a long-stale read as current.
   */
  fetchedAt?: string;
}

export interface AttentionContributor {
  id: string;
  domain: AttentionDomain;
  getItems(): readonly AttentionItem[];
  /**
   * Read freshness of the source backing this contributor
   * (gascity-dashboard-5t0m, Freshness Spine). Folded per-domain into
   * {@link AttentionDomainSummary} so a calm-but-frozen domain still reports its
   * read age even when it emits zero items — the one question no item-level
   * signal answers ("is the data CURRENT?", not "is it alarming?"). `provenance`
   * is the cache read's SourceStatus; `fetchedAt` is its ISO read time.
   *
   * `staleAt` (gascity-dashboard-fchh) is the ISO instant after which this read
   * is no longer current — `fetchedAt + ATTENTION_READ_STALE_AFTER_MS`, set ONLY
   * by polled sources (the cache-read domains). The event-driven runs source
   * leaves it undefined: its liveness is the gc event stream, not a read age, so
   * it must not age-flip on a quiet-but-live board. {@link boardFreshness} flips
   * a domain to `stale` once `now >= staleAt`.
   */
  provenance?: SourceStatus;
  fetchedAt?: string;
  staleAt?: string;
}

export interface AttentionDomainSummary {
  domain: AttentionDomain;
  attention: number;
  watch: number;
  /** Count of `unavailable`-tier items; never folded into the badge count. */
  unavailable: number;
  /** Badge tier — only ever attention/watch/null; `unavailable` never sets it. */
  severity: BadgeSeverity | null;
  items: readonly AttentionItem[];
  /**
   * Freshness folded across this domain's contributors (gascity-dashboard-5t0m):
   * the WORST provenance (most degraded — `fresh` < `fixture` < `stale` <
   * `error`) and the OLDEST (earliest) `fetchedAt`. Undefined when no contributor
   * reported one. Independent of `severity`: a domain can be calm (no items, null
   * severity) yet stale — that is exactly the signal this carries. `staleAt` is
   * the EARLIEST (soonest) stale instant across the domain's polled contributors
   * (gascity-dashboard-fchh); undefined for event-driven sources that do not age.
   */
  provenance?: SourceStatus;
  fetchedAt?: string;
  staleAt?: string;
}

export interface AttentionOverflowGroup {
  domain: AttentionDomain;
  attention: number;
  watch: number;
  unavailable: number;
  total: number;
}

export interface AttentionModel {
  items: readonly AttentionItem[];
  topItems: readonly AttentionItem[];
  overflowByDomain: readonly AttentionOverflowGroup[];
  byDomain: Record<AttentionDomain, AttentionDomainSummary>;
}

export interface ComposeAttentionOptions {
  topLimit?: number;
}

const DEFAULT_TOP_LIMIT = 5;

const DOMAIN_ORDER = new Map<AttentionDomain, number>(
  ATTENTION_DOMAINS.map((domain, index) => [domain, index]),
);

export function composeAttention(
  contributors: readonly AttentionContributor[],
  options: ComposeAttentionOptions = {},
): AttentionModel {
  const byDomain = emptyDomainSummaries();
  const indexedItems: Array<{ item: AttentionItem; index: number }> = [];
  let index = 0;

  for (const contributor of contributors) {
    // gascity-dashboard-5t0m: fold the contributor's own read freshness FIRST,
    // before its items — so a calm contributor (zero items) still records its
    // age/provenance on the domain summary. The item loop preserves these via
    // the `...summary` spread.
    byDomain[contributor.domain] = foldFreshness(
      byDomain[contributor.domain],
      contributor.provenance,
      contributor.fetchedAt,
      contributor.staleAt,
    );
    for (const item of contributor.getItems()) {
      indexedItems.push({ item, index });
      const summary = byDomain[item.domain];
      const nextItems = [...summary.items, item];
      byDomain[item.domain] = {
        ...summary,
        attention: summary.attention + (item.severity === 'attention' ? 1 : 0),
        watch: summary.watch + (item.severity === 'watch' ? 1 : 0),
        unavailable: summary.unavailable + (item.severity === 'unavailable' ? 1 : 0),
        // Unavailable items report degradation; they must never color the badge.
        severity:
          item.severity === 'unavailable'
            ? summary.severity
            : highestSeverity(summary.severity, item.severity),
        items: nextItems,
      };
      index += 1;
    }
  }

  const items = indexedItems
    .sort((a, b) => compareAttentionItems(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
  const topLimit = options.topLimit ?? DEFAULT_TOP_LIMIT;
  const topItems = items.slice(0, topLimit);
  const overflowByDomain = groupOverflow(items.slice(topLimit));

  return { items, topItems, overflowByDomain, byDomain };
}

function emptyDomainSummaries(): Record<AttentionDomain, AttentionDomainSummary> {
  const summaries = {} as Record<AttentionDomain, AttentionDomainSummary>;
  for (const domain of ATTENTION_DOMAINS) {
    summaries[domain] = {
      domain,
      attention: 0,
      watch: 0,
      unavailable: 0,
      severity: null,
      items: [],
    };
  }
  return summaries;
}

function highestSeverity(current: BadgeSeverity | null, next: BadgeSeverity): BadgeSeverity {
  if (current === 'attention' || next === 'attention') return 'attention';
  return 'watch';
}

// gascity-dashboard-5t0m: read-freshness fold. "Worst" provenance is the most
// degraded for the liveness question — a live read (`fresh`) is best; `fixture`
// is intentional demo data (not live but not broken); `stale` is a real source
// gone old; `error` is a failed read. Higher rank wins.
const PROVENANCE_RANK: Record<SourceStatus, number> = {
  fresh: 0,
  fixture: 1,
  stale: 2,
  error: 3,
};

/** Fold one contributor's provenance + fetchedAt + staleAt into a domain
 *  summary. The summary takes the worst provenance, the oldest read time, and
 *  the soonest stale instant — so a domain goes stale as soon as its earliest
 *  contributor would. */
function foldFreshness(
  summary: AttentionDomainSummary,
  provenance: SourceStatus | undefined,
  fetchedAt: string | undefined,
  staleAt: string | undefined,
): AttentionDomainSummary {
  const worst = worseProvenance(summary.provenance, provenance);
  const oldest = olderFetchedAt(summary.fetchedAt, fetchedAt);
  const soonestStale = olderFetchedAt(summary.staleAt, staleAt);
  return {
    ...summary,
    // exactOptionalPropertyTypes: include each key only when defined.
    ...(worst !== undefined && { provenance: worst }),
    ...(oldest !== undefined && { fetchedAt: oldest }),
    ...(soonestStale !== undefined && { staleAt: soonestStale }),
  };
}

/** The more-degraded of two provenances (undefined = no signal yet). */
function worseProvenance(
  current: SourceStatus | undefined,
  next: SourceStatus | undefined,
): SourceStatus | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return PROVENANCE_RANK[next] > PROVENANCE_RANK[current] ? next : current;
}

/** The older (earlier) of two ISO read times. Unparsable values lose to a
 *  parsable one, so a real read time always wins over a malformed marker. */
function olderFetchedAt(current: string | undefined, next: string | undefined): string | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  const c = Date.parse(current);
  const n = Date.parse(next);
  if (!Number.isFinite(n)) return current;
  if (!Number.isFinite(c)) return next;
  return n < c ? next : current;
}

/**
 * Board-wide read freshness, folded across every domain summary
 * (gascity-dashboard-5t0m, Freshness Spine). Drives the one quiet Header
 * liveness line: `fetchedAt` is the OLDEST read on the board (the line's "as of
 * N ago"), `provenance` the WORST, and `degraded` the domains whose read is
 * stale/errored — the only trigger for the line's single maroon glyph+word.
 */
export interface BoardFreshness {
  provenance: SourceStatus | undefined;
  fetchedAt: string | undefined;
  degraded: readonly { domain: AttentionDomain; provenance: SourceStatus }[];
}

export function boardFreshness(model: AttentionModel, nowMs: number): BoardFreshness {
  let provenance: SourceStatus | undefined;
  let fetchedAt: string | undefined;
  const degraded: { domain: AttentionDomain; provenance: SourceStatus }[] = [];
  for (const domain of ATTENTION_DOMAINS) {
    const summary = model.byDomain[domain];
    const effective = effectiveProvenance(summary, nowMs);
    provenance = worseProvenance(provenance, effective);
    fetchedAt = olderFetchedAt(fetchedAt, summary.fetchedAt);
    if (effective === 'stale' || effective === 'error') {
      degraded.push({ domain, provenance: effective });
    }
  }
  return { provenance, fetchedAt, degraded };
}

/**
 * A domain's effective provenance for the liveness line (gascity-dashboard-fchh
 * blocker 1). Most polled domains can only ever report `fresh`/`error` from a
 * single read, so a frozen-but-not-erroring cache would never degrade off
 * provenance alone. A polled domain therefore carries a `staleAt`
 * (`fetchedAt + ATTENTION_READ_STALE_AFTER_MS`); once `now >= staleAt` its read
 * is no longer current and ages to `stale`. `error` and an already-`stale`
 * source are unchanged; `fixture` is intentional demo data and never ages; the
 * event-driven runs source has no `staleAt`, so it never age-flips (its liveness
 * is the gc event stream — see BoardLiveness).
 */
function effectiveProvenance(
  summary: AttentionDomainSummary,
  nowMs: number,
): SourceStatus | undefined {
  const { provenance, staleAt } = summary;
  if (provenance === 'error' || provenance === 'stale' || provenance === 'fixture') {
    return provenance;
  }
  if (staleAt !== undefined) {
    const staleAtMs = Date.parse(staleAt);
    if (Number.isFinite(staleAtMs) && nowMs >= staleAtMs) return 'stale';
  }
  return provenance;
}

// gascity-dashboard-fchh (Freshness Spine, Option B): the polled attention
// domains (everything except the event-driven runs source) re-read on this
// cadence so a healthy board's reads stay current. A read older than the stale
// threshold is treated as no-longer-current and flips the board liveness line
// maroon. INVARIANT: REFRESH_INTERVAL_MS < STALE_AFTER_MS with headroom, so a
// healthy board re-reads ~3x (90s / 30s) before any domain can age out — only a
// genuinely wedged/frozen refresh loop crosses the threshold. Follows the same
// fetchedAt + staleAt convention the runs SourceState uses for its own liveness.
export const ATTENTION_READ_REFRESH_INTERVAL_MS = 30_000;
export const ATTENTION_READ_STALE_AFTER_MS = 90_000;

function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    booleanRank(b.current ?? true) - booleanRank(a.current ?? true) ||
    booleanRank(b.actionable ?? false) - booleanRank(a.actionable ?? false) ||
    recencyRank(b.updatedAt) - recencyRank(a.updatedAt) ||
    domainRank(a.domain) - domainRank(b.domain)
  );
}

function severityRank(severity: AttentionSeverity): number {
  switch (severity) {
    case 'attention':
      return 0;
    case 'watch':
      return 1;
    case 'unavailable':
      return 2;
  }
}

function booleanRank(value: boolean): number {
  return value ? 1 : 0;
}

function recencyRank(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function domainRank(domain: AttentionDomain): number {
  return DOMAIN_ORDER.get(domain) ?? ATTENTION_DOMAINS.length;
}

function groupOverflow(items: readonly AttentionItem[]): AttentionOverflowGroup[] {
  const groups: AttentionOverflowGroup[] = [];
  for (const domain of ATTENTION_DOMAINS) {
    let attention = 0;
    let watch = 0;
    let unavailable = 0;
    for (const item of items) {
      if (item.domain !== domain) continue;
      if (item.severity === 'attention') attention += 1;
      else if (item.severity === 'watch') watch += 1;
      else unavailable += 1;
    }
    const total = attention + watch + unavailable;
    if (total > 0) groups.push({ domain, attention, watch, unavailable, total });
  }
  return groups;
}
