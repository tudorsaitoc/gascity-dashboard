// Snap and smoke-test the formula run detail route with deterministic API data.
//
// Usage:
//   node scripts/snap-formula-run-detail.mjs
//   node scripts/snap-formula-run-detail.mjs dark
//   node scripts/snap-formula-run-detail.mjs --test
//   node scripts/snap-formula-run-detail.mjs --test light --inject-late-api-failure
//
// Starts at /runs, clicks the deterministic scoped lane, then validates
// the run detail view, active session evidence, partial snapshots, and
// historical-only transcripts. In --test mode, any /api/* failure across the
// full journey fails the run.
//
// Output: /tmp/cp-snaps/<theme>-formula-run-detail*.png at 1440x900.

import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// BASE is env-configurable so an isolated worktree dev stack (its own
// backend PORT + a vite instance proxying /api to it on an alternate port)
// can be driven without touching the primary :5174 the user may be viewing.
// Default keeps the historic single-tree behaviour.
const BASE = process.env.SNAP_BASE || 'http://127.0.0.1:5174';
// gascity-dashboard-ucc: the dashboard is now city-scoped. The browser route
// carries a `/city/:cityName` basename and every city-scoped API call rides
// `/api/city/:cityName/*`. The harness navigates under this city and mocks
// the city-scoped request plane.
const CITY = 'racoon-city';
const CITY_BASE = `${BASE}/city/${CITY}`;
const OUT = '/tmp/cp-snaps';
const THEMES = ['light', 'dark'];
const TEST_MODE = argv.includes('--test');
const INJECT_LATE_API_FAILURE = argv.includes('--inject-late-api-failure');
const themeArg = argv.find((arg) => THEMES.includes(arg));
const wantThemes = themeArg ? [themeArg] : THEMES;
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../frontend/src/test/fixtures/formula-run-detail.json',
);

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

await mkdir(OUT, { recursive: true });

