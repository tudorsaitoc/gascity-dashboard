// Maintainer (Triage) backend module — first-party, opt-in via
// MODULES_ENABLED in PR-C. Phase 1 PR-B1 ships the descriptor but
// app.ts continues to mount it explicitly; PR-B2 swaps to the registry
// iterator and deletes the explicit mount.
//
// Resources posture (premortem #5 + maintainer-coupling.md):
//   - filesystem 'cache' (perCity)       — the triage envelope cache.
//   - filesystem 'slung-state' (perCity) — the active-sling-state map.
//   - memory     'sse-clients' (perCity) — the in-process SSE registry
//     in ./sse.ts. Module-scoped Set is intentional (audit C1); the
//     `// module-allow` marker in sse.ts opts it out of the
//     no-module-singletons grep gate.
//
// `slungStatePath` is derived ONCE here from ctx.cityDataDir per audit
// C2 — the router and the worker both receive the SAME computed path so
// they cannot drift (the router's defaultSlungStatePath fallback was
// deleted in PR-B1).
//
// NOTE (PR-B1 scope): this descriptor is NOT yet added to ALL_MODULES.
// The explicit app.ts mount remains the live wiring. PR-B2 will:
//   (a) register this in views/registry.ts,
//   (b) delete the explicit app.ts maintainer mount + refresher start/stop,
//   (c) resolve audit C6 — `needs()` currently only sees
//       DashboardRuntimeConfig (the read-only view); the maintainer-prefixed
//       env values (cache path, refresh interval, sling/triage target) live
//       on AdminConfig. PR-B2 either widens the contract to pass AdminConfig
//       directly or introduces `AdminConfig.modules` per audit C6's
//       follow-up. Until then, this `needs()` returns the safe-default
//       shape; `mount`/`workers` derive paths from `ctx.cityDataDir`.

import path from 'node:path';
import type { BackendModule } from '../../types.js';
import { maintainerRouter } from './router.js';
import { createMaintainerRefresher } from './worker.js';
import { raceWithTimeout } from '../../../lib/race-with-timeout.js';

export interface MaintainerDeps {
  repo: string;
  slingTarget: string;
  triageTarget: string;
  refreshIntervalMs: number;
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
  // PR-B2 follow-up: when the contract widens to expose the maintainer-
  // prefixed AdminConfig fields (or migrates them under
  // `AdminConfig.modules` per audit C6), this returns the real env-derived
  // shape. For PR-B1 the descriptor is defensive-default so the type
  // is honest about what shared/DashboardRuntimeConfig actually exposes.
  needs: (config) => ({
    repo: config.githubRepo,
    slingTarget: 'mayor',
    triageTarget: 'mayor',
    refreshIntervalMs: 0,
  }),
  mount: (ctx, deps) => {
    const cachePath = path.join(ctx.cityDataDir, 'maintainer-cache.json');
    const slungStatePath = path.join(ctx.cityDataDir, 'slung-state.json');
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
  workers: (ctx, deps) =>
    deps.refreshIntervalMs > 0
      ? createMaintainerRefresher({
          repo: deps.repo,
          cachePath: path.join(ctx.cityDataDir, 'maintainer-cache.json'),
          slungStatePath: path.join(ctx.cityDataDir, 'slung-state.json'),
          intervalMs: deps.refreshIntervalMs,
        })
      : undefined,
};
