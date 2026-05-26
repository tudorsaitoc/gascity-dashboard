import type {
  AimuxQuotaSummary,
  CityStatusSummary,
  DashboardHeadline,
  DashboardRuntimeConfig,
  DashboardSnapshot,
  DashboardSources,
  GcSessionList,
  GitHubSummary,
  ResourceSummary,
  SourceName,
  SourceState,
  SourceStatus,
  TokenUsageSummary,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';

import type { GcClient } from '../gc-client.js';
import { SourceCache } from './cache.js';
import { createCityStatusSourceCache } from './collectors/cityStatus.js';
import { createResourcesSourceCache } from './collectors/resources.js';
import { createWorkflowsSourceCache } from './collectors/workflows.js';
import { fixtureSessions } from './fixtures/snapshot.js';
import { fixtureSourceLoader } from './fixtures/loader.js';
import {
  advanceProgressMarks,
  deriveWorkflowHealth,
  type LaneProgressMark,
} from './health.js';

/**
 * TTL for the shared sessions cache (gascity-dashboard-3ax). Matches the
 * city collector's 45s — the tighter of city(45s)/workflows(60s) — so the
 * bead×session join in the health engine never reads session liveness
 * staler than the city view already shows.
 */
export const SESSIONS_CACHE_TTL_MS = 45 * 1000;

// SnapshotService — gascity-dashboard-8nj. Composes the six SourceCaches
// behind one aggregate getSnapshot()/refresh() façade. Ported from
// demo-dash src/server/snapshot.ts; differences from the upstream port:
//   - Uses GcClient (HTTP) for city sessions, not the gc/bd subprocess
//     CLIs (dkb Q1 — HTTP is the canonical contract here).
//   - aimux/github/tokens caches are wired with throwing load() (their
//     collectors are deferred) — snapshot serves status='error' for those
//     three sources in v0. NOT a bug; the deferred contract is explicit.
//   - workflows runs the real lane builder (gascity-dashboard-0t6) over
//     gc.listBeads({ limit }) with the co-located workflowBeadFilter.

export const SOURCE_NAMES = [
  'aimux',
  'city',
  'resources',
  'workflows',
  'github',
  'tokens',
] as const satisfies readonly SourceName[];

export interface SourceCacheMap {
  aimux: SourceCache<AimuxQuotaSummary>;
  city: SourceCache<CityStatusSummary>;
  resources: SourceCache<ResourceSummary>;
  workflows: SourceCache<WorkflowSummary>;
  github: SourceCache<GitHubSummary>;
  tokens: SourceCache<TokenUsageSummary>;
}

export interface SnapshotHealth {
  ok: true;
  uptimeSeconds: number;
  lastSnapshotAt: string | null;
  lastSnapshotDurationMs: number | null;
  lastRefreshAt: string | null;
  lastRefreshDurationMs: number | null;
  sources: Record<SourceName, SourceStatus>;
}

export interface SnapshotService {
  getSnapshot: () => Promise<DashboardSnapshot>;
  refresh: (sources?: readonly SourceName[]) => Promise<DashboardSnapshot>;
  health: () => SnapshotHealth;
}

export interface CreateSnapshotServiceOptions {
  /** Shared GcClient instance — must NOT be re-instantiated per request. */
  gc?: GcClient;
  /** Pre-built cache map. Tests inject this directly for spy-tracked loaders. */
  caches?: SourceCacheMap;
  /**
   * Shared sessions cache (gascity-dashboard-3ax). Feeds BOTH the city
   * collector's listSessions seam and the workflow-health engine's
   * bead×session join, so one gc.listSessions() per TTL window backs both —
   * never a 2nd independent fetch (PRD R2). NOT a wire-shape source: raw
   * sessions stay off /api/snapshot (payload size). Tests may inject a
   * spy-tracked cache; otherwise built from `gc`.
   */
  sessions?: SourceCache<GcSessionList>;
  config: DashboardRuntimeConfig;
  /** Optional path to city.toml directory (for cityStatus collector). */
  cityPath?: string;
  now?: () => Date;
  uptimeSeconds?: () => number;
}

const sourceNameSet = new Set<string>(SOURCE_NAMES);

export function createSnapshotService(
  options: CreateSnapshotServiceOptions,
): SnapshotService {
  const now = options.now ?? (() => new Date());
  const startedAtMs = Date.now();
  const uptimeSeconds =
    options.uptimeSeconds ?? (() => Math.max(0, (Date.now() - startedAtMs) / 1000));
  // Sessions cache first — the city collector's seam reads from it, so it
  // must exist before buildDefaultCaches wires city.
  const sessionsCache = options.sessions ?? buildSessionsCache(options);
  const caches = options.caches ?? buildDefaultCaches(options, sessionsCache);

  // Cross-cycle progress marks for the monotonicity predicate (R1) +
  // hysteresis (R8). Ephemeral process state, NOT a persistence layer (R7):
  // it carries no historical baseline and resets on restart. Advanced ONLY
  // when the workflows cache produces a new generation (fetchedAt identity),
  // so concurrent GET/POST builds reading one frozen generation can't clobber
  // the streak (architect review §2A). The advance is synchronous, so each
  // build runs it atomically before yielding — this safety holds ONLY because
  // enrichWorkflows contains no `await`; do not introduce one inside it.
  let progressMarks = new Map<string, LaneProgressMark>();
  let marksFetchedAt: string | null = null;

  let lastSnapshotAt: string | null = null;
  let lastSnapshotDurationMs: number | null = null;
  let lastRefreshAt: string | null = null;
  let lastRefreshDurationMs: number | null = null;

  const enrichWorkflows = (
    sources: DashboardSources,
    sessionsState: SourceState<GcSessionList>,
  ): DashboardSources => {
    const wf = sources.workflows;
    if (wf.data === null) return sources;

    // A sessions read failure degrades confidence (all lanes inferred, no
    // maroon — R2 fail-safe); it never blanks the lanes. Only advance the
    // monotonicity marks on a genuine new workflows generation.
    if (wf.fetchedAt !== marksFetchedAt) {
      progressMarks = advanceProgressMarks(progressMarks, wf.data.lanes);
      marksFetchedAt = wf.fetchedAt;
    }

    const { lanes, census } = deriveWorkflowHealth({
      lanes: wf.data.lanes,
      sessions: sessionsState.data?.items ?? [],
      sessionsAvailable: sessionsState.data !== null,
      marks: progressMarks,
    });

    return {
      ...sources,
      workflows: { ...wf, data: { ...wf.data, lanes, census } },
    };
  };

  const readSnapshot = async (
    refreshSources?: ReadonlySet<SourceName>,
  ): Promise<DashboardSnapshot> => {
    const startedAt = Date.now();
    // Read sessions in the SAME mode as workflows so the bead×session join
    // samples one instant — a TTL desync would cross two clocks (R2).
    const [sources, sessionsState] = await Promise.all([
      readSources(caches, refreshSources),
      readSessions(sessionsCache, refreshSources),
    ]);
    const snapshot = buildSnapshot(
      options.config,
      enrichWorkflows(sources, sessionsState),
      now(),
    );
    const durationMs = Date.now() - startedAt;

    lastSnapshotAt = snapshot.generatedAt;
    lastSnapshotDurationMs = durationMs;
    if (refreshSources !== undefined) {
      lastRefreshAt = snapshot.generatedAt;
      lastRefreshDurationMs = durationMs;
    }

    return snapshot;
  };

  return {
    getSnapshot: () => readSnapshot(),
    refresh: (sources) => {
      const selected =
        sources && sources.length > 0
          ? SOURCE_NAMES.filter((name) => sources.includes(name))
          : SOURCE_NAMES;
      return readSnapshot(new Set(selected));
    },
    health: () => ({
      ok: true,
      uptimeSeconds: uptimeSeconds(),
      lastSnapshotAt,
      lastSnapshotDurationMs,
      lastRefreshAt,
      lastRefreshDurationMs,
      sources: sourceStatuses(caches),
    }),
  };
}

export function isSourceName(value: unknown): value is SourceName {
  return typeof value === 'string' && sourceNameSet.has(value);
}

export function buildSnapshot(
  config: DashboardRuntimeConfig,
  sources: DashboardSources,
  generatedAt: Date,
): DashboardSnapshot {
  return {
    generatedAt: generatedAt.toISOString(),
    config,
    headline: buildHeadline(sources),
    sources,
  };
}

/**
 * Shared sessions cache (gascity-dashboard-3ax). Labeled with the 'city'
 * SourceName because it IS the city's session list — but it is held privately
 * by the service and never placed in DashboardSources, so raw sessions stay
 * off the /api/snapshot wire. sanitizeErrorMessage:null mirrors the city/
 * workflows posture: GcClient already throws operator-safe messages.
 *
 * Without a live `gc` (test injection of `caches` only), returns an
 * empty-sessions cache so the health engine degrades every lane to
 * unresolved/inferred — the same fail-safe as a live sessions failure.
 */
function buildSessionsCache(options: CreateSnapshotServiceOptions): SourceCache<GcSessionList> {
  const { gc, now } = options;
  const useFixture = options.config.useFixtures;

  if (!gc) {
    return new SourceCache<GcSessionList>({
      source: 'city',
      ttlMs: SESSIONS_CACHE_TTL_MS,
      now,
      sanitizeErrorMessage: null,
      load: () => ({ items: [] }),
    });
  }

  return new SourceCache<GcSessionList>({
    source: 'city',
    ttlMs: SESSIONS_CACHE_TTL_MS,
    now,
    sanitizeErrorMessage: null,
    load: () => gc.listSessions(),
    useFixture,
    loadFixture: useFixture ? () => fixtureSessions : undefined,
  });
}

function buildDefaultCaches(
  options: CreateSnapshotServiceOptions,
  sessionsCache: SourceCache<GcSessionList>,
): SourceCacheMap {
  if (!options.gc) {
    throw new Error(
      'createSnapshotService requires either { gc } (to build default caches) or { caches } (pre-built).',
    );
  }
  const { gc, config, cityPath, now } = options;
  const useFixture = config.useFixtures;

  return {
    // aimux/github/tokens: deferred collectors (dkb Q2 pending). The
    // throwing load() materializes as status='error' in the snapshot —
    // the only correct shape until their endpoints / subprocess
    // wrappers land. NO fixture binding either — fixtureSourceLoader
    // would throw on these per loader.ts's null-data guard.
    aimux: notWiredCache<AimuxQuotaSummary>('aimux', now),
    city: createCityStatusSourceCache({
      gc,
      cityPath: cityPath ?? '',
      now,
      useFixture,
      loadFixture: useFixture ? fixtureSourceLoader('city') : undefined,
      // Read sessions from the shared cache (gascity-dashboard-3ax) instead
      // of calling gc.listSessions() directly, so the city aggregate and the
      // workflow-health join share ONE underlying fetch per TTL window (R2).
      // Throw on a sessions failure so the city source surfaces status='error'
      // exactly as it did when it owned the fetch — preserving failure
      // isolation rather than silently aggregating an empty list.
      listSessions: async () => {
        const state = await sessionsCache.get();
        if (state.data === null) {
          throw new Error(state.error ?? 'sessions unavailable');
        }
        return state.data;
      },
    }),
    resources: createResourcesSourceCache({
      now,
      useFixture,
      loadFixture: useFixture ? fixtureSourceLoader('resources') : undefined,
    }),
    workflows: createWorkflowsSourceCache({
      gc,
      now,
      useFixture,
      loadFixture: useFixture ? fixtureSourceLoader('workflows') : undefined,
    }),
    github: notWiredCache<GitHubSummary>('github', now),
    tokens: notWiredCache<TokenUsageSummary>('tokens', now),
  };
}

/**
 * SourceCache for sources whose collectors are deferred (aimux, github,
 * tokens — dkb Q2 pending). Load throws so the snapshot envelope carries
 * status='error' for those sources. Tests cover the deferred shape in
 * snapshot-route.test.ts via the same constructor pattern.
 *
 * Opts out of the default-on sanitizer (gascity-dashboard-4r5) via
 * `sanitizeErrorMessage: null`: the thrown message is a hand-authored
 * string with no OS-path or secret material, and preserving the literal
 * "${source} collector not wired (gascity-dashboard-37u, dkb Q2
 * pending)" gives the operator a bead-id breadcrumb in the wire error
 * instead of a generic "${source} collection failed".
 */
function notWiredCache<T>(source: SourceName, now: (() => Date) | undefined): SourceCache<T> {
  return new SourceCache<T>({
    source,
    ttlMs: 30_000,
    now,
    sanitizeErrorMessage: null,
    load: () => {
      throw new Error(`${source} collector not wired (gascity-dashboard-37u, dkb Q2 pending)`);
    },
  });
}

async function readSources(
  caches: SourceCacheMap,
  refreshSources?: ReadonlySet<SourceName>,
): Promise<DashboardSources> {
  // Three call modes per source:
  //   - refreshSources includes it → cache.refresh() (force re-fetch)
  //   - refreshSources is set but excludes it → cache.snapshot() (read-only)
  //   - refreshSources is undefined → cache.get() (normal TTL-driven path)
  const useSnapshotOnly = refreshSources !== undefined;
  const pick = <T>(name: SourceName, cache: SourceCache<T>) => {
    if (refreshSources?.has(name)) return cache.refresh();
    if (useSnapshotOnly) return Promise.resolve(cache.snapshot());
    return cache.get();
  };

  // settle wraps pick() so a rejection from any single cache becomes a
  // wire-shape SourceState envelope with status='error' instead of
  // propagating. This is the snapshot route's failure-isolation
  // guarantee, owned at the composition layer rather than SourceCache's
  // internal try/catch. If a future collector wrapper escapes the
  // cache's catch (sync throw before refreshUnshared's try, returned
  // rejected promise, etc.), the dashboard still serves a partial
  // envelope — never 500s the whole route. Regression-guarded by
  // backend/test/snapshot-failure-isolation.test.ts (gascity-dashboard-9tv).
  //
  // The caught error is routed through cache.sanitize() before landing
  // on the wire: the very scenario this wrapper protects against (an
  // escape from refreshUnshared's internal catch) is also the scenario
  // where SourceCache.sanitize never ran. Without delegating here, the
  // settle wrapper would silently leak the raw error.message — defeating
  // the default-on sanitization contract added in gascity-dashboard-4r5.
  const settle = async <T>(
    name: SourceName,
    cache: SourceCache<T>,
  ): Promise<SourceState<T>> => {
    try {
      return await pick(name, cache);
    } catch (error) {
      return errorState(cache, error);
    }
  };

  const [aimux, city, resources, workflows, github, tokens] = await Promise.all([
    settle('aimux', caches.aimux),
    settle('city', caches.city),
    settle('resources', caches.resources),
    settle('workflows', caches.workflows),
    settle('github', caches.github),
    settle('tokens', caches.tokens),
  ]);

  return { aimux, city, resources, workflows, github, tokens };
}

/**
 * Read the shared sessions cache in the SAME mode the workflows source is
 * read (gascity-dashboard-3ax), so the bead×session join samples one instant:
 *   - normal GET (refreshSources undefined) → get() (TTL-driven)
 *   - POST /refresh including 'workflows' → refresh() (force same-instant)
 *   - POST /refresh excluding 'workflows' → snapshot() (read-only)
 * A failure surfaces as a SourceState with data:null; the health engine then
 * degrades every lane to unresolved/inferred (R2 fail-safe) — it never throws
 * here, so a sessions outage can't 500 the snapshot.
 */
async function readSessions(
  cache: SourceCache<GcSessionList>,
  refreshSources?: ReadonlySet<SourceName>,
): Promise<SourceState<GcSessionList>> {
  try {
    if (refreshSources === undefined) return await cache.get();
    if (refreshSources.has('workflows')) return await cache.refresh();
    return cache.snapshot();
  } catch (error) {
    return errorState(cache, error);
  }
}

/**
 * Wire-shape failure envelope shared by readSources' settle wrapper and
 * readSessions: a thrown error becomes a SourceState with status='error',
 * data:null, and the message routed through cache.sanitize() (so the escape
 * scenarios these wrappers guard against still get the default-on
 * sanitization from gascity-dashboard-4r5).
 */
function errorState<T>(cache: SourceCache<T>, error: unknown): SourceState<T> {
  return {
    ...cache.snapshot(),
    status: 'error',
    error: cache.sanitize(error),
    data: null,
  };
}

function buildHeadline(sources: DashboardSources): DashboardHeadline {
  return {
    activeAgents: sources.city.data?.activeAgents ?? null,
    maxAgents: sources.city.data?.maxSessions ?? null,
    activeSessions: sources.city.data?.activeSessions ?? null,
    activeWorkflows:
      sources.workflows.data?.runCounts.total ?? sources.workflows.data?.totalActive ?? null,
    githubOpenReviews: sources.github.data?.openReviewDemand ?? null,
  };
}

function sourceStatuses(caches: SourceCacheMap): Record<SourceName, SourceStatus> {
  return {
    aimux: caches.aimux.snapshot().status,
    city: caches.city.snapshot().status,
    resources: caches.resources.snapshot().status,
    workflows: caches.workflows.snapshot().status,
    github: caches.github.snapshot().status,
    tokens: caches.tokens.snapshot().status,
  };
}
