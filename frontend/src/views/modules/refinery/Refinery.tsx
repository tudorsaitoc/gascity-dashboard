// Refinery — the merge pipeline as a ledger page. Queue in (publish pool),
// gate verdicts (closeout outcomes over the window), merges out (with
// pool-entry→merge lead time). Calm by default; the single maroon mark on
// this page belongs to stuck work, and only when some exists.
//
// Fail-safe register: each host-side source degrades independently as a
// text-warn "unavailable" notice (glyph + word, greyscale-legible); a total
// fetch failure renders one role="alert" line — at that point no rows are
// on the page, so the One Mark Rule holds in every combination.

import { api } from '../../../api/client';
import { useCachedData } from '../../../hooks/useCachedData';
import { useNow } from '../../../contexts/NowContext';
import { PageHeader } from '../../../components/PageHeader';
import { PartialDataNotice } from '../../../components/PartialDataNotice';
import { Table, type TableColumn } from '../../../components/Table';
import type {
  RefineryMergeItem,
  RefineryPoolItem,
  RefinerySummary,
} from 'gas-city-dashboard-shared';

const CACHE_KEY = 'refinery-summary';

function formatAgo(nowMs: number, iso: string | null): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return formatDuration(Math.max(0, nowMs - t));
}

function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${Math.round(hours - days * 24)}h`;
}

function prNumberFromUrl(url: string | null): string | null {
  if (url === null) return null;
  const m = /\/pull\/(\d+)$/.exec(url);
  return m === null ? null : `#${m[1]}`;
}

// Label + number pair for the gate ledger line. Numbers in tabular figures;
// labels in the Label scale like table column headers.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-label uppercase tracking-wider text-fg-muted">{label} </span>
      <span className="text-body text-fg tnum">{value}</span>
    </span>
  );
}

function poolColumns(nowMs: number, suppressAccent: boolean): TableColumn<RefineryPoolItem>[] {
  return [
    {
      key: 'bead',
      label: 'Bead',
      render: (row) => (
        <span className="whitespace-nowrap">
          {row.stuck && (
            <span
              aria-hidden="true"
              className={`${suppressAccent ? 'text-fg' : 'text-accent'} text-[0.85em] leading-none`}
            >
              ●{' '}
            </span>
          )}
          <span className="text-fg">{row.beadId}</span>
        </span>
      ),
    },
    {
      key: 'title',
      label: 'Title',
      className: 'max-w-[28rem]',
      render: (row) => <span className="text-fg-muted line-clamp-1">{row.title}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortValue: (row) => `${row.stuck ? '0' : '1'}:${row.status}`,
      render: (row) =>
        row.stuck ? (
          <span className="text-fg" title={row.blockedReason ?? undefined}>
            stuck · {row.status}
          </span>
        ) : (
          <span className="text-fg-muted" title={row.blockedReason ?? undefined}>
            {row.status}
          </span>
        ),
    },
    {
      key: 'pr',
      label: 'PR',
      render: (row) =>
        row.prUrl !== null ? (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-fg-muted hover:text-fg transition-colors duration-150 ease-out-quart focus-mark"
          >
            {prNumberFromUrl(row.prUrl) ?? 'PR'}
          </a>
        ) : (
          <span className="text-fg-faint">{row.branch ?? '—'}</span>
        ),
    },
    {
      key: 'age',
      label: 'Last movement',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.updatedAt ?? '',
      render: (row) => <span className="text-fg-muted tnum">{formatAgo(nowMs, row.updatedAt)}</span>,
    },
  ];
}

function mergeColumns(nowMs: number): TableColumn<RefineryMergeItem>[] {
  return [
    {
      key: 'bead',
      label: 'Bead',
      render: (row) => <span className="text-fg whitespace-nowrap">{row.beadId}</span>,
    },
    {
      key: 'title',
      label: 'Title',
      className: 'max-w-[28rem]',
      render: (row) => <span className="text-fg-muted line-clamp-1">{row.title ?? '—'}</span>,
    },
    {
      key: 'pr',
      label: 'PR',
      render: (row) =>
        row.prUrl !== null ? (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-fg-muted hover:text-fg transition-colors duration-150 ease-out-quart focus-mark"
          >
            {row.prNumber !== null ? `#${row.prNumber}` : 'PR'}
          </a>
        ) : (
          <span className="text-fg-faint">—</span>
        ),
    },
    {
      key: 'lead',
      label: 'Lead time',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.leadTimeMs ?? -1,
      render: (row) => (
        <span className="text-fg tnum">
          {row.leadTimeMs !== null ? formatDuration(row.leadTimeMs) : '—'}
        </span>
      ),
    },
    {
      key: 'merged',
      label: 'Merged',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.mergedAt,
      render: (row) => <span className="text-fg-muted tnum">{formatAgo(nowMs, row.mergedAt)} ago</span>,
    },
  ];
}

