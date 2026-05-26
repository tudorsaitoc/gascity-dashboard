// Live sample-city smoke test for graph.v2 workflow run detail.
//
// This intentionally hits the running dashboard and supervisor-backed APIs.
// It verifies that the sample todo and tic-tac-toe planning and implementation
// runs are present, clickable from /workflows, and render as real run-detail
// pages with backend-owned progress, graph selection, diff evidence, and session
// empty/state handling.
//
// Usage:
//   node scripts/e2e-sample-workflow-runs.mjs
//
// Optional:
//   DASHBOARD_BASE_URL=http://127.0.0.1:5174 node scripts/e2e-sample-workflow-runs.mjs

import { chromium } from 'playwright';
import { exit } from 'node:process';

const BASE = process.env.DASHBOARD_BASE_URL ?? 'http://127.0.0.1:5174';
const EXPECTED_RUNS = [
  {
    key: 'todo planning',
    scopeKind: 'rig',
    scopeRef: 'todo-app',
    title: /plan\b.*todo/i,
  },
  {
    key: 'todo implementation',
    scopeKind: 'rig',
    scopeRef: 'todo-app',
    title: /implement|implementation/i,
  },
  {
    key: 'tic-tac-toe planning',
    scopeKind: 'rig',
    scopeRef: 'tic-tac-toe-app',
    title: /plan\b.*tic tac toe/i,
  },
  {
    key: 'tic-tac-toe implementation',
    scopeKind: 'rig',
    scopeRef: 'tic-tac-toe-app',
    title: /implement|implementation/i,
  },
];

const snapshot = await fetchJson(`${BASE}/api/snapshot`);
const lanes = snapshot?.sources?.workflows?.data?.lanes;
if (!Array.isArray(lanes)) {
  console.error('sample workflow e2e: FAILED');
  console.error('  /api/snapshot did not include sources.workflows.data.lanes');
  exit(1);
}

const foundRuns = [];
const missingRuns = [];
for (const expected of EXPECTED_RUNS) {
  const lane = lanes.find((candidate) => laneMatches(candidate, expected));
  if (lane) foundRuns.push({ expected, lane });
  else missingRuns.push(expected);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  storageState: {
    cookies: [],
    origins: [
      {
        origin: BASE,
        localStorage: [{ name: 'gascity:theme', value: 'light' }],
      },
    ],
  },
});

const page = await context.newPage();
const errors = [];
const apiCalls = [];
const apiFailures = [];

page.on('response', (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith('/api/')) {
    apiCalls.push({
      status: response.status(),
      method: response.request().method(),
      url: url.toString(),
    });
  }
});

page.on('requestfailed', (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/api/')) {
    apiFailures.push({
      method: request.method(),
      url: url.toString(),
      failure: request.failure()?.errorText ?? 'request failed',
    });
  }
});

page.on('console', (message) => {
  if (message.type() === 'error') {
    errors.push(`browser console error: ${message.text()}`);
  }
});

try {
  for (const { expected, lane } of foundRuns) {
    await verifyRun(page, expected, lane, errors);
  }
} finally {
  await context.close();
  await browser.close();
}

recordApiFailures(errors, apiCalls, apiFailures);

for (const missing of missingRuns) {
  errors.push(
    `missing ${missing.key} run for ${missing.scopeKind}:${missing.scopeRef} on /workflows`,
  );
}

console.log(`sample workflow e2e: found ${foundRuns.length}/${EXPECTED_RUNS.length} expected runs`);
for (const { expected, lane } of foundRuns) {
  console.log(`  found ${expected.key}: ${lane.id} (${lane.title})`);
}
for (const missing of missingRuns) {
  console.log(`  missing ${missing.key}: ${missing.scopeKind}:${missing.scopeRef}`);
}

if (errors.length > 0) {
  console.error('sample workflow e2e: FAILED');
  for (const error of errors) console.error(`  ${error}`);
  exit(1);
}

console.log('sample workflow e2e: PASSED');

