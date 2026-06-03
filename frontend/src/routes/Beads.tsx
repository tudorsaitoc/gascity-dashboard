import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GC_EVENT_PREFIX } from 'gas-city-dashboard-shared';
import { formatApiError } from '../api/client';
import { useAttentionModel } from '../attention/context';
import {
  attentionRowProps,
  resourceAttentionSeverity,
} from '../attention/routeHighlight';
import { BeadBoardSection } from '../components/beads/BeadBoardSection';
import { BeadDetailRail } from '../components/beads/BeadDetailRail';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { Button } from '../components/Button';
import { FilterChips } from '../components/FilterChips';
import { GroupedTable } from '../components/GroupedTable';
import { ListSearchBar } from '../components/ListSearchBar';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { SortToggle } from '../components/SortToggle';
import { beadStatusTone, StatusBadge } from '../components/StatusBadge';
import { type TableColumn } from '../components/Table';
import { buildBeadGraph } from '../lib/beadGraph';
import { useCachedData } from '../hooks/useCachedData';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useListFilters, type FilterChip } from '../hooks/useListFilters';
import { beadProject } from '../hooks/projectOf';
import { formatDate } from '../lib/format';
import {
  listSupervisorBeads,
  type SupervisorBead,
} from '../supervisor/beadReads';
import { listSupervisorAgents } from '../supervisor/agentReads';
import {
  claimSupervisorBead,
  closeSupervisorBead,
  createAndSlingSupervisorBead,
  nudgeSupervisorAgent,
} from '../supervisor/beadWrites';
import { listSupervisorSessions } from '../supervisor/sessionReads';

type BeadView = 'board' | 'list';

const VIEW_OPTIONS: ReadonlyArray<{ id: BeadView; label: string }> = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
];

const EMPTY_IDS: ReadonlySet<string> = new Set();

const BEAD_CHIPS: ReadonlyArray<FilterChip<SupervisorBead>> = [
  { id: 'open', label: 'open', match: (b) => b.status === 'open' },
  { id: 'in_progress', label: 'in progress', match: (b) => b.status === 'in_progress' },
  { id: 'blocked', label: 'blocked', match: (b) => b.status === 'blocked' },
  { id: 'closed', label: 'closed', match: (b) => b.status === 'closed' },
];

const BEAD_SEARCH_FIELDS = (b: SupervisorBead): ReadonlyArray<string | undefined> => [
  b.id,
  b.title,
  b.assignee,
  ...(b.labels ?? []),
];

