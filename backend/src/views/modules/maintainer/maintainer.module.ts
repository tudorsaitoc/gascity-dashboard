// Maintainer (Triage) backend module — first-party, opt-in via
// MODULES_ENABLED in PR-C. PR-B2 wires this into ALL_MODULES so the
// explicit app.ts mount + refresher are deleted.
//
// Resources posture (premortem #5 + specs/architecture/maintainer-coupling-audit.md):
//   - filesystem 'cache' (perCity)       — the triage envelope cache.
//   - filesystem 'slung-state' (perCity) — the active-sling-state map.
//   - memory     'sse-clients' (perCity) — the in-process SSE registry
//     in ./sse.ts. Module-scoped Set is intentional (audit C1); the
//     `// module-allow` marker in sse.ts opts it out of the
//     no-module-singletons grep gate.
//
// `slungStatePath` and `cachePath` are derived ONCE here per audit C2 —
// the router and the worker both receive the SAME computed paths so they
// cannot drift. Operators can pin the cache path via MAINTAINER_CACHE_PATH;
// when set, the descriptor honours the pin AND skips the legacy-path
// migration (operator location is sovereign).
//
// Multi-city note (gascity-dashboard-ucc): `cachePath` is process-global,
// but the maintainer's `cache` + `slung-state` resources are declared
// `perCity`. A bare pin would map EVERY city's runtime to the same two
// JSON files and clobber across cities. So when a pin is set, the pinned
// dir is treated as a per-city BASE: we join the CITY_NAME_RE-validated
// `ctx.cityName` segment under it, keeping the perCity contract intact.
// The cityName has already passed the dispatch-middleware guard, and we
// re-validate here defensively before it lands in a path.join.

import path from 'node:path';
import os from 'node:os';
import type { BackendModule, CityContext } from '../../types.js';
import { isValidCityName } from '../../../lib/cityName.js';
import { maintainerRouter } from './router.js';
import { createMaintainerRefresher } from './worker.js';
import { migrateLegacyMaintainerPaths } from './migrate-legacy-paths.js';

export interface MaintainerDeps {
  repo: string;
  refreshIntervalMs: number;
  /** Operator-pinned cache path. Undefined = use cityDataDir default. */
  cachePath?: string;
}

/**
 * Single source of truth for the on-disk locations the router and the
 * refresher must agree on. Previously `mount()` and `workers()` each
 * computed `path.join(ctx.cityDataDir, ...)` independently with matching
 * string literals; extracting to a helper guarantees they always resolve
 * identically.
 *
 * When `deps.cachePath` is set, the operator pin is treated as a per-city
 * BASE DIRECTORY (the file basename, if any, is discarded): both files
 * live under `<pinnedDir>/<cityName>/` so two cities sharing one process
 * resolve to DISTINCT paths and cannot clobber each other. The cityName is
 * re-validated against CITY_NAME_RE here before it enters path.join.
 */
export function maintainerPaths(ctx: CityContext, deps: MaintainerDeps): {
  cachePath: string;
  slungStatePath: string;
} {
  if (deps.cachePath !== undefined) {
    if (!isValidCityName(ctx.cityName)) {
      // Defensive: the dispatch middleware guards this before a runtime is
      // ever built, but a per-city path segment must NEVER be derived from
      // an unvalidated name. Fail loud rather than path.join a bad segment.
      throw new Error(
        `maintainer: refusing to derive a pinned per-city cache path for invalid cityName "${ctx.cityName}"`,
      );
    }
    const pinnedDir = pinnedBaseDir(deps.cachePath);
    const perCityDir = path.join(pinnedDir, ctx.cityName);
    return {
      cachePath: path.join(perCityDir, 'maintainer-cache.json'),
      slungStatePath: path.join(perCityDir, 'slung-state.json'),
    };
  }
  return {
    cachePath: path.join(ctx.cityDataDir, 'maintainer-cache.json'),
    slungStatePath: path.join(ctx.cityDataDir, 'slung-state.json'),
  };
}

/**
 * Resolve the operator pin to a base directory. A pin ending in `.json`
 * (the historic single-city contract) is read as a file and its dirname
 * is taken; any other value is treated as a directory verbatim. Either
 * way the per-city segment is joined under the result.
 */
function pinnedBaseDir(pin: string): string {
  return path.extname(pin) === '.json' ? path.dirname(pin) : pin;
}

/**
 * The legacy pre-modular files (`~/.gascity-dashboard/{maintainer-cache,
 * slung-state}.json`) belong to exactly ONE city — the legacy GC_CITY_NAME
 * carried on `config.cityName`. The migration may run only for that city,
 * and only when the operator has NOT pinned a cache path. Any other city
 * mounting first must NOT claim the legacy data (mis-attribution).
 */
export function shouldMigrateLegacyPaths(
  ctx: CityContext,
  deps: MaintainerDeps,
): boolean {
  return deps.cachePath === undefined && ctx.cityName === ctx.config.cityName;
}

/** Legacy pre-modular default location (before paths derived from cityDataDir). */
function legacyDefaultDir(): string {
  return path.join(os.homedir(), '.gascity-dashboard');
}

export const maintainerBackend: BackendModule<MaintainerDeps> = {
  id: 'maintainer',
  kind: 'firstParty',
  resources: {
    filesystem: [
      { name: 'cache', scope: 'perCity' },
      { name: 'slung-state', scope: 'perCity' },
    ],
    memory: [
      { name: 'sse-clients', scope: 'perCity' },
    ],
  },
  needs: (config) => {
    const slice = config.modules.maintainer;
    const deps: MaintainerDeps = {
      repo: slice.githubRepo,
      refreshIntervalMs: slice.refreshIntervalMs,
    };
    if (slice.cachePath !== undefined) {
      deps.cachePath = slice.cachePath;
    }
    return deps;
  },
  mount: (ctx, deps) => {
    const { cachePath, slungStatePath } = maintainerPaths(ctx, deps);
    // Path-drift migration (audit-C8, Option A): when the operator has NOT
    // pinned a cache path AND legacy files exist at the pre-modular default
    // (~/.gascity-dashboard/), move them into ctx.cityDataDir BEFORE the
    // router starts reading. Synchronous by design — see migrate-legacy-paths
    // header comment for why fire-and-forget was rejected (Phase-4 security
    // MEDIUM: race vs. concurrent router/worker writes).
    //
    // Multi-city gate (gascity-dashboard-ucc): the legacy files belong to
    // the single pre-modular city = the legacy GC_CITY_NAME (`config.cityName`).
    // Without this gate, the FIRST city to mount (whatever its name) would
    // renameSync the legacy data under its own cityDataDir — mis-attributing
    // another city's maintainer cache + slung-state. Only the legacy city may
    // claim them.
    if (shouldMigrateLegacyPaths(ctx, deps)) {
      migrateLegacyMaintainerPaths(legacyDefaultDir(), ctx.cityDataDir);
    }
    return maintainerRouter({
      repo: deps.repo,
      cachePath,
      slungStatePath,
    });
  },
  workers: (ctx, deps) => {
    if (deps.refreshIntervalMs <= 0) return undefined;
    const { cachePath, slungStatePath } = maintainerPaths(ctx, deps);
    return createMaintainerRefresher({
      repo: deps.repo,
      cachePath,
      slungStatePath,
      intervalMs: deps.refreshIntervalMs,
    });
  },
};
