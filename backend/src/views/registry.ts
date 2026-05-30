// Backend module registry — the single list iterated by app.ts. PR-A
// contains only `health`; PR-B1/B2 adds `maintainer`; later PRs add the
// remaining first-party modules per PRD §7.
//
// `ALL_MODULES` is typed as `ReadonlyArray<BackendModule<unknown>>`
// rather than `BackendModule<any>` so the type system still tracks the
// Deps erasure honestly. The `register()` helper widens each module's
// Deps to `unknown` at registration time — the only place this widening
// happens — and `bind<D>()` re-narrows at the call site via the existential
// closure (see views/types.ts). No `as never` anywhere.

import type { BackendModule } from './types.js';
import { healthBackend } from './modules/health.module.js';

/** Erases a module's concrete Deps to `unknown` so heterogeneous modules
 *  share a single array type. Safe because `bind<D>()` re-closes over the
 *  original Deps via the module's own `needs`/`mount`/`workers` closures,
 *  which were already typed at definition time. */
function register<D>(mod: BackendModule<D>): BackendModule<unknown> {
  return mod as BackendModule<unknown>;
}

export const ALL_MODULES: ReadonlyArray<BackendModule<unknown>> = [
  register(healthBackend),
];
