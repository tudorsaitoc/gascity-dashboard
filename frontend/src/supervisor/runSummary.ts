import type {
  DashboardBead,
  DashboardSession,
  RunFeedScope,
  RunFeedScopeMap,
  RunSummary,
  SourceAvailableState,
  SourceState,
} from 'gas-city-dashboard-shared';
import {
  advanceProgressMarks,
  buildCensus,
  buildRunSummary,
  deriveRunHealth,
  fromFeedScope,
  fromDashboardBead,
  fromRootMetadataScope,
  fromStoreRef,
  isStaleSessionlessLatch,
  MAX_VISIBLE_ACTIVE_LANES,
  runBeadFilter,
  runCounts,
  type LaneProgressMark,
} from 'gas-city-dashboard-shared';
import { activeCityOrThrow } from '../api/cityBase';
import type { Bead, FormulaFeedBody } from 'gas-city-dashboard-shared/gc-supervisor';
import { supervisorApiForRequestBudget } from './client';
import { listIsIncomplete, listIsPartial } from './listPartial';
import { normalizeSessions } from './sessionReads';

// Pre-exposure load bound (gascity-dashboard-q89b): the primary in-flight
// bead fetch refreshes on SSE bursts (10s debounce floor in Runs.tsx) per
// client. listIsIncomplete keeps truncation visible in the lanes-partial signal.
const RUNS_FETCH_LIMIT = 500;
// gascity-dashboard-4xcv: the supervisor's bead list has no sort/recency
// guarantee, so a small `all=true` window can drop run roots and step beads
// arbitrarily — observed live as an empty first paint and a history list
// missing most completed runs (a busy rig store holds hundreds of closed
// task beads). 500 covers the largest observed store with headroom; if a
// store outgrows it the symptom returns as silently missing lanes, so a
// real fix beyond raising the cap means cursor pagination.
const RECENT_RUN_FETCH_LIMIT = 500;
const RUNS_STALE_AFTER_MS = 60 * 1000;
const REQUIRED_RUN_SUMMARY_TIMEOUT_MS = 5_000;
const OPTIONAL_ENRICHMENT_TIMEOUT_MS = 2_500;

interface LoadedRunBeads {
  beads: DashboardBead[];
  feedScopes: RunFeedScopeMap;
  partial: boolean;
}

type RecentFetchOutcome = { ok: true; items: DashboardBead[]; partial: boolean } | { ok: false };

type RunSessionsLookup =
  | { kind: 'available'; sessions: DashboardSession[] }
  | { kind: 'unavailable'; sessions: DashboardSession[] };

interface ProgressState {
  marks: Map<string, LaneProgressMark>;
  fetchedAt: string;
}

const progressStateByCity = new Map<string, ProgressState>();

export async function loadSupervisorRunSummarySource(): Promise<SourceState<RunSummary>> {
  const cityName = activeCityOrThrow('load supervisor run summary');
  const fetchedAt = new Date().toISOString();
  try {
    const [loaded, sessions] = await Promise.all([
      loadRunBeads(cityName, RUNS_FETCH_LIMIT),
      loadRunSessions(cityName),
    ]);
    const summary = buildRunSummary(
      loaded.beads.filter(runBeadFilter).map(fromDashboardBead),
      loaded.feedScopes,
      loaded.partial,
    );
    const source: SourceAvailableState<RunSummary> = {
      source: 'runs',
      status: 'fresh',
      fetchedAt,
      staleAt: new Date(Date.parse(fetchedAt) + RUNS_STALE_AFTER_MS).toISOString(),
      error: { kind: 'none' },
      data: summary,
    };
    return {
      ...source,
      data: enrichRunSummary(cityName, source, sessions),
    };
  } catch (err) {
    return {
      source: 'runs',
      status: 'error',
      error: errorMessage(err, 'formula runs unavailable'),
    };
  }
}

export async function loadSupervisorRunSummaryPreviewSource(): Promise<SourceState<RunSummary>> {
  const cityName = activeCityOrThrow('load supervisor run summary preview');
  const fetchedAt = new Date().toISOString();
  try {
    const loaded = await loadRunBeads(cityName, RUNS_FETCH_LIMIT);
    const summary = buildRunSummary(
      loaded.beads.filter(runBeadFilter).map(fromDashboardBead),
      loaded.feedScopes,
      loaded.partial,
    );
    return {
      source: 'runs',
      status: 'fresh',
      fetchedAt,
      staleAt: new Date(Date.parse(fetchedAt) + RUNS_STALE_AFTER_MS).toISOString(),
      error: { kind: 'none' },
      // First paint has no sessions yet, so no latch demotion — just apply the
      // visible cap that buildRunSummary now defers to its consumers (s4rp).
      data: { ...summary, lanes: summary.lanes.slice(0, MAX_VISIBLE_ACTIVE_LANES) },
    };
  } catch (err) {
    return {
      source: 'runs',
      status: 'error',
      error: errorMessage(err, 'formula runs unavailable'),
    };
  }
}

