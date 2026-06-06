# Static `test-city` supervisor fixture

A deterministic, seeded snapshot of GC-supervisor state used to drive the
dashboard's **supervisor-backed tabs** — Agents, Runs, Beads, Mail, Sessions,
Health — without a live `gc` supervisor or a live city.

## Why it exists

The dashboard has two data planes:

- **Dashboard-owned `/api/*`** — served by the dashboard's own backend. This
  plane already has a fixture path: `SNAPSHOT_USE_FIXTURES=1` makes each
  `SourceCache` fall back to canned data so the home/maintainer views stay
  renderable when upstream fails.
- **Supervisor-owned `/gc-supervisor/*`** — a transport-only proxy to the `gc`
  supervisor. The supervisor-backed tabs read this plane **directly** via the
  generated client. `SNAPSHOT_USE_FIXTURES` does **not** cover it, so before
  this fixture those tabs could only be exercised against whatever a live
  supervisor happened to hold — non-deterministic, and impossible in CI.

This fixture fills that gap. It seeds ~44 beads across every status and issue
type (two epics with children, a dependency-blocked cluster, three `graph.v2`
formula-run groups), 8 agents across states (incl. a stuck "needs you" agent),
their sessions (one with a pending operator approval), threaded mail across
read/unread, a monitor feed spanning running/blocked/failed/done, an event
stream including attention-class events, and health/status bodies.

## Where it lives

| Path                                               | Role                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/fixtures/test-city/data.ts`            | The typed seed — built against the **generated** supervisor types, so a wire-shape drift is a compile error. `buildTestCitySupervisorData(nowMs?)` returns the snapshot; timestamps are offsets from `nowMs` so seeded mail/events land in the views' relative windows. |
| `shared/src/fixtures/test-city/match.ts`           | Pure `(method, pathname, search) → response` matcher + the SSE stream renderer.                                                                                                                                                                                         |
| `shared/src/fixtures/test-city/test-city.test.ts`  | The **regression gate**: validates every payload against the generated **zod** schemas and asserts coverage invariants. Runs under `npm --workspace shared test` (CI).                                                                                                  |
| `scripts/fixtures/install-supervisor-fixtures.mjs` | Playwright route installer — intercepts `**/gc-supervisor/**` and fulfils from the snapshot.                                                                                                                                                                            |
| `scripts/snap-test-city.mjs`                       | Browser regression script that drives every supervisor-backed tab against the fixture and asserts known seeded content.                                                                                                                                                 |

Exported from shared as `gas-city-dashboard-shared/fixtures/test-city`.

## How the two regression gates relate

- **`shared` zod test** — always-on, deterministic, no browser. This is the CI
  gate: when the supervisor OpenAPI is regenerated and a shape changes, the
  fixture stops conforming and the test fails, forcing it back into line.
- **`scripts/snap-test-city.mjs`** — the browser gate. Like the other snap
  scripts it does **not** start its own server and **skips (exit 0)** when
  nothing is serving the base URL. It is wired into `npm run browser:test`.

## Pointing a dashboard at the fixture

The fixture is **city-agnostic** (the matcher ignores the `/city/<name>/`
segment) and only fakes the `/gc-supervisor/*` plane. The dashboard's own
`/api/*` plane stays real, so you drive the host's **real** configured city and
let the fixture serve its supervisor calls:

```bash
npm run build:shared          # the fixture import resolves from shared/dist
npm run dev:backend           # real /api plane (its configured GC_CITY_NAME)
npm run dev:frontend          # Vite on :5174

# In another shell, with the dev server up:
node scripts/snap-test-city.mjs --test
# or against the production node:
TEST_CITY_BASE=http://127.0.0.1:8082 node scripts/snap-test-city.mjs --test
```

`snap-test-city` discovers the host's real city from the shell, then installs
the fixture (scoped to that city so the header's city switcher stays
consistent) and asserts each tab. To reuse the installer in another Playwright
script:

```js
import { installSupervisorFixtures } from './fixtures/install-supervisor-fixtures.mjs';
const data = await installSupervisorFixtures(context, { activeCity });
// every /gc-supervisor/* call the page makes is now served from `data`.
```

## Scope boundary and where live data still helps

- **`gc city init` + registration is mayor-owned.** This fixture deliberately
  does **not** stand up a real city; it serves supervisor responses by route
  interception, which is enough for the list/board views and needs no live
  supervisor. The same seed could later back a real seeded city if one is
  provisioned (that step is the mayor's).
- **Live runs would extend drill-in coverage.** The fixture seeds the Runs
  _list_ (lane summaries from `graph.v2` bead groups) but not the per-run
  _detail_ drill-in (`/workflow/<id>`, `/formulas/<name>`) or session
  transcripts/streams — the installer answers those unseeded endpoints with an
  explicit `501` so a view that needs them surfaces the gap rather than a false
  all-clear. Exercising run-detail and transcript views against known state is
  the natural next increment.
