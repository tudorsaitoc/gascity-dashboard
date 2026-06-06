// Deterministic regression gate for the dashboard's supervisor-backed tabs.
//
// Unlike dashboard-tester.mjs (which drives a LIVE node against whatever the
// live supervisor currently holds, so it can only assert "renders something or
// an explicit empty state"), this script installs the static "test-city"
// supervisor fixture via Playwright route interception and asserts SPECIFIC,
// KNOWN seeded state on every supervisor-backed tab — with no live supervisor
// or live city. This fills the gap the dashboard-owned SNAPSHOT_USE_FIXTURES
// path leaves: it only covers `/api/*`, never the `/gc-supervisor/*` proxy.
//
// It does NOT start its own server: it drives whatever Vite/dashboard is
// serving the base URL, mirroring the snap-harness contract in AGENTS.md.
//
//   node scripts/snap-test-city.mjs          # run + report, always exit 0
//   node scripts/snap-test-city.mjs --test   # run + assert; non-zero on regression
//
// Base URL override (default http://127.0.0.1:5174, the Vite dev server):
//   TEST_CITY_BASE=http://127.0.0.1:8082 node scripts/snap-test-city.mjs --test
//
// Requires the shared workspace to be built (`npm run build:shared`) so the
// fixture import resolves.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { installSupervisorFixtures } from './fixtures/install-supervisor-fixtures.mjs';

const BASE = env.TEST_CITY_BASE || 'http://127.0.0.1:5174';
const OUT = '/tmp/cp-snaps';
const TEST_MODE = argv.includes('--test');
const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 2_000;

// The host dashboard's own `/api/*` data is real and scoped to its configured
// city; only the `/gc-supervisor/*` proxy is faked. So we drive the host's real
// city (discovered from the shell) and let the city-agnostic fixture serve its
// supervisor calls — that keeps `/api/city/<city>/*` pointed at a city the
// backend actually knows.
let activeCity = null;

const short = (s, n = 110) => (s ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, n);
const makeResult = (name) => ({ name, errors: [], info: {} });

/**
 * Open a context with the supervisor fixture installed (scoped to the
 * discovered active city) and run `fn`. Pass `{ fixtures: false }` to open a
 * plain context — used for city discovery before the city is known.
 */