export function BeadsPage() {
  const attention = useAttentionModel();
  const [searchParams] = useSearchParams();
  const selectedBeadParam = normalizeSelectedBeadParam(searchParams.get('bead'));
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [rigFilter, setRigFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<BeadView>('board');
  // The board is a kanban: its in-progress / blocked / done columns are
  // empty under the open-only default, so Board implies "show all". List
  // keeps the manual toggle.
  const showAllEffective = view === 'board' || showAll;
  const { data, loading, error, refresh } = useCachedData(
    `${showAllEffective ? 'beads:all' : 'beads:open'}:rig:${rigFilter}`,
    () => listSupervisorBeads(showAllEffective, rigFilter),
  );
  const rows = useMemo(() => data?.items ?? [], [data]);
  const totalShown = data?.total ?? 0;
  const upstreamTotal = data?.upstream_total;
  const upstreamFetched = data?.upstream_fetched;
  const fetchLimit = data?.fetch_limit;

  const [closing, setClosing] = useState<SupervisorBead | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [actionInFlight, setActionInFlight] = useState<{ id: string; action: string } | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [viewing, setViewing] = useState<SupervisorBead | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedBeadParam);
  const [creating, setCreating] = useState(false);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newRig, setNewRig] = useState('');
  const [newAgent, setNewAgent] = useState('');

  // Sessions back the board's bead -> live-run resolution. Only the board
  // view reads them; the list view leaves the cache cold.
  const sessions = useCachedData('sessions', listSupervisorSessions);
  const sessionItems = useMemo(
    () => sessions.data?.items ?? [],
    [sessions.data],
  );
  const agents = useCachedData('agents', listSupervisorAgents);
  const agentItems = useMemo(
    () => agents.data?.items ?? [],
    [agents.data],
  );
  const rigOptions = useMemo(
    () => Array.from(
      new Set(agentItems.map((agent) => agent.rig).filter(isNonEmptyString)),
    ).sort((a, b) => a.localeCompare(b)),
    [agentItems],
  );
  const filteredAgents = useMemo(
    () => newRig.length === 0
      ? agentItems
      : agentItems.filter((agent) => agent.rig === newRig),
    [agentItems, newRig],
  );

  const filteredRows = useMemo(() => {
    if (labelFilter === null) return rows;
    return rows.filter((r) => Array.isArray(r.labels) && r.labels.includes(labelFilter));
  }, [rows, labelFilter]);

  const filters = useListFilters<SupervisorBead>({
    viewKey: 'beads',
    rows: filteredRows,
    projectOf: beadProject,
    searchOf: BEAD_SEARCH_FIELDS,
    chips: BEAD_CHIPS,
  });

  useGcEventRefresh([GC_EVENT_PREFIX.bead], () => void refresh());

  useEffect(() => {
    if (selectedBeadParam !== null) setSelectedId(selectedBeadParam);
  }, [selectedBeadParam]);

  // The board operates on the same search/chip/label-filtered set the list
  // does, flattened across project groups. The dependency graph (columns +
  // needs/blocks edges) is rebuilt from that set; edges pointing outside it
  // render unresolved rather than fabricated.
  const matched = useMemo(
    () => filters.groups.flatMap((g) => g.rows),
    [filters.groups],
  );
  const graph = useMemo(() => buildBeadGraph(matched), [matched]);
  const beadAttentionSeverity = useCallback(
    (beadId: string) => resourceAttentionSeverity(attention, 'beads', beadId),
    [attention],
  );
  const rowProps = useMemo(
    () => (bead: SupervisorBead) =>
      attentionRowProps(beadAttentionSeverity(bead.id)),
    [beadAttentionSeverity],
  );
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
      bead: SupervisorBead,
      action: 'claim' | 'close' | 'nudge',
      reason?: string,
    ): Promise<void> => {
      setActionInFlight({ id: bead.id, action });
      setActionResult(null);
      try {
        if (action === 'claim') await claimSupervisorBead(bead.id);
        else if (action === 'close') await closeSupervisorBead(bead.id, reason);
        else {
          const agentAlias = bead.assignee?.trim();
          if (!agentAlias) throw new Error('no assignee to nudge');
          await nudgeSupervisorAgent(agentAlias);
        }
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
  const openCreateBead = useCallback(() => {
    const defaultRig = rigOptions[0] ?? '';
    const defaultAgent = agentItems.find((agent) =>
      defaultRig.length === 0 || agent.rig === defaultRig,
    );
    setNewTitle('');
    setNewBody('');
    setNewRig(defaultRig);
    setNewAgent(defaultAgent?.name ?? '');
    setCreateError(null);
    setActionResult(null);
    setCreating(true);
  }, [agentItems, rigOptions]);
  const handleRigChange = useCallback(
    (rig: string) => {
      setNewRig(rig);
      if (
        newAgent.length > 0 &&
        !agentItems.some((agent) =>
          agent.name === newAgent && (rig.length === 0 || agent.rig === rig),
        )
      ) {
        setNewAgent('');
      }
    },
    [agentItems, newAgent],
  );
  const createAndSling = useCallback(async (): Promise<void> => {
    setCreateInFlight(true);
    setCreateError(null);
    setActionResult(null);
    try {
      const result = await createAndSlingSupervisorBead({
        title: newTitle,
        description: newBody,
        rig: newRig,
        target: newAgent,
      });
      setActionResult(`created and slung ${result.bead.id} to ${result.sling.target}`);
      setCreating(false);
      setNewTitle('');
      setNewBody('');
      setNewRig('');
      setNewAgent('');
      await refresh();
    } catch (err) {
      setCreateError(formatApiError(err, 'create and sling failed'));
    } finally {
      setCreateInFlight(false);
    }
  }, [newAgent, newBody, newRig, newTitle, refresh]);

  const synopsis = useMemo(
    () => buildSynopsis(filteredRows, totalShown, labelFilter, rigFilter),
    [filteredRows, totalShown, labelFilter, rigFilter],
  );

  const columns = useMemo<ReadonlyArray<TableColumn<SupervisorBead>>>(() => [
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
      // Sort null priority to the bottom (sentinel > any P-value the supervisor uses).
      sortValue: (r) => r.priority ?? Number.POSITIVE_INFINITY,
      render: (r) => (
        <span className={`tnum font-medium ${priorityColor(r.priority)}`}>
          {r.priority == null ? 'P—' : `P${r.priority}`}
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
      render: (r) => <StatusBadge tone={beadStatusTone(r.status)} label={r.status} />,
      className: 'w-32',
    },
    {
      // 6bv7 F16: OpenAPI Bead has no updated_at; the column reflects the
      // only timestamp the supervisor actually emits — created_at.
      key: 'created',
      label: 'Created',
      sortable: true,
      sortValue: (r) => r.created_at,
      render: (r) => (
        <span className="text-fg-muted tnum">{formatDate(r.created_at)}</span>
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
            {view === 'board' ? (
              <span className="text-label uppercase tracking-wider text-fg-faint">
                All statuses
              </span>
            ) : (
              <label className="flex items-baseline gap-2 text-label uppercase tracking-wider text-fg-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="accent-accent translate-y-0.5"
                />
                Show all
              </label>
            )}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
            <Button size="sm" onClick={openCreateBead}>
              New bead
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
        {rigFilter.length > 0 && (
          <p>
            Filtering by rig <span className="text-accent">{rigFilter}</span>.{' '}
            <button
              type="button"
              onClick={() => setRigFilter('')}
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
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
            <FilterChips
              chips={BEAD_CHIPS}
              activeIds={filters.activeChipIds}
              onToggle={filters.toggleChip}
              legend="Status"
            />
            <label className="flex items-baseline gap-2 text-label uppercase tracking-wider text-fg-muted">
              <span>Rig filter</span>
              <select
                aria-label="Rig filter"
                value={rigFilter}
                onChange={(e) => setRigFilter(e.target.value)}
                className="bg-transparent border border-rule rounded-sm px-2 py-1 text-label uppercase tracking-wider text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="">All rigs</option>
                {rigOptions.map((rig) => (
                  <option key={rig} value={rig}>
                    {rig}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <SortToggle<BeadView>
            value={view}
            options={VIEW_OPTIONS}
            onChange={setView}
            legend="View"
          />
        </div>
      </div>

      {view === 'board' ? (
        matched.length === 0 ? (
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
                  attentionSeverity={beadAttentionSeverity}
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
        )
      ) : (
        <GroupedTable
          groups={filters.groups}
          columns={columns}
          rowKey={(r) => r.id}
          onToggleProject={filters.toggleProject}
          rowProps={rowProps}
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
      )}

      <BeadDetailModal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        beadId={viewing?.id ?? null}
        initialBead={viewing}
      />

      <Modal
        open={creating}
        onClose={() => {
          if (!createInFlight) setCreating(false);
        }}
        title="New bead"
        widthClass="max-w-xl"
        footer={
          <>
            <Button
              tone="quiet"
              size="sm"
              disabled={createInFlight}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button
              tone="accent"
              size="sm"
              disabled={
                createInFlight ||
                newTitle.trim().length === 0 ||
                newAgent.trim().length === 0
              }
              onClick={() => void createAndSling()}
            >
              {createInFlight ? 'Creating' : 'Create and sling'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <p className="text-accent" role="alert">
              {createError}
            </p>
          )}
          {agents.error && (
            <p className="text-accent" role="alert">
              {agents.error}
            </p>
          )}
          <label className="block">
            <span className="text-label uppercase tracking-wider text-fg-muted">
              Title
            </span>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="mt-2 w-full bg-surface-tint border border-rule rounded-sm px-3 py-2 text-body text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </label>
          <label className="block">
            <span className="text-label uppercase tracking-wider text-fg-muted">
              Body
            </span>
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={5}
              className="mt-2 w-full bg-surface-tint border border-rule rounded-sm px-3 py-2 text-body text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 resize-y"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-label uppercase tracking-wider text-fg-muted">
                Rig
              </span>
              <select
                value={newRig}
                onChange={(e) => handleRigChange(e.target.value)}
                className="mt-2 w-full bg-surface-tint border border-rule rounded-sm px-3 py-2 text-body text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="">Any rig</option>
                {rigOptions.map((rig) => (
                  <option key={rig} value={rig}>
                    {rig}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-label uppercase tracking-wider text-fg-muted">
                Agent
              </span>
              <select
                value={newAgent}
                onChange={(e) => setNewAgent(e.target.value)}
                className="mt-2 w-full bg-surface-tint border border-rule rounded-sm px-3 py-2 text-body text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="">Choose agent</option>
                {filteredAgents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.display_name ?? agent.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </Modal>

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

function priorityColor(p: number | null | undefined): string {
  if (p === 0) return 'text-accent';
  if (p === 1) return 'text-warn';
  return 'text-fg-muted';
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeSelectedBeadParam(value: string | null): string | null {
  const clean = value?.trim();
  return clean && clean.length > 0 ? clean : null;
}

function buildSynopsis(
  filtered: ReadonlyArray<SupervisorBead>,
  totalShown: number,
  labelFilter: string | null,
  rigFilter: string,
): string {
  if (labelFilter !== null) {
    return `${filtered.length} matching "${labelFilter}".`;
  }
  if (rigFilter.length > 0 && filtered.length === 0) return `No beads on ${rigFilter}.`;
  const open = filtered.filter((b) => b.status === 'open').length;
  const inProgress = filtered.filter((b) => b.status === 'in_progress').length;
  const blocked = filtered.filter((b) => b.status === 'blocked').length;
  const parts: string[] = [];
  if (open > 0) parts.push(`${open} open`);
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (parts.length === 0) return 'Nothing on the queue.';
  let s = parts.join(', ') + '.';
  if (rigFilter.length > 0) s = `${rigFilter}: ${s}`;
  if (totalShown > filtered.length) s += ` Showing ${filtered.length} of ${totalShown}.`;
  return s;
}
