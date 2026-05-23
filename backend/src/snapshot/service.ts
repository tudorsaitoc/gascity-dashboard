import type {
  AimuxQuotaSummary,
  CityStatusSummary,
  DashboardHeadline,
  DashboardRuntimeConfig,
  DashboardSnapshot,
  DashboardSources,
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
import { fixtureSourceLoader } from './fixtures/loader.js';

// SnapshotService — gascity-dashboard-8nj. Composes the six SourceCaches
// behind one aggregate getSnapshot()/refresh() façade. Ported from
// demo-dash src/server/snapshot.ts; differences from the upstream port:
//   - Uses GcClient (HTTP) for city sessions, not the gc/bd subprocess
//     CLIs (dkb Q1 — HTTP is the canonical contract here).
//   - aimux/github/tokens caches are wired with throwing load() (their
//     collectors are deferred) — snapshot serves status='error' for those
//     three sources in v0. NOT a bug; the deferred contract is explicit.
//   - workflows is a STUB collector that returns a zeroed WorkflowSummary
//     until gascity-dashboard-0t6 (WorkflowMap port) lands.

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
  const caches = options.caches ?? buildDefaultCaches(options);

  let lastSnapshotAt: string | null = null;
  let lastSnapshotDurationMs: number | null = null;
  let lastRefreshAt: string | null = null;
  let lastRefreshDurationMs: number | null = null;

  const readSnapshot = async (
    refreshSources?: ReadonlySet<SourceName>,
  ): Promise<DashboardSnapshot> => {
    const startedAt = Date.now();
    const sources = await readSources(caches, refreshSources);
    const snapshot = buildSnapshot(options.config, sources, now());
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

function buildDefaultCaches(options: CreateSnapshotServiceOptions): SourceCacheMap {
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
    }),
    resources: createResourcesSourceCache({
      now,
      useFixture,
      loadFixture: useFixture ? fixtureSourceLoader('resources') : undefined,
    }),
    workflows: createWorkflowsSourceCache({
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
 */
function notWiredCache<T>(source: SourceName, now: (() => Date) | undefined): SourceCache<T> {
  return new SourceCache<T>({
    source,
    ttlMs: 30_000,
    now,
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
  const settle = async <T>(
    name: SourceName,
    cache: SourceCache<T>,
  ): Promise<SourceState<T>> => {
    try {
      return await pick(name, cache);
    } catch (error) {
      return {
        ...cache.snapshot(),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        data: null,
      };
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
