import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Bead } from 'gas-city-dashboard-shared/gc-supervisor';
import type { SupervisorBeadList } from './beadReads';
import { loadActiveConvoyRoots, loadConvoyView } from './convoyReads';

const GRAPH_V2_META = {
  'gc.formula_contract': 'graph.v2',
  'gc.routed_to': 'city/claude-1',
} as const;

const mockFetchSupervisorBead = vi.hoisted(() => vi.fn());
const mockListSupervisorBeads = vi.hoisted(() => vi.fn());
const mockFetchBeadSubtreeIds = vi.hoisted(() => vi.fn());

vi.mock('./beadReads', () => ({
  fetchSupervisorBead: mockFetchSupervisorBead,
  listSupervisorBeads: mockListSupervisorBeads,
  fetchBeadSubtreeIds: mockFetchBeadSubtreeIds,
}));

function bead(id: string, overrides: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `bead ${id}`,
    status: 'open',
    issue_type: 'task',
    priority: null,
    created_at: '2026-06-12T00:00:00Z',
    ...overrides,
  } as Bead;
}

function list(items: Bead[], extra: Partial<SupervisorBeadList> = {}): SupervisorBeadList {
  return {
    items,
    total: items.length,
    upstream_fetched: items.length,
    fetch_limit: 1000,
    partial: false,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadConvoyView', () => {
  it('derives the transitive parent-chain steps below the root and excludes the root', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root', { status: 'in_progress' }));
    mockListSupervisorBeads.mockResolvedValue(
      list([
        bead('root', { status: 'in_progress' }),
        bead('a', { parent: 'root', status: 'closed', created_at: '2026-06-12T00:00:01Z' }),
        bead('b', { parent: 'a', status: 'open', created_at: '2026-06-12T00:00:02Z' }),
        bead('unrelated', { parent: 'other', status: 'open' }),
      ]),
    );

    const load = await loadConvoyView('root');

    expect(load.view.rootBeadId).toBe('root');
    expect(load.view.exposure.kind).toBe('exposed');
    if (load.view.exposure.kind !== 'exposed') throw new Error('expected exposed');
    expect(load.view.exposure.steps.map((s) => s.bead.id)).toEqual(['a', 'b']);
    // Derived progress over the two descendants: one closed.
    expect(load.view.progress).toEqual({ closed: 1, total: 2 });
    expect(load.partial).toBe(false);
  });

  it('passes includeClosed + includeBookkeeping so closed/bookkeeping step beads are read', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root'));
    mockListSupervisorBeads.mockResolvedValue(list([bead('root')]));

    await loadConvoyView('root');

    expect(mockListSupervisorBeads).toHaveBeenCalledWith(
      expect.objectContaining({ includeClosed: true, includeBookkeeping: true }),
    );
  });

  it('collapses honestly to graph_v2_root_only for a graph.v2 root with no children', async () => {
    const root = bead('root', {
      status: 'in_progress',
      metadata: { 'gc.formula_contract': 'graph.v2', 'gc.run_target': 'city/claude-1' },
      title: 'mol-focus-review',
    });
    mockFetchSupervisorBead.mockResolvedValue(root);
    mockListSupervisorBeads.mockResolvedValue(list([root]));

    const load = await loadConvoyView('root');

    expect(load.view.exposure).toEqual({ kind: 'collapsed', reason: 'graph_v2_root_only' });
  });

  it('clears partial when the city page is complete without walking the subtree', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root'));
    mockListSupervisorBeads.mockResolvedValue(
      list([bead('root'), bead('a', { parent: 'root' })], { partial: false }),
    );

    const load = await loadConvoyView('root');

    expect(load.partial).toBe(false);
    // A complete city page already proves the subtree is whole; no scoped walk.
    expect(mockFetchBeadSubtreeIds).not.toHaveBeenCalled();
  });

  it('clears partial for a truncated page when the authoritative subtree is captured', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root', { status: 'in_progress' }));
    mockListSupervisorBeads.mockResolvedValue(
      list(
        [
          bead('root', { status: 'in_progress' }),
          bead('a', { parent: 'root', created_at: '2026-06-12T00:00:01Z' }),
          bead('b', { parent: 'a', created_at: '2026-06-12T00:00:02Z' }),
        ],
        { partial: true },
      ),
    );
    // The graph walk reports exactly the descendants the page already captured.
    mockFetchBeadSubtreeIds.mockResolvedValue(['a', 'b']);

    const load = await loadConvoyView('root');

    expect(mockFetchBeadSubtreeIds).toHaveBeenCalledWith('root');
    expect(load.partial).toBe(false);
  });

  it('keeps partial for a truncated page when the subtree holds an uncaptured descendant', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root', { status: 'in_progress' }));
    mockListSupervisorBeads.mockResolvedValue(
      list(
        [
          bead('root', { status: 'in_progress' }),
          bead('a', { parent: 'root', created_at: '2026-06-12T00:00:01Z' }),
        ],
        { partial: true },
      ),
    );
    // Authoritative walk surfaces a descendant 'c' the bounded page missed.
    mockFetchBeadSubtreeIds.mockResolvedValue(['a', 'c']);

    const load = await loadConvoyView('root');

    expect(load.partial).toBe(true);
  });

  it('does not walk the subtree for a graph.v2 root whose steps the page never carries', async () => {
    const root = bead('root', {
      status: 'in_progress',
      metadata: { 'gc.formula_contract': 'graph.v2', 'gc.run_target': 'city/claude-1' },
      title: 'mol-focus-review',
    });
    mockFetchSupervisorBead.mockResolvedValue(root);
    mockListSupervisorBeads.mockResolvedValue(list([root], { partial: true }));

    const load = await loadConvoyView('root');

    // graph.v2 steps live in the workflow snapshot, never the bead page, so a
    // truncated city page provably cannot hide them — no scoped walk, no warning.
    expect(load.partial).toBe(false);
    expect(mockFetchBeadSubtreeIds).not.toHaveBeenCalled();
  });

  it('stays conservative and logs when the subtree walk fails on a truncated page', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root'));
    mockListSupervisorBeads.mockResolvedValue(
      list([bead('root'), bead('a', { parent: 'root' })], { partial: true }),
    );
    mockFetchBeadSubtreeIds.mockRejectedValue(new Error('graph read failed'));
    // The failed refinement read degrades to over-warn rather than swallowing
    // the error — assert the warning so the global no-warn guard stays in force.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const load = await loadConvoyView('root');

    expect(load.partial).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subtree completeness check failed'));
    warn.mockRestore();
  });

  it('walks the subtree for a graph.v2 root once any parent-linked step is captured', async () => {
    // The graph_v2_root_only short-circuit fires ONLY when the captured child
    // set is empty (gascity-dashboard-3i31). A graph.v2 root that DOES expose a
    // parent-linked step is `exposed`, not collapsed, so it is not exempt from
    // the authoritative completeness walk — proving the short-circuit cannot
    // clear `partial` for a graph.v2 root whose steps the page actually carries.
    const root = bead('root', {
      status: 'in_progress',
      metadata: { 'gc.formula_contract': 'graph.v2', 'gc.run_target': 'city/claude-1' },
      title: 'mol-focus-review',
    });
    mockFetchSupervisorBead.mockResolvedValue(root);
    mockListSupervisorBeads.mockResolvedValue(
      list([root, bead('a', { parent: 'root', created_at: '2026-06-12T00:00:01Z' })], {
        partial: true,
      }),
    );
    // Authoritative walk surfaces a step 'c' the truncated page dropped.
    mockFetchBeadSubtreeIds.mockResolvedValue(['a', 'c']);

    const load = await loadConvoyView('root');

    expect(load.view.exposure.kind).toBe('exposed');
    expect(mockFetchBeadSubtreeIds).toHaveBeenCalledWith('root');
    expect(load.partial).toBe(true);
  });

  it('walks the subtree for a genuine no_children leaf on a truncated page', async () => {
    // A non-graph.v2 leaf collapses to `no_children`, NOT `graph_v2_root_only`,
    // so it is not short-circuited: a truncated page might be hiding children the
    // leaf actually has, so the authoritative walk must run and over-warn when it
    // surfaces an uncaptured descendant.
    mockFetchSupervisorBead.mockResolvedValue(bead('root'));
    mockListSupervisorBeads.mockResolvedValue(list([bead('root')], { partial: true }));
    mockFetchBeadSubtreeIds.mockResolvedValue(['hidden-child']);

    const load = await loadConvoyView('root');

    expect(load.view.exposure).toEqual({ kind: 'collapsed', reason: 'no_children' });
    expect(mockFetchBeadSubtreeIds).toHaveBeenCalledWith('root');
    expect(load.partial).toBe(true);
  });

  it('rejects an invalid root bead id at the loader boundary before any supervisor read', async () => {
    // The `/convoy/:rootBead` route param is untrusted input; a malformed id must
    // be turned away at the loader edge (as a 404 the route renders as not-found)
    // rather than reaching a supervisor path param (gascity-dashboard-3i31).
    await expect(loadConvoyView('../etc/passwd')).rejects.toMatchObject({
      name: 'SupervisorApiError',
      status: 404,
    });
    expect(mockFetchSupervisorBead).not.toHaveBeenCalled();
    expect(mockListSupervisorBeads).not.toHaveBeenCalled();
  });

  it('does not treat a self-parent bead as its own child', async () => {
    mockFetchSupervisorBead.mockResolvedValue(bead('root'));
    mockListSupervisorBeads.mockResolvedValue(list([bead('root', { parent: 'root' })]));

    const load = await loadConvoyView('root');

    expect(load.view.exposure).toEqual({ kind: 'collapsed', reason: 'no_children' });
  });
});