export function resetSupervisorRunSummaryStateForTests(): void {
  progressStateByCity.clear();
}

function requiredRunSummaryApi() {
  return supervisorApiForRequestBudget(REQUIRED_RUN_SUMMARY_TIMEOUT_MS);
}

function optionalRunSummaryApi() {
  return supervisorApiForRequestBudget(OPTIONAL_ENRICHMENT_TIMEOUT_MS);
}

async function loadRunBeads(cityName: string, limit: number): Promise<LoadedRunBeads> {
  const moleculeFetch = settledRecentFetch(cityName, {
    limit: RECENT_RUN_FETCH_LIMIT,
    type: 'molecule',
    all: true,
  });
  const [activeList, feedDiscovery] = await Promise.all([
    requiredRunSummaryApi().listBeads(cityName, { limit }),
    discoverFromFeed(cityName),
  ]);
  const active = normalizeBeads(activeList.items ?? []);
  const rigNames = unionRigNames(runRigNames(active), feedDiscovery.rigNames);

  const rigFetches = rigNames.map((rig) =>
    settledRecentFetch(cityName, {
      limit: RECENT_RUN_FETCH_LIMIT,
      type: 'task',
      rig,
      all: true,
    }),
  );

  const settled = await Promise.all([moleculeFetch, ...rigFetches]);
  const recentItems: DashboardBead[] = [];
  // Truncation at the bounded fetch reads as partial lanes, not complete
  // (gascity-dashboard-q89b).
  let partial = feedDiscovery.partial || listIsIncomplete(activeList, active.length);

  for (const outcome of settled) {
    if (outcome.ok) {
      recentItems.push(...outcome.items);
      partial ||= outcome.partial;
      continue;
    }
    partial = true;
  }

  return {
    beads: uniqueBeads([...active, ...recentItems]),
    feedScopes: feedDiscovery.scopes,
    partial,
  };
}

async function settledRecentFetch(
  cityName: string,
  query: { limit: number; type: string; all: true; rig?: string },
): Promise<RecentFetchOutcome> {
  try {
    const list = await withOptionalReadBudget(
      optionalRunSummaryApi().listBeads(cityName, query),
      `recent ${query.type} beads`,
    );
    return {
      ok: true,
      items: normalizeBeads(list.items ?? []),
      partial: listIsPartial(list),
    };
  } catch {
    return { ok: false };
  }
}

interface FeedDiscovery {
  rigNames: string[];
  scopes: RunFeedScopeMap;
  partial: boolean;
}

async function discoverFromFeed(cityName: string): Promise<FeedDiscovery> {
  try {
    const runs = await withOptionalReadBudget(
      optionalRunSummaryApi().formulaFeed(cityName, {
        scope_kind: 'city',
        scope_ref: cityName,
      }),
      'formula feed',
    );
    const rigNames = new Set<string>();
    const scopes = new Map<string, RunFeedScope>();
    for (const run of runs.items ?? []) {
      if (run.type !== 'formula') continue;
      const storeScope = fromStoreRef(run.root_store_ref ?? null);
      if (storeScope?.scopeKind === 'rig') {
        rigNames.add(storeScope.scopeRef);
      }
      const rootId = run.root_bead_id ?? run.workflow_id ?? null;
      const scope = fromFeedScope(run);
      if (rootId !== null && scope !== null) {
        scopes.set(rootId, {
          scopeKind: scope.scopeKind,
          scopeRef: scope.scopeRef,
          rootStoreRef: scope.rootStoreRef,
        });
      }
    }
    return { rigNames: [...rigNames], scopes, partial: feedIsPartial(runs) };
  } catch {
    return { rigNames: [], scopes: new Map(), partial: true };
  }
}

async function loadRunSessions(cityName: string): Promise<RunSessionsLookup> {
  try {
    const list = await withOptionalReadBudget(
      optionalRunSummaryApi().listSessions(cityName),
      'run sessions',
    );
    return {
      kind: 'available',
      sessions: normalizeSessions(list),
    };
  } catch {
    return { kind: 'unavailable', sessions: [] };
  }
}

