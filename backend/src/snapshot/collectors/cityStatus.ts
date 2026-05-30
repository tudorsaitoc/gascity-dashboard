import type {
  CitySessionProvider,
  CityStatusSummary,
  DashboardMetric,
  GcRigList,
  GcSession,
  GcSessionList,
} from 'gas-city-dashboard-shared';
import { type GcClient } from '../../gc-client.js';
import { LOG_COMPONENT, logWarn, sanitizeForLog } from '../../logging.js';
import { SourceCache } from '../cache.js';

// City status collector — gascity-dashboard-8nj + gascity-dashboard-19w.
// Source of truth for sessions is GcClient.listSessions(); rigs come from
// GcClient.listRigs() (the supervisor's `GET /v0/city/{name}/rigs` HTTP
// API). The legacy on-disk city.toml parse + the host-can-see-city-dir
// assumption are gone (gascity-dashboard-19w). The demo-dash subprocess
// path (`gc status`, `bd list`) is deliberately not ported per
// gascity-dashboard-dkb Q1 (HTTP via GcClient is canonical).
//
// sessionsByProvider aggregation rule (gascity-dashboard-dkb Q4 + upstream
// issue gastownhall/gascity#2508): only count sessions where
// GcSession.provider is populated. Title-parsing as a fallback is
// intentionally NOT ported — that path is a ZFC violation (regex
// meaning-detection) and was rejected by the architecture review. Sessions
// without provider get silently undercounted until the upstream fix lands.
//
// maxSessions degradation (gascity-dashboard-19w): the supervisor's HTTP
// API does NOT expose city-level max_active_sessions today. Verified
// upstream in gastownhall/gascity@main:
//   - internal/api/handler_status.go StatusBody construction omits it.
//   - internal/api/handler_config.go workspaceResponse omits it.
//   - The `MaxActiveSessions` references inside handler_status.go's
//     poolScaleLabel helper render a per-agent string only.
// We therefore surface maxSessions as permanently 'unavailable' until
// upstream exposes it (tracked for a follow-up bead). Frontend
// already handles the unavailable case (AmbientHome, Workflows).

export const CITY_STATUS_CACHE_TTL_MS = 45 * 1000;

const MAX_SESSIONS_UNAVAILABLE_REASON =
  'supervisor HTTP API does not expose city-level max_active_sessions';

export interface CollectCityStatusOptions {
  /** Live upstream loader for sessions. */
  listSessions: () => Promise<GcSessionList>;
  /** Live upstream loader for rigs. */
  listRigs: () => Promise<GcRigList>;
}

export interface CreateCityStatusSourceCacheOptions {
  gc: GcClient;
  now?: (() => Date) | undefined;
  loadFixture?: (() => Promise<CityStatusSummary> | CityStatusSummary) | undefined;
  useFixture?: boolean | undefined;
  /** Test seam: override the listSessions binding to avoid a real GcClient. */
  listSessions?: (() => Promise<GcSessionList>) | undefined;
  /** Test seam: override the listRigs binding to avoid a real GcClient. */
  listRigs?: (() => Promise<GcRigList>) | undefined;
}

const ACTIVE_STATES = new Set<string>(['active', 'creating']);

export function createCityStatusSourceCache(
  options: CreateCityStatusSourceCacheOptions,
): SourceCache<CityStatusSummary> {
  const listSessions = options.listSessions ?? (() => options.gc.listSessions());
  const listRigs = options.listRigs ?? (() => options.gc.listRigs());

  return new SourceCache<CityStatusSummary>({
    source: 'city',
    ttlMs: CITY_STATUS_CACHE_TTL_MS,
    now: options.now,
    load: () => collectCityStatus({ listSessions, listRigs }),
    loadFixture: options.loadFixture,
    useFixture: options.useFixture,
    // gascity-dashboard-4r5: opt out of default-on sanitization.
    // GcClient already throws sanitized messages
    // (`gc supervisor returned ${status}`, `connection refused`, etc.)
    // with no OS paths, so the operator benefits from seeing the
    // actual upstream failure reason in the wire shape.
    sanitizeErrorMessage: null,
  });
}