async function runTheme(browser, theme) {
  const result = { theme, skipped: null, errors: [], info: {} };
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    storageState: {
      cookies: [],
      origins: [{ origin: BASE, localStorage: [{ name: 'gascity:theme', value: theme }] }],
    },
  });
  await installApiFixtureRoutes(ctx);
  const page = await ctx.newPage();
  const apiCalls = [];
  const apiFailures = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) {
      apiCalls.push({
        url: url.toString(),
        method: response.request().method(),
        status: response.status(),
      });
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      apiFailures.push({
        url: url.toString(),
        method: request.method(),
        failure: request.failure()?.errorText ?? 'request failed',
      });
    }
  });

  try {
    try {
      await page.goto(`${CITY_BASE}/runs`, {
        waitUntil: 'domcontentloaded',
        timeout: 5_000,
      });
    } catch (err) {
      if (String(err).includes('ERR_CONNECTION_REFUSED') || String(err).includes('net::ERR')) {
        result.skipped = 'no-frontend';
        return result;
      }
      throw err;
    }

    const summaryLane = page.getByRole('link', { name: /adopt pr #42/i });
    await summaryLane.waitFor({ timeout: 5_000 });
    await summaryLane.click();
    await page.waitForURL(
      `${CITY_BASE}/runs/gc-adopt-pr-active?scope_kind=city&scope_ref=racoon-city`,
      { timeout: 5_000 },
    );
    await page.getByRole('heading', { name: /adopt pr #42/i }).waitFor({ timeout: 5_000 });
    await page.getByText(/v11 · seq 91/i).waitFor({ timeout: 5_000 });
    await page.getByRole('heading', { name: /formula graph/i }).waitFor({ timeout: 5_000 });
    await page.getByRole('heading', { name: /local changes/i }).waitFor({ timeout: 5_000 });
    await page.getByText('preserve failed attempt transcript links').waitFor({ timeout: 5_000 });
    await page.getByText('old session guard').waitFor({ timeout: 5_000 });
    // Related section (gascity-dashboard-j4x) — RK3 density gate. The
    // high-volume fixture (40 molecule members + 3 unresolved links) must
    // render exactly one aggregate maroon mark in the whole viewport, cap
    // rows per group with a `+ N more`, and pass the greyscale test (every
    // state still readable without colour).
    const relatedHeading = page.getByRole('heading', { name: /^related$/i });
    await relatedHeading.waitFor({ timeout: 5_000 });
    await page.getByText(/40 resolved, 3 unresolved/i).waitFor({ timeout: 5_000 });
    // One Mark Rule: at most one maroon (the .text-accent class) on the
    // page once the Related summary line crosses the unresolved threshold.
    const maroonCount = await page.locator('.text-accent').count();
    if (maroonCount > 1) {
      result.errors.push(`Related section broke the One Mark Rule, maroon count=${maroonCount}`);
    }
    await page.getByRole('button', { name: /show detail/i }).click();
    // Density: the 40-member molecule group must collapse to a `+ N more`.
    await page.getByText(/\+ \d+ more/i).waitFor({ timeout: 5_000 });
    await page.getByRole('button', { name: /hide detail/i }).click();

    await page.getByRole('tab', { name: /session/i }).click();
    await page.getByText(/select a node/i).waitFor({ timeout: 5_000 });

    const reviewNode = page.getByRole('button', { name: /multi-model review pipeline/i });
    const initiallySelected = await reviewNode.getAttribute('aria-pressed');
    if (initiallySelected !== 'false') {
      result.errors.push(`review-pipeline started selected, aria-pressed=${initiallySelected}`);
    }

    await reviewNode.click();
    await page.getByText(/checking graph\.v2 node grouping/i).waitFor({ timeout: 5_000 });
    await page
      .getByText(/streaming: preserving active-session progress/i)
      .waitFor({ timeout: 5_000 });
    await page.getByRole('radio', { name: /iteration 1/i }).click();
    await page.getByText(/found two issues/i).waitFor({ timeout: 5_000 });
    await page.getByText(/^historical$/i).waitFor({ timeout: 5_000 });
    await expectTextCount(
      page.getByText(/streaming: preserving active-session progress/i),
      0,
      result,
      'historical iteration unexpectedly kept the active session stream text visible',
    );
    await page.getByRole('radio', { name: /iteration 2/i }).click();
    await page.getByText(/checking graph\.v2 node grouping/i).waitFor({ timeout: 5_000 });
    await page
      .getByText(/streaming: preserving active-session progress/i)
      .waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);

    const selected = await page
      .getByRole('button', { name: /multi-model review pipeline/i })
      .getAttribute('aria-pressed');
    if (selected !== 'true') {
      result.errors.push(`review-pipeline was not selected, aria-pressed=${selected}`);
    }

    const snapPath = `${OUT}/${theme}-formula-run-detail.png`;
    await page.screenshot({ path: snapPath, fullPage: false });
    result.info.snap = snapPath;

    await reviewNode.click();
    await page.getByText(/select a node/i).waitFor({ timeout: 5_000 });
    const cleared = await reviewNode.getAttribute('aria-pressed');
    if (cleared !== 'false') {
      result.errors.push(`review-pipeline did not toggle off, aria-pressed=${cleared}`);
    }

    await reviewNode.focus();
    await page.keyboard.press('Enter');
    await page.getByText(/checking graph\.v2 node grouping/i).waitFor({ timeout: 5_000 });
    const keyboardSelected = await reviewNode.getAttribute('aria-pressed');
    if (keyboardSelected !== 'true') {
      result.errors.push(`Enter did not select review-pipeline, aria-pressed=${keyboardSelected}`);
    }
    await page.keyboard.press('Escape');
    await page.getByText(/select a node/i).waitFor({ timeout: 5_000 });
    const escapeCleared = await reviewNode.getAttribute('aria-pressed');
    if (escapeCleared !== 'false') {
      result.errors.push(`Escape did not clear review-pipeline, aria-pressed=${escapeCleared}`);
    }

    await page.getByRole('button', { name: /pre-approval ci repair loop/i }).click();
    await page.getByText(/session unresolved for this node/i).waitFor({ timeout: 5_000 });

    await page.goto(`${CITY_BASE}/runs/gc-adopt-pr-partial`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/partial run data/i).waitFor({ timeout: 5_000 });

    await page.goto(`${CITY_BASE}/runs/gc-adopt-pr-active?node=old-only-review`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/historical-only/i).waitFor({ timeout: 5_000 });
    await page.getByText(/found two issues/i).waitFor({ timeout: 5_000 });
    const hiddenCount = await page.getByRole('button', { name: /old-only review/i }).count();
    if (hiddenCount !== 0) {
      result.errors.push(`historical-only node rendered in graph, count=${hiddenCount}`);
    }
    const hiddenSnapPath = `${OUT}/${theme}-formula-run-detail-historical-only.png`;
    await page.screenshot({ path: hiddenSnapPath, fullPage: false });
    result.info.hiddenSnap = hiddenSnapPath;

    await page.goto(`${CITY_BASE}/runs/gc-no-graph`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/no graph nodes have materialized/i).waitFor({ timeout: 5_000 });

    await page.goto(`${CITY_BASE}/runs/gc-not-git`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/not a git work tree/i).waitFor({ timeout: 5_000 });

    await page.goto(`${CITY_BASE}/runs/gc-path-unknown`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/execution folder is unknown/i).waitFor({ timeout: 5_000 });

    await page.goto(`${CITY_BASE}/runs/gc-clean-worktree`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/no renderable patch/i).waitFor({ timeout: 5_000 });

    recordApiFailures(result, apiCalls, apiFailures);
    result.info.apiCalls = apiCalls;
    result.info.apiFailures = apiFailures;
  } finally {
    await ctx.close();
  }

  return result;
}

async function expectTextCount(locator, expected, result, message) {
  const count = await locator.count();
  if (count !== expected) result.errors.push(`${message}, count=${count}`);
}

function recordApiFailures(result, apiCalls, apiFailures) {
  const failedApiCalls = apiCalls.filter((call) => call.status >= 400);
  if (failedApiCalls.length > 0) {
    result.errors.push(
      `unexpected API failures: ${failedApiCalls
        .map((call) => `${call.status} ${call.url}`)
        .join('; ')}`,
    );
  }
  if (apiFailures.length > 0) {
    result.errors.push(
      `unexpected API request failures: ${apiFailures
        .map((call) => `${call.method} ${call.url} (${call.failure})`)
        .join('; ')}`,
    );
  }
}

async function installApiFixtureRoutes(context) {
  // The city switcher (Header) lists managed cities via the non-city-scoped
  // `/api/cities`. Mock it so the harness needs no live supervisor.
  await context.route('**/api/cities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ name: CITY, running: true }],
        total: 1,
      }),
    });
  });

  // All city-scoped endpoints now ride `/api/city/:cityName/*`. The glob
  // `*` segment matches the city name. session-stream lives under its own
  // `/session-stream/` prefix (distinct from the REST `/sessions/`), so the
  // peek and stream mocks target different paths.
  await context.route('**/api/city/*/snapshot', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshotFixture()),
    });
  });

  await context.route('**/api/city/*/events/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: 'retry: 60000\n: formula run detail fixture\n\n',
    });
  });

  await context.route('**/api/city/*/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cityName: 'racoon-city',
        cityRoot: '/tmp/gascity',
        useFixtures: false,
      }),
    });
  });

  await context.route('**/api/city/*/runs/gc-adopt-pr-partial**', async (route) => {
    if (INJECT_LATE_API_FAILURE && route.request().url().includes('/diff')) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'injected late diff failure' }),
      });
      return;
    }
    const payload = route.request().url().includes('/diff')
      ? fixture.diff
      : { ...fixture.detail, runId: 'gc-adopt-pr-partial', completeness: { kind: 'partial', reasons: ['supervisor_snapshot_partial'] } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/city/*/runs/gc-adopt-pr-active**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? fixture.diff
      : fixture.detail;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/city/*/runs/gc-no-graph**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? fixture.diff
      : {
          ...fixture.detail,
          runId: 'gc-no-graph',
          nodes: fixture.detail.nodes.map((node) => ({
            ...node,
            visibleInGraph: false,
            historicalOnly: true,
          })),
          edges: [],
          lanes: [],
        };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/city/*/runs/gc-not-git**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? {
          kind: 'not_git',
          rootPath: { kind: 'unavailable', reason: 'not_git' },
          status: [],
          changedFiles: [],
          unstagedDiff: '',
          stagedDiff: '',
          truncated: false,
        }
      : { ...fixture.detail, runId: 'gc-not-git' };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/city/*/runs/gc-path-unknown**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? {
          kind: 'path_unknown',
          rootPath: { kind: 'unavailable', reason: 'path_unknown' },
          status: [],
          changedFiles: [],
          unstagedDiff: '',
          stagedDiff: '',
          truncated: false,
        }
      : {
          ...fixture.detail,
          runId: 'gc-path-unknown',
          executionPath: { kind: 'unavailable', reason: 'missing_cwd_and_rig_root' },
        };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/city/*/runs/gc-clean-worktree**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? {
          kind: 'ok',
          rootPath: { kind: 'known', path: '/tmp/gascity/adopt-pr-42' },
          status: [],
          changedFiles: [],
          unstagedDiff: '',
          stagedDiff: '',
          truncated: false,
        }
      : { ...fixture.detail, runId: 'gc-clean-worktree' };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  // Bead-ID linked view (gascity-dashboard-j4x). A high-volume fixture
  // (40-entity stuck run) exercises RK3 density discipline: capped rows
  // per group + `+ N more`, the unresolved/derived/staleness summary line,
  // and exactly ONE aggregate section-level maroon. Without this route the
  // --test harness would fail on the unmocked /api/links/* call the
  // WorkflowRunDetail Related section now makes.
  await context.route('**/api/city/*/links/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(highVolumeLinkView()),
    });
  });

  await context.route('**/api/city/*/sessions/*/peek', async (route) => {
    const sessionId = route
      .request()
      .url()
      .match(/\/api\/city\/[^/]+\/sessions\/([^/]+)\/peek$/)?.[1];
    const transcript = sessionId ? fixture.transcripts[decodeURIComponent(sessionId)] : null;
    if (!transcript) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'missing transcript fixture' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(transcript),
    });
  });

  // Session SSE stream rides its own `/session-stream/` prefix (distinct from
  // the REST `/sessions/`) — see city/runtime.ts + api.sessionStreamUrl.
  await context.route('**/api/city/*/session-stream/*/stream', async (route) => {
    const sessionId = route
      .request()
      .url()
      .match(/\/api\/city\/[^/]+\/session-stream\/([^/]+)\/stream$/)?.[1];
    const turns = sessionId ? fixture.streamTurns[decodeURIComponent(sessionId)] ?? [] : [];
    const body = turns
      .map((turn) => `event: turn\ndata: ${JSON.stringify(turn)}\n\n`)
      .join('');
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body,
    });
  });
}