describe('loadActiveConvoyRoots', () => {
  it('keeps only in-flight graph.v2 run roots, sorted newest first', async () => {
    mockListSupervisorBeads.mockResolvedValue(
      list([
        bead('gc-old', {
          status: 'in_progress',
          metadata: { ...GRAPH_V2_META },
          created_at: '2026-06-12T00:00:00Z',
        }),
        bead('gc-new', {
          status: 'blocked',
          metadata: { ...GRAPH_V2_META },
          created_at: '2026-06-12T05:00:00Z',
        }),
        // Excluded: graph.v2 root but terminal (a finished convoy drops off).
        bead('gc-done', {
          status: 'closed',
          metadata: { ...GRAPH_V2_META },
          created_at: '2026-06-12T06:00:00Z',
        }),
        // Excluded: has the contract label but no run target (not a runnable root).
        bead('gc-no-target', {
          status: 'open',
          metadata: { 'gc.formula_contract': 'graph.v2' },
        }),
        // Excluded: an ordinary bead with no convoy contract at all.
        bead('gc-plain', { status: 'open' }),
      ]),
    );

    const { roots, partial } = await loadActiveConvoyRoots();

    expect(roots.map((r) => r.rootBeadId)).toEqual(['gc-new', 'gc-old']);
    expect(partial).toBe(false);
  });

  it('resolves the formula name + provenance from the root, falling back to the title', async () => {
    mockListSupervisorBeads.mockResolvedValue(
      list([
        bead('gc-explicit', {
          status: 'in_progress',
          metadata: { ...GRAPH_V2_META, 'gc.formula': 'mol-pr-iterate' },
        }),
        bead('gc-inferred', {
          title: 'mol-focus-review',
          status: 'in_progress',
          metadata: { ...GRAPH_V2_META },
        }),
      ]),
    );

    const { roots } = await loadActiveConvoyRoots();
    const byId = new Map(roots.map((r) => [r.rootBeadId, r]));
    expect(byId.get('gc-explicit')).toMatchObject({
      formulaName: 'mol-pr-iterate',
      formulaNameProvenance: 'metadata',
    });
    expect(byId.get('gc-inferred')).toMatchObject({
      formulaName: 'mol-focus-review',
      formulaNameProvenance: 'title_fallback',
    });
  });

  it('propagates the bounded-scan truncation flag so the page can warn', async () => {
    mockListSupervisorBeads.mockResolvedValue(
      list([bead('gc-1', { status: 'in_progress', metadata: { ...GRAPH_V2_META } })], {
        partial: true,
      }),
    );

    expect((await loadActiveConvoyRoots()).partial).toBe(true);
  });
});
