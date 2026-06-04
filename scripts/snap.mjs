// Headless screenshot harness for design iteration.
//
// Usage:
//   node scripts/snap.mjs            # snap all routes × both themes
//   node scripts/snap.mjs agents     # snap one route, both themes
//   node scripts/snap.mjs agents light  # one route, one theme
//   node scripts/snap.mjs runs --test  # fail on API/browser errors
//
// SSE routes (/agents, /runs) auto-wait longer so the live-connection
// badge settles to 'live' before the shot. SNAP_WAIT_MS=<ms> overrides the
// per-route wait for every route.
//
// Output: /tmp/cp-snaps/<theme>-<route>.png at 1440×900 (MBP-ish).

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const BASE = process.env.SNAP_BASE || 'http://127.0.0.1:5174';
const CITY = process.env.SNAP_CITY || 'racoon-city';
const CITY_BASE = `${BASE}/city/${encodeURIComponent(CITY)}`;
const OUT = '/tmp/cp-snaps';

const ROUTES = ['home', 'agents', 'beads', 'runs', 'mail', 'activity', 'health', 'maintainer'];
const FIRST_PARTY_ROUTE_MODULES = {
  maintainer: 'maintainer',
};
const ROUTE_PATHS = {
  home: '/',
  agents: '/agents',
  beads: '/beads',
  runs: '/runs',
  mail: '/mail',
  activity: '/activity',
  health: '/health',
  maintainer: '/maintainer',
};
const ROUTE_HEADINGS = {
  home: /home|attention|city/i,
  agents: /^agents$/i,
  beads: /^beads$/i,
  runs: /formula runs/i,
  mail: /^mail$/i,
  activity: /^activity$/i,
  health: /^health$/i,
  maintainer: /maintainer|triage/i,
};
const THEMES = ['light', 'dark'];

// Routes that subscribe to /api/events/stream via useGcEventRefresh and render
// an SseIndicator. Their badge starts amber ('connecting') and only flips green
// ('live') once the EventSource handshake completes — which takes longer than a
// plain mount + fetch. Keep this set in sync with the SseIndicator consumers
// (see frontend/src/components/SseIndicator.tsx); a stale name here just means a
// route silently reverts to the short wait.
const SSE_ROUTES = new Set(['agents', 'runs']);

// Post-mount settle waits (ms). SSE routes need enough time for the
// SseIndicator to reach 'live'; non-SSE routes keep the short wait so the
// common case is not slowed.
const DEFAULT_WAIT_MS = 900;
const SSE_WAIT_MS = 5_000;

// Escape hatch: SNAP_WAIT_MS overrides the wait for ALL routes (manual control).
// Unset = auto-detect per route via SSE_ROUTES.
const overrideWaitMs = env.SNAP_WAIT_MS ? Number(env.SNAP_WAIT_MS) : null;
if (overrideWaitMs !== null && !Number.isFinite(overrideWaitMs)) {
  console.error(`SNAP_WAIT_MS must be a number, got "${env.SNAP_WAIT_MS}"`);
  exit(1);
}

const waitFor = (r) => overrideWaitMs ?? (SSE_ROUTES.has(r) ? SSE_WAIT_MS : DEFAULT_WAIT_MS);

const args = argv.slice(2);
const TEST_MODE = args.includes('--test');
const positional = args.filter((arg) => arg !== '--test');
const route = positional[0];
const theme = positional[1];

if (route && !ROUTES.includes(route)) {
  console.error(`Unknown route "${route}". Valid: ${ROUTES.join(', ')}`);
  exit(1);
}
if (theme && !THEMES.includes(theme)) {
  console.error(`Unknown theme "${theme}". Valid: ${THEMES.join(', ')}`);
  exit(1);
}

