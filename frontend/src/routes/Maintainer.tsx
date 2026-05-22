import { useCallback, useState } from 'react';
import type {
  ContributorStat,
  ContributorTier,
  MaintainerTriage,
  TriageCluster,
  TriageItem,
  TriageItemStatus,
  TriageTier,
  TriageTierSection,
} from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { setCached } from '../api/cache';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { useCachedData } from '../hooks/useCachedData';

// Triage route — read-only maintainer surface for gastownhall/gascity.
// Shell + tokens from gascity-dashboard-hq2; live data from
// gascity-dashboard-361 (gh ingest + JSON cache). Enrichment lands in
// 7ts (priority tiers), gtr (file clusters + blast radius), alh
// (contributor trust + ratios), and 98h (semantic weak ties).

const CACHE_KEY = 'maintainer-triage';

export function MaintainerPage() {
  const { data, loading, error, refresh } = useCachedData<MaintainerTriage>(
    CACHE_KEY,
    () => api.maintainerTriage(),
  );

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

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
            {data.tiers.map((tier) => (
              <TierSection key={tier.tier} section={tier} />
            ))}
          </div>
          <Footer computedAt={data.computed_at} />
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

function TierSection({ section }: { section: TriageTierSection }) {
  const itemCount =
    section.clusters.reduce((n, c) => n + c.items.length, 0) +
    section.unclustered.length;

  return (
    <section>
      <header className="flex items-baseline justify-between gap-4 mb-6 pb-2 border-b border-rule">
        <h2
          className={
            section.tier === 'regression_breaking'
              ? 'text-headline font-semibold uppercase tracking-wide text-fg'
              : 'text-headline font-semibold uppercase tracking-wide text-fg-muted'
          }
        >
          {tierLabel(section.tier)}
        </h2>
        <span className="text-label uppercase tracking-wider text-fg-muted tnum">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </span>
      </header>

      {section.clusters.length === 0 && section.unclustered.length === 0 ? (
        <p className="text-body text-fg-faint italic">No items in this tier.</p>
      ) : (
        <div className="space-y-10">
          {section.clusters.map((cluster) => (
            <ClusterBlock key={cluster.cluster_id} cluster={cluster} />
          ))}

          {section.unclustered.length > 0 && (
            <div className="space-y-2">
              <div className="text-title font-medium text-fg-muted">
                {section.clusters.length > 0 ? 'Unclustered' : 'Awaiting cluster enrichment'}
              </div>
              <RowList items={section.unclustered} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ClusterBlock({ cluster }: { cluster: TriageCluster }) {
  const issues = cluster.items.filter((i) => i.kind === 'issue').length;
  const prs = cluster.items.filter((i) => i.kind === 'pr').length;
  const totals: string[] = [];
  if (issues > 0) totals.push(`${issues} ${issues === 1 ? 'issue' : 'issues'}`);
  if (prs > 0) totals.push(`${prs} ${prs === 1 ? 'PR' : 'PRs'}`);
  if (cluster.lines_pending > 0) totals.push(`${cluster.lines_pending} lines pending`);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-title font-medium text-fg min-w-0 truncate">
          {cluster.files.join(', ')}
        </div>
        <div className="text-body text-fg-muted tnum shrink-0">
          {totals.join(' · ')}
        </div>
      </div>
      <RowList items={cluster.items} />
    </div>
  );
}

// Lays out a list of items, nesting PRs under their parent issue when
// the parent is also in the same list. PRs whose linked issue is NOT
// in the list render at the top level alongside issues, distinguished
// by a leading "PR" kind marker. The reverse-mapped issue.linked_numbers
// (populated server-side in triage.ts) drives the "anchored" affordance
// on issues.
function RowList({ items }: { items: TriageItem[] }) {
  const issueNumbersInList = new Set<number>();
  for (const it of items) {
    if (it.kind === 'issue') issueNumbersInList.add(it.number);
  }

  const nestedPrNumbers = new Set<number>();
  const childrenOf = new Map<number, TriageItem[]>();
  for (const it of items) {
    if (it.kind !== 'pr') continue;
    for (const linked of it.linked_numbers) {
      if (issueNumbersInList.has(linked)) {
        nestedPrNumbers.add(it.number);
        const list = childrenOf.get(linked);
        if (list) list.push(it);
        else childrenOf.set(linked, [it]);
      }
    }
  }

  return (
    <div>
      {items.map((it) => {
        if (it.kind === 'pr' && nestedPrNumbers.has(it.number)) return null;
        const children = it.kind === 'issue' ? childrenOf.get(it.number) ?? [] : [];
        return (
          <div key={rowKey(it)}>
            {it.kind === 'issue' ? (
              <IssueRow item={it} hasInListChildren={children.length > 0} />
            ) : (
              <PrRow item={it} nested={false} />
            )}
            {children.map((child) => (
              <PrRow key={rowKey(child)} item={child} nested={true} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function IssueRow({
  item,
  hasInListChildren,
}: {
  item: TriageItem;
  hasInListChildren: boolean;
}) {
  // 'anchored' only lights up when the linked PR is NOT also in view —
  // when it IS in view, the visual nesting already communicates the
  // link and the label would be noise.
  const showAnchored = item.linked_numbers.length > 0 && !hasInListChildren;
  return (
    <div className="grid grid-cols-[1.75em_1fr_auto] items-baseline gap-x-3 py-1.5">
      <span aria-hidden className="text-accent text-[0.85em] leading-none translate-y-[1px]">
        {item.is_marked ? '●' : ''}
      </span>
      <div className="min-w-0">
        <span className="text-body text-fg">{item.title}</span>
        {item.weak_ties.length > 0 && (
          <span className="ml-3 text-body text-fg-faint">
            also in: {item.weak_ties.map((t) => `${t.label} (${t.count})`).join(', ')}
          </span>
        )}
        {showAnchored && (
          <span className="ml-3 text-label uppercase tracking-wider text-fg-faint">
            anchored
          </span>
        )}
      </div>
      <RowMeta item={item} />
    </div>
  );
}

function PrRow({ item, nested }: { item: TriageItem; nested: boolean }) {
  // Three visual states:
  //   - Standalone PR, marked    → maroon ● in leading col (rare)
  //   - Standalone PR, unmarked  → "PR" label in leading col
  //   - Nested PR                → '↳' continuation glyph + pl-10 indent
  //     (urgency is the parent issue's, so no maroon mark even when
  //     is_marked — the parent above already carries the One Mark)
  const leading = nested ? (
    <span className="text-fg-faint leading-none translate-y-[1px]" aria-label="fixes issue above">↳</span>
  ) : item.is_marked ? (
    <span className="text-accent text-[0.85em] leading-none translate-y-[1px]" aria-hidden>●</span>
  ) : (
    <span
      className="text-label uppercase tracking-wider text-fg-muted leading-none translate-y-[1px]"
      aria-label="pull request"
    >
      PR
    </span>
  );

  return (
    <div
      className={`grid grid-cols-[1.75em_1fr_auto] items-baseline gap-x-3 py-1 ${nested ? 'pl-10' : ''}`}
    >
      {leading}
      <div className="min-w-0">
        <span className={nested ? 'text-body text-fg-muted' : 'text-body text-fg'}>
          {item.title}
        </span>
        {item.weak_ties.length > 0 && (
          <span className="ml-3 text-body text-fg-faint">
            also in: {item.weak_ties.map((t) => `${t.label} (${t.count})`).join(', ')}
          </span>
        )}
      </div>
      <RowMeta item={item} extraStatus={item.status} />
    </div>
  );
}

function RowMeta({
  item,
  extraStatus,
}: {
  item: TriageItem;
  extraStatus?: TriageItemStatus;
}) {
  return (
    <div className="flex items-baseline gap-3 text-body text-fg-muted shrink-0 tnum">
      <a
        href={item.html_url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-fg focus-mark"
      >
        #{item.number}
      </a>
      <span aria-hidden>·</span>
      <ContributorByline author={item.author} />
      <span aria-hidden>·</span>
      <span>{formatAge(item.updated_at)}</span>
      {extraStatus && extraStatus !== 'open' && (
        <>
          <span aria-hidden>·</span>
          <PrStatus status={extraStatus} />
        </>
      )}
    </div>
  );
}

function PrStatus({ status }: { status: TriageItemStatus }) {
  const label = statusLabel(status);
  const className =
    status === 'approved'
      ? 'text-ok'
      : status === 'changes_requested'
        ? 'text-accent'
        : status === 'needs_review'
          ? 'text-warn'
          : 'text-fg-muted';
  return <span className={className}>{label}</span>;
}

function ContributorByline({ author }: { author: ContributorStat }) {
  const ratesAvailable =
    author.issues_accepted !== null &&
    author.issues_opened !== null &&
    author.prs_merged !== null &&
    author.prs_opened !== null;

  const ratesTitle = ratesAvailable
    ? `${author.issues_accepted}/${author.issues_opened} issues accepted · ${author.prs_merged}/${author.prs_opened} PRs merged`
    : 'rates not yet computed';

  return (
    <span title={ratesTitle} className="whitespace-nowrap">
      {author.login}{' '}
      <span className={tierClass(author.tier)}>{tierWord(author.tier)}</span>
    </span>
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

// ── derivation helpers ───────────────────────────────────────────────

function rowKey(item: TriageItem): string {
  return `${item.kind}-${item.number}`;
}

function tierLabel(tier: TriageTier): string {
  if (tier === 'regression_breaking') return 'Regression + breaking';
  if (tier === 'regression') return 'Regression';
  return 'Stability';
}

function tierWord(tier: ContributorTier): string {
  if (tier === 'spam_risk') return 'spam risk';
  return tier;
}

function tierClass(tier: ContributorTier): string {
  if (tier === 'core') return 'text-fg font-medium';
  if (tier === 'trusted') return 'text-fg';
  if (tier === 'regular') return 'text-fg-muted';
  if (tier === 'new') return 'text-fg-muted italic';
  return 'text-accent';
}

function statusLabel(status: TriageItemStatus): string {
  if (status === 'needs_review') return 'needs review';
  if (status === 'changes_requested') return 'changes requested';
  return status;
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

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