async function verifyRun(page, expected, lane, errors) {
  const detailUrl = workflowDetailApiUrl(lane);
  const diffUrl = workflowDiffApiUrl(lane);
  const detail = await fetchJson(detailUrl);
  const diff = await fetchJson(diffUrl);
  validateDetailPayload(expected, lane, detail, errors);
  validateDiffPayload(expected, diff, errors);

  await page.goto(`${BASE}/workflows`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.getByRole('heading', { name: 'Workflows' }).waitFor({ timeout: 10_000 });
  const laneLink = page.getByRole('link', { name: lane.title });
  const laneLinkCount = await waitForLocatorCount(laneLink, 1, 10_000);
  if (laneLinkCount !== 1) {
    errors.push(`${expected.key}: expected one /workflows link named "${lane.title}", got ${laneLinkCount}`);
    return;
  }

  await laneLink.click();
  await page.waitForURL(
    `${BASE}/workflows/${encodeURIComponent(lane.id)}?scope_kind=${lane.scopeKind}&scope_ref=${lane.scopeRef}`,
    { timeout: 10_000 },
  );
  await page.locator('h1').filter({ hasText: detail.title }).waitFor({ timeout: 10_000 });
  await page.getByRole('heading', { name: 'Formula Graph' }).waitFor({ timeout: 10_000 });

  const synopsis = page.locator('header p').filter({
    hasText: `${detail.progress.visibleNodeCount} nodes, ${detail.progress.edgeCount} edges`,
  });
  if ((await synopsis.count()) !== 1) {
    errors.push(`${expected.key}: detail header did not render backend progress counts`);
  }

  const graphButtons = page.locator('section[aria-label="Workflow graph"] button');
  const graphButtonCount = await graphButtons.count();
  if (graphButtonCount !== detail.progress.visibleNodeCount) {
    errors.push(
      `${expected.key}: graph rendered ${graphButtonCount} selectable nodes, expected ${detail.progress.visibleNodeCount}`,
    );
  }
  if (graphButtonCount === 0) return;

  const selectableNodes = detail.nodes.filter((node) => node.visibleInGraph !== false);
  const sessionNodeIndex = selectableNodes.findIndex((node) =>
    node.executionInstances.some((instance) => instance.sessionLink),
  );
  const selectedIndex = sessionNodeIndex >= 0 ? sessionNodeIndex : 0;
  const selectedNode = selectableNodes[selectedIndex];
  if (!selectedNode) {
    errors.push(`${expected.key}: detail had visible graph buttons but no visible node payload`);
    return;
  }

  const selectedButton = graphButtons.nth(selectedIndex);
  await selectedButton.click();
  await expectPressedCount(page, expected.key, 1, errors);
  await selectedButton.click();
  await expectPressedCount(page, expected.key, 0, errors);

  await selectedButton.click();
  if (nodeHasSession(selectedNode)) {
    const sessionTab = page.getByRole('tab', { name: 'Session' });
    if (!(await sessionTab.isEnabled())) {
      errors.push(`${expected.key}: Session tab disabled for node "${selectedNode.title}" with a session link`);
    } else {
      await sessionTab.click();
      await page.locator('[role="tabpanel"]').waitFor({ timeout: 5_000 });
      await page.waitForTimeout(500);
    }
  } else {
    await page.getByText('No session is attached to this node.').waitFor({ timeout: 10_000 });
    const sessionDisabled = await page
      .getByRole('tab', { name: 'Session' })
      .evaluate((node) =>
        node instanceof HTMLButtonElement &&
        node.disabled &&
        node.getAttribute('aria-disabled') === 'true',
      );
    if (!sessionDisabled) {
      errors.push(`${expected.key}: Session tab stayed enabled for node "${selectedNode.title}" without a session`);
    }
  }
}

async function expectPressedCount(page, label, expectedCount, errors) {
  const count = await page
    .locator('section[aria-label="Workflow graph"] button[aria-pressed="true"]')
    .count();
  if (count !== expectedCount) {
    errors.push(`${label}: selected-node count was ${count}, expected ${expectedCount}`);
  }
}

async function waitForLocatorCount(locator, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() <= deadline) {
    lastCount = await locator.count();
    if (lastCount === expected) return lastCount;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return lastCount;
}

function validateDetailPayload(expected, lane, detail, errors) {
  if (detail.workflowId !== lane.id) {
    errors.push(`${expected.key}: detail.workflowId=${detail.workflowId}, lane.id=${lane.id}`);
  }
  if (detail.scopeKind !== expected.scopeKind || detail.scopeRef !== expected.scopeRef) {
    errors.push(`${expected.key}: detail scope is ${detail.scopeKind}:${detail.scopeRef}`);
  }
  if (!detail.progress || typeof detail.progress.visibleNodeCount !== 'number') {
    errors.push(`${expected.key}: detail payload is missing progress`);
  }
  if (!Array.isArray(detail.nodes) || detail.nodes.length === 0) {
    errors.push(`${expected.key}: detail payload has no nodes`);
  }
  if (!Array.isArray(detail.edges)) {
    errors.push(`${expected.key}: detail payload has no edges array`);
  }
}

function validateDiffPayload(expected, diff, errors) {
  if (!diff || typeof diff.kind !== 'string') {
    errors.push(`${expected.key}: diff payload missing kind`);
  }
  if (diff?.kind === 'error') {
    errors.push(`${expected.key}: diff endpoint returned error: ${diff.error ?? 'unknown error'}`);
  }
}

function laneMatches(candidate, expected) {
  return (
    candidate?.scopeKind === expected.scopeKind &&
    candidate?.scopeRef === expected.scopeRef &&
    typeof candidate?.title === 'string' &&
    expected.title.test(candidate.title)
  );
}

function nodeHasSession(node) {
  return node.executionInstances.some((instance) => instance.sessionLink);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function workflowDetailApiUrl(lane) {
  const query = new URLSearchParams({
    scope_kind: lane.scopeKind,
    scope_ref: lane.scopeRef,
  });
  return `${BASE}/api/workflows/${encodeURIComponent(lane.id)}?${query.toString()}`;
}

function workflowDiffApiUrl(lane) {
  const query = new URLSearchParams({
    scope_kind: lane.scopeKind,
    scope_ref: lane.scopeRef,
  });
  return `${BASE}/api/workflows/${encodeURIComponent(lane.id)}/diff?${query.toString()}`;
}

function recordApiFailures(errors, apiCalls, apiFailures) {
  const failedApiCalls = apiCalls.filter((call) => call.status >= 400);
  for (const call of failedApiCalls) {
    errors.push(`unexpected API failure: ${call.status} ${call.method} ${call.url}`);
  }
  for (const call of apiFailures) {
    const url = new URL(call.url);
    if (url.pathname === '/api/events/stream' && call.failure.includes('ERR_ABORTED')) {
      continue;
    }
    errors.push(`unexpected API request failure: ${call.method} ${call.url} (${call.failure})`);
  }
}