function enrichRunSummary(
  cityName: string,
  source: SourceAvailableState<RunSummary>,
  sessionsLookup: RunSessionsLookup,
): RunSummary {
  // gascity-dashboard-4xcv: blocked lanes are enriched alongside active
  // ones so they carry derived health (needsOperator) for the attention
  // layer, then split back out — they are not part of the Active set.
  const inFlight = [...source.data.lanes, ...source.data.blockedLanes];
  const state = progressStateByCity.get(cityName);
  const generationMs = Date.parse(source.fetchedAt);
  let marks = state?.marks ?? new Map<string, LaneProgressMark>();
  if (state === undefined || generationMs > Date.parse(state.fetchedAt)) {
    marks = advanceProgressMarks(marks, inFlight);
    progressStateByCity.set(cityName, { marks, fetchedAt: source.fetchedAt });
  }

  const sessionsAvailable = sessionsLookup.kind === 'available';
  const { lanes } = deriveRunHealth({
    lanes: inFlight,
    sessions: sessionsLookup.sessions,
    sessionsAvailable,
    marks,
  });

  const blockedLanes = lanes.filter((lane) => lane.phase === 'blocked');
  const activeEnriched = lanes.filter((lane) => lane.phase !== 'blocked');

  // gascity-dashboard-s4rp: sessions only resolve here at enrichment, so this is
  // the earliest seam with enough information to demote stale session-less
  // latches (the gc-1920 phantom: no live session, no in_progress step, days
  // stale) out of the Active set. buildRunSummary hands us the FULL active set
  // (not the capped window), so totalActive is recomputed exactly from the
  // surviving lanes — a phantom past the 8th slot is demoted too. Staleness is
  // judged against the snapshot generation time, not a live clock, so the result
  // is stable for a snapshot.
  const liveActive = activeEnriched.filter(
    (lane) => !isStaleSessionlessLatch(lane, generationMs, sessionsAvailable),
  );
  const visibleActive = liveActive.slice(0, MAX_VISIBLE_ACTIVE_LANES);
  const census = buildCensus([...liveActive, ...blockedLanes]);

  return {
    ...source.data,
    totalActive: liveActive.length,
    lanes: visibleActive,
    blockedLanes,
    runCounts: runCounts(liveActive, visibleActive.length, blockedLanes.length),
    census: { status: 'available', data: census },
  };
}

function runRigNames(beads: readonly DashboardBead[]): string[] {
  const names = new Set<string>();
  for (const bead of beads) {
    const storeScope = fromStoreRef(bead.metadata?.['gc.root_store_ref']);
    if (storeScope?.scopeKind === 'rig') {
      names.add(storeScope.scopeRef);
      continue;
    }

    const metadataScope = fromRootMetadataScope(bead.metadata);
    if (metadataScope?.scopeKind === 'rig') {
      names.add(metadataScope.scopeRef);
    }
  }
  return Array.from(names).sort();
}

function unionRigNames(a: readonly string[], b: readonly string[]): string[] {
  const all = new Set<string>();
  for (const name of a) all.add(name);
  for (const name of b) all.add(name);
  return [...all];
}

function withOptionalReadBudget<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const budget = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${OPTIONAL_ENRICHMENT_TIMEOUT_MS}ms`));
    }, OPTIONAL_ENRICHMENT_TIMEOUT_MS);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeout !== null) clearTimeout(timeout);
    }),
    budget,
  ]);
}

function uniqueBeads(beads: readonly DashboardBead[]): DashboardBead[] {
  const byId = new Map<string, DashboardBead>();
  for (const bead of beads) {
    if (!byId.has(bead.id)) byId.set(bead.id, bead);
  }
  return Array.from(byId.values());
}

function normalizeBeads(beads: readonly Bead[]): DashboardBead[] {
  return beads.map(normalizeBead);
}

function normalizeBead(bead: Bead): DashboardBead {
  const normalized: DashboardBead = {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    issue_type: bead.issue_type,
    priority: bead.priority ?? null,
    created_at: bead.created_at,
  };
  if (bead.description !== undefined) normalized.description = bead.description;
  if (bead.assignee !== undefined) normalized.assignee = bead.assignee;
  if (Array.isArray(bead.labels)) normalized.labels = bead.labels;
  if (bead.metadata !== undefined) normalized.metadata = bead.metadata;
  if (bead.ref !== undefined) normalized.ref = bead.ref;
  if (bead.parent !== undefined) normalized.parent = bead.parent;
  if (bead.from !== undefined) normalized.from = bead.from;
  if (bead.ephemeral !== undefined) normalized.ephemeral = bead.ephemeral;
  if (bead.needs !== undefined) normalized.needs = bead.needs;
  if (bead.dependencies !== undefined) normalized.dependencies = bead.dependencies;
  if (bead.updated_at !== undefined) normalized.updated_at = bead.updated_at;
  return normalized;
}

function feedIsPartial(feed: FormulaFeedBody): boolean {
  return feed.partial === true || (feed.partial_errors?.length ?? 0) > 0;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim().length > 0 ? err.message : fallback;
}
