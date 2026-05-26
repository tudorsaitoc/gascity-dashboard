import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

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

  test('maintainerTriageTarget defaults to chief-of-staff', () => {
    // gascity-dashboard-0nn: triage intent routes to chief-of-staff so
    // bulk-sling fans out without per-request target resolution.
    const cfg = loadConfig({});
    assert.equal(cfg.maintainerTriageTarget, 'chief-of-staff');
  });

  test('maintainerTriageTarget honours MAINTAINER_TRIAGE_TARGET when valid', () => {
    const cfg = loadConfig({ MAINTAINER_TRIAGE_TARGET: 'project-lead' });
    assert.equal(cfg.maintainerTriageTarget, 'project-lead');
  });

  test('maintainerTriageTarget silently falls back on invalid env (no startup crash)', () => {
    // Same precedent as maintainerSlingTarget: a typo in one optional env
    // should not dark the dashboard.
    const cfg = loadConfig({ MAINTAINER_TRIAGE_TARGET: 'bad alias!!' });
    assert.equal(cfg.maintainerTriageTarget, 'chief-of-staff');
  });

  test('maintainerSlingTarget and maintainerTriageTarget resolve independently', () => {
    const cfg = loadConfig({
      MAINTAINER_SLING_TARGET: 'mayor',
      MAINTAINER_TRIAGE_TARGET: 'chief-of-staff',
    });
    assert.equal(cfg.maintainerSlingTarget, 'mayor');
    assert.equal(cfg.maintainerTriageTarget, 'chief-of-staff');
  });
});