function highVolumeLinkView() {
  const focus = { key: 'bead:racoon-city:gc-adopt-pr-active', type: 'bead', ref: 'gc-adopt-pr-active' };
  const nodes = [
    { ...focus, title: 'Adopt PR #42', status: 'in_progress', url: null, fetchedAt: '2026-05-25T00:00:00Z', unresolved: false },
  ];
  const edges = [];
  // 40 molecule-member beads (resolved) — exercises the per-group cap.
  for (let i = 0; i < 40; i += 1) {
    const key = `bead:racoon-city:gc-step-${i}`;
    nodes.push({ key, type: 'bead', ref: `gc-step-${i}`, title: `step ${i}`, status: 'closed', url: null, fetchedAt: '2026-05-25T00:00:00Z', unresolved: false });
    edges.push({ from: focus.key, to: key, relation: 'molecule', provenance: 'supervisor', resolved: true });
  }
  // A merged-and-vanished PR (unresolved + stale 24h) and two unresolved
  // issues — three unresolved links cross the aggregate-maroon threshold.
  nodes.push({ key: 'github_pr:github:42', type: 'github_pr', ref: 'pr/42', title: null, status: null, url: 'https://github.com/gastownhall/gascity-dashboard/pull/42', fetchedAt: '2026-05-24T00:00:00Z', unresolved: true });
  edges.push({ from: focus.key, to: 'github_pr:github:42', relation: 'pr', provenance: 'supervisor', resolved: false });
  for (const n of ['7', '8']) {
    nodes.push({ key: `github_issue:github:${n}`, type: 'github_issue', ref: `issue/${n}`, title: null, status: null, url: null, fetchedAt: null, unresolved: true });
    edges.push({ from: focus.key, to: `github_issue:github:${n}`, relation: 'issue', provenance: 'supervisor', resolved: false });
  }
  return {
    focus,
    nodes,
    edges,
    stats: [
      { relation: 'molecule', resolved: 40, unresolved: 0, nCandidates: 0 },
      { relation: 'pr', resolved: 0, unresolved: 1, nCandidates: 0 },
      { relation: 'issue', resolved: 0, unresolved: 2, nCandidates: 0 },
    ],
    partial: false,
    generatedAt: '2026-05-25T00:00:00.000Z',
    asOf: '2026-05-24T00:00:00Z',
  };
}

