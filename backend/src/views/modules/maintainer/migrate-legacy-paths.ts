// Path-drift migration helper. The pre-modular `app.ts` mount stored the
// maintainer cache + slung-state JSON under `~/.gascity-dashboard/`, but
// the modular descriptor derives paths from `ctx.cityDataDir`
// (= `~/.gascity-dashboard/cities/<cityName>/`). Without migration, an
// operator upgrading would silently re-trigger the gh-fetch enrichment
// (cache miss) and lose their slung-state tracking across the cutover.
//
// Audit-C8 / PR-B2 resolution = Option A: at maintainer mount, if the
// legacy files exist AND the new ones do NOT, rename them in place.
// Idempotent: any other state (new exists, or both absent) is a silent
// no-op. Cross-device or permission failures log a warn and fall through
// (the worker will simply rebuild the cache on its next refresh).
//
// Operator-pinned override (`MAINTAINER_CACHE_PATH` / `deps.cachePath`)
// MUST be checked at the call site BEFORE invoking this — when set, no
// migration runs at all (the operator's path is sovereign).
//
// IMPLEMENTATION: sync filesystem ops, by design. `BackendModule.mount`
// is synchronous in the shared contract, so we cannot `await` the
// migration from the descriptor. A fire-and-forget async migration
// would race the router/worker writes that start immediately on mount
// (Phase-4 security MEDIUM). The migration touches at most two small
// JSON files in `~/.gascity-dashboard/`, so blocking mount briefly is
// acceptable for this one-shot upgrade step.

import fs from 'node:fs';
import path from 'node:path';
import { LOG_COMPONENT, errorMessage, logInfo, logWarn } from '../../../logging.js';

const LEGACY_FILES = ['maintainer-cache.json', 'slung-state.json'] as const;

// Restrictive mode for the per-city data dir we create here. The triage
// envelope holds only public-API data (repo, issue/PR titles, contributor
// logins) but operator-level isolation is the safer default — see the
// Phase-4 security MEDIUM rationale.
const PER_CITY_DIR_MODE = 0o700;

/**
 * Move legacy `<oldDir>/{maintainer-cache,slung-state}.json` to
 * `<newDir>/...` when the new locations do not exist yet. Per-file
 * decisions are independent: one file may migrate while the other is
 * already at the new path.
 *
 * Synchronous: see header comment.
 */
export function migrateLegacyMaintainerPaths(
  oldDir: string,
  newDir: string,
): void {
  if (path.resolve(oldDir) === path.resolve(newDir)) return;

  for (const file of LEGACY_FILES) {
    const oldPath = path.join(oldDir, file);
    const newPath = path.join(newDir, file);

    // lstat (not stat) — `rename` on a symlink moves the link, not its
    // target. A symlink planted at `oldPath` would relocate into the
    // new tree on first boot, silently rewriting the operator's home
    // layout. Per-Phase-4 security MEDIUM: bail with a warn instead.
    let oldStat: fs.Stats;
    try {
      oldStat = fs.lstatSync(oldPath);
    } catch {
      continue; // old absent → nothing to migrate
    }
    if (oldStat.isSymbolicLink()) {
      logWarn(
        LOG_COMPONENT.maintainer,
        `skipping migration of symlink at ${oldPath} — operator must move it manually`,
      );
      continue;
    }
    if (fileExistsSync(newPath)) continue;

    try {
      fs.mkdirSync(newDir, { recursive: true, mode: PER_CITY_DIR_MODE });
      fs.renameSync(oldPath, newPath);
      logInfo(
        LOG_COMPONENT.maintainer,
        `migrated ${file} from ${oldPath} to ${newPath}`,
      );
    } catch (err) {
      logWarn(
        LOG_COMPONENT.maintainer,
        `failed to migrate ${file} from ${oldPath} to ${newPath}: ${errorMessage(err)}`,
      );
    }
  }
}

function fileExistsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