const wantRoutes = route ? [route] : await enabledRoutesForCity();
const wantThemes = theme ? [theme] : THEMES;

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];
try {
  for (const t of wantThemes) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: t,
      // Pre-pin the theme in localStorage so the inline FOUC script
      // applies the data-theme attribute before paint.
      storageState: {
        cookies: [],
        origins: [
          {
            origin: BASE,
            localStorage: [{ name: 'gascity:theme', value: t }],
          },
        ],
      },
    });

    for (const r of wantRoutes) {
      const result = {
        theme: t,
        route: r,
        path: null,
        errors: [],
        apiCalls: [],
        apiFailures: [],
        consoleErrors: [],
      };
      const page = await ctx.newPage();
      const apiCalls = [];
      const apiFailures = [];
      const onResponse = (response) => {
        const url = new URL(response.url());
        if (isObservedApiPath(url.pathname)) {
          apiCalls.push({
            url: url.toString(),
            method: response.request().method(),
            status: response.status(),
          });
        }
      };
      const onRequestFailed = (request) => {
        const url = new URL(request.url());
        const failure = request.failure()?.errorText ?? 'request failed';
        if (isObservedApiPath(url.pathname) && !isIgnorableRequestFailure(failure)) {
          apiFailures.push({
            url: url.toString(),
            method: request.method(),
            failure,
          });
        }
      };
      const onPageError = (error) => {
        result.consoleErrors.push(`page error: ${error.message}`);
      };
      const onConsole = (message) => {
        if (message.type() === 'error') {
          result.consoleErrors.push(`console error: ${message.text()}`);
        }
      };
      page.on('response', onResponse);
      page.on('requestfailed', onRequestFailed);
      page.on('pageerror', onPageError);
      page.on('console', onConsole);
      const url = `${CITY_BASE}${ROUTE_PATHS[r]}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        // Wait for the React app to mount + at least one fetch round trip.
        // Vite dev keeps an HMR socket open so networkidle never fires.
        await page.waitForSelector('header', { timeout: 5_000 }).catch(() => {});
        await assertRouteHeading(page, r, result);
        // SSE routes need extra time for the EventSource to reach 'live'; others
        // keep the short wait. SNAP_WAIT_MS overrides both. See waitFor() above.
        await page.waitForTimeout(waitFor(r));
        const path = `${OUT}/${t}-${r}.png`;
        await page.screenshot({ path, fullPage: false });
        result.path = path;
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
      result.apiCalls = apiCalls.slice();
      result.apiFailures = apiFailures.slice();
      if (TEST_MODE) {
        recordApiFailures(result);
        if (result.consoleErrors.length > 0) {
          result.errors.push(`browser errors: ${result.consoleErrors.join('; ')}`);
        }
      }
      results.push(result);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      await page.close().catch(() => {});
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

let hadErrors = false;
for (const result of results) {
  if (result.path) console.log(`snap ${result.path}`);
  if (TEST_MODE) {
    for (const call of result.apiCalls) {
      console.log(
        `[${result.theme}/${result.route}] api ${call.status} ${call.method} ${call.url}`,
      );
    }
    for (const call of result.apiFailures) {
      console.log(
        `[${result.theme}/${result.route}] api failed ${call.method} ${call.url} (${call.failure})`,
      );
    }
  }
  if (result.errors.length > 0) {
    hadErrors = true;
    for (const error of result.errors) {
      console.error(`[${result.theme}/${result.route}] FAIL, ${error}`);
    }
  } else if (TEST_MODE) {
    console.log(`[${result.theme}/${result.route}] PASS`);
  }
}

if (hadErrors) {
  console.error(TEST_MODE ? 'snapshot regression: FAILED' : 'snapshot: FAILED');
  exit(1);
}

if (TEST_MODE) {
  console.log('snapshot regression: PASSED');
}

function isObservedApiPath(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/gc-supervisor/');
}

function isIgnorableRequestFailure(failure) {
  return failure === 'net::ERR_ABORTED';
}

async function enabledRoutesForCity() {
  const routeModules = Object.entries(FIRST_PARTY_ROUTE_MODULES);
  if (routeModules.length === 0) return ROUTES;

  const configUrl = `${BASE}/api/city/${encodeURIComponent(CITY)}/config`;

  const response = await fetch(configUrl);
  if (!response.ok) {
    throw new Error(`Could not read city config from ${configUrl}: ${response.status}`);
  }

  const config = await response.json();
  const enabledModules = new Set(Array.isArray(config.enabledModules) ? config.enabledModules : []);
  return ROUTES.filter((candidate) => {
    const requiredModule = FIRST_PARTY_ROUTE_MODULES[candidate];
    return requiredModule === undefined || enabledModules.has(requiredModule);
  });
}

async function assertRouteHeading(page, route, result) {
  if (!TEST_MODE) return;
  const heading = page.locator('h1').first();
  try {
    await heading.waitFor({ timeout: 8_000 });
    const text = (await heading.textContent()) ?? '';
    if (!ROUTE_HEADINGS[route].test(text.trim())) {
      result.errors.push(`unexpected h1 for ${route}: "${text.trim()}"`);
    }
  } catch (err) {
    result.errors.push(
      `missing h1 for ${route}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function recordApiFailures(result) {
  const failedApiCalls = result.apiCalls.filter((call) => call.status >= 400);
  if (failedApiCalls.length > 0) {
    result.errors.push(
      `unexpected API failures: ${failedApiCalls
        .map((call) => `${call.status} ${call.url}`)
        .join('; ')}`,
    );
  }
  if (result.apiFailures.length > 0) {
    result.errors.push(
      `unexpected API request failures: ${result.apiFailures
        .map((call) => `${call.method} ${call.url} (${call.failure})`)
        .join('; ')}`,
    );
  }
}
