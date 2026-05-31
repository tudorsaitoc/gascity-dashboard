# Plan: Standalone Feature Gap Remediation

Date: 2026-05-31
Status: Draft plan from product disposition review
Source analysis: [`../feature-gap-analysis.md`](../feature-gap-analysis.md)

## Goal

Address the legacy-dashboard gaps we chose to fill in the standalone
`gascity-dashboard`, without recreating the legacy one-page command center or
expanding into fold-back work that belongs in the main `gascity` repo.

The product target is:

- Home summarizes abnormal city state at a glance.
- Nav tabs show themed attention/watch indicators for their domains.
- Focused tabs remain complete domain workspaces, with attention highlighted
  but non-attention data still visible and interactable.
- The frontend owns the attention model through domain contributors.
- The backend serves raw, typed, normalized data and audited write endpoints.

## Non-Goals

- `gc dashboard` launch/packaging integration.
- Legacy supervisor/fleet/no-city command-center mode.
- Legacy one-screen wall of panels.
- Full bead administration parity: reopen, priority/label editing, broad
  assign/unassign, escalations, queues, and assigned-work admin.
- Dedicated convoy workspace.
- Service/rig restart, suspend, or resume controls.
- Run/order execution controls.
- Command palette, raw JSON inspectors, global output panel, or global action
  log.

## Architecture Principles

1. **Attention is client-owned.** Backend DTOs expose facts; frontend
   contributors decide what is attention/watch.
2. **Attention controls prominence, not visibility.** Focused views show full
   relevant datasets with reasonable defaults.
3. **One composed model.** Home, nav, and route highlights must consume the same
   attention facts so they cannot disagree.
4. **Domain ownership stays local.** Each domain owns its attention derivation
   close to its route/data model, then registers contributions into the shared
   composer.
5. **Writes stay backend-mediated.** Any new mutation uses shared request/response
   types, CSRF/origin protection, audit logging, centralized supervisor decoding,
   and local UI feedback.
6. **Design stays quiet.** Attention/watch indicators use the dashboard's
   maroon/ochre language, words/glyphs, and greyscale-readable treatment rather
   than generic red/yellow dot clutter.

## Phase 0: Attention Model Foundation

Build the reusable client architecture before adding domain-specific signals.

### Deliverables

- Shared frontend attention types, for example:
  - `AttentionSeverity = 'attention' | 'watch'`
  - `AttentionDomain = 'agents' | 'beads' | 'runs' | 'mail' | 'activity' | 'health' | 'maintainer'`
  - `AttentionItem`
  - `AttentionContributor`
  - derived `AttentionSummaryByDomain`
- A city-wide attention composer/provider mounted near `Layout`/`Header`.
- A contributor registry that supports core views and enabled first-party
  modules.
- Nav indicator component with accessible text and themed severity treatment.
- Home replacement/extension that shows top attention items and grouped
  overflow, not a full data dump.
- Ranking rules:
  - `attention` before `watch`
  - actionable, current conditions before historical conditions
  - domain ties stable by current nav order
  - Home shows a small top subset plus grouped overflow
- Tests for:
  - summary derivation from item-level facts
  - nav highest-severity rollup
  - Home top-N/overflow behavior
  - no route disagreement when multiple consumers read the same model
  - `DESIGN.md` One Mark / greyscale expectations for indicators

### Acceptance

- With mocked contributors, Home and nav agree on domain counts and severity.
- Clearing a mocked underlying condition clears the indicator without separate
  acknowledgement state.
- Multiple attention domains remain readable without violating the page's quiet
  visual hierarchy.

## Phase 1: Domain Attention Contributors

Add contributors that derive attention/watch from existing data first. Add raw
data endpoints only where the current backend does not expose the facts needed
by the focused route.

### Runs

Use the existing Formula Run health model as the first contributor:

- `attention`: waiting on operator, blocked, failed, stalled/thrashing known
  lane.
- `watch`: unverifiable/inferred run health, stale but not yet stalled.
- Deep links should target `/runs/:runId` with node/scope query when available.

### Agents

Contribute from agent/session facts:

- `attention`: pending question / needs-you, crashed/stuck/error state,
  unexpectedly detached, no live session for an expected running agent.
- `watch`: idle/asleep longer than threshold, suspended, degraded provider/rig
  context when available.
- Highlight matching rows in Agents.

Raw data gap to investigate:

- Whether pending interaction state is already available through the current
  supervisor/session endpoints or needs a new typed backend route.

### Beads

Contribute from bead status/kanban facts:

- `attention`: blocked, high-priority, stale unclaimed, stale assigned with no
  movement.
- `watch`: ready/unclaimed beyond a softer threshold, convoy tracker artifacts
  only if they appear in the accepted status/kanban workflow.
- Highlight matching cards/rows in Beads.

Do not use this phase to add full bead admin parity.

### Mail

Contribute from visible mail data and mailbox history:

- `attention`: unread/recent mail addressed to the operator or otherwise
  requiring response.
- `watch`: unread non-operator mail, partial mail corpus, stale mailbox fetch.
- Highlight matching messages/threads in Mail.

### Activity

Contribute from current git/deploy data and future supervisor/city events:

- `attention`: failed deploy marker, request failures, crashed/stranded
  sessions, failed orders, event classes that imply operator intervention.
- `watch`: event-stream degradation, unusual but non-actionable event bursts.

### Health

Contribute from existing health data:

- `attention`: supervisor unreachable, host memory below threshold, load above
  CPU count by threshold, dashboard process unhealthy.
- `watch`: missing optional supervisor health fields, dolt-noms sampling
  unavailable, service/rig degraded facts if exposed.

### Maintainer

If enabled, contribute from the maintainer module:

