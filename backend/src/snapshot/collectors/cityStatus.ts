import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CityRig,
  CitySessionProvider,
  CityStatusSummary,
  GcSession,
  GcSessionList,
} from 'gas-city-dashboard-shared';
import { GcClient } from '../../gc-client.js';
import { SourceCache } from '../cache.js';

// City status collector — gascity-dashboard-8nj. Source of truth is
// GcClient.listSessions() over the supervisor's HTTP API; the demo-dash
// subprocess path (`gc status`, `bd list`) is deliberately not ported per
// gascity-dashboard-dkb Q1 (HTTP via GcClient is canonical).
//
// sessionsByProvider aggregation rule (gascity-dashboard-dkb Q4 + upstream
// issue gastownhall/gascity#2508): only count sessions where
// GcSession.provider is populated. Title-parsing as a fallback is
// intentionally NOT ported — that path is a ZFC violation (regex
// meaning-detection) and was rejected by the architecture review. Sessions
// without provider get silently undercounted until the upstream fix lands.

export const CITY_STATUS_CACHE_TTL_MS = 45 * 1000;

export interface CollectCityStatusOptions {
  /** Live upstream loader. Defaults to a GcClient.listSessions() call when gc is provided. */
  listSessions?: () => Promise<GcSessionList>;
  /** Absolute path to the city directory. Empty string = no city.toml read. */
  cityPath?: string;
  /** Optional override for the city.toml reader. Returns null when the file is missing. */
  readCityToml?: (cityPath: string) => Promise<CityTomlSummary | null>;
}

export interface CreateCityStatusSourceCacheOptions {
  gc: GcClient;
  cityPath?: string;
  now?: () => Date;
  loadFixture?: () => Promise<CityStatusSummary> | CityStatusSummary;
  useFixture?: boolean;
  /** Test seam: override the listSessions binding to avoid a real GcClient. */
  listSessions?: () => Promise<GcSessionList>;
  readCityToml?: (cityPath: string) => Promise<CityTomlSummary | null>;
}

export interface CityTomlSummary {
  maxSessions: number | null;
  rigs: CityRig[];
}

const ACTIVE_STATES = new Set<string>(['active', 'creating']);

