# GC Supervisor API Gap Analysis For Future Dashboard Work

Date: 2026-06-01
Status: Consolidated from current architecture and remediation specs; extended
with `gc` CLI-elimination gaps (GC-10..GC-12) and the direct-supervisor
dashboard replacement direction

## Purpose

This document is the single source of truth for Gas City supervisor API and
Gas City/shared presentation gaps that this dashboard should push upstream
into `gastownhall/gascity` before it becomes the future `gc dashboard`.

It is separate from `specs/feature-gap-analysis.md`: that file tracks features
present in the legacy built-in dashboard but missing from this standalone
dashboard. This file tracks upstream data/API capabilities needed so the
standalone dashboard can delete local derivation, temporary adapters, broad
refresh behavior, and dashboard-server GC proxy routes, and so the browser can
reach Gas City **directly through the supervisor API** for every GC-owned
resource.

A goal of this work: the dashboard service **never invokes `gc` commands as a
subprocess** and does not own GC DTOs. Every supervisor operation, read or
write, goes through the supervisor HTTP/WS API from the browser-generated
client whenever browser transport allows. The backend's only remaining
subprocesses are host-local evidence the supervisor does not own (`git`
diffs/log, `gh` maintainer triage), never `gc` itself. The three `gc` CLI calls
that exist today (GC-10..GC-12) are tracked here as supervisor-API holes to
close, not as accepted behavior.

This repo should not patch `~/Code/gastownhall/gascity` as part of dashboard
work. When a gap below is hit, document it here, keep the dashboard behavior
explicit, and implement the upstream fix in the Gas City repo separately.

## Method

Sources consolidated:

- `specs/architecture/formula-run-detail-type.md`
- `specs/plans/code-quality-remediation-plan.md`
- archived run-detail planning notes under `specs/plans/archive/`
- current dashboard implementation constraints implied by generated supervisor
  client usage, direct browser use, and Formula Run Detail projection
- backend `gc` CLI subprocess wrappers in `backend/src/exec.ts` and their
  routes (`backend/src/routes/beads.ts`, `backend/src/routes/agents.ts`)

Validation rules:

- A gap only belongs here if fixing it requires Gas City supervisor API output,
  Gas City OpenAPI/Huma schema source, or a shared Gas City presentation
  package.
- Dashboard-only presentation, routing, styling, local git diff behavior, and
  frontend ergonomics stay out of this file.
- Dashboard-server proxy convenience also stays out unless the supervisor lacks
  a browser-safe API capability. Transport is not a data/API gap.
- Existing `gc.*` metadata is treated as authoritative data. The gap is not
  "metadata is weak"; the gap is where the supervisor omits a canonical field,
  leaves a presentation shape empty, fails to attach identity to every event,
  or has an OpenAPI schema that does not match emitted payloads.

## Impact Scale

- **Critical** - Blocks deletion of dashboard-side adapters or causes current
  run detail to miss core identity/status.
- **High** - Forces local derivation or broad refresh for common formula-run
  inspection.
- **Medium** - Improves correctness, diagnostics, or future presentation
  ownership but has a current dashboard workaround.
- **Low** - Polish or cleanup once stronger upstream shapes exist.

## Executive Summary

The current dashboard can render useful Formula Run Detail views from today's
supervisor data. The worst remaining issues are not that `gc.*` metadata is
untrustworthy; it is that the supervisor does not yet expose a complete
view-model-grade run presentation shape, and its OpenAPI source still has a few
accuracy gaps relative to observed payloads.

Highest-impact upstream work:

1. Emit formula identity directly in run snapshots.
2. Populate canonical graph.v2 presentation fields, or provide a shared
   presentation package consumed by both Gas City and this dashboard.
3. Guarantee fresh rig-store runtime state through scoped bead reads or fresh
   scoped snapshots.
4. Attach canonical run/root identity to every run-affecting event.
5. Align Gas City Huma/OpenAPI source with actual emitted payloads so generated
   validators can be the only supervisor-shape authority.
6. Emit a GC-native worker heartbeat or per-entity progress/liveness signal for
   robust ambient staleness detection.
7. Provide HTTP equivalents for the three operations the backend still shells
   out to the `gc` CLI for — bead close-with-reason, agent nudge, and agent
   prime — so the browser can reach Gas City through the supervisor API and the
   dashboard service can stop invoking `gc` as a subprocess.

