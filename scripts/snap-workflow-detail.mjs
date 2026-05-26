// Snap and smoke-test the workflow run detail route with deterministic API data.
//
// Usage:
//   node scripts/snap-workflow-detail.mjs
//   node scripts/snap-workflow-detail.mjs dark
//   node scripts/snap-workflow-detail.mjs --test
//   node scripts/snap-workflow-detail.mjs --test light --inject-late-api-failure
//
// Starts at /workflows, clicks the deterministic scoped lane, then validates
// the run detail view, active session evidence, partial snapshots, and
// historical-only transcripts. In --test mode, any /api/* failure across the
// full journey fails the run.
//
// Output: /tmp/cp-snaps/<theme>-workflow-detail*.png at 1440x900.

import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'http://127.0.0.1:5174';
const OUT = '/tmp/cp-snaps';
const THEMES = ['light', 'dark'];
const TEST_MODE = argv.includes('--test');
const INJECT_LATE_API_FAILURE = argv.includes('--inject-late-api-failure');
const themeArg = argv.find((arg) => THEMES.includes(arg));
const wantThemes = themeArg ? [themeArg] : THEMES;
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../frontend/src/test/fixtures/workflow-run-detail.json',
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
      await page.goto(`${BASE}/workflows`, {
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
      `${BASE}/workflows/gc-adopt-pr-active?scope_kind=city&scope_ref=racoon-city`,
      { timeout: 5_000 },
    );
    await page.getByRole('heading', { name: /adopt pr #42/i }).waitFor({ timeout: 5_000 });
    await page.getByText(/v11 · seq 91/i).waitFor({ timeout: 5_000 });
    await page.getByRole('heading', { name: /formula graph/i }).waitFor({ timeout: 5_000 });
    await page.getByRole('heading', { name: /^unstaged diff$/i }).waitFor({ timeout: 5_000 });
    await page.getByRole('heading', { name: /^staged diff$/i }).waitFor({ timeout: 5_000 });
    await expectTextCount(
      page.locator('.diff-line-add').filter({
        hasText: '+preserve failed attempt transcript links',
      }),
      1,
      result,
      'unstaged add line did not render with add diff class',
    );
    await expectTextCount(
      page.locator('.diff-line-remove').filter({ hasText: '-old session guard' }),
      1,
      result,
      'unstaged remove line did not render with remove diff class',
    );
    await expectTextCount(
      page.locator('.diff-line-hunk').filter({ hasText: '@@ -1,4 +1,4 @@' }),
      1,
      result,
      'unstaged hunk line did not render with hunk diff class',
    );
    await expectTextCount(
      page.locator('.diff-line-add').filter({ hasText: '+<StatusBadge label="live" />' }),
      1,
      result,
      'staged add line did not render with add diff class',
    );
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

    const snapPath = `${OUT}/${theme}-workflow-detail.png`;
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
    await page.getByText(/no session is attached/i).waitFor({ timeout: 5_000 });
    const sessionTabUnavailable = await page
      .getByRole('tab', { name: /session/i })
      .evaluate((node) =>
        node instanceof HTMLButtonElement &&
        node.disabled &&
        node.getAttribute('aria-disabled') === 'true',
      );
    if (!sessionTabUnavailable) {
      result.errors.push('Session tab stayed available for a selected node with no session link');
    }

    await page.goto(`${BASE}/workflows/gc-adopt-pr-partial`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/partial snapshot/i).waitFor({ timeout: 5_000 });

    await page.goto(`${BASE}/workflows/gc-adopt-pr-active?node=old-only-review`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/historical-only/i).waitFor({ timeout: 5_000 });
    await page.getByText(/found two issues/i).waitFor({ timeout: 5_000 });
    const hiddenCount = await page.getByRole('button', { name: /old-only review/i }).count();
    if (hiddenCount !== 0) {
      result.errors.push(`historical-only node rendered in graph, count=${hiddenCount}`);
    }
    const hiddenSnapPath = `${OUT}/${theme}-workflow-detail-historical-only.png`;
    await page.screenshot({ path: hiddenSnapPath, fullPage: false });
    result.info.hiddenSnap = hiddenSnapPath;

    await page.goto(`${BASE}/workflows/gc-no-graph`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/no graph nodes have materialized/i).waitFor({ timeout: 5_000 });

    await page.goto(`${BASE}/workflows/gc-not-git`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/not a git work tree/i).waitFor({ timeout: 5_000 });

    await page.goto(`${BASE}/workflows/gc-path-unknown`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/execution folder is unknown/i).waitFor({ timeout: 5_000 });

    await page.goto(`${BASE}/workflows/gc-clean-worktree`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.getByText(/no tracked-file diff/i).waitFor({ timeout: 5_000 });

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
  await context.route('**/api/snapshot', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshotFixture()),
    });
  });

  await context.route('**/api/events/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: 'retry: 60000\n: workflow detail fixture\n\n',
    });
  });

  await context.route('**/api/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cityName: 'racoon-city',
        cityRoot: '/tmp/gascity',
        githubRepo: 'sjarmak/gascity-dashboard',
        useFixtures: false,
      }),
    });
  });

  await context.route('**/api/workflows/gc-adopt-pr-partial**', async (route) => {
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
      : { ...fixture.detail, workflowId: 'gc-adopt-pr-partial', partial: true };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/workflows/gc-adopt-pr-active**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? fixture.diff
      : fixture.detail;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/workflows/gc-no-graph**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? fixture.diff
      : {
          ...fixture.detail,
          workflowId: 'gc-no-graph',
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

  await context.route('**/api/workflows/gc-not-git**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? {
          kind: 'not_git',
          rootPath: null,
          status: [],
          changedFiles: [],
          unstagedDiff: '',
          stagedDiff: '',
          truncated: false,
        }
      : { ...fixture.detail, workflowId: 'gc-not-git' };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/workflows/gc-path-unknown**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? {
          kind: 'path_unknown',
          rootPath: null,
          status: [],
          changedFiles: [],
          unstagedDiff: '',
          stagedDiff: '',
          truncated: false,
        }
      : { ...fixture.detail, workflowId: 'gc-path-unknown', executionPath: null };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/workflows/gc-clean-worktree**', async (route) => {
    const payload = route.request().url().includes('/diff')
      ? {
          kind: 'ok',
          rootPath: '/tmp/gascity/adopt-pr-42',
          status: [],
          changedFiles: [],
          unstagedDiff: '',
          stagedDiff: '',
          truncated: false,
        }
      : { ...fixture.detail, workflowId: 'gc-clean-worktree' };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('**/api/sessions/*/peek', async (route) => {
    const sessionId = route.request().url().match(/\/api\/sessions\/([^/]+)\/peek$/)?.[1];
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

  await context.route('**/api/sessions/*/stream', async (route) => {
    const sessionId = route.request().url().match(/\/api\/sessions\/([^/]+)\/stream$/)?.[1];
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

function snapshotFixture() {
  return {
    generatedAt: '2026-05-25T00:00:00.000Z',
    config: {
      cityName: 'racoon-city',
      cityRoot: '/tmp/gascity',
      githubRepo: 'sjarmak/gascity-dashboard',
      useFixtures: false,
    },
    headline: {
      activeAgents: null,
      maxAgents: null,
      activeSessions: null,
      activeWorkflows: 1,
      githubOpenReviews: null,
    },
    sources: {
      aimux: sourceFixture('aimux', null),
      city: sourceFixture('city', null),
      resources: sourceFixture('resources', null),
      workflows: sourceFixture('workflows', {
        totalActive: 1,
        runCounts: {
          total: 1,
          visible: 1,
          prReview: 1,
          designReview: 0,
          bugfix: 0,
          blocked: 0,
          other: 0,
        },
        lanes: [workflowLaneFixture()],
        recentChanges: [],
      }),
      github: sourceFixture('github', null),
      tokens: sourceFixture('tokens', null),
    },
  };
}

function workflowLaneFixture() {
  return {
    id: 'gc-adopt-pr-active',
    title: 'Adopt PR #42',
    formula: 'mol-adopt-pr-v2',
    scopeKind: 'city',
    scopeRef: 'racoon-city',
    rootStoreRef: 'city:racoon-city',
    externalUrl: null,
    externalLabel: null,
    phase: 'review',
    phaseLabel: 'Review',
    statusCounts: {
      active: 3,
      completed: 1,
      ready: 1,
      skipped: 1,
    },
    activeAssignees: ['gc-session-review-i2'],
    updatedAt: '2026-05-25T00:00:00.000Z',
    stages: [
      { key: 'intake', label: 'Intake', status: 'complete' },
      { key: 'implementation', label: 'Implementation', status: 'complete' },
      { key: 'review', label: 'Review', status: 'active' },
      { key: 'approval', label: 'Approval', status: 'pending' },
      { key: 'finalization', label: 'Finalization', status: 'pending' },
    ],
  };
}

function sourceFixture(source, data) {
  return {
    source,
    status: 'fresh',
    fetchedAt: '2026-05-25T00:00:00.000Z',
    staleAt: '2026-05-25T00:01:00.000Z',
    error: null,
    data,
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
    console.error('workflow detail snapshot: FAILED');
    exit(1);
  }
  const ranAny = results.some((result) => result.skipped === null);
  if (!ranAny) {
    console.log('workflow detail snapshot: SKIPPED (no live frontend)');
    exit(0);
  }
  console.log('workflow detail snapshot: PASSED');
}
