// Maintainer (Triage) backend module — first-party, opt-in via
// MODULES_ENABLED in PR-C. PR-B2 wires this into ALL_MODULES so the
// explicit app.ts mount + refresher are deleted.
//
// Resources posture (premortem #5 + maintainer-coupling.md):
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

import path from 'node:path';
import os from 'node:os';
import type { BackendModule, CityContext } from '../../types.js';
import { maintainerRouter } from './router.js';
import { createMaintainerRefresher } from './worker.js';
import { migrateLegacyMaintainerPaths } from './migrate-legacy-paths.js';
import { raceWithTimeout } from '../../../lib/race-with-timeout.js';

export interface MaintainerDeps {
  repo: string;
  slingTarget: string;
  triageTarget: string;
  refreshIntervalMs: number;
  /** Operator-pinned cache path. Undefined = use cityDataDir default. */
  cachePath?: string;
}

/**
 * Single source of truth for the on-disk locations the router and the
 * refresher must agree on. Previously `mount()` and `workers()` each
 * computed `path.join(ctx.cityDataDir, ...)` independently with matching
 * string literals; extracting to a helper guarantees they always resolve
 * identically. When `deps.cachePath` is set, the cache file location is
 * operator-pinned and slung-state sits next to it.
 */
function maintainerPaths(ctx: CityContext, deps: MaintainerDeps): {
  cachePath: string;
  slungStatePath: string;
} {
  if (deps.cachePath !== undefined) {
    return {
      cachePath: deps.cachePath,
      slungStatePath: path.join(path.dirname(deps.cachePath), 'slung-state.json'),
    };
  }
  return {
    cachePath: path.join(ctx.cityDataDir, 'maintainer-cache.json'),
    slungStatePath: path.join(ctx.cityDataDir, 'slung-state.json'),
  };
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
      slingTarget: slice.slingTarget,
      triageTarget: slice.triageTarget,
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
    if (deps.cachePath === undefined) {
      migrateLegacyMaintainerPaths(legacyDefaultDir(), ctx.cityDataDir);
    }
    return maintainerRouter({
      repo: deps.repo,
      cachePath,
      slungStatePath,
      slingTarget: deps.slingTarget,
      triageTarget: deps.triageTarget,
      sling: (input) => ctx.gc.sling(input),
      listSessions: async () => {
        const { items } = await raceWithTimeout(ctx.gc.listSessions(), 3_000);
        return items;
      },
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
