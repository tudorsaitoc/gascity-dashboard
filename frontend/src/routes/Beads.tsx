import { useCallback, useMemo, useState } from 'react';
import type { GcBead } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { Button } from '../components/Button';
import { FilterChips } from '../components/FilterChips';
import { GroupedTable } from '../components/GroupedTable';
import { ListSearchBar } from '../components/ListSearchBar';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { type TableColumn } from '../components/Table';
import { useCachedData } from '../hooks/useCachedData';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useListFilters, type FilterChip } from '../hooks/useListFilters';
import { beadProject } from '../hooks/projectOf';
import { formatDateTime } from '../lib/format';

const BEAD_CHIPS: ReadonlyArray<FilterChip<GcBead>> = [
  { id: 'open', label: 'open', match: (b) => b.status === 'open' },
  { id: 'in_progress', label: 'in progress', match: (b) => b.status === 'in_progress' },
  { id: 'blocked', label: 'blocked', match: (b) => b.status === 'blocked' },
  { id: 'closed', label: 'closed', match: (b) => b.status === 'closed' },
];

const BEAD_SEARCH_FIELDS = (b: GcBead): ReadonlyArray<string | undefined> => [
  b.id,
  b.title,
  b.assignee,
  b.owner,
  ...(b.labels ?? []),
];

