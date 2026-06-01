import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConfig,
  parseModulesEnabled,
  __resetMaintainerAliasWarnState,
} from '../src/config.js';

// loadConfig env-flag coverage. Seeded for gascity-dashboard-hzy's
// useFixtures gate; new env-driven knobs land here to keep config
// behavior reviewable in one place.

describe('loadConfig', () => {
  test('cityName defaults to racoon-city for the single-city dashboard', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.cityName, 'racoon-city');
  });

  test('cityName honors GC_CITY_NAME when set', () => {
    const cfg = loadConfig({ GC_CITY_NAME: 'other-city' });
    assert.equal(cfg.cityName, 'other-city');
  });

  test('auditLogPath honors ADMIN_AUDIT_LOG_PATH exactly when set', () => {
    const cfg = loadConfig({
      ADMIN_AUDIT_LOG_PATH: '/tmp/custom-events.jsonl',
      HOME: '/tmp/home-for-defaults',
    });
    assert.equal(cfg.auditLogPath, '/tmp/custom-events.jsonl');
  });

  test('auditLogPath default derives from the provided HOME env', () => {
    const cfg = loadConfig({ HOME: '/tmp/dashboard-home' });
    assert.equal(cfg.auditLogPath, '/tmp/dashboard-home/.gc/events.jsonl');
  });

  test('bindHost stays loopback-only even when HOST is set', () => {
    const cfg = loadConfig({ HOST: '0.0.0.0' });
    assert.equal(cfg.bindHost, '127.0.0.1');
  });

  test('useFixtures is true when SNAPSHOT_USE_FIXTURES=1', () => {
    const cfg = loadConfig({ SNAPSHOT_USE_FIXTURES: '1' });
    assert.equal(cfg.useFixtures, true);
  });

  test('useFixtures is false when SNAPSHOT_USE_FIXTURES is unset', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.useFixtures, false);
  });

  test('useFixtures is false for any value other than the exact string "1"', () => {
    // Strict equality with '1' prevents accidental opt-in via
    // SNAPSHOT_USE_FIXTURES=true, =yes, or =0.
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: 'true' }).useFixtures, false);
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: 'yes' }).useFixtures, false);
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: '0' }).useFixtures, false);
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: '' }).useFixtures, false);
  });

  test('runCwdAllowedRoots defaults to empty (shape-only, no regression) when unset', () => {
    assert.deepEqual(loadConfig({}).runCwdAllowedRoots, []);
  });

  test('runCwdAllowedRoots parses a colon-separated list of absolute roots', () => {
    const cfg = loadConfig({
      RUN_CWD_ALLOWED_ROOTS: '/home/ds/gascity:/home/ds/gascity-dashboard',
    });
    assert.deepEqual(cfg.runCwdAllowedRoots, [
      '/home/ds/gascity',
      '/home/ds/gascity-dashboard',
    ]);
  });

  test('runCwdAllowedRoots trims whitespace and drops empty/invalid entries', () => {
    const cfg = loadConfig({
      // leading/trailing space, an empty segment, a relative path, and a
      // ..-bearing path are all dropped (only safe absolute roots survive).
      RUN_CWD_ALLOWED_ROOTS: ' /home/ds/gascity : :relative/path:/a/../b:/srv/runs ',
    });
    assert.deepEqual(cfg.runCwdAllowedRoots, ['/home/ds/gascity', '/srv/runs']);
  });

  test('runCwdAllowedRoots drops a bare "/" root (would otherwise admit every path)', () => {
    // A root of "/" passes the shape check but makes the prefix gate admit
    // every absolute path — it is rejected so it can never defeat the allowlist.
    assert.deepEqual(loadConfig({ RUN_CWD_ALLOWED_ROOTS: '/' }).runCwdAllowedRoots, []);
    assert.deepEqual(
      loadConfig({ RUN_CWD_ALLOWED_ROOTS: '/:/home/ds/gascity' }).runCwdAllowedRoots,
      ['/home/ds/gascity'],
    );
  });

  test('maintainerTriageTarget defaults to mayor (always-present dispatcher)', () => {
    // gascity-dashboard-cus8: default was 'chief-of-staff' but that role
    // can be suspended in a deployment's agent roster (observed
    // 2026-05-29 with oversight-rig.chief-of-staff: suspended), causing
    // slings to silently fail. mayor is the top-level dispatcher present
    // in every Gas City deployment.
    const cfg = loadConfig({});
    assert.equal(cfg.modules.maintainer.triageTarget, 'mayor');
  });

  test('maintainerTriageTarget honours MAINTAINER_TRIAGE_TARGET when valid', () => {
    const cfg = loadConfig({ MAINTAINER_TRIAGE_TARGET: 'project-lead' });
    assert.equal(cfg.modules.maintainer.triageTarget, 'project-lead');
  });

  test('maintainerTriageTarget still accepts chief-of-staff as an explicit override', () => {
    // Deployments where chief-of-staff IS provisioned can still opt in.
    // The default change in cus8 is about safe fresh-install behaviour,
    // not about removing chief-of-staff as a valid target.
    const cfg = loadConfig({ MAINTAINER_TRIAGE_TARGET: 'chief-of-staff' });
    assert.equal(cfg.modules.maintainer.triageTarget, 'chief-of-staff');
  });

  test('maintainerTriageTarget warns and falls back on invalid env without a startup crash', () => {
    // Same precedent as maintainerSlingTarget: a typo in one optional env
    // should not dark the dashboard.
    const cfg = loadConfig({ MAINTAINER_TRIAGE_TARGET: 'bad alias!!' });
    assert.equal(cfg.modules.maintainer.triageTarget, 'mayor');
  });

  test('maintainerSlingTarget and maintainerTriageTarget resolve independently', () => {
    const cfg = loadConfig({
      MAINTAINER_SLING_TARGET: 'mayor',
      MAINTAINER_TRIAGE_TARGET: 'project-lead',
    });
    assert.equal(cfg.modules.maintainer.slingTarget, 'mayor');
    assert.equal(cfg.modules.maintainer.triageTarget, 'project-lead');
  });

  test('modules.maintainer.githubRepo defaults to gastownhall/gascity', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.modules.maintainer.githubRepo, 'gastownhall/gascity');
  });

  test('modules.maintainer.githubRepo honours MAINTAINER_GITHUB_REPO (the new env name)', () => {
    const cfg = loadConfig({ MAINTAINER_GITHUB_REPO: 'acme/widget' });
    assert.equal(cfg.modules.maintainer.githubRepo, 'acme/widget');
  });

  test('modules.maintainer.githubRepo accepts the deprecated MAINTAINER_REPO alias', () => {
    // Backwards-compat: existing operator envs keep working with a warn at boot.
    const cfg = loadConfig({ MAINTAINER_REPO: 'legacy/repo' });
    assert.equal(cfg.modules.maintainer.githubRepo, 'legacy/repo');
  });

  test('MAINTAINER_GITHUB_REPO wins when both are set', () => {
    const cfg = loadConfig({
      MAINTAINER_REPO: 'old/value',
      MAINTAINER_GITHUB_REPO: 'new/value',
    });
    assert.equal(cfg.modules.maintainer.githubRepo, 'new/value');
  });

  test('modules.maintainer.cachePath is undefined when MAINTAINER_CACHE_PATH is unset', () => {
    // The descriptor uses ctx.cityDataDir as the default; cachePath stays
    // undefined so the maintainer module knows to run the legacy-path
    // migration instead of treating the default as an operator pin.
    const cfg = loadConfig({});
    assert.equal(cfg.modules.maintainer.cachePath, undefined);
  });

  test('modules.maintainer.cachePath honours MAINTAINER_CACHE_PATH when set', () => {
    const cfg = loadConfig({ MAINTAINER_CACHE_PATH: '/var/cache/maintainer.json' });
    assert.equal(cfg.modules.maintainer.cachePath, '/var/cache/maintainer.json');
  });
});