## Gap Matrix

| ID | Gap | Needed upstream capability | Impact | Why the dashboard needs it |
|----|-----|----------------------------|--------|-----------------------------|
| GC-1 | Formula identity in run snapshots | `WorkflowSnapshotResponse` should expose root `ref`, typed `formula_name`, `gc.formula`, or an equivalent canonical formula field. | **Critical** | Formula detail lookup should not fail when only the root bead `ref` knows the formula name. |
| GC-2 | Canonical graph.v2 presentation | Populate `logical_nodes`, `logical_edges`, and `scope_groups`, or ship a shared Gas City presentation package that owns semantic ids, display order, hidden-control collapsing, loop/retry grouping, and visible edges. | **High** | The dashboard should consume presentation semantics instead of deriving a local TypeScript view model from raw bead metadata. |
| GC-3 | Rig-store runtime freshness | Expose scoped rig-store bead reads through the supervisor, or guarantee that scoped run snapshots include current runtime state for non-city stores. | **High** | City-store runs can refresh bead status independently; rig-store runs are snapshot-bound. |
| GC-4 | Per-execution session identity | Attach canonical session id/name to every execution instance or node when a session exists. | **High** | Current metadata is usable when present, but absent session fields force assignee/name matching and can leave nodes unresolved. |
| GC-5 | Event identity on every run-affecting event | Every event that can affect a formula run should carry canonical `workflow_id`/`run_id`, `root_bead_id`, or equivalent identity in the envelope or nested payload metadata. | **High** | Identity-less events force broad refresh invalidation instead of precise run-detail refresh. |
| GC-6 | OpenAPI schema accuracy | Gas City Huma/OpenAPI source must match observed payloads: nullable `Bead.priority`; legacy bead fields such as `owner`, `updated_at`, `closed_at` if still emitted; phantom event fields such as `next`; and formula-detail degraded/missing responses. | **Critical** | The dashboard now uses generated SDK + generated Zod validators. Future schema refreshes must not re-break valid degraded payloads or require dashboard-side schema overlays. |
| GC-7 | Canonical execution-instance fields | Optionally expose execution instance id, semantic node id, loop iteration, retry attempt, current/historical flag, and attached session identity directly. | **Medium** | Existing metadata is enough for the current page, but canonical fields would delete projection code and remove field-precedence decisions from the dashboard. |
| GC-8 | GC-native heartbeat/progress signal | Emit worker heartbeat or per-entity progress/liveness metadata such as `metadata.gc.last_heartbeat_at`, plus events when useful. | **High** | Ambient stuck/stale detection currently has to infer from bead/session joins and progress monotonicity because `bead.updated_at` is noisy and there is no per-entity progress SSE. |
| GC-9 | Canonical formula-detail status in snapshots | Optionally include formula-detail availability/status on the run snapshot when formula detail cannot be fetched. | **Medium** | The dashboard currently models lookup failures locally. A supervisor-owned status would make diagnostics more consistent. |
| GC-10 | Bead close with operator reason | `POST /v0/city/{cityName}/bead/{id}/close` should accept an optional length-bounded `reason` and persist/audit it as `gc bd close --reason` does. | **High** | The close-reason UI is the only reason `execCloseBead` shells out to the `gc` CLI; the HTTP close route exists but drops the reason. |
| GC-11 | Agent nudge endpoint | Expose an HTTP route to nudge an agent by alias (the `gc bd nudge <alias>` queue), returning an acceptance status. | **High** | No HTTP route exists for the nudge queue, so `execNudgeAgent` shells out to the `gc` CLI. |
| GC-12 | Agent composed-prompt (prime) read | Expose a read-only HTTP route returning an agent's composed behavioural prompt by alias, with a distinct "not configured" signal. | **Medium** | No HTTP equivalent of `gc prime --strict <alias>` exists, so `execAgentPrime` shells out to the `gc` CLI. |

## Gap Detail

### GC-1: Formula Identity In Run Snapshots

Current state:

- Some graph root beads expose `gc.formula_contract=graph.v2` but do not carry
  `gc.formula` or `gc.formula_name`.
- Gas City can recover a formula name from the root bead `ref` in other feed
  projections.
- `WorkflowSnapshotResponse` bead rows do not expose `ref`.

Needed upstream change:

- Add one canonical formula identity source to the run snapshot:
  root `ref`, typed `formula_name`, typed `formula_id`, `gc.formula`, or an
  equivalent field with stable semantics.

Why:

- Formula detail/preview ordering should be available from supervisor data.
- The dashboard should not parse formula files and should not guess a formula
  from titles.

### GC-2: Canonical Graph.v2 Presentation

Current state:

- Gas City emits authoritative graph.v2 metadata such as `gc.logical_bead_id`,
  `gc.step_ref`, `gc.scope_ref`, `gc.control_for`, `gc.iteration`,
  `gc.attempt`, and `gc.max_attempts`.
- The supervisor response also has presentation-shaped fields
  `logical_nodes`, `logical_edges`, and `scope_groups`, but they are empty
  today.
- The dashboard derives semantic nodes, visible edges, hidden-control badges,
  loop/retry grouping, current/historical visibility, and display statuses
  locally.

Needed upstream change:

- Populate `logical_nodes`, `logical_edges`, and `scope_groups` with the
  canonical graph.v2 display model, or publish a shared presentation package
  that this dashboard and Gas City can both consume.

Why:

- The dashboard should be a view over Gas City formula-run semantics, not a
  second presentation engine that can drift.

### GC-3: Rig-Store Runtime Freshness

Current state:

- City-store runs can refresh individual beads through city bead APIs.
- Rig-store runs cannot refresh the same way because the supervisor city bead
  endpoint does not expose scoped rig-store bead reads.
- For rig-store details, the embedded run snapshot is authoritative for that
  request but only as fresh as the snapshot.

Needed upstream change:

- Provide scoped rig-store bead reads, or make scoped run snapshots carry
  guaranteed-current runtime bead status.

Why:

- Running formula detail should update status reliably for rig-backed work
  without relying on stale embedded snapshot state.

### GC-4: Per-Execution Session Identity

Current state:

- Session resolution is robust when beads carry `session_id`,
  `session_name`, `gc.session_id`, `gc.session_name`, or t3bridge
  `gc.sessionName`.
- When those are absent, the dashboard falls back to assignee/name matching
  against session summaries and may surface `session_unresolved`.

Needed upstream change:

- Attach canonical session id/name to each execution instance or graph node
  whenever a session exists, including loop and retry executions.

Why:

- Selecting a node should deterministically open the right transcript without
  matching aliases or inferring from assignees.

### GC-5: Event Identity On Every Run-Affecting Event

Current state:

- Events with `workflow_id`, `run_id`, `root_bead_id`, or corresponding
  `gc.*` metadata can be filtered to one Formula Run Detail page.
- Events without identity remain broad invalidation signals.

Needed upstream change:

- Every event that can affect a run detail should carry canonical run/root
  identity in the envelope or nested payload.

Why:

- The dashboard can then refresh only affected runs and can eventually move
  toward backend-owned event reduction without broad invalidation.

### GC-6: OpenAPI Schema Accuracy

Current state:

- The dashboard currently generates supervisor SDK/types/validators from the
  committed OpenAPI for backend use, and the migration target adds a
  browser-consumable generated supervisor client.
- The committed dashboard schema has been corrected enough for current
  validators to run, but the upstream Gas City Huma/OpenAPI source still needs
  source-of-truth fixes.
- Temporary dashboard DTO normalization remains in `gc-supervisor-decoders.ts`
  until direct browser use and generated types delete the mirror layer.

Needed upstream change:

- Fix the Gas City Huma/OpenAPI source for observed payload reality:
  `Bead.priority` is nullable in read responses; legacy bead fields such as
  `owner`, `updated_at`, and `closed_at` must either be modeled or removed from
  emitted payloads; phantom event fields such as `next` must match actual
  event payloads; formula-detail required fields must match degraded and
  missing-formula responses.

Why:

- Generated response validation should be the only supervisor-shape authority.
- Future `npm run openapi:gc-supervisor:update` refreshes must not reintroduce
  drift that forces dashboard-side schema patches.

### GC-7: Canonical Execution-Instance Fields

Current state:

- Existing metadata is enough to render the current Formula Run Detail page.
- The dashboard still decides field precedence for semantic node id, execution
  instance id, loop iteration, retry attempt, current/historical state, and
  attached session identity.

Needed upstream change:

- Optionally expose a canonical execution-instance projection on the snapshot
  or graph presentation shape.

Why:

- This would let the dashboard remove derivation code and render a stable
  upstream view model directly.

### GC-8: GC-Native Heartbeat/Progress Signal

Current state:

- The city event stream has discrete state-change events, but no per-entity
  progress event. SSE heartbeat is transport keep-alive, not work liveness.
- `bead.updated_at` is noisy because metadata rewrites update it even when
  a run is not making semantic progress.
- `session.last_active` is useful but only indirect: it reports tmux pane I/O,
  not formula-node progress.
- Archived observability planning identified a future Gas City heartbeat issue
  that would write `metadata.gc.last_heartbeat_at`.

Needed upstream change:

- Emit a canonical work-liveness signal, such as
  `metadata.gc.last_heartbeat_at` on active work, and expose it in supervisor
  snapshots and/or run-affecting events.

Why:

- Ambient "is this stuck?" UI should not depend permanently on bead/session
  joins, alias matching, or progress-monotonicity inference.
- Once this exists, the dashboard can demote its current staleness inference to
  fallback behavior and make concern signals more robust.

### GC-9: Canonical Formula-Detail Status

Current state:

- The dashboard uses `RunFormulaDetailState` to distinguish missing formula
  metadata, missing target, timeout, not-found, invalid payload, and upstream
  failures.

Needed upstream change:

- Optionally include formula-detail availability/status in the run snapshot
  when the supervisor already knows formula detail cannot be fetched.

Why:

- The dashboard can display supervisor-owned diagnostics instead of deriving
  them from follow-up route calls.

## CLI-Backed Operations Requiring HTTP Equivalents

The current dashboard backend reaches the supervisor over HTTP for every read
and for the claim, sling, and mail-send writes. The target dashboard reaches
those same supervisor capabilities from the browser-generated client. Three
operations remain on the `gc` CLI (`backend/src/exec.ts`, via
`runExec('gc', ...)`) because the supervisor HTTP API has no equivalent today.
These are the **complete set** of `gc` subprocess calls in the backend: closing
GC-10, GC-11, and GC-12 removes the dashboard's `gc` CLI dependency entirely
and satisfies the goal that the dashboard service never shells out to Gas City.
(The remaining `git`/`gh` subprocesses are host-local evidence the supervisor
does not own and are tracked as non-gaps.)

Both the in-process `gc dashboard` and the from-scratch `gasworks-gui`
("Mission Control") consumer avoid these CLI calls, but for opposite reasons,
and neither is a counter-example:

- The legacy in-process `gc dashboard` calls the underlying Gas City Go
  functions directly — the same functions the CLI commands wrap — so it needs
  neither the CLI nor an HTTP route.
- Mission Control consumes only the supervisor HTTP/WS API and therefore simply
  does not offer these three features: it closes beads with no `reason`, and has
  no nudge or prime surface at all. Its zero-CLI footprint confirms the holes
  rather than disproving them.

This standalone dashboard exposes all three features from an out-of-process
client, so it must either gain these HTTP endpoints upstream or drop the
features.

### GC-10: Bead Close With Operator Reason

Current state:

- The supervisor exposes `POST /v0/city/{cityName}/bead/{id}/close`, but it
  returns `OKResponseBody` and accepts no operator `reason` field.
- The dashboard's close action carries an operator free-text reason that must
  reach both the bead close and the admin audit log.
- Because the HTTP route drops the reason, `execCloseBead`
  (`backend/src/exec.ts`) shells out to `gc bd close <id> --reason <reason>`.
  The claim write already moved to the HTTP `updateBead` fn; only
  close-with-reason remains on the CLI.

Needed upstream change:

- Accept an optional `reason` (free-text, length-bounded) on the close request
  body and persist/record it the same way `gc bd close --reason` does.

Why:

- Lets the dashboard close beads with a reason over HTTP and delete the
  subprocess path, including the control/escape/bidi byte-stripping hardening
  that exists only because the reason currently reaches a `gc` CLI argument and
  `.gc/events.jsonl` (gascity-dashboard-htrz).

### GC-11: Agent Nudge Endpoint

Current state:

- There is no HTTP route for the agent nudge queue.
- The dashboard's row-level nudge action targets an agent alias (the bead id is
  only route/audit context), so `execNudgeAgent` (`backend/src/exec.ts`) shells
  out to `gc bd nudge <alias>`.