export function BeadsPage() {
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { data, loading, error, refresh } = useCachedData(
    showAll ? 'beads:all' : 'beads:open',
    () => api.listBeads(showAll),
  );
  const rows = useMemo(() => data?.items ?? [], [data]);
  const totalShown = data?.total ?? 0;
  const upstreamTotal = data?.upstream_total;
  const upstreamFetched = data?.upstream_fetched;
  const fetchLimit = data?.fetch_limit;

  const [closing, setClosing] = useState<GcBead | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [actionInFlight, setActionInFlight] = useState<{ id: string; action: string } | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [viewing, setViewing] = useState<GcBead | null>(null);

  const filteredRows = useMemo(() => {
    if (labelFilter === null) return rows;
    return rows.filter((r) => Array.isArray(r.labels) && r.labels.includes(labelFilter));
  }, [rows, labelFilter]);

  const filters = useListFilters<GcBead>({
    viewKey: 'beads',
    rows: filteredRows,
    projectOf: beadProject,
    searchOf: BEAD_SEARCH_FIELDS,
    chips: BEAD_CHIPS,
  });

  useGcEventRefresh(['bead.'], () => void refresh());

  const runAction = useCallback(
    async (
      bead: GcBead,
      action: 'claim' | 'close' | 'nudge',
      reason?: string,
    ): Promise<void> => {
      setActionInFlight({ id: bead.id, action });
      setActionResult(null);
      try {
        if (action === 'claim') await api.claimBead(bead.id);
        else if (action === 'close') await api.closeBead(bead.id, reason);
        else await api.nudgeBead(bead.id);
        setActionResult(`${action} ${bead.id}: ok`);
        await refresh();
      } catch (err) {
        const msg =
          err instanceof ApiClientError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'action failed';
        setActionResult(`${action} ${bead.id}: ${msg}`);
      } finally {
        setActionInFlight(null);
      }
    },
    [refresh],
  );

  const synopsis = useMemo(
    () => buildSynopsis(filteredRows, totalShown, labelFilter),
    [filteredRows, totalShown, labelFilter],
  );

  const columns = useMemo<ReadonlyArray<TableColumn<GcBead>>>(() => [
    {
      key: 'id',
      label: 'ID',
      sortable: true,
      sortValue: (r) => r.id,
      render: (r) => <span className="text-fg-muted tnum">{r.id}</span>,
      className: 'w-32',
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      sortValue: (r) => r.title,
      render: (r) => (
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => setViewing(r)}
            className="text-fg truncate hover:text-accent focus-mark text-left"
            title={`Open ${r.id}`}
          >
            {r.title}
          </button>
          <p className="text-label uppercase tracking-wider text-fg-faint mt-1 truncate">
            {r.issue_type}
            {r.assignee ? ` · ${r.assignee}` : ''}
          </p>
          {Array.isArray(r.labels) && r.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {r.labels.slice(0, 8).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLabelFilter((cur) => (cur === l ? null : l));
                  }}
                  className={`text-label uppercase tracking-wider transition-colors duration-150 ease-out-quart focus-mark rounded-sm ${labelTone(l)}`}
                  title={`Filter to label "${l}"`}
                >
                  {l}
                </button>
              ))}
              {r.labels.length > 8 && (
                <span className="text-label uppercase tracking-wider text-fg-faint italic">
                  +{r.labels.length - 8} more
                </span>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'priority',
      label: 'P',
      sortable: true,
      sortValue: (r) => r.priority,
      render: (r) => (
        <span className={`tnum font-medium ${priorityColor(r.priority)}`}>
          P{r.priority}
        </span>
      ),
      align: 'right',
      className: 'w-12',
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortValue: (r) => r.status,
      render: (r) => <StatusBadge tone={statusTone(r.status)} label={r.status} />,
      className: 'w-32',
    },
    {
      key: 'updated',
      label: 'Updated',
      sortable: true,
      sortValue: (r) => r.updated_at ?? r.created_at,
      render: (r) => (
        <span className="text-fg-muted tnum">{formatBeadTimestamp(r.updated_at ?? r.created_at)}</span>
      ),
      className: 'w-28',
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <div className="flex items-baseline justify-end gap-4">
          <Button
            size="sm"
            tone="quiet"
            disabled={r.status === 'in_progress' || actionInFlight !== null}
            onClick={() => void runAction(r, 'claim')}
          >
            Claim
          </Button>
          <Button
            size="sm"
            tone="quiet"
            disabled={r.status === 'closed' || actionInFlight !== null}
            onClick={() => {
              setCloseReason('');
              setClosing(r);
            }}
          >
            Close
          </Button>
          <Button
            size="sm"
            tone="quiet"
            disabled={!r.assignee || actionInFlight !== null}
            onClick={() => void runAction(r, 'nudge')}
            title={r.assignee ? `nudge ${r.assignee}` : 'no assignee'}
          >
            Nudge
          </Button>
        </div>
      ),
      align: 'right',
      className: 'w-56',
    },
  ], [actionInFlight, runAction]);

  const isTruncated =
    typeof upstreamTotal === 'number' &&
    typeof upstreamFetched === 'number' &&
    upstreamFetched < upstreamTotal;

  return (
    <section>
      <PageHeader
        title="Beads"
        synopsis={synopsis}
        meta={
          <>
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            <label className="flex items-baseline gap-2 text-label uppercase tracking-wider text-fg-muted cursor-pointer">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="accent-accent translate-y-0.5"
              />
              Show all
            </label>
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      <div className="space-y-2 mb-6 text-body text-fg-muted max-w-prose">
        {isTruncated && (
          <p className="text-warn">
            <StatusBadge
              tone="warn"
              label={`Fetch window covered ${upstreamFetched} of ${upstreamTotal} store beads. Raise the limit (currently ${fetchLimit ?? '?'}) if engineering work sits past the window.`}
            />
          </p>
        )}
        {labelFilter !== null && (
          <p>
            Filtering by label <span className="text-accent">{labelFilter}</span>.{' '}
            <button
              type="button"
              onClick={() => setLabelFilter(null)}
              className="text-fg-muted hover:text-fg focus-mark underline decoration-dotted underline-offset-2 rounded-sm"
            >
              Clear
            </button>
          </p>
        )}
        {actionResult && <p className="italic">{actionResult}</p>}
      </div>

      <div className="mb-6 space-y-3">
        <ListSearchBar
          value={filters.search}
          onChange={filters.setSearch}
          placeholder="Search beads by id, title, label, assignee"
          matchCount={filters.totalMatches}
          totalCount={filteredRows.length}
          ariaLabel="Search beads"
        />
        <FilterChips
          chips={BEAD_CHIPS}
          activeIds={filters.activeChipIds}
          onToggle={filters.toggleChip}
          legend="Status"
        />
      </div>

      <GroupedTable
        groups={filters.groups}
        columns={columns}
        rowKey={(r) => r.id}
        onToggleProject={filters.toggleProject}
        emptyMessage={
          filters.search.length > 0 || filters.activeChipIds.size > 0
            ? 'No beads match the current search or filter.'
            : labelFilter !== null
              ? `No beads match label "${labelFilter}".`
              : 'Nothing on the queue right now.'
        }
        perProjectEmpty="No beads in this project."
        initialSort={{ key: 'updated', dir: 'desc' }}
      />

      <BeadDetailModal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        beadId={viewing?.id ?? null}
        initialBead={viewing}
      />

      <Modal
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={closing ? `Close ${closing.id}` : 'Close bead'}
        caption={closing?.title}
        widthClass="max-w-lg"
        footer={
          <>
            <Button tone="quiet" size="sm" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              tone="accent"
              size="sm"
              disabled={actionInFlight !== null}
              onClick={() => {
                if (!closing) return;
                const c = closing;
                setClosing(null);
                void runAction(c, 'close', closeReason.trim() || undefined);
              }}
            >
              {actionInFlight?.action === 'close' ? 'Closing' : 'Close bead'}
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="text-label uppercase tracking-wider text-fg-muted">
            Reason (optional)
          </span>
          <textarea
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="What was resolved, and how."
            rows={5}
            className="mt-2 w-full bg-surface-tint border border-rule rounded-sm px-3 py-2 text-body text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 resize-y"
          />
        </label>
      </Modal>
    </section>
  );
}

function labelTone(label: string): string {
  // Pipeline-state labels carry the load. Approval = ok, needs- = warn,
  // blocked = stuck. Scope / gc: / agent: are quiet structural prefixes.
  if (label === 'approved' || label.endsWith('-approved')) return 'text-ok hover:opacity-80';
  if (label === 'needs-review' || label.startsWith('needs-review-')) return 'text-warn hover:opacity-80';
  if (label.startsWith('needs-impl:') || label.startsWith('needs-')) return 'text-warn hover:opacity-80';
  if (label === 'blocked' || label === 'mayor-skip' || label === 'mayor-needs-human') return 'text-accent hover:opacity-80';
  if (label.startsWith('scope:')) return 'text-fg-muted hover:text-fg';
  if (label.startsWith('gc:') || label.startsWith('agent:')) return 'text-fg-faint hover:text-fg-muted';
  return 'text-fg-muted hover:text-fg';
}

function priorityColor(p: number): string {
  if (p === 0) return 'text-accent';
  if (p === 1) return 'text-warn';
  return 'text-fg-muted';
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'in_progress':
      return 'ok';
    case 'blocked':
      return 'stuck';
    case 'open':
      return 'neutral';
    case 'closed':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function buildSynopsis(filtered: ReadonlyArray<GcBead>, totalShown: number, labelFilter: string | null): string {
  if (labelFilter !== null) {
    return `${filtered.length} matching "${labelFilter}".`;
  }
  const open = filtered.filter((b) => b.status === 'open').length;
  const inProgress = filtered.filter((b) => b.status === 'in_progress').length;
  const blocked = filtered.filter((b) => b.status === 'blocked').length;
  const parts: string[] = [];
  if (open > 0) parts.push(`${open} open`);
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (parts.length === 0) return 'Nothing on the queue.';
  let s = parts.join(', ') + '.';
  if (totalShown > filtered.length) s += ` Showing ${filtered.length} of ${totalShown}.`;
  return s;
}

function formatBeadTimestamp(timestamp: string | undefined): string {
  return timestamp ? formatDateTime(timestamp) : '·';
}