function snapshotFixture() {
  return {
    generatedAt: '2026-05-25T00:00:00.000Z',
    config: {
      cityName: 'racoon-city',
      cityRoot: '/tmp/gascity',
      useFixtures: false,
    },
    headline: {
      activeAgents: unavailableMetric('city', 'city unavailable in fixture'),
      maxAgents: unavailableMetric('city', 'city unavailable in fixture'),
      activeSessions: unavailableMetric('city', 'city unavailable in fixture'),
      activeRuns: { status: 'available', value: 1 },
      workInProgress: { status: 'available', value: 1 },
    },
    sources: {
      city: sourceUnavailable('city', 'city unavailable in fixture'),
      resources: sourceUnavailable('resources', 'resources unavailable in fixture'),
      work: sourceFixture('work', { open: 1, ready: 0, inProgress: 1 }),
      runs: sourceFixture('runs', {
        totalActive: 1,
        // yh5i: shared RunSummary now carries totalHistorical +
        // historicalLanes. This is a .mjs fixture and isn't typechecked,
        // so the shape must be kept in lockstep with shared/src by hand.
        totalHistorical: 0,
        runCounts: {
          total: 1,
          visible: 1,
          prReview: 1,
          designReview: 0,
          bugfix: 0,
          blocked: 0,
          other: 0,
        },
        lanes: [runLaneFixture()],
        historicalLanes: [],
        recentChanges: [],
        census: {
          status: 'unavailable',
          error: 'run health has not been derived',
        },
      }),
    },
  };
}

