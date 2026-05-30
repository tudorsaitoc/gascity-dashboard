// Module enable-set resolution (PR-C / bead 9yj.5).
//
// The host iterates a registry of `BackendModule` descriptors. `core`
// modules are always mounted; `firstParty` modules are operator-opt-in via
// MODULES_ENABLED. The resolution rules live in one function so the boot
// log, the wire-shape mirror, and the iterator filter all consult the SAME
// answer — premortem #4 anti-drift.

import type { BackendModule } from './types.js';
import { LOG_COMPONENT, logWarn } from '../logging.js';

/**
 * Given the registry's modules and the parsed `enabledModules` env value,
 * return the set of `firstParty` module ids that SHOULD mount.
 *
 *   - `enabled === null` (env unset): every `firstParty` id is enabled
 *     (preserves pre-PR-C behaviour).
 *   - `enabled` is an empty set: no `firstParty` ids are enabled.
 *   - `enabled` is non-empty: every member that matches a `firstParty` id
 *     in the registry is enabled. Members that name a `core` id are
 *     silently ignored — operators cannot disable core via omission AND
 *     cannot re-enable a core that was never disable-able. Members that
 *     name an unknown id emit a `warn` so a typo doesn't pass silently.
 *
 * Returns a fresh `Set` so the caller cannot accidentally mutate the env.
 */
export function resolveEnabledFirstPartyIds(
  registry: ReadonlyArray<BackendModule<unknown>>,
  enabled: ReadonlySet<string> | null,
): ReadonlySet<string> {
  const firstPartyIds = new Set(
    registry.filter((m) => m.kind === 'firstParty').map((m) => m.id),
  );
  if (enabled === null) return firstPartyIds;

  const coreIds = new Set(
    registry.filter((m) => m.kind === 'core').map((m) => m.id),
  );

  const resolved = new Set<string>();
  for (const id of enabled) {
    if (firstPartyIds.has(id)) {
      resolved.add(id);
      continue;
    }
    if (coreIds.has(id)) {
      // Operator-redundant: core mounts unconditionally. Don't add (the
      // returned set is the firstParty subset) but don't warn either —
      // naming a core id in MODULES_ENABLED is benign, not a typo.
      continue;
    }
    logWarn(
      LOG_COMPONENT.admin,
      `MODULES_ENABLED contains unknown module id "${id}" — ignored`,
    );
  }
  return resolved;
}
