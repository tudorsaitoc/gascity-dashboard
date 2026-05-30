import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, __resetMaintainerAliasWarnState } from '../src/config.js';

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

  test('maintainerTriageTarget silently falls back on invalid env (no startup crash)', () => {
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
