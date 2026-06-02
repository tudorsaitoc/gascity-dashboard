import { useCallback, useMemo, useState } from 'react';
import { GC_EVENT_PREFIX, type GcBead } from 'gas-city-dashboard-shared';
import { api, formatApiError } from '../api/client';
import { BeadBoardSection } from '../components/beads/BeadBoardSection';
import { BeadDetailRail } from '../components/beads/BeadDetailRail';
import { Button } from '../components/Button';
import { FilterChips } from '../components/FilterChips';
import { ListSearchBar } from '../components/ListSearchBar';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { buildBeadGraph } from '../lib/beadGraph';
import { useCachedData } from '../hooks/useCachedData';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useListFilters, type FilterChip } from '../hooks/useListFilters';
import { beadProject } from '../hooks/projectOf';

const EMPTY_IDS: ReadonlySet<string> = new Set();

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
  ...(b.labels ?? []),
];

export function BeadsPage() {
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  // #33: read the real-work-filtered feed (no showAll). The
  // default endpoint keeps every status (it filters by type/label, not
  // status), so the kanban's in-progress / blocked / done columns stay
  // populated, while bookkeeping beads (slack/nudge/mail/session/convoy) are
  // excluded. This keeps the ready column/count mirroring the supervisor's
  // "Ready to Work" instead of inflating it with synthetic beads.
  const { data, loading, error, refresh } = useCachedData(
    'beads:all',
    () => api.listBeads(),
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Sessions back the board's bead -> live-run resolution.
  const sessions = useCachedData('sessions', () => api.listSessions());
  const sessionItems = useMemo(
    () => sessions.data?.items ?? [],
    [sessions.data],
  );

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

  useGcEventRefresh([GC_EVENT_PREFIX.bead], () => void refresh());

  // The board operates on the search/chip/label-filtered set, flattened
  // across project groups. The dependency graph (columns + needs/blocks
  // edges) is rebuilt from that set; edges pointing outside it render
  // unresolved rather than fabricated.
  const matched = useMemo(
    () => filters.groups.flatMap((g) => g.rows),
    [filters.groups],
  );
  const graph = useMemo(() => buildBeadGraph(matched), [matched]);
  // Bead ids per rig group, so each rig section renders its own slice of the
  // single shared graph (cross-rig edges stay resolved).
  const groupIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const g of filters.groups) {
      map.set(g.projectKey, new Set(g.rows.map((r) => r.id)));
    }
    return map;
  }, [filters.groups]);
  const selectedBead = useMemo(
    () => matched.find((b) => b.id === selectedId) ?? null,
    [matched, selectedId],
  );

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
        setActionResult(`${action} ${bead.id}: ${formatApiError(err, 'action failed')}`);
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
            <span className="text-label uppercase tracking-wider text-fg-faint">
              All statuses
            </span>
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

      {matched.length === 0 ? (
        <p className="text-body text-fg-muted italic">
          {filters.search.length > 0 || filters.activeChipIds.size > 0
            ? 'No beads match the current search or filter.'
            : labelFilter !== null
              ? `No beads match label "${labelFilter}".`
              : 'Nothing on the queue right now.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-x-10 gap-y-8">
          <div className="space-y-12">
            {filters.groups.map((g) => (
              <BeadBoardSection
                key={g.projectKey}
                label={g.project}
                count={g.totalInProject}
                graph={graph}
                ids={groupIds.get(g.projectKey) ?? EMPTY_IDS}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ))}
          </div>
          <div className="xl:sticky xl:top-6 xl:self-start">
            <BeadDetailRail
              beadId={selectedId}
              initialBead={selectedBead}
              sessions={sessionItems}
              onOpenBead={setSelectedId}
            />
          </div>
        </div>
      )}

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
