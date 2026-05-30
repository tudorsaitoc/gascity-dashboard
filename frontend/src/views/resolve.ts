// View resolution helpers (PR-C / bead 9yj.5).
//
// Two related questions the frontend has to answer once the operator can
// opt-out of `firstParty` modules:
//
//   1. Which views should mount? (filter `ALL_VIEWS` by the backend's
//      `enabledModules` set so a backend-disabled module's path does not
//      render a React-Router 404 — the route is simply absent.)
//   2. Which view owns `/`? (descriptor-flag chain + operator override via
//      DEFAULT_VIEW env, mirrored on the wire as `defaultView`.)
//
// Both answers live in pure functions so App.tsx, Header.tsx, and unit
// tests all read the same logic. Warns about unknown / disabled overrides
// surface in the browser console — operator-visible, premortem #5.

import type { FrontendViewDescriptor } from './types';
import { LOG_COMPONENT, logWarn } from '../lib/logging';

/**
 * Filter `ALL_VIEWS` down to what should mount in this deployment.
 *
 *   - `core` views always mount (operators cannot disable a core view).
 *   - When `enabledModules` is `null` (env unset), every `firstParty` view
 *     also mounts — preserves pre-PR-C behaviour.
 *   - When `enabledModules` is a list, only those `firstParty` ids mount.
 */
export function filterEnabledViews(
  views: ReadonlyArray<FrontendViewDescriptor>,
  enabledModules: ReadonlyArray<string> | null,
): ReadonlyArray<FrontendViewDescriptor> {
  if (enabledModules === null) return views;
  const enabled = new Set(enabledModules);
  return views.filter((v) => v.kind === 'core' || enabled.has(v.id));
}

export type DefaultViewSource = 'env' | 'descriptor' | 'fallback';

export interface DefaultViewResolution {
  /** The view that should render at `/`, or `null` to fall through to the
   *  caller's built-in ambient-home component. */
  view: FrontendViewDescriptor | null;
  /** Which rule won: operator env, descriptor flag, or the kb3 fallback. */
  source: DefaultViewSource;
  /** Non-fatal diagnostics the resolver surfaced (e.g. unknown env id,
   *  disabled env target, multiple defaultRoute flags). Each entry is one
   *  human-readable line; the caller decides how to surface them (the
   *  default caller writes them to `console.warn`). */
  warnings: ReadonlyArray<string>;
}

/**
 * Resolve which view owns the `/` route.
 *
 * Resolution order (first match wins):
 *
 *   1. DEFAULT_VIEW env override (`defaultView` argument) — if it points
 *      at an ENABLED view, that view wins. If it names a view that is
 *      disabled OR unknown, we WARN and fall through (the operator was
 *      explicit, so silence would be wrong).
 *   2. Exactly one ENABLED view with `defaultRoute: true` wins. When
 *      multiple are flagged, we WARN and pick the one with the lowest
 *      `nav.order` (tiebreaker; views without nav sort last by id) so the
 *      choice is deterministic across deploys.
 *   3. Fallback: `view: null` — caller renders its built-in ambient-home
 *      component, preserving the pre-PR-C behaviour at `/`.
 *
 * The input `enabledViews` is the OUTPUT of `filterEnabledViews()` — the
 * resolver never re-derives membership, so the two-layer SSOT (registry +
 * wire) cannot split in this code path.
 */
export function resolveDefaultView(
  enabledViews: ReadonlyArray<FrontendViewDescriptor>,
  defaultView: string | null,
): DefaultViewResolution {
  const warnings: string[] = [];

  if (defaultView !== null) {
    const match = enabledViews.find((v) => v.id === defaultView);
    if (match !== undefined) {
      return { view: match, source: 'env', warnings };
    }
    // Either unknown or disabled. Distinguish the two for the operator —
    // an unknown id is almost certainly a typo; a disabled id is an
    // inconsistent MODULES_ENABLED + DEFAULT_VIEW pairing.
    warnings.push(
      `DEFAULT_VIEW="${defaultView}" does not match any enabled view ` +
        `(known enabled ids: ${enabledViews.map((v) => v.id).join(', ') || '(none)'}); ` +
        `falling through to descriptor / ambient-home`,
    );
  }

  const flagged = enabledViews.filter((v) => v.defaultRoute === true);
  const [first, ...rest] = flagged;
  if (first !== undefined && rest.length === 0) {
    return { view: first, source: 'descriptor', warnings };
  }
  if (first !== undefined) {
    // length > 1 — sort to pick a deterministic winner.
    const sorted = [...flagged].sort(compareDefaultCandidates);
    // sorted[0] is guaranteed defined: flagged was non-empty, sort
    // preserves length, and `first` is the proof we had at least one
    // element going in. Narrow explicitly so tsc doesn't reach for
    // a possibly-undefined index access.
    const winner = sorted[0] ?? first;
    warnings.push(
      `multiple views declare defaultRoute: true (${flagged
        .map((v) => v.id)
        .join(', ')}); picking "${winner.id}" by lowest nav.order`,
    );
    return { view: winner, source: 'descriptor', warnings };
  }

  return { view: null, source: 'fallback', warnings };
}

/**
 * Convenience wrapper: run `resolveDefaultView` and surface its warnings
 * via `console.warn` so the operator sees them in the browser console
 * (premortem #5 — DEFAULT_VIEW shadowing must be loud, not silent).
 * Returns the resolution unchanged.
 */
export function resolveDefaultViewWithLogging(
  enabledViews: ReadonlyArray<FrontendViewDescriptor>,
  defaultView: string | null,
): DefaultViewResolution {
  const result = resolveDefaultView(enabledViews, defaultView);
  for (const w of result.warnings) {
    logWarn(LOG_COMPONENT.views, w);
  }
  return result;
}

/**
 * Deterministic tiebreaker for multiple-`defaultRoute: true` collisions.
 * Lower `nav.order` wins; views without a nav entry sort last (after every
 * nav'd view) so a "routable but hidden" defaultRoute candidate never
 * silently outranks a visible nav entry. Final fallback is lexicographic
 * id order so the choice is stable across deploys.
 */
function compareDefaultCandidates(
  a: FrontendViewDescriptor,
  b: FrontendViewDescriptor,
): number {
  const ao = a.nav?.order ?? Number.POSITIVE_INFINITY;
  const bo = b.nav?.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}