- `attention`: needs-you, needs triage, blocked triage/draft state.
- `watch`: stale cache, partial GitHub data, background refresher degradation.

If disabled, Maintainer contributes nothing and should not appear in nav/Home.

### Acceptance

- Every first-class domain has a contributor or an explicit "no current
  attention facts" module.
- Home can show city-wide attention from at least Runs, Agents, Beads, Mail,
  Activity, and Health using mocked or fixture data.
- Focused routes highlight attention items while preserving full route data.

## Phase 2: Mail Workspace Completion

Mail is a first-class domain and should become a complete workspace.

### Backend

Add typed, audited routes as needed for:

- reply
- archive
- mark read
- mark unread
- all-traffic/history reads with time-window defaults

Keep read and send/write paths physically separated where the current security
model requires it. Continue to support viewing-as for reads and operator-only
send semantics.

### Frontend

- Add inbox/sent/all-traffic or equivalent mode controls.
- Add reasonable default time window and explicit expansion/search.
- Add reply/archive/read-state controls to thread/message views.
- Highlight attention/watch messages without filtering out the rest.
- Keep compose/send behavior consistent with the existing viewing-as guard.
- Use local success/error feedback near the triggering control.

### Acceptance

- The operator can read, reply to, archive, and update read-state for eligible
  messages in the visible dataset.
- Attention mail is highlighted and drives Home/nav, but non-attention mail is
  still visible and actionable.
- Write failures are visible and audited.

## Phase 3: Activity Event Timeline

Activity should answer "what happened?" across both project/dev activity and
Gas City supervisor/city events.

### Backend

- Add raw typed event-history reads if the current backend only exposes event
  streaming.
- Preserve same-origin SSE proxy behavior for live refresh.
- Normalize event records at the backend edge without deciding attention
  severity there.

### Frontend

- Add Activity modes/tabs for:
  - commits/deploy log
  - supervisor/city event timeline
- Add event filters for time window, type, actor/source, and severity if useful.
- Add event-derived attention contributor logic in the Activity domain.
- Deep-link attention items to filtered event views where possible.

### Acceptance

- The operator can inspect recent supervisor/city events without using the CLI.
- Failed deploys and actionable event classes contribute attention/watch items.
- Activity remains readable and route-based; it does not become a dense legacy
  event wall on Home.

## Phase 4: Agents Intervention Ergonomics

Agents should resolve the "agent needs you" loop far enough that the operator
knows exactly what to do.

### Backend

- Expose pending interaction facts if not already included in current agent or
  session DTOs.
- Investigate whether in-dashboard respond can safely use an existing
  supervisor HTTP endpoint. If it cannot meet the security/audit model, keep
  v1 to attach/copy affordances.

### Frontend

- Highlight agents/sessions with pending questions.
- Add copy/open affordance for the appropriate `gc agent attach ...` or
  equivalent command.
- If safe respond is implemented, add local response controls near the pending
  prompt.
- Add grouping/filtering by rig/state without recreating separate legacy crew,
  rigged, and pooled panels.

### Acceptance

- An agent question produces Home/nav attention, a highlighted Agents row, and
  a clear route to respond.
- The minimum response path is one click to copy/open the attach command.
- No separate command-center panels are added.

## Phase 5: Beads Status and Targeted Dispatch

Beads should remain a status/kanban workspace with one targeted dispatch write.

### Backend

- Add a route to create and sling a new bead to a specific rig + agent.
- Validate rig and agent inputs with explicit schemas.
- Audit the dispatch write and return only the typed result needed by the UI.

### Frontend

- Preserve current board/list/detail strengths.
- Add rig filters where bead data supports them.
- Highlight attention/watch beads in board/list.
- Add create-and-sling flow:
  - bead title/body
  - rig selection
  - agent selection
  - local success/error feedback
- Keep existing claim/close/nudge if they remain useful.

### Acceptance

- The operator can create a new bead and route it to a selected rig + agent.
- Stale/high-priority/blocked bead attention is visible in Home/nav and Beads.
- Full legacy admin operations remain out of scope.

## Phase 6: Health and Cross-Cutting Rig Context

Health remains observational, but abnormal facts should be visible and shared
with attention.

### Deliverables

- Health contributor for supervisor, host, admin process, dolt-noms, and any
  available service/rig health facts.
- Shared rig filter primitives or conventions for Agents, Beads, Runs, Mail,
  and Activity where data supports rig grouping.
- No service/rig mutation controls.

### Acceptance

- Health degradation contributes Home/nav attention.
- Rigs/services can contextualize data and filtering without becoming their own
  admin-control domain.

## Phase 7: Local Feedback, QA, and Documentation

### Deliverables

- Local write feedback patterns for mail, bead dispatch, and any agent response
  write.
- Route-level loading/error/partial-data states for every new raw data path.
- Update README/specs if default route, attention semantics, or module behavior
  changes.
- Test coverage scaled to risk:
  - shared/frontend type tests for attention model
  - route/component tests for nav indicators and Home
  - backend route tests for new write/read endpoints
  - focused frontend tests for Mail, Activity, Agents, Beads
  - Playwright/snap coverage only where visual layout or multi-route behavior
    needs browser verification

### Acceptance

- `npm run lint`
- `npm run typecheck`
- `npm --workspace frontend test`
- `npm --workspace backend test`
- Any targeted snapshot/browser harness relevant to touched views

## Open Product Checks

- Exact attention thresholds for stale agents/beads/mail should be tuned with
  fixtures and operator feedback, not copied blindly from legacy panels.
- Convoys stay deferred unless the accepted Beads status/kanban workflow cannot
  represent grouped work without them.
- Rich stopped-city guardrails stay deferred unless city switching exposes a
  confusing stopped-city experience.
- Command palette/raw inspectors stay deferred until navigation/debugging pain
  is observed.
