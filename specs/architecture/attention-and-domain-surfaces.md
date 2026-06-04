# Attention And Domain Surfaces

This is the durable architecture for the standalone feature-gap work. The
archived remediation plan is only history; this file describes the current
product and implementation contract.

## Attention Model

Attention is a frontend-owned view model. Domain contributors derive
`attention` and `watch` items from live facts, then Home, nav, and focused
routes consume the same composed model. There must not be separate Home/nav
state or acknowledgement state that can drift from focused-route data.

Rules:

- Attention controls prominence, not visibility.
- Focused routes continue to show the full relevant dataset.
- Home summarizes abnormal city state instead of becoming a dense command
  center.
- Contributors live near their domain data model and register with the shared
  composer.
- GC-owned reads and supported writes go through the generated supervisor
  client; dashboard-service writes are limited to local host capabilities.

## Domain Surfaces

Runs:

- Uses generated supervisor formula feed, bead, session, workflow snapshot, and
  formula detail data.
- Highlights failed, blocked, waiting, partial, unavailable, unverifiable, and
  stalled/thrashing run states.
- Keeps execution-folder git diff as a dashboard-local `/api/*` resource.

Agents:

- Uses generated supervisor agents, sessions, transcripts, pending interaction
  reads, and respond writes.
- Highlights failed/stuck/crashed, detached, running-without-session, suspended,
  idle-stale, unavailable, and pending-interaction states.
- Provides attach-copy plus direct approve/deny when the supervisor exposes a
  pending response surface.

Beads:

- Uses generated supervisor bead list/detail/update/close/create/sling/nudge
  surfaces.
- Defaults to current engineering work, including decision, epic, and chore
  rows, so nav counts cannot claim work that the page hides.
- Highlights blocked, high-priority, stale unclaimed, stale assigned, partial,
  and unavailable bead states.
- Supports rig filtering when the supervisor bead query exposes rig data.

Mail:

- Uses generated supervisor mail list/thread/send/reply/archive/read-state
  surfaces.
- Viewing-as affects reads only; sends remain operator-authored.
- Supports all-traffic, history-depth expansion through `limit`, client-side
  search, and local time-window filtering over fetched messages.
- True supervisor clock-window queries remain upstream gap `GC-13` unless
  operator feedback proves they are needed.

Activity:

- Combines dashboard-local git/build/deploy evidence with generated supervisor
  event history.
- Event-derived attention links to filtered Activity views.
- Live refresh uses supervisor event streams through the direct/transport
  supervisor path.

Health:

- Combines generated supervisor health/status with dashboard-local host,
  process, local-tool, and dolt-noms facts.
- Supervisor diagnostics use a short generated-client request budget so host
  health renders even when the supervisor is slow.
- Richer rig/service health waits on upstream supervisor facts; no service/rig
  mutation controls are in scope.

Maintainer:

- Optional first-party module enabled by runtime config.
- Contributes attention only when enabled.
- Reads gh/GitHub triage as dashboard-local evidence.
- Dispatches through generated supervisor sling from the browser, then records
  maintainer-local slung-state/audit facts through the dashboard service.

## Calibration And Deferred Scope

The stale-agent, stale-bead, and stale-mail thresholds are intentionally initial
values. Tune them with fixtures and operator feedback.

Still deferred unless real operator pain justifies them:

- dedicated convoy workspace
- rich stopped-city guardrails
- command palette
- raw JSON inspectors
- global output/action-log panels
- full legacy bead administration parity
- service/rig restart, suspend, resume, or run/order execution controls

## Browser QA

`npm run browser:test` is the local browser regression gate. It expects the
dashboard backend/frontend to be running and drives the served app with
Playwright. The root harness visits city-scoped Home, Agents, Beads, Runs,
Mail, Activity, Health, and enabled first-party module surfaces. The Formula
Run Detail harness clicks through `/runs` into mocked detail data.

In test mode, the harness fails on unexpected dashboard `/api/*` and supervisor
`/gc-supervisor/*` HTTP failures while ignoring browser-aborted transition
requests.