export async function collectCityStatus(
  options: CollectCityStatusOptions,
): Promise<CityStatusSummary> {
  // Fetch sessions and rigs in parallel. Both throws propagate; the
  // SourceCache surfaces them as the city source's status='error',
  // preserving failure isolation per the snapshot service contract.
  // We do NOT catch-and-empty here — silently aggregating an empty
  // rigs list would mask an upstream rigs-route outage.
  const [sessionList, rigList] = await Promise.all([
    options.listSessions(),
    options.listRigs(),
  ]);

  const sessions = sessionList.items;
  const sessionsByProvider = aggregateSessionsByProvider(sessions);
  const activeSessions = countActiveSessions(sessions);

  // gascity-dashboard-19w.1: supervisor-reported wire-partial on a 200
  // response (one or more rig backends failed during aggregation) is a
  // degradation signal, not an outage — propagate it so the operator
  // sees "rigs degraded" rather than an apparent "no rigs configured."
  // Mirrors the convention in backend/src/routes/links.ts and
  // routes/mail.ts. Per CLAUDE.md "Don't Swallow Errors".
  const rigsPartial =
    rigList.partial === true || (rigList.partial_errors?.length ?? 0) > 0;
  if (rigsPartial) {
    const detail = rigList.partial_errors && rigList.partial_errors.length > 0
      ? rigList.partial_errors.map(sanitizeForLog).join(', ')
      : 'no detail';
    logWarn(
      LOG_COMPONENT.snapshot,
      `supervisor reported partial rig list (${detail}); rigs degraded`,
    );
  }

  const summary: CityStatusSummary = {
    activeAgents: countActiveAgents(sessions),
    totalAgents: sessions.length,
    activeSessions,
    suspendedSessions: Math.max(0, sessions.length - activeSessions),
    maxSessions: unavailableCityMetric(MAX_SESSIONS_UNAVAILABLE_REASON),
    sessionsByProvider,
    // gascity-dashboard-19w.2: inline projection (no toCityRig delegate).
    // GcRig and CityRig are structurally equivalent today; the explicit
    // {name, path} pick keeps the field-strip in place so a future upstream
    // widening of GcRig (agent_count, running_count, etc.) does not silently
    // leak into the CityStatusSummary wire shape.
    rigs: rigList.items.map(({ name, path }) => ({ name, path })),
  };
  if (rigsPartial) {
    summary.rigsPartial = true;
  }
  return summary;
}

/**
 * Aggregate sessions into a per-provider active/total breakdown. Sessions
 * without GcSession.provider are EXCLUDED (no title-parsing fallback —
 * see gascity-dashboard-dkb Q4). Result is sorted by active desc, then
 * provider name asc for stable display.
 *
 * gascity-dashboard-6bv7.2: empty-string providers are still skipped
 * (the wire contract is `string`, not "non-empty string", so a degenerate
 * supervisor sending `provider: ""` for all sessions would otherwise
 * silently produce zero buckets). The skip is no longer silent — a single
 * warn is emitted per call with the count when any are dropped. Per-call
 * (not per-session) keeps the log volume bounded by the SourceCache TTL
 * (~45s) instead of scaling with session count.
 */
export function aggregateSessionsByProvider(
  sessions: ReadonlyArray<GcSession>,
): CitySessionProvider[] {
  const buckets = new Map<string, { active: number; total: number }>();
  let emptyProviderCount = 0;

  for (const session of sessions) {
    const provider = session.provider;
    if (!provider) {
      emptyProviderCount += 1;
      continue;
    }

    const bucket = buckets.get(provider) ?? { active: 0, total: 0 };
    bucket.total += 1;
    if (isActive(session.state)) {
      bucket.active += 1;
    }
    buckets.set(provider, bucket);
  }

  if (emptyProviderCount > 0) {
    logWarn(
      LOG_COMPONENT.snapshot,
      `aggregateSessionsByProvider: ${emptyProviderCount} sessions skipped due to empty provider`,
    );
  }

  return Array.from(buckets.entries())
    .map(([provider, counts]) => ({ provider, ...counts }))
    .sort((a, b) => b.active - a.active || a.provider.localeCompare(b.provider));
}

function countActiveAgents(sessions: ReadonlyArray<GcSession>): number {
  return sessions.filter((s) => s.running === true || isActive(s.state)).length;
}

function countActiveSessions(sessions: ReadonlyArray<GcSession>): number {
  return sessions.filter((s) => isActive(s.state)).length;
}

function isActive(state: string): boolean {
  return ACTIVE_STATES.has(state);
}

function unavailableCityMetric(error: string): DashboardMetric {
  return { status: 'unavailable', source: 'city', error };
}
