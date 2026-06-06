// Playwright route installer for the static "test-city" supervisor fixture.
//
// Intercepts every `/gc-supervisor/*` proxy call a page makes and fulfills it
// from the seeded snapshot in `gas-city-dashboard-shared/fixtures/test-city`,
// so the dashboard's supervisor-backed tabs (Agents/Runs/Beads/Mail/Sessions/
// Health) render deterministic, known state WITHOUT a live `gc` supervisor or a
// live city. Dashboard-owned `/api/*` calls are left untouched — they pass
// through to whatever backend is serving the page.
//
// Usage (from a Playwright script):
//   import { installSupervisorFixtures } from './fixtures/install-supervisor-fixtures.mjs';
//   await installSupervisorFixtures(page);
//   await page.goto(`${cityBase}/beads`, ...);
//
// Requires the shared workspace to be built (`npm run build:shared`).

import {
  buildTestCitySupervisorData,
  matchTestCitySupervisorRequest,
  renderTestCityEventStream,
} from 'gas-city-dashboard-shared/fixtures/test-city';

const SUPERVISOR_GLOB = '**/gc-supervisor/**';

/**
 * Register the fixture route handler on a Playwright Page (or BrowserContext).
 * Returns the seeded snapshot so callers can assert against the exact data.
 *
 * The supervisor data is city-agnostic (the matcher ignores the `/city/<name>/`
 * segment), so the fixture serves whatever city the host dashboard is scoped
 * to. Pass `activeCity` to make the seeded `/v0/cities` list advertise that
 * same city, keeping the header's city switcher consistent with the active
 * city — leave it unset to advertise the default `test-city`.
 *
 * @param {import('playwright').Page | import('playwright').BrowserContext} target
 * @param {{ nowMs?: number, activeCity?: string }} [opts]
 */
export async function installSupervisorFixtures(target, opts = {}) {
  const built = buildTestCitySupervisorData(opts.nowMs);
  const data =
    typeof opts.activeCity === 'string' && opts.activeCity.length > 0
      ? {
          ...built,
          cities: [
            { name: opts.activeCity, path: `/tmp/${opts.activeCity}`, running: true, status: 'ok' },
          ],
        }
      : built;
  const streamBody = renderTestCityEventStream(data);

  await target.route(SUPERVISOR_GLOB, (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const pathname = url.pathname;

    // SSE streams: serve a finite event-stream body. EventSource opens (the
    // dashboard's stream badge goes live), reads the seeded events, then the
    // long `retry` directive keeps it from reconnect-storming during a test.
    if (pathname.endsWith('/stream')) {
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
        body: streamBody,
      });
    }

    const matched = matchTestCitySupervisorRequest(data, method, pathname, url.searchParams);
    if (matched !== null) {
      return route.fulfill({
        status: matched.status,
        contentType: matched.contentType,
        body: matched.body,
      });
    }

    // Unseeded supervisor endpoint: answer with an explicit 501 rather than
    // passing silently, so a view that depends on data the fixture doesn't
    // cover surfaces as a visible gap (e.g. run-detail drill-in) instead of a
    // false all-clear.
    return route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'test-city fixture: no seed for this supervisor endpoint',
        method,
        path: pathname,
      }),
    });
  });

  return data;
}
