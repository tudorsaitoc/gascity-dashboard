// Backend-side narrowing of the shared/views.ts contract. `shared/` cannot
// import express or the concrete GcClient, so this file:
//   1. Re-exports the shared types as type-only.
//   2. Provides backend-narrowed aliases pinning the generics to express
//      Router + the concrete DashboardRuntimeConfig.
//   3. Implements `bind<D>()` — the existential wrapper that closes over
//      each module's Deps so app.ts's iterator never sees them. Premortem
//      #3 mitigation: no `as never` anywhere in app.ts.

import type { Router } from 'express';
import type { DashboardRuntimeConfig } from 'gas-city-dashboard-shared';
import type {
  BackendModule as SharedBackendModule,
  BackgroundWorker,
  CityContext as SharedCityContext,
  ModuleResources,
  ViewDescriptor as SharedViewDescriptor,
} from 'gas-city-dashboard-shared';

import type { AdminConfig } from '../config.js';
import type { GcClient } from '../gc-client.js';

// Re-exports keep module authors importing from the backend wrapper, not
// reaching into shared/ directly. Today the value is documentation;
// tomorrow it lets us swap the underlying generic without churning every
// module file.
export type { BackgroundWorker, ModuleResources };

/** Backend-narrowed `CityContext`: pins gc to the concrete `GcClient` and
 *  config to `DashboardRuntimeConfig`. */
export type CityContext = SharedCityContext<GcClient, DashboardRuntimeConfig>;

/** Backend-narrowed `BackendModule`: pins router to `express.Router`. */
export type BackendModule<Deps = void> = SharedBackendModule<
  Deps,
  Router,
  GcClient,
  DashboardRuntimeConfig
>;

/** Frontend re-export shape (backend doesn't render views but exports the
 *  type so server-side smoke tests can import it consistently). */
export type ViewDescriptor<TElement = unknown> = SharedViewDescriptor<TElement>;

/** What app.ts's iterator actually sees: an opaque, uniform interface
 *  whose `mount` closure has already bound the module's Deps. */
export interface MountedModule {
  id: string;
  kind: 'core' | 'firstParty';
  mount: (ctx: CityContext) => Router;
  worker?: (ctx: CityContext) => BackgroundWorker | undefined;
}

/** Existential `bind<D>()` wrapper. Closes over Deps per-module so the
 *  iterator at the call site never needs to know the Deps type. Premortem
 *  #3 mitigation — replaces the `as never` cast that erased the Deps
 *  contract in the original sketch.
 *
 *  Boot-time validation: throws if `mod.needs` is not a function. The
 *  registry typecheck enforces this at compile time, but the runtime
 *  guard catches a hand-rolled module that ships with `needs: undefined`
 *  via JS interop. */
export function bind<D>(
  mod: BackendModule<D>,
  config: AdminConfig,
): MountedModule {
  if (typeof mod.needs !== 'function') {
    throw new Error(
      `BackendModule "${mod.id}" is missing required needs(config) function`,
    );
  }
  const deps = mod.needs(toRuntimeConfig(config));
  const workersFn = mod.workers;
  const mounted: MountedModule = {
    id: mod.id,
    kind: mod.kind,
    mount: (ctx) => mod.mount(ctx, deps),
  };
  if (workersFn !== undefined) {
    mounted.worker = (ctx) => workersFn(ctx, deps);
  }
  return mounted;
}

/** Mirror of the constructor in app.ts. Exposed so `bind()` and tests
 *  share one projection; modules see the same runtime view either way. */
export function toRuntimeConfig(config: AdminConfig): DashboardRuntimeConfig {
  return {
    cityName: config.cityName,
    cityRoot: config.cityPath,
    githubRepo: config.maintainerRepo,
    useFixtures: config.useFixtures,
  };
}