describe('MAINTAINER_REPO deprecation warning is warn-once per process', () => {
  // Phase-4 correctness MEDIUM: the unguarded logWarn() fired on every
  // loadConfig call. The fix is a module-scope guard; this test verifies
  // the guard exists by counting console output across repeated calls.
  test('legacy-alias-used warn fires at most once across repeated loadConfig calls', () => {
    __resetMaintainerAliasWarnState();
    const calls: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (text.includes('MAINTAINER_REPO is deprecated')) calls.push(text);
      return origStderr(chunk);
    }) as typeof process.stderr.write;
    try {
      loadConfig({ MAINTAINER_REPO: 'legacy/one' });
      loadConfig({ MAINTAINER_REPO: 'legacy/two' });
      loadConfig({ MAINTAINER_REPO: 'legacy/three' });
    } finally {
      process.stderr.write = origStderr;
    }
    assert.equal(calls.length, 1, `expected 1 warn across 3 calls, got ${calls.length}`);
    __resetMaintainerAliasWarnState();
  });
});

describe('parseModulesEnabled (PR-C / bead 9yj.5)', () => {
  test('returns null when env is unset — distinct from explicit-empty; both resolve core-only (PR-D)', () => {
    assert.equal(parseModulesEnabled(undefined), null);
  });

  test('returns an EMPTY set when env is the empty string — operator explicit opt-out', () => {
    const set = parseModulesEnabled('');
    assert.ok(set instanceof Set);
    assert.equal(set?.size, 0);
  });

  test('returns the parsed set for a CSV value', () => {
    const set = parseModulesEnabled('health,maintainer');
    assert.deepEqual([...(set ?? [])].sort(), ['health', 'maintainer']);
  });

  test('trims whitespace around each entry', () => {
    const set = parseModulesEnabled(' health , maintainer ');
    assert.deepEqual([...(set ?? [])].sort(), ['health', 'maintainer']);
  });

  test('drops empty entries from leading / trailing / doubled commas', () => {
    const set = parseModulesEnabled(',health,,maintainer,');
    assert.deepEqual([...(set ?? [])].sort(), ['health', 'maintainer']);
  });

  test('preserves casing — typo surfaces as "module never mounted", not silent match', () => {
    const set = parseModulesEnabled('Health,MAINTAINER');
    assert.deepEqual([...(set ?? [])].sort(), ['Health', 'MAINTAINER']);
  });
});