export function createCityStatusSourceCache(
  options: CreateCityStatusSourceCacheOptions,
): SourceCache<CityStatusSummary> {
  const listSessions = options.listSessions ?? (() => options.gc.listSessions());
  const cityPath = options.cityPath ?? '';
  const readToml = options.readCityToml ?? defaultReadCityToml;

  return new SourceCache<CityStatusSummary>({
    source: 'city',
    ttlMs: CITY_STATUS_CACHE_TTL_MS,
    now: options.now,
    load: () =>
      collectCityStatus({
        listSessions,
        cityPath,
        readCityToml: readToml,
      }),
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
  const list = await options.listSessions?.();
  const sessions = list?.items ?? [];
  const cityPath = options.cityPath ?? '';
  const reader = options.readCityToml ?? defaultReadCityToml;
  const cityToml = cityPath ? await reader(cityPath) : null;

  const sessionsByProvider = aggregateSessionsByProvider(sessions);
  const activeSessions = countActiveSessions(sessions);

  return {
    activeAgents: countActiveAgents(sessions),
    totalAgents: sessions.length > 0 ? sessions.length : null,
    activeSessions,
    suspendedSessions: Math.max(0, sessions.length - activeSessions),
    maxSessions: cityToml?.maxSessions ?? null,
    sessionsByProvider,
    rigs: cityToml?.rigs ?? [],
  };
}

/**
 * Aggregate sessions into a per-provider active/total breakdown. Sessions
 * without GcSession.provider are EXCLUDED (no title-parsing fallback —
 * see gascity-dashboard-dkb Q4). Result is sorted by active desc, then
 * provider name asc for stable display.
 */
export function aggregateSessionsByProvider(
  sessions: ReadonlyArray<GcSession>,
): CitySessionProvider[] {
  const buckets = new Map<string, { active: number; total: number }>();

  for (const session of sessions) {
    const provider = session.provider;
    if (!provider) continue;

    const bucket = buckets.get(provider) ?? { active: 0, total: 0 };
    bucket.total += 1;
    if (isActive(session.state)) {
      bucket.active += 1;
    }
    buckets.set(provider, bucket);
  }

  return Array.from(buckets.entries())
    .map(([provider, counts]) => ({ provider, ...counts }))
    .sort((a, b) => b.active - a.active || a.provider.localeCompare(b.provider));
}

export function parseCityToml(content: string): CityTomlSummary {
  const rigs: CityRig[] = [];
  let maxSessions: number | null = null;
  let currentRig: Partial<CityRig> | null = null;

  const flushRig = (): void => {
    if (currentRig?.name) {
      rigs.push({
        name: currentRig.name,
        path: currentRig.path ?? currentRig.name,
      });
    }
    currentRig = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;

    if (line === '[[rigs]]') {
      flushRig();
      currentRig = {};
      continue;
    }
    if (line.startsWith('[') && line !== '[[rigs]]') {
      flushRig();
    }

    const maxMatch = line.match(/^max_active_sessions\s*=\s*(-?\d+)\s*$/);
    if (maxMatch && maxSessions === null) {
      maxSessions = Number(maxMatch[1]);
    }

    if (currentRig) {
      const name = quotedTomlValue(line, 'name');
      if (name) currentRig.name = name;
      const path = quotedTomlValue(line, 'path');
      if (path) currentRig.path = path;
    }
  }

  flushRig();
  return { maxSessions, rigs };
}

async function defaultReadCityToml(cityPath: string): Promise<CityTomlSummary | null> {
  try {
    const content = await readFile(join(cityPath, 'city.toml'), 'utf8');
    return parseCityToml(content);
  } catch {
    return null;
  }
}

function countActiveAgents(sessions: ReadonlyArray<GcSession>): number | null {
  if (sessions.length === 0) return null;
  return sessions.filter((s) => s.running === true || isActive(s.state)).length;
}

function countActiveSessions(sessions: ReadonlyArray<GcSession>): number {
  return sessions.filter((s) => isActive(s.state)).length;
}

function isActive(state: string): boolean {
  return ACTIVE_STATES.has(state);
}

/**
 * Extract a quoted TOML value for `key` from a single, already-trimmed line
 * of the form `key = "value"`. Returns the captured string, or null when
 * the line does not match.
 *
 * Exported only so the per-line parser is directly testable
 * (gascity-dashboard-ddz). Treats `key` as a literal string — no regex
 * metacharacter interpretation — so passing a key like `max.sessions`
 * matches only that exact key, not e.g. `maxXsessions`.
 *
 * Preserves the previous greedy "(.*)" behavior by using lastIndexOf('"')
 * for the closing quote, so values containing embedded escaped quotes are
 * captured up to the last quote on the line. This function does not
 * de-escape the value.
 */
export function quotedTomlValue(line: string, key: string): string | null {
  if (!line.startsWith(key)) return null;

  // Whitespace before '=' is allowed; anything else after the key means
  // this is a different identifier that merely shares the prefix
  // (e.g. 'nameX = ...' against key 'name').
  const afterKey = line.slice(key.length).trimStart();
  if (!afterKey.startsWith('=')) return null;

  const valuePart = afterKey.slice(1).trimStart();
  if (!valuePart.startsWith('"')) return null;

  const closingQuote = valuePart.lastIndexOf('"');
  // closingQuote === 0 → only the opening quote, no closing one.
  // closingQuote === 1 → `""` empty value — pin contract: return null rather
  // than '', so the exported API and parseCityToml's truthy check agree.
  if (closingQuote <= 1) return null;

  // The caller already trims the line, so trailing must be empty.
  if (valuePart.slice(closingQuote + 1).trim() !== '') return null;

  return valuePart.slice(1, closingQuote);
}