function synopsisFor(summary: RefinerySummary): string {
  const pool = summary.poolSource.status === 'ok' ? `${summary.pool.length} in the publish pool` : null;
  const merged =
    summary.riverSource.status === 'ok'
      ? `${summary.gate.merged + summary.gate.closedOnMerge} merged in ${summary.gate.windowDays} days`
      : null;
  const parts = [pool, merged].filter((p): p is string => p !== null);
  return parts.length > 0
    ? `${parts.join(' · ')}.`
    : 'The merge pipeline for fleet-produced work.';
}

export function RefineryPage() {
  const { data, error, loading } = useCachedData<RefinerySummary>(CACHE_KEY, () =>
    api.refinerySummary(),
  );
  const nowMs = useNow();

  const stuckCount = data?.pool.filter((row) => row.stuck).length ?? 0;

  return (
    <div className="space-y-14">
      <PageHeader
        title="Refinery"
        synopsis={data !== undefined ? synopsisFor(data) : 'The merge pipeline for fleet-produced work.'}
        meta={
          <span className="flex items-baseline gap-4">
            {data?.lastPatrolAt != null && (
              <span className="text-label uppercase tracking-wider text-fg-muted tnum">
                last patrol {formatAgo(nowMs, data.lastPatrolAt)} ago
              </span>
            )}
            {error !== null && (
              <span className="normal-case text-body text-accent" role="alert">
                Refinery data unavailable — {error}
              </span>
            )}
          </span>
        }
      />

      {loading && data === undefined && <p className="text-body text-fg-muted italic">Loading.</p>}

      {data !== undefined && (
        <>
          <section>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
              <h2 className="text-headline font-semibold uppercase tracking-wide text-fg">
                Publish pool
              </h2>
              <span className="flex items-baseline gap-4">
                {stuckCount > 0 && (
                  <span className="text-label uppercase tracking-wider text-fg tnum">
                    {stuckCount} stuck &gt;{data.stuckThresholdHours}h
                  </span>
                )}
                <PartialDataNotice
                  show={data.poolSource.status === 'unavailable'}
                  glyph="◐"
                  label="pool unavailable"
                  title={data.poolSource.status === 'unavailable' ? data.poolSource.reason : ''}
                />
              </span>
            </div>
            {data.poolSource.status === 'ok' && (
              <Table
                columns={poolColumns(nowMs, error !== null)}
                rows={data.pool}
                rowKey={(row) => row.beadId}
                initialSort={{ key: 'age', dir: 'asc' }}
                empty={
                  <p className="text-body text-fg-faint italic">
                    Pool is empty — nothing waiting on the refinery.
                  </p>
                }
              />
            )}
            {data.poolSource.status === 'unavailable' && (
              <p className="text-body text-fg-muted italic mt-3">{data.poolSource.reason}.</p>
            )}
          </section>

          <section>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
              <h2 className="text-headline font-semibold uppercase tracking-wide text-fg">
                Gate · last {data.gate.windowDays} days
              </h2>
              <PartialDataNotice
                show={data.riverSource.status === 'unavailable'}
                glyph="◐"
                label="river unavailable"
                title={data.riverSource.status === 'unavailable' ? data.riverSource.reason : ''}
              />
            </div>
            {data.riverSource.status === 'ok' ? (
              <p className="flex flex-wrap gap-x-6 gap-y-1 mt-3">
                <Stat
                  label="merged"
                  value={String(data.gate.merged + data.gate.closedOnMerge)}
                />
                <Stat label="blocked on checks" value={String(data.gate.blockedRequiredChecks)} />
                <Stat label="waiting CI" value={String(data.gate.waitingCi)} />
                <Stat label="CI failed" value={String(data.gate.ciFailed)} />
                <Stat label="judge blocked" value={String(data.gate.llmJudgeBlocked)} />
                <Stat label="merge failed" value={String(data.gate.mergeFailed)} />
                <Stat
                  label="pass rate"
                  value={
                    data.gate.passRate !== null
                      ? `${Math.round(data.gate.passRate * 100)}%`
                      : '—'
                  }
                />
              </p>
            ) : (
              <p className="text-body text-fg-muted italic mt-3">{data.riverSource.reason}.</p>
            )}
          </section>

          <section>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
              <h2 className="text-headline font-semibold uppercase tracking-wide text-fg">Merged</h2>
              {data.riverSource.status === 'ok' && data.leadTimeMedianMs !== null && (
                <span className="text-label uppercase tracking-wider text-fg-muted tnum">
                  lead time median {formatDuration(data.leadTimeMedianMs)}
                  {data.leadTimeP90Ms !== null && ` · p90 ${formatDuration(data.leadTimeP90Ms)}`}
                </span>
              )}
            </div>
            {data.riverSource.status === 'ok' ? (
              <Table
                columns={mergeColumns(nowMs)}
                rows={data.merges}
                rowKey={(row) => row.beadId}
                empty={
                  <p className="text-body text-fg-faint italic">
                    Nothing merged in the last {data.gate.windowDays} days.
                  </p>
                }
              />
            ) : (
              <p className="text-body text-fg-muted italic mt-3">{data.riverSource.reason}.</p>
            )}
          </section>
        </>
      )}

      {data === undefined && !loading && error === null && (
        <p className="text-body text-fg-faint italic">No refinery data yet.</p>
      )}
    </div>
  );
}