describe('loadConfig — enabledModules / defaultView (PR-C / bead 9yj.5)', () => {
  test('enabledModules is null when MODULES_ENABLED is unset', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.enabledModules, null);
  });

  test('enabledModules is an empty set when MODULES_ENABLED is the empty string', () => {
    const cfg = loadConfig({ MODULES_ENABLED: '' });
    assert.ok(cfg.enabledModules instanceof Set);
    assert.equal(cfg.enabledModules?.size, 0);
  });

  test('enabledModules carries the parsed CSV when set', () => {
    const cfg = loadConfig({ MODULES_ENABLED: 'health,maintainer' });
    assert.deepEqual([...(cfg.enabledModules ?? [])].sort(), ['health', 'maintainer']);
  });

  test('defaultView is null when DEFAULT_VIEW is unset', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.defaultView, null);
  });

  test('defaultView is null when DEFAULT_VIEW is the empty string', () => {
    // Empty-string env vars are a Unix convention for "unset" — treat them
    // as null so a `DEFAULT_VIEW=` doesn't accidentally pin "" as the id.
    const cfg = loadConfig({ DEFAULT_VIEW: '' });
    assert.equal(cfg.defaultView, null);
  });

  test('defaultView carries the env value verbatim when set', () => {
    const cfg = loadConfig({ DEFAULT_VIEW: 'maintainer' });
    assert.equal(cfg.defaultView, 'maintainer');
  });
});