Needed upstream change:

- Expose an HTTP route to nudge an agent by alias (for example a city-scoped
  `POST .../agent/{alias}/nudge`), returning a simple acceptance status.

Why:

- Removes the second `gc` subprocess and lets nudge participate in the same HTTP
  error and audit path as the other write actions.

### GC-12: Agent Composed-Prompt (Prime) Read

Current state:

- There is no HTTP route that returns an agent's composed behavioural prompt
  (the text an agent reads on wake).
- The agent detail page surfaces this read-only, so `execAgentPrime`
  (`backend/src/exec.ts`) shells out to `gc prime --strict <alias>`. `--strict`
  makes an unconfigured alias exit non-zero with stderr (rendered as "agent not
  configured") instead of falling back to a generic worker prompt. Measured
  output is ~15 KB.

Needed upstream change:

- Expose a read-only HTTP route returning the composed prime prompt for an agent
  alias, with a distinct "alias not configured" signal so the dashboard can
  render a 404 "not configured" state rather than a generic upstream error.

Why:

- Removes the last `gc` subprocess. The dashboard surfaces the resolved prompt
  read-only today; a supervisor-owned read keeps it read-only without a CLI
  dependency.

## Explicit Non-Gaps

These are intentionally not tracked as current GC supervisor API gaps:

- **`gc.*` metadata as a source.** Metadata such as `gc.logical_bead_id`,
  `gc.step_ref`, `gc.scope_ref`, `gc.control_for`, `gc.iteration`,
  `gc.attempt`, `gc.max_attempts`, `gc.run_target`, and identity fields is
  authoritative producer data. The gap is only where it is absent or where a
  canonical presentation shape would prevent duplicate dashboard projection.
- **Run/root identity when present.** Top-level supervisor fields and bead
  metadata can identify runs via `workflow_id`, `run_id`, and
  `root_bead_id`. Only identity-less events remain a gap.
- **Formula detail target selection.** The dashboard can use root-bead
  `gc.run_target`, `gc.routed_to`, or assignee. The remaining formula gap is
  identity exposure when only root `ref` knows the formula name.
- **Logical grouping metadata for the current page.** Current `gc.*` metadata
  is enough for the current dashboard view. The future gap is centralizing the
  canonical presentation in Gas City/shared code.
- **Local git diff evidence.** Diff rendering is dashboard-local evidence from
  the execution folder, not supervisor run state.
- **Host-local `git`/`gh` subprocesses.** Git diff/log evidence and `gh`-backed
  maintainer triage are host capabilities the supervisor does not own. They are
  distinct from the `gc` CLI gaps (GC-10..GC-12): those are supervisor-operation
  holes with no HTTP route and must be closed so the dashboard never calls `gc`
  as a subprocess; `git`/`gh` are not `gc` and stay behind the exec boundary.
- **Current staleness inference.** The dashboard can infer likely stalled work
  from bead/session joins and progress monotonicity. That inference is useful
  today, but a native heartbeat/progress field would be the better upstream
  source of truth for future ambient status.

## Downstream Dashboard Cleanup Unblocked By These Gaps

Once these upstream gaps are closed and this repo refreshes
`backend/openapi/gc-supervisor.openapi.json`, the dashboard should:

1. Delete temporary hand-Zod supervisor adapters, `GcClient` mirror methods,
   and any `SchemaOutputFor` machinery that duplicates generated response
   validation.
2. Move raw supervisor mirror types out of `shared`; keep `shared` for
   dashboard-owned local service DTOs, UI/module contracts, and local/composed
   view models only.
3. Replace local graph.v2 presentation derivation with canonical Gas City or
   shared presentation output.
4. Remove broad run-detail invalidation for identity-less events.
5. Remove session alias/assignee fallback paths once execution instances carry
   canonical session identity.
6. Demote bead/session staleness inference once a GC-native heartbeat/progress
   signal is available.
7. Delete the `gc` CLI wrappers in `backend/src/exec.ts` (`execCloseBead`,
   `execNudgeAgent`, `execAgentPrime`) and the close-reason subprocess hardening
   once GC-10, GC-11, and GC-12 land, so the only subprocesses behind the exec
   boundary are host-local `git`/`gh` — never `gc`.