async function withPage(browser, fn, { fixtures = true } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  try {
    if (fixtures) await installSupervisorFixtures(ctx, { activeCity: activeCity ?? undefined });
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

/** Collect any broken `/gc-supervisor/*` responses (>=400, incl. unseeded 501s). */
function collectSupervisorErrors(page, result) {
  const errs = [];
  page.on('response', (r) => {
    const url = r.url();
    if (url.includes('/gc-supervisor/') && r.status() >= 400) {
      errs.push(`${r.status()} ${r.request().method()} ${short(url, 90)}`);
    }
  });
  return () => {
    for (const e of errs) result.errors.push(`broken supervisor call: ${e}`);
  };
}

async function readMain(page) {
  return page
    .locator('main')
    .first()
    .innerText()
    .catch(() => '');
}

/** Assert each expected substring is present in the route's main content. */
function assertContains(result, label, text, expected) {
  for (const needle of expected) {
    if (!text.includes(needle)) {
      result.errors.push(`${label}: expected seeded text "${needle}" not found`);
    }
  }
}

async function snap(page, name) {
  await page.screenshot({ path: `${OUT}/test-city-${name}.png` }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Discover the host's real city from the shell (no fixtures — the city comes
// from the backend config, not supervisor data). Skip (exit 0) when nothing is
// serving the base URL — the snap-harness contract; a real regression is the
// only non-zero exit.
// ---------------------------------------------------------------------------

async function discoverCity(browser) {
  return withPage(
    browser,
    async (page) => {
      try {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      } catch (err) {
        const s = String(err);
        if (/ERR_CONNECTION_REFUSED|net::ERR|NS_ERROR|Timeout/.test(s)) {
          return { skip: `base URL not reachable at ${BASE}` };
        }
        throw err;
      }
      await page
        .locator('nav a, header a')
        .first()
        .waitFor({ timeout: 8_000 })
        .catch(() => {});
      const href = await page
        .locator('nav a, header a')
        .first()
        .getAttribute('href')
        .catch(() => null);
      const match = href?.match(/\/city\/([^/]+)/);
      if (!match) {
        return {
          fail: `reachable at ${BASE} but no /city/<name> nav link rendered (broken shell?)`,
        };
      }
      const city = match[1];
      return { cityBase: `${BASE}/city/${city}`, city };
    },
    { fixtures: false },
  );
}

// ---------------------------------------------------------------------------
// Per-tab checks: assert KNOWN seeded content (text-based, greyscale-safe).
// ---------------------------------------------------------------------------

async function checkBeads(browser, cityBase) {
  const result = makeResult('beads');
  await withPage(browser, async (page) => {
    const drain = collectSupervisorErrors(page, result);
    await page.goto(`${cityBase}/beads`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(SETTLE_MS);
    const text = await readMain(page);
    // A seeded epic title + a seeded p0 bug — both render verbatim in the board.
    assertContains(result, 'beads', text, ['Guest checkout overhaul', 'SSO login redirect loop']);
    drain();
    await snap(page, 'beads');
  });
  return result;
}

async function checkAgents(browser, cityBase) {
  const result = makeResult('agents');
  await withPage(browser, async (page) => {
    const drain = collectSupervisorErrors(page, result);
    await page.goto(`${cityBase}/agents`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(SETTLE_MS);
    const labels = await page
      .locator('table tbody a[href*="/agents/"]')
      .allInnerTexts()
      .catch(() => []);
    result.info.rows = labels.length;
    if (labels.length === 0) {
      result.errors.push('agents: roster rendered zero rows against the seeded fixture');
    } else if (!labels.some((l) => l.includes(' · '))) {
      result.errors.push('agents: no `rig · agent` label rendered (rig column regression?)');
    }
    drain();
    await snap(page, 'agents');
  });
  return result;
}

async function checkRuns(browser, cityBase) {
  const result = makeResult('runs');
  await withPage(browser, async (page) => {
    const drain = collectSupervisorErrors(page, result);
    await page.goto(`${cityBase}/runs`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(SETTLE_MS);
    const laneLinks = await page
      .locator('a[href*="/runs/"]')
      .count()
      .catch(() => 0);
    result.info.runLanes = laneLinks;
    const text = await readMain(page);
    // The Runs view derives lanes from graph.v2 workflow bead groups; a seeded
    // in-flight run title should render.
    assertContains(result, 'runs', text, ['guest-checkout address autocomplete']);
    drain();
    await snap(page, 'runs');
  });
  return result;
}

async function checkMail(browser, cityBase) {
  const result = makeResult('mail');
  await withPage(browser, async (page) => {
    const drain = collectSupervisorErrors(page, result);
    await page.goto(`${cityBase}/mail`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(SETTLE_MS);
    const text = await readMain(page);
    assertContains(result, 'mail', text, ['Warehouse still not provisioned']);
    drain();
    await snap(page, 'mail');
  });
  return result;
}

async function checkHealth(browser, cityBase) {
  const result = makeResult('health');
  await withPage(browser, async (page) => {
    const drain = collectSupervisorErrors(page, result);
    await page.goto(`${cityBase}/health`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(SETTLE_MS);
    const text = await readMain(page);
    // Health renders the seeded city/supervisor status; the fixture build id is
    // a stable, distinctive marker.
    if (!/test-fixture/i.test(text) && !/\bok\b/i.test(text)) {
      result.errors.push('health: neither seeded version nor an "ok" status rendered');
    }
    drain();
    await snap(page, 'health');
  });
  return result;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const results = [];
let skipReason = null;

try {
  const discovery = await discoverCity(browser);
  if (discovery.skip) {
    skipReason = discovery.skip;
  } else if (discovery.fail) {
    results.push({ name: 'preflight', errors: [discovery.fail], info: {} });
  } else {
    const { cityBase, city } = discovery;
    activeCity = city;
    console.log(`snap-test-city: driving ${cityBase} with the test-city supervisor fixture`);
    results.push(await checkBeads(browser, cityBase));
    results.push(await checkAgents(browser, cityBase));
    results.push(await checkRuns(browser, cityBase));
    results.push(await checkMail(browser, cityBase));
    results.push(await checkHealth(browser, cityBase));
  }
} finally {
  await browser.close();
}

if (skipReason) {
  console.log(`snap-test-city: SKIPPED — ${skipReason}`);
  exit(0);
}

let hadErrors = false;
for (const r of results) {
  const info = Object.entries(r.info)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  if (r.errors.length) {
    hadErrors = true;
    console.error(`[${r.name}] FAIL${info ? ` (${info})` : ''}`);
    for (const e of r.errors) console.error(`  - ${e}`);
  } else {
    console.log(`[${r.name}] PASS${info ? ` — ${info}` : ''}`);
  }
}

if (TEST_MODE) {
  if (hadErrors) {
    console.error('snap-test-city: FAILED');
    exit(1);
  }
  console.log('snap-test-city: PASSED');
}