function runLaneFixture() {
  return {
    id: 'gc-adopt-pr-active',
    title: 'Adopt PR #42',
    formula: { status: 'known', name: 'mol-adopt-pr-v2' },
    scope: {
      status: 'available',
      kind: 'city',
      ref: 'racoon-city',
      rootStoreRef: 'city:racoon-city',
    },
    external: { status: 'unavailable', error: 'external unavailable in fixture' },
    phase: 'review',
    phaseLabel: 'Review',
    statusCounts: {
      active: 3,
      completed: 1,
      ready: 1,
      skipped: 1,
    },
    activeAssignees: ['gc-session-review-i2'],
    updatedAt: {
      status: 'available',
      at: '2026-05-25T00:00:00.000Z',
    },
    stages: [
      { key: 'intake', label: 'Intake', status: 'complete' },
      { key: 'implementation', label: 'Implementation', status: 'complete' },
      { key: 'review', label: 'Review', status: 'active' },
      { key: 'approval', label: 'Approval', status: 'pending' },
      { key: 'finalization', label: 'Finalization', status: 'pending' },
    ],
    progress: {
      status: 'active_step',
      stepId: 'review-pipeline',
      stage: {
        status: 'available',
        index: 2,
        key: 'review',
        label: 'Review',
      },
      attempt: {
        status: 'available',
        value: 2,
      },
    },
    formulaStageResolved: true,
    health: {
      status: 'unavailable',
      error: 'run health has not been derived',
    },
  };
}

function sourceFixture(source, data) {
  return {
    source,
    status: 'fresh',
    fetchedAt: '2026-05-25T00:00:00.000Z',
    staleAt: '2026-05-25T00:01:00.000Z',
    error: { kind: 'none' },
    data,
  };
}

function sourceUnavailable(source, error) {
  return {
    source,
    status: 'error',
    error,
  };
}

function unavailableMetric(source, error) {
  return {
    status: 'unavailable',
    source,
    error,
  };
}

const browser = await chromium.launch();
const results = [];
try {
  for (const theme of wantThemes) {
    results.push(await runTheme(browser, theme));
  }
} finally {
  await browser.close();
}

let hadErrors = false;
for (const result of results) {
  if (result.skipped === 'no-frontend') {
    console.log(`[${result.theme}] SKIP, frontend not reachable at ${BASE}`);
    continue;
  }
  if (result.info.snap) console.log(`[${result.theme}] snap ${result.info.snap}`);
  if (result.info.hiddenSnap) {
    console.log(`[${result.theme}] snap ${result.info.hiddenSnap}`);
  }
  if (TEST_MODE) {
    for (const call of result.info.apiCalls ?? []) {
      console.log(`[${result.theme}] api ${call.status} ${call.method} ${call.url}`);
    }
    for (const call of result.info.apiFailures ?? []) {
      console.log(`[${result.theme}] api failed ${call.method} ${call.url} (${call.failure})`);
    }
  }
  if (result.errors.length > 0) {
    hadErrors = true;
    for (const error of result.errors) console.error(`[${result.theme}] FAIL, ${error}`);
  } else if (TEST_MODE) {
    console.log(`[${result.theme}] PASS`);
  }
}

if (TEST_MODE) {
  if (hadErrors) {
    console.error('formula run detail snapshot: FAILED');
    exit(1);
  }
  const ranAny = results.some((result) => result.skipped === null);
  if (!ranAny) {
    console.log('formula run detail snapshot: SKIPPED (no live frontend)');
    exit(0);
  }
  console.log('formula run detail snapshot: PASSED');
}
