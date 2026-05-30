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

import fs from 'node:fs/promises';
import path from 'node:path';
import { LOG_COMPONENT, errorMessage, logInfo, logWarn } from '../../../logging.js';

const LEGACY_FILES = ['maintainer-cache.json', 'slung-state.json'] as const;

/**
 * Move legacy `<oldDir>/{maintainer-cache,slung-state}.json` to
 * `<newDir>/...` when the new locations do not exist yet. Per-file
 * decisions are independent: one file may migrate while the other is
 * already at the new path.
 */
export async function migrateLegacyMaintainerPaths(
  oldDir: string,
  newDir: string,
): Promise<void> {
  // Same directory = nothing to migrate (operator already on the new path).
  if (path.resolve(oldDir) === path.resolve(newDir)) return;

  for (const file of LEGACY_FILES) {
    const oldPath = path.join(oldDir, file);
    const newPath = path.join(newDir, file);
    const oldExists = await fileExists(oldPath);
    if (!oldExists) continue;
    const newExists = await fileExists(newPath);
    if (newExists) continue;

    try {
      await fs.mkdir(newDir, { recursive: true });
      await fs.rename(oldPath, newPath);
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
