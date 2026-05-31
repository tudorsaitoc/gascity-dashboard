import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  maintainerPaths,
  shouldMigrateLegacyPaths,
  type MaintainerDeps,
} from './maintainer.module.js';
import type { CityContext } from '../../types.js';

// gascity-dashboard-ucc review fixes:
//   - Blocker 1: an operator-pinned cachePath must resolve to DISTINCT
//     per-city cache + slung-state paths so two cities sharing one process
//     cannot clobber each other.
//   - Blocker 2: the legacy-path migration must run ONLY for the legacy
//     GC_CITY_NAME (config.cityName), never for the first arbitrary city to
//     mount.

const BASE_DEPS: MaintainerDeps = {
  repo: 'gastownhall/gascity',
  slingTarget: 'mayor',
  triageTarget: 'mayor',
  refreshIntervalMs: 0,
};

/** Build a minimal CityContext for path/predicate derivation. Only the
 *  fields the unit-under-test reads are populated. */
function fakeCtx(cityName: string, legacyCityName: string): CityContext {
  return {
    cityName,
    cityPath: `/srv/cities/${cityName}`,
    cityDataDir: path.join('/home/op/.gascity-dashboard/cities', cityName),
    gc: {} as CityContext['gc'],
    config: { cityName: legacyCityName } as CityContext['config'],
  };
}

describe('maintainerPaths — pinned per-city derivation (blocker 1)', () => {
  test('two cities with the SAME pin resolve to DISTINCT cache + slung-state paths', () => {
    const deps: MaintainerDeps = { ...BASE_DEPS, cachePath: '/var/cache/maintainer-cache.json' };

    const a = maintainerPaths(fakeCtx('alpha-city', 'alpha-city'), deps);
    const b = maintainerPaths(fakeCtx('beta-city', 'alpha-city'), deps);

    assert.notEqual(a.cachePath, b.cachePath, 'cache paths must differ per city');
    assert.notEqual(a.slungStatePath, b.slungStatePath, 'slung-state paths must differ per city');

    // The per-city segment is joined under the pinned dir.
    assert.equal(a.cachePath, path.join('/var/cache', 'alpha-city', 'maintainer-cache.json'));
    assert.equal(a.slungStatePath, path.join('/var/cache', 'alpha-city', 'slung-state.json'));
    assert.equal(b.cachePath, path.join('/var/cache', 'beta-city', 'maintainer-cache.json'));
    assert.equal(b.slungStatePath, path.join('/var/cache', 'beta-city', 'slung-state.json'));
  });

  test('a directory pin (no .json) is treated as the base dir verbatim', () => {
    const deps: MaintainerDeps = { ...BASE_DEPS, cachePath: '/var/cache/triage' };
    const p = maintainerPaths(fakeCtx('alpha-city', 'alpha-city'), deps);
    assert.equal(p.cachePath, path.join('/var/cache/triage', 'alpha-city', 'maintainer-cache.json'));
  });

  test('cache + slung-state always share the same per-city directory', () => {
    const deps: MaintainerDeps = { ...BASE_DEPS, cachePath: '/var/cache/maintainer-cache.json' };
    const p = maintainerPaths(fakeCtx('gamma-city', 'gamma-city'), deps);
    assert.equal(path.dirname(p.cachePath), path.dirname(p.slungStatePath));
  });

  test('unpinned: paths derive from cityDataDir, still distinct per city', () => {
    const a = maintainerPaths(fakeCtx('alpha-city', 'alpha-city'), BASE_DEPS);
    const b = maintainerPaths(fakeCtx('beta-city', 'alpha-city'), BASE_DEPS);
    assert.notEqual(a.cachePath, b.cachePath);
    assert.notEqual(a.slungStatePath, b.slungStatePath);
  });
});

describe('shouldMigrateLegacyPaths — single-legacy-city gate (blocker 2)', () => {
  test('runs for the legacy city (cityName === config.cityName) when unpinned', () => {
    const ctx = fakeCtx('racoon-city', 'racoon-city');
    assert.equal(shouldMigrateLegacyPaths(ctx, BASE_DEPS), true);
  });

  test('a NON-legacy city does NOT claim the legacy files', () => {
    const ctx = fakeCtx('other-city', 'racoon-city');
    assert.equal(shouldMigrateLegacyPaths(ctx, BASE_DEPS), false);
  });

  test('never migrates when a cache path is pinned, even for the legacy city', () => {
    const ctx = fakeCtx('racoon-city', 'racoon-city');
    const deps: MaintainerDeps = { ...BASE_DEPS, cachePath: '/var/cache/maintainer-cache.json' };
    assert.equal(shouldMigrateLegacyPaths(ctx, deps), false);
  });
});
