# Run Run Detail Plan

Status: first implementation slice shipped on `csells/runs-formula-runs`; post-audit alignment passes added same-origin SSE docs, OpenAPI-shaped graph.v2 enrichment fixtures, failed-attempt transcript preservation, scoped summary-to-detail links, complete-scope-pair query handling, malformed scope-query rejection on both backend and frontend routes, run route validation/redaction coverage, distinct first-pass construct shape classes, status-summary header copy, latest-iteration loop visibility, historical-only transcript access, partial snapshot surfacing, staged/unstaged diff sections, a deterministic detail-route browser harness, focused backend run presentation modules, runtime `step_ref` suffix stripping for supervisor execution refs, strict positive-integer parsing for runtime attempt/iteration metadata, `gc.scope_ref` loop context and `gc.control_for` badge targeting for current `.run.N` paths, and red/green coverage that accepts only current supervisor run snapshot fields for graph.v2 roots, step refs, construct kinds, and session links.

Latest alignment: the backend now builds a dedicated `RunningFormulaRun` projection before emitting browser data. The UI consumes `FormulaRunDetail.progress` rather than recomputing aggregate node status from the raw node list. The grouping adapter now matches the Gasworks presentation rules that a check-loop control bead and its generated execution bead collapse into one display node when runtime metadata links them with `gc.logical_bead_id`, and that an `in_progress`/`active` bead is only displayed as running when it has a non-empty assignee. When a run root exposes `gc.formula` and a run target, the detail route fetches the supervisor formula detail/preview response and uses that compiled formula step order for the vertical graph; it still does not parse formula files locally. A live sample-city browser/API harness verifies the two planning runs present in `formula-detail-demo-city` and still fails explicitly because the expected todo and tic-tac-toe implementation runs are not present yet.
Mockup: [assets/formula-run-detail-graphv2-adopt-pr.svg](assets/formula-run-detail-graphv2-adopt-pr.svg)

## Goal

Make the Runs page navigable from a run summary to a run detail page for graph.v2 formula runs. The detail page should show:

- A vertical run visualization with a distinct shape for each formula construct type.
- Node state for already run, running, and not yet run work, with room for blocked, failed, skipped, and ready.
- Current git working tree changes in code files for the folder where the formula is executing, skipped when that folder is not a git work tree.
- The full coding-agent session for the selected node, streaming while active. The transcript should read like real agent work: request/context, agent responses, tool calls, command output summaries, file edits, and final handoff.
- Exactly zero or one selected node. Clicking the selected node again clears selection.

The target layout is a split view:

- Left: vertical formula graph.
- Right: tabs for `Diff` and `Session`. `Diff` is a code working-tree diff, not a run/spec diff. `Session` is a coding-agent request/response transcript, not a generic log.

## Scope

This plan is graph.v2-only.

In scope:

- Run roots whose formula/run metadata identifies a graph.v2 formula run.
- Graph.v2 run formulas and graph.v2 expansion formulas after they have been compiled/materialized into the run graph.
- Runtime graph nodes and controls emitted by the graph.v2 compiler/dispatcher: normal steps, retry controls, check-loop controls, scope/body nodes, fanout controls, scope-check controls, run-finalize controls, and spec/source nodes where present.

Out of scope for this plan:

- Legacy molecule or root-only formula detail pages.
- Router formulas that do not declare `contract = "graph.v2"` unless they launch or resolve to a graph.v2 run.
- Generic formula catalog/preview UI.
- A compatibility renderer for non-graph bead hierarchies.
- Recovering source-level semantics from legacy formulas.

Terminology rule:

- The operator-facing UI must say `check loop`, `review loop`, or the formula's own step title.
- Do not expose implementation-private check-loop codenames in UI copy, route labels, mockups, or operator-facing docs.
- Backend enrichment may map internal check-loop metadata to the external `check-loop` construct kind.

Formula data-source rule:

- The dashboard must not read or parse formula TOML files for run details.
- Runtime detail pages consume supervisor API data: the run snapshot first, then any compiled formula detail/preview data exposed by the supervisor if the snapshot does not carry enough display metadata.
- Gas City already parses formulas into `formula.Formula`, compiles them into `formula.Recipe`, and exposes recipe-derived order and preview data through its API. The stable source order lives in `Recipe.Steps`, surfaced through supervisor response data, not in dashboard-owned file parsing.

Running formula projection rule:

- The backend owns a single aggregate data structure for an in-flight formula run: `RunningFormulaRun` in `backend/src/runs/formula-run.ts`.
- `RunningFormulaRun` combines the supervisor run snapshot, runtime bead overlays, session summaries, semantic node groups, execution instances, hidden-control badges, display edges, lanes, execution folder, and progress summary.
- React renders `FormulaRunDetail`, which is a browser-safe projection of `RunningFormulaRun`. It should not infer run progress by walking raw beads, raw sessions, or ad hoc formula metadata.
- `FormulaRunDetail.progress` is the browser contract for aggregate progress: snapshot version/event cursor, partial flag, visible/all node counts, edge count, execution-instance count, session-link count, streamable session count, streamable session ids, visible status counts, and all-node status counts.
- If the dashboard later needs richer event history, add it to `RunningFormulaRun` first, then expose only the browser-safe projection fields the UI needs.

## Repo Comparison

### This Repo: `gascity-dashboard`

Relevant files:

- `frontend/src/routes/Runs.tsx`
- `frontend/src/routes/FormulaRunDetail.tsx`
- `frontend/src/components/run/RunMap.tsx`
- `frontend/src/components/run/LaneCard.tsx`
- `frontend/src/components/run/RunRunDiagram.tsx`
- `frontend/src/components/run/RunRunNode.tsx`
- `frontend/src/components/run/RunRunTabs.tsx`
- `frontend/src/components/run/RunDiffPanel.tsx`
- `frontend/src/components/run/RunNodeSessionPanel.tsx`
- `frontend/src/hooks/useRunNodeSelection.ts`
- `frontend/src/hooks/useFormulaRunDetail.ts`
- `frontend/src/hooks/useSessionStream.ts`
- `backend/src/snapshot/collectors/runs.ts`
- `backend/src/routes/runs.ts`
- `backend/src/routes/session-stream.ts`
- `backend/src/routes/sse-proxy.ts`
- `backend/src/runs/bead-fields.ts`
- `backend/src/runs/formula-run.ts`
- `backend/src/runs/edges.ts`
- `backend/src/runs/execution-path.ts`
- `backend/src/runs/enrich.ts`
- `backend/src/runs/node-shape.ts`
- `backend/src/runs/session-link.ts`
- `backend/src/runs/status.ts`
- `backend/src/runs/diff.ts`
- `shared/src/snapshot/types.ts`
- `shared/src/run-detail.ts`
- `shared/src/run-snapshot.ts`
- `backend/src/gc-client.ts`
- `backend/src/routes/sessions.ts`
- `backend/src/routes/events.ts`
- `backend/test/run-enrich.test.ts`
- `frontend/src/test/fixtures/formula-run-detail.json`
- `scripts/snap-run-detail.mjs`
- `scripts/e2e-sample-formula-runs.mjs`

Current behavior after this branch:

- `/runs` reads `/api/snapshot` through `useCachedData`, with manual and SSE-driven refreshes routed through `/api/snapshot/refresh`.
- The backend builds a `RunSummary` from `GcClient.listBeads({ limit: 1000 })`.
- `buildRunSummary()` derives lane scope from run root metadata, and `LaneCard` links each lane to `/runs/:runId` with the supervisor-required scope query params when available.
- `/api/runs/:runId` calls the gc supervisor run endpoint and enriches graph.v2 physical beads/deps into dashboard `FormulaRunDetail`.
- `enrichFormulaRun()` now builds a `RunningFormulaRun` projection and returns a browser-safe `FormulaRunDetail`; the detail page uses `detail.progress` for aggregate run status instead of deriving progress in React.
- `/api/runs/:runId/diff` resolves the execution folder from supervisor-owned run data and returns current git working-tree state when the folder is a git work tree.
- `/api/sessions/:id/stream` is a same-origin SSE proxy for active selected-node sessions.
- Transcript support remains session-centric and is reused for run nodes:
  - `GcClient.fetchTranscript(id)` calls `/v0/city/{city}/session/{id}/transcript`.
  - `POST /api/sessions/:id/peek` sanitizes and caps transcript output.
- `SessionPeekContent` remains the canonical transcript renderer.
- City events and session streams now share the same backend SSE proxy helper.
- `scripts/snap-run-detail.mjs` uses deterministic summary, run detail, diff, transcript, and stream fixtures to click from `/runs` into `/runs/:runId` and snapshot the detail route without a live supervisor run.
- `scripts/e2e-sample-formula-runs.mjs` uses the running dashboard and live supervisor-backed APIs to require todo and tic-tac-toe planning and implementation runs. It verifies present runs are clickable from `/runs`, render detail pages, expose backend-owned progress, support zero/one graph selection, show diff evidence, and handle session/no-session state.

Takeaway:

This repo now has the first real run-detail slice plus testable route-level visual coverage. The remaining work is no longer "create the route"; it is to harden the local TypeScript presentation enrichment with captured supervisor data and keep the run-specific code within the dashboard's existing shared-type, route-factory, cached-data, and typographic UI patterns.

### `~/Code/gastownhall/demo-dash`

Relevant files:

- `src/components/RunMap.ts`
- `src/server/collectors/runs.ts`

Current behavior:

- This is the predecessor of the current dashboard run summary.
- It renders an "Active run map" with lanes, count boxes, circular stage nodes, and connecting lines.
- It collects issues by shelling out to `bd list` in city and rig roots, then groups issues by run root id.
- It has the same phase grammar and formula-specific stage inference as this repo.

Takeaway:

`demo-dash` is useful history for how run lanes got here, but it does not solve node-level run detail, construct-specific shapes, diff viewing, or session drill-in.

Updated contrast after this branch:

- The branch has moved beyond `demo-dash`; `demo-dash` remains a reference for summary-lane derivation only.
- Do not copy more from `demo-dash` for run details. Its useful patterns are already present here through `SourceCache`, `RunSummary`, phase mapping, and lane rendering.

### `~/Code/gascity/gasworks-gui`

Relevant frontend files:

- `src/hooks/useOrdersFormulas.ts`
- `src/components/orders/OrdersListTab.tsx`
- `src/components/orders/OrdersDagDetail.tsx`
- `src/components/orders/RunGraph.tsx`
- `src/components/orders/runGraphLayout.ts`
- `src/components/orders/runGraphHelpers.ts`
- `src/components/orders/runSessionLinks.ts`
- `src/components/orders/useOrdersDagDetailState.ts`
- `src/components/orders/useRunWatchRuntime.ts`

Relevant server files:

- `server/src/ws/run_presentation.rs`
- `server/src/ws/run_presentation/types.rs`
- `server/src/ws/run_presentation/logical_mapping.rs`
- `server/src/ws/run_presentation/logical_nodes.rs`
- `server/src/ws/run_presentation/display/mod.rs`
- `server/src/ws/run_presentation/display/node_filter.rs`

Current behavior:

- Formula runs can open a DAG detail view through `OrdersDagDetail`.
- `getRunDetail` sends `convoy:get` through the broker with `run_id`, `scope_kind`, and `scope_ref`.
- The detail response uses `RunSnapshot`, including:
  - physical `beads`
  - physical `deps`
  - `logical_nodes`
  - `logical_edges`
  - `scope_groups`
  - `display_graph`
  - `snapshot_version`
  - `snapshot_event_seq`
- The Rust presentation layer enriches Gas City's raw run snapshot into logical nodes, logical edges, scope groups, and display graph.
- `RunGraph` renders the display graph with lanes, status counts, live session chips, zoom/pan, and selected-node styling.
- Selection currently sets the selected node id; it does not toggle off when clicking the already selected node.
- Session links are resolved from node metadata and active/completed node state.
- Run updates use a broker watch/resync flow. The dashboard can use its existing supervisor SSE event stream instead.

Takeaway:

This is the best implementation reference. The right move is to reuse the same conceptual contract (`RunSnapshot` plus `display_graph`) and adapt the rendering to the dashboard's quieter vertical layout. The dashboard should not own all run grouping, retry aggregation, and scope collapsing logic if Gasworks already has it in one place.

Updated contrast after this branch:

- The branch borrows the right concepts from Gasworks: semantic display nodes, execution instances, control-badge collapse, session links, and display edges.
- The branch intentionally does not copy Gasworks' interaction model: no broker watch runtime, no zoom/pan graph canvas, and no dense DAG layout. This matches the dashboard's page-level, typographic design language.
- The main gap is fidelity. Gasworks has a dedicated Rust presentation layer with logical nodes, logical edges, scope groups, and `display_graph`; this branch currently has a local TypeScript approximation in `backend/src/runs/enrich.ts`.
- Until Gas City or a shared package owns presentation enrichment, the dashboard must protect that approximation with real graph.v2 fixture tests so it does not drift from Gasworks semantics.

## Code Pattern Deep Dive: Branch Alignment

This audit compares the codebase's established patterns with the formula-run detail code currently on this branch.

### Strong Existing Patterns

1. Shared wire contracts live in the `shared` workspace.
   - `shared/src/index.ts` owns gc supervisor-facing `Gc*` shapes.
   - Domain-specific browser wire shapes can live in smaller shared modules and be re-exported from `index.ts`.
   - Consumers import types from `gas-city-dashboard-shared`, not from backend/frontend internals.

2. Supervisor reads go through `GcClient`.
   - The client owns city URL construction, JSON fetches, default timeouts, and URL-keyed single-flight coalescing.
   - Route handlers should not fetch supervisor URLs directly unless they are intentionally proxying a stream.
   - Error messages thrown by `GcClient` are topology-safe.

3. Backend route files are small router factories.
   - Routes validate params before upstream calls.
   - Timeout errors map to `504` with `kind: "upstream-timeout"`.
   - Unknown upstream failures log the raw message server-side and return a generic browser-safe message with `details.name`.
   - Write routes use DI for exec helpers; read routes use injected clients or narrow options.
   - Tests exercise both success and failure through real Express apps plus narrow fake upstreams, including "no upstream call happened" assertions for validation failures.

4. Expensive or shared dashboard summaries use cache layers.
   - `SourceCache` owns TTL, stale-while-error, fixture fallback, and single-flight for aggregate snapshot sources.
   - Page-level frontend data uses `useCachedData` for cache-warm initial paint and explicit refresh.
   - Detail reads can be direct when they are route-specific, but they should still use the same hook/API shape on the frontend.

5. The frontend is built from route pages plus quiet primitives.
   - Route pages start with `PageHeader`.
   - Manual refresh controls live in the header meta slot.
   - Buttons are typographic controls from `Button.tsx`.
   - Lists and panels are separated by whitespace, type, and hairlines rather than structural cards.
   - Selection state must be accessible through `aria-*`, not color alone.

6. Session transcript rendering is centralized.
   - The backend sanitizes transcript text.
   - `SessionPeekContent` is the canonical React renderer for turns.
   - New session surfaces should reuse that renderer until a richer structured transcript renderer exists.

7. Tests favor integration at the route and component boundary.
   - Backend tests use `node:test`, `assert`, fake HTTP supervisors, and real Express apps.
   - Frontend tests use Vitest, Testing Library, fake `fetch`, fake `EventSource`, and real router components.
   - Console warnings and React Router future warnings are treated as test failures.

### Where The Branch Now Matches

| Area                       | Existing repo pattern                                                                                                             | Branch fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor client          | `GcClient` owns supervisor URL construction and typed reads                                                                       | `getRun()` was added to `GcClient`; run routes do not hand-build supervisor fetches.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Shared contracts           | Browser/backend wire shapes are exported from `gas-city-dashboard-shared`                                                         | Dashboard detail/diff shapes live in `shared/src/run-detail.ts`; raw supervisor run snapshot types live in `shared/src/run-snapshot.ts`; both are re-exported from the package root and now mirror the current OpenAPI `RunSnapshotResponse`/`RunBeadResponse`/`RunDepResponse` fields instead of guessed legacy/camel variants.                                                                                                                                                                          |
| Running formula projection | Backend aggregates domain state before React renders it                                                                           | `backend/src/runs/formula-run.ts` owns the `RunningFormulaRun` projection. It builds nodes, edges, lanes, session context, execution path, and `FormulaRunDetail.progress`; `FormulaRunDetailPage` renders that progress contract instead of deriving aggregate status from `detail.nodes`.                                                                                                                                                                                                                       |
| Summary-to-detail scope    | Summary links preserve supervisor lookup context                                                                                  | `buildRunSummary()` carries `gc.scope_kind`, `gc.scope_ref`, and `gc.root_store_ref` from run root metadata onto each lane, and `LaneCard` includes those as detail-route query params.                                                                                                                                                                                                                                                                                                                   |
| Route structure            | Express router factories with early validation and sanitized errors                                                               | `runsRouter()` follows the factory pattern, validates run id/scope, defaults unscoped direct detail URLs to the configured dashboard city scope, handles timeout/404/unsupported/upstream paths, logs raw details server-side only, and now has fake-supervisor tests for validation, default scope, and redaction paths.                                                                                                                                                                                 |
| Stream proxying            | Same-origin SSE routes keep CSP and browser behavior simple                                                                       | `eventsRouter` and `sessionStreamRouter` now share `routes/sse-proxy.ts`, reducing duplicated streaming/backpressure code.                                                                                                                                                                                                                                                                                                                                                                                |
| Validator reuse            | Route validators that cross surfaces live under `backend/src/lib`                                                                 | `SESSION_ID_RE` now lives in `backend/src/lib/sessionId.ts` so transcript peek and session stream routes share the same session-id boundary.                                                                                                                                                                                                                                                                                                                                                              |
| Subprocess boundaries      | Every privileged command has a named wrapper in `backend/src/exec.ts` with clean env, timeout, output cap, and concurrency limits | Run run diffs now call `execRunGit()` instead of invoking `child_process` directly from the diff reader.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Execution paths            | Filesystem path derivation stays server-side and directly tested                                                                  | `resolveRunExecutionPath()` owns cwd/work-dir/rig-root precedence, trims blanks, and returns `null` when no real execution path exists so the browser never supplies a local path.                                                                                                                                                                                                                                                                                                                        |
| Display edges              | Edge projection is separate from node ordering                                                                                    | `buildRunDisplayEdges()` owns supervisor logical-edge preference, physical-dep fallback, visible-node filtering, duplicate/self-edge filtering, and externalized ids without reordering nodes.                                                                                                                                                                                                                                                                                                            |
| Frontend data              | Route-specific hooks call `api` methods and expose loading/error/refresh                                                          | `useFormulaRunDetail()` uses `useCachedData` and returns `{ detail, diff, loading, error, refresh }`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Page shell                 | Route pages use `PageHeader` and a meta refresh control                                                                           | `FormulaRunDetailPage` matches the page shell used by `RunsPage`, `AgentsPage`, and `HealthPage`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Transcript UI              | Reuse sanitized peek transcript renderer                                                                                          | Run node sessions use `SessionPeekContent`; streaming appends turns into the same `TranscriptResult` shape and surfaces live/connecting/offline state through the existing `StatusBadge` convention.                                                                                                                                                                                                                                                                                                      |
| Display graph ordering     | Preserve compiled formula order from supervisor data                                                                              | `enrichFormulaRun()` keeps the supervisor bead/group order for the quiet vertical node list. Gas City compiles graph.v2 formulas into ordered `Recipe.Steps`, and the supervisor can expose that order through run snapshot and formula detail/preview response data. If the dashboard later needs source-order metadata beyond the run snapshot, fetch the supervisor's compiled formula detail/preview data; do not parse formula files locally. Logical/physical deps influence edges, not vertical order. |
| Node shape                 | Construct/id/label projection has a narrow helper                                                                                 | `node-shape.ts` owns semantic id precedence, construct-kind mapping, hidden-control badge targets, external labels, loop parent ids, and display-title fallback, with direct tests ensuring implementation-private names do not leak.                                                                                                                                                                                                                                                                     |
| Node status                | Status normalization is isolated and directly tested                                                                              | `presentationStatus()` maps supervisor bead status plus `gc.outcome` to dashboard status, while `aggregateStatus()` keeps active attempts visible above terminal history.                                                                                                                                                                                                                                                                                                                                 |
| Session links              | Transcript availability rules are separate from graph assembly                                                                    | `runSessionLinkFor()` owns session id/name/assignee/rig extraction and suppresses links for pending/ready nodes while preserving completed/failed transcript access.                                                                                                                                                                                                                                                                                                                                      |
| Visual language            | Typography, hairlines, and restrained controls instead of card grids                                                              | Run tabs and iteration/attempt controls now use typographic tab/radio affordances instead of boxed button strips.                                                                                                                                                                                                                                                                                                                                                                                         |
| Route state                | URL-derived state should not leak across route/query changes                                                                      | `useRunNodeSelection()` owns run detail selection semantics. Selection starts empty without `?node=`, applies a valid `?node=`, clears when the query is removed, preserves user selection inside the same route, and still applies the query target if a refreshed detail payload materializes it after a stale cache paint.                                                                                                                                                                             |
| Test style                 | Backend fake-supervisor route tests; pure semantic tests in focused files; frontend component tests with fake network             | `backend/test/runs.test.ts` stays focused on routes/SSE, `backend/test/run-enrich.test.ts` owns pure graph.v2 enrichment fixtures, `backend/test/run-bead-fields.test.ts` covers raw run bead field readers, `useRunNodeSelection.test.tsx` covers selection state, and `FormulaRunDetail.test.tsx` covers the browser route.                                                                                                                                                                                 |
| Strict gates               | Warnings should fail, lint/typecheck should be tight                                                                              | `eslint.config.mjs`, root `lint`, root `typecheck`, and frontend test setup now enforce that posture.                                                                                                                                                                                                                                                                                                                                                                                                     |

### Remaining Pattern Mismatches

1. `backend/src/runs/enrich.ts` is carrying a full presentation layer locally.
   - This is the highest-risk mismatch. It is a reasonable first slice, but it is not yet as defensible as Gasworks' dedicated presentation pipeline.
   - Current state after the latest alignment pass: `enrich.ts` is now mostly orchestration. It validates graph.v2 snapshots, resolves root/scope metadata, dedupes supervisor beads, and delegates semantic grouping, execution-instance decoration, display edges, execution path resolution, and lane construction to focused modules with direct tests.
   - Existing repo precedent allows large collectors (`snapshot/collectors/runs.ts` is also large), but new semantic logic of this importance now has smaller focused tests in addition to golden fixture coverage.

2. The display graph is still a quiet vertical list, not a full DAG renderer.
   - This is acceptable for the dashboard's visual system and the requested left-panel vertical flow.
   - The stable vertical order comes from supervisor-owned compiled formula data: currently the run snapshot's bead order. When more precise source-order metadata is required, use the supervisor's compiled formula response built from Gas City's `Recipe.Steps`.
   - If a future live snapshot does not contain enough order metadata, the dashboard should ask the supervisor for the formula detail/preview response built from `Recipe.Steps`; it should still not read formula files.
   - Supervisor `logical_edges` win when available for visible edge data, and physical deps are the fallback, but edges do not reorder nodes.
   - It is still not equivalent to Gasworks' `display_graph`, zoom/pan layout, or scope-group presentation.
   - The plan should continue to call this a dashboard display graph, not a full DAG renderer.

3. Real graph.v2 fixture coverage is partially live-captured.
   - This audit added OpenAPI-shaped active adopt-PR and completed bug-hunt fixtures under `backend/test/fixtures/run-snapshots.ts`, modeled on the production formula pack.
   - Direct `enrichFormulaRun()` tests now assert stable semantic node ids, current/latest iteration selection, hidden badge collapse, streamability, retry/fanout/condition handling, and no leaked internal check-loop terminology.
   - Live evidence rechecked on May 25, 2026: the local racoon-city supervisor exposes formulas, but `/v0/city/racoon-city/formulas/feed?scope_kind=city&scope_ref=racoon-city` still returns an empty feed, the only matching formula with run text is `mol-dog-stale-db` with `run_count=0`, no bead advertises `gc.kind=run` or `gc.formula_contract=graph.v2`, and `/v0/city/racoon-city/run/rc-lkr9?scope_kind=city&scope_ref=racoon-city` returns 404.
   - Live capture added after that audit: an isolated suspended rig produced a side-effect-free cooked graph.v2 smoke run whose supervisor snapshot has current OpenAPI fields, empty logical presentation fields, physical `tracks` containment deps, hidden `scope-check` controls, and a hidden `run-finalize` control. The captured shape now lives in `backend/test/fixtures/run-snapshots.ts` as `capturedDashboardGraphV2SmokeSnapshot`.
   - Remaining gap: replace or augment the modeled active/completed fixtures with captured live supervisor snapshots once `/v0/city/{name}/run/{id}` can return known completed and active graph.v2 runs in the local environment.

4. Session streaming is still transcript-shaped rather than agent-step-shaped.
   - `useSessionStream()` fetches a sanitized transcript snapshot, opens the session SSE stream for active nodes, appends named `turn` events, and exposes visible connection state.
   - It now keeps the EventSource listener alive across transient stream errors so browser-level reconnect can continue delivering turns.
   - Remaining gap: it does not yet expose stream cursor state, event ids, or structured tool-call sections beyond what `TranscriptTurn` provides.
   - This matches v1 scope, but richer coding-agent transcript rendering should be a separate follow-up rather than folded into the graph layout work.

5. The diff is run-level, not node-level.
   - This matches the user decision for v1.
   - UI and docs must keep saying "current working tree" and "execution folder"; do not imply a selected node caused those changes until per-node baselines or commits exist.

### Recommended Alignment Work

1. Keep expanding the backend fixture corpus as live snapshots become available.
   - Done in this pass: active adopt-PR and completed bug-hunt real-shaped fixtures cover check loops, historical iterations, retry attempts, failed-attempt sessions, fanout, skipped conditions, finalizer badges, and no-session nodes.
   - This pass also checked the live racoon-city supervisor. It currently has graph.v2 formulas in the catalog but no graph.v2 runs in the run feed, so captured fixtures are not available from this environment yet.
   - Latest live sample-city check: `formula-detail-demo-city` currently exposes two planning runs on `/runs`, `todo-p25w` (`Plan Todo App demo`) and `ttt-uuum` (`Plan Tic Tac Toe demo`). Both planning detail pages load through the dashboard route with no unexpected API failures. The expected todo and tic-tac-toe implementation runs are not present, so the live e2e harness fails intentionally until those runs exist.
   - Next evidence step: capture at least one real active graph.v2 run and one real completed graph.v2 run from the supervisor endpoint, then add them beside the modeled fixtures.

2. Keep `enrich.ts` cohesive around presentation semantics, but move generic raw-field readers out as they become shared utility.
   - Done in this pass: `backend/src/runs/bead-fields.ts` owns metadata trimming, step-ref normalization, attempt/iteration extraction, and externalized ids.
   - Done in the latest alignment pass: `backend/src/runs/groups.ts` owns semantic grouping and hidden-control badge collapse, `backend/src/runs/execution-instances.ts` owns execution-instance decoration and loop/retry presentation state, and `backend/src/runs/lanes.ts` owns lane construction.
   - `backend/src/runs/enrich.ts` is intentionally left as the dashboard presentation adapter rather than split further until live captured snapshots reveal a stronger boundary.

3. Keep `docs/ARCHITECTURE.md` in sync when stream behavior changes.
   - The implementation now has one proxy helper for city events and session streams.
   - The run detail frontend now follows the same visible SSE status pattern as the city event stream instead of hiding reconnect/error state.
   - Any future direct-supervisor browser EventSource work should update both code and architecture docs in the same change.

4. Keep the dashboard API shape stable while investigating upstream/shared enrichment.
   - Short term: dashboard owns a minimal TypeScript presentation adapter.
   - Medium term: move logical-node/display-graph enrichment into Gas City or a shared package so Gasworks and this dashboard do not fork semantics.

5. Keep the detail-route visual harness close to the frontend fixture contract.
   - Done in this pass: `scripts/snap-run-detail.mjs` snapshots run detail in both themes with deterministic run summary, run detail, diff, transcript, stream, app-shell config, snapshot, and SSE responses.
   - The harness now exercises no initial selection, active selected-node transcript streaming, iteration tabs, selected-node toggle-off, and historical-only deep-link transcript access.
   - `frontend/src/routes/FormulaRunDetail.test.tsx` consumes the same `frontend/src/test/fixtures/formula-run-detail.json` fixture so component behavior and visual harness data stay aligned.
   - The harness installs context-level API routes before page creation and treats any `/api/*` request failure as a test failure, matching the repo's preference for visible browser automation regressions.
   - Extend the fixture when the UI adds richer transcript sections or when live-captured supervisor snapshots replace the modeled active run.

6. Keep a live sample-city harness separate from deterministic fixture screenshots.
   - Added `scripts/e2e-sample-formula-runs.mjs` for the real `formula-detail-demo-city` run route.
   - The harness requires four sample runs: todo planning, todo implementation, tic-tac-toe planning, and tic-tac-toe implementation.
   - The current live result is intentionally red: 2/4 expected runs exist. This is useful because it proves the dashboard no longer silently calls a fixture path or the wrong city when the sample data is incomplete.
   - Do not mark the live sample-city e2e complete until both implementation runs are present and pass the same clickthrough/detail/selection/diff/session checks.

7. Keep route error coverage explicit as new run endpoints appear.
   - Done in this pass: run detail route tests now cover invalid run ids, invalid scope params, unsupported non-graph snapshots, upstream 404 mapping, and generic upstream failure redaction.
   - The important pattern is not just the response status. Validation tests also assert that the supervisor was not called, and redaction tests assert that response bodies do not leak supervisor topology, local paths, or city-specific details.
   - Session stream validation now uses the same shared `SESSION_ID_RE` as transcript peek and has route coverage for the no-upstream-call path.

### Alignment Work Completed In This Pass

- Added `backend/src/runs/formula-run.ts` with the `RunningFormulaRun` projection so the backend aggregates supervisor run snapshots, runtime bead overlays, sessions, semantic node groups, display edges, lanes, execution path, and progress before the browser renders anything.
- Added `FormulaRunDetail.progress` to the shared browser contract and updated `FormulaRunDetailPage` to render backend-owned aggregate progress rather than recomputing status summaries in React.
- Added red/green coverage proving the backend emits progress and the frontend uses it even when the node array would produce a different derived summary.
- Added `scripts/e2e-sample-formula-runs.mjs` as a live sample-city browser/API check. The current run is intentionally red because only the planning runs exist in `formula-detail-demo-city`; the implementation runs are missing.
- Added `backend/test/fixtures/run-snapshots.ts` with two OpenAPI-shaped graph.v2 runtime snapshots modeled on the production formula pack:
  - active `mol-adopt-pr-v2`, including check-loop history, expansion, skipped condition, scope-check badge, finalizer badge, and streamable current iteration.
  - completed `mol-bug-hunt-v2`, including retry attempts, a failed historical attempt, fanout, skipped condition, completed no-session node, and finalizer badge.
- Added direct enrichment golden tests in `backend/test/run-enrich.test.ts`.
- Tightened raw supervisor run snapshot types to the current OpenAPI shape, and removed guessed root/camel/dependency fallback fields from the dashboard enrichment path.
- Tightened graph.v2 root detection and formula naming to current supervisor metadata only: `gc.formula_contract` identifies graph.v2 roots and `gc.formula` carries the formula name. Red tests first proved that `contract`, `formula_contract`, `gc.contract`, and plain `formula` aliases were still being accepted, then the enrichment path was narrowed and the backend suite passed.
- Tightened root-bead resolution to the current supervisor contract. Red tests first proved that a snapshot whose `root_bead_id` did not match any emitted bead still enriched by falling back to the first bead; enrichment now rejects that snapshot as unsupported instead of guessing a root.
- Tightened scope resolution to the current supervisor contract. Red tests first proved that missing `scope_ref` and unknown `scope_kind` still enriched by falling back to the configured city scope; enrichment now requires the supervisor snapshot to provide `scope_kind` as `city` or `rig` and a non-empty `scope_ref`. Direct unscoped browser requests are still handled at the route boundary by asking the supervisor for the configured city scope.
- Tightened required snapshot metadata handling to the current supervisor contract. Red tests first proved that a malformed `snapshot_version` still enriched as `v0`; enrichment now requires a finite numeric `snapshot_version` from the supervisor response instead of inventing one.
- Tightened required snapshot identity/store handling to the current supervisor contract. Red tests first proved that blank `run_id`, blank `root_store_ref`, blank `resolved_root_store`, and malformed `partial` values were still accepted; enrichment now rejects those malformed snapshots instead of falling back to root ids, empty store strings, or a synthesized non-partial state.
- Tightened step-ref, construct-kind, and session-link derivation to current supervisor run snapshot fields only. Red tests first proved that plain `metadata.step_ref`, dashboard-invented `metadata.constructKind`, `gc.session_*`, camel-case session aliases, metadata `assignee`, and legacy `mc_rig_id` were still being accepted; the adapter now uses `metadata["gc.step_ref"]` plus top-level `step_ref`, `metadata["gc.kind"]`/`metadata["gc.original_kind"]` plus top-level `kind`, and `metadata.session_id`/`metadata.session_name` plus top-level `assignee`.
- Tightened metadata value handling to the current supervisor/OpenAPI contract. Gas City's `RunBeadResponse.Metadata` is `map[string]string`, so run presentation helpers now ignore malformed non-string metadata values instead of stringifying numbers or booleans. A red test first proved those malformed values were still accepted.
- Tightened internal check-loop name externalization so implementation-private `ralph` segments are removed across hyphen, dot, and underscore separated ids without rewriting embedded words. A red test first proved `mol_ralph_review` still leaked; `externalizeId()` now treats any non-alphanumeric delimiter as a private-name boundary.
- Tightened display-title projection so implementation-private check-loop names are scrubbed from operator-facing node titles, not just semantic ids and kinds. A red test first proved a supervisor title such as `Review ralph pass` would still leak; display titles now render that vocabulary as `check loop` while leaving embedded words untouched.
- Added lane-level run scope derivation from `gc.scope_kind`, `gc.scope_ref`, and `gc.root_store_ref`, so summary links carry the supervisor-required lookup scope into the run detail route.
- Tightened summary links, detail-route loading, and run API helpers so they send `scope_kind` and `scope_ref` only as a complete pair. If summary or route state has only half the scope, the frontend omits scope query params and lets the backend's default city-scope resolution handle the run. Red tests first proved partial scope pairs were being emitted; focused route/component tests and the browser clickthrough harness now cover omission and complete-pair preservation.
- Added a route default for direct unscoped detail URLs: the dashboard asks the supervisor for the configured city scope instead of making an invalid unscoped run request.
- Changed run enrichment so failed terminal attempts with attached sessions keep their transcript link while remaining non-streaming.
- Added `frontend/src/test/fixtures/formula-run-detail.json` as the deterministic frontend wire fixture for an active graph.v2 run detail.
- Tightened `FormulaRunDetailPage` selection state so URL-driven node selection clears when `?node=` is removed instead of leaking stale state across route changes, while preserving the URL target across stale-cache-to-fresh-detail refreshes.
- Extracted run-detail node selection into `frontend/src/hooks/useRunNodeSelection.ts`, with focused hook tests for route selection, user selection, query removal, refresh materialization, node toggling, and Escape clear.
- Added `scripts/snap-run-detail.mjs`, a Playwright harness that clicks from the run summary into the run-detail split panel and snapshots it in light and dark themes without a live supervisor run.
- Tightened `scripts/snap-run-detail.mjs` so app-shell API traffic is fixture-backed and request-level `/api/*` failures fail the harness across the full browser journey.
- Expanded `backend/test/runs.test.ts` route coverage for validation, unsupported non-graph snapshots, supervisor 404 mapping, and generic upstream error redaction.
- Extracted shared `SESSION_ID_RE` validation under `backend/src/lib` and covered the stream route's invalid-id/no-upstream path.
- Added session stream route coverage proving a client disconnect closes the upstream supervisor session stream, matching the shared `/api/events/stream` proxy cleanup contract.
- Aligned run node session streaming with the repo's SSE status pattern: active transcript streams now show live/connecting/offline state with `StatusBadge`, and the component test proves a transient SSE error does not drop the named-turn listener.
- Made the dashboard display graph preserve supervisor-emitted formula order without changing the quiet vertical UI. Enrichment keeps node order from supervisor run data, and when the run exposes `gc.formula` plus a run target it fetches the supervisor formula detail/preview response and ranks display groups by compiled formula step order. It still prefers supervisor `logical_edges` over physical deps for the edge list. Fixture and route tests cover formula-order preference, logical-edge preference, and physical-dep fallback without allowing edge sources to reorder nodes.
- Tightened the React graph renderer so it also preserves the supervisor-emitted node order. Display lanes remain metadata for grouping/context, but they no longer reorder the vertical graph.
- Moved run git diff subprocess calls behind `execRunGit()` in `backend/src/exec.ts`, preserving the repo's whitelist/clean-env/timeout/output-cap/concurrency pattern for the new diff surface.
- Split pure run presentation enrichment tests into `backend/test/run-enrich.test.ts`, leaving `backend/test/runs.test.ts` focused on route and SSE behavior.
- Extracted raw supervisor bead field readers to `backend/src/runs/bead-fields.ts`, with direct unit coverage in `backend/test/run-bead-fields.test.ts`.
- Moved raw supervisor run snapshot wire types out of the shared package root into `shared/src/run-snapshot.ts`, preserving root re-exports while keeping run-specific contracts near `shared/src/run-detail.ts`.
- Extracted execution-folder resolution to `backend/src/runs/execution-path.ts`, with direct coverage for root cwd, child/session work-dir metadata, supervisor rig root metadata, configured rig-root fallback, and blank-path handling.
- Extracted display-edge projection to `backend/src/runs/edges.ts`, with direct coverage for supervisor logical-edge preference, physical-dep fallback, hidden/duplicate/self/empty edge filtering, and externalized implementation-private ids.
- Extracted node shape projection to `backend/src/runs/node-shape.ts`, with direct coverage for semantic id precedence, construct-kind mapping, explicit construct metadata, hidden badge targets, external labels, loop parent ids, and title fallback.
- Extracted status normalization to `backend/src/runs/status.ts`, with direct coverage for closed outcomes, active statuses, terminal/waiting fallback, aggregate active precedence, and streamable-state detection.
- Extracted session-link resolution to `backend/src/runs/session-link.ts`, with direct coverage for missing sessions, pending/ready suppression, explicit supervisor session metadata, assignee fallback, and failed-attempt transcript preservation.
- Added detail-page status-summary copy so the header includes the requested run-state rollup, not just node and edge counts.
- Added detail-page snapshot metadata copy so the header shows both supervisor snapshot version and event sequence when the supervisor includes `snapshotEventSeq`.
- Added detail-page partial snapshot copy so a `partial` supervisor snapshot is visible to the operator instead of being a hidden wire-field.
- Split the Diff panel into explicit `Unstaged Diff` and `Staged Diff` sections, keeping prefix-based colorization and truncation copy. Route tests now cover staged diffs, server-owned path resolution, `path_unknown`, `not_git`, file classification, and backend truncation metadata.
- Added stable, construct-specific frontend shape classes for first-pass graph.v2 constructs, with component tests proving run root, step, retry, check-loop, scope, condition, fanout, and expansion no longer collapse to shared visual treatments.
- Aligned construct shape CSS with the dashboard's Flat Page Rule by avoiding at-rest shadow/elevation and side-stripe treatment while preserving distinct retry and scope shapes.
- Added latest-loop-iteration visibility semantics: loop body nodes that only exist in older iterations are preserved for right-panel transcript access but excluded from the left graph.
- Added an explicit `historical-only` label and route coverage proving a deep-linked historical-only semantic node can show its transcript without appearing as a selectable graph node.
- Expanded the deterministic Playwright run-detail harness to exercise summary-lane clickthrough with preserved scope query params, exact staged/unstaged diff text and prefix classes, partial snapshot copy, no initial selection, mouse and keyboard node selection, Escape clearing, iteration tabs, active-session stream turns, historical iteration non-streaming, toggle-off clearing, no-session tab disabling, no-graph, no-git, path-unknown, clean-worktree, and historical-only transcript deep links.
- Added browser clickthrough validation from the Runs summary lane to the detail route with preserved `scope_kind` and `scope_ref`, plus browser validation for partial snapshot copy, snapshot version/event-sequence copy, staged/unstaged diff rendering, and full-journey `/api/*` failure detection.
- Tightened the generic screenshot harness with `--test` mode so route snapshots can fail on `/api/*` failures instead of silently capturing a broken proxy/API state.
- Tightened run detail/diff route query validation so malformed non-string `scope_kind` or `scope_ref` values, including duplicated query params, are rejected before any supervisor call. A red route test first proved the both-duplicated case fell through to an upstream lookup and returned 404; the parser now returns 400 validation and preserves the no-upstream-call contract.
- Tightened frontend detail-route scope parsing so malformed or duplicated complete scope query params surface an immediate route validation error and do not trigger the default-city `/api/runs/:id` request. Red route/component tests first proved the browser silently dropped malformed params and loaded the run.
- Added frontend route/component tests for no-graph and selected-node-without-session empty states, retry attempt tabs, partial snapshots, and staged/unstaged diff labels.
- Added frontend route coverage proving selected-node session streams close when selection changes or the Session tab is hidden.
- Added frontend route and browser-harness coverage proving the Session tab is unavailable for a selected semantic node that has no execution instance with a session link, while the no-session empty state remains visible.
- Aligned the run evidence tab control with ARIA tab semantics by wiring each tab to the shared evidence `tabpanel`, with route coverage for the active panel label relationship.
- Expanded the deterministic run-detail transcript fixture to include coding-agent request/response structure with `tool_use`, `tool_result`, and `final` turns, and added route coverage that those roles render in the selected-node Session panel.
- Moved the historical-only loop case into `frontend/src/test/fixtures/formula-run-detail.json` so the route tests and Playwright harness share one fixture contract instead of synthesizing the same case independently.
- Reworked `backend/src/runs/enrich.ts` into the orchestration layer for the dashboard presentation adapter. It now delegates raw field reads, semantic grouping, execution-instance decoration, edge projection, execution-path resolution, status normalization, session links, and lanes to focused modules with direct tests.
- Added `useCachedData` race coverage so stale fetches cannot overwrite state after a route-key change or overwrite the active same-key cache slot after a newer refresh completes.
- Changed the no-env local default city from `gas-city` to `racoon-city`, with config tests and env docs, so local run snapshots hit the supervisor city that exists in this environment instead of rendering a 404.
- Extracted run semantic grouping, execution-instance decoration, and lane construction out of `backend/src/runs/enrich.ts` into focused modules with direct tests:
  - `backend/src/runs/groups.ts` plus `backend/test/run-groups.test.ts`
  - `backend/src/runs/execution-instances.ts` plus `backend/test/run-execution-instances.test.ts`
  - `backend/src/runs/lanes.ts` plus `backend/test/run-lanes.test.ts`
- Tightened semantic node id projection for supervisor runtime `step_ref` values. A red test first proved `mol.review.attempt.2` projected to the numeric suffix `2`; `semanticNodeIdFor()` now strips runtime suffixes such as `attempt.N`, `run.N`, `check.N`, and terminal `iteration.N` before deriving the stable semantic node id, while preserving loop-body ids such as `review-codex` inside `iteration.N.review-codex.attempt.N`.
- Tightened runtime numeric field parsing so malformed strings are not accepted through JavaScript numeric-prefix parsing. Red tests first proved `gc.iteration="2x"`, `step_ref` segments such as `iteration.2x`, and `gc.max_attempts="3x"` could still produce iteration numbers or attempt badges; run field readers now accept only positive integer values for attempt, iteration, and max-attempt presentation metadata.
- Tightened current runtime `.run.N` path handling for loop contexts and hidden controls. Red tests first proved nested `run.1-scope-check` targets collapsed to the numeric suffix `1` and `gc.scope_ref="mol.review-loop.run.2"` did not identify the loop control; hidden badge targeting now prefers supervisor `gc.control_for` and falls back through semantic runtime-ref derivation, and loop context now uses supervisor `gc.scope_ref` for `.iteration.N` and `.run.N` scopes.
- Tightened display-edge projection to match the left graph's latest-iteration visibility. A red test first proved an edge connected to a `visibleInGraph: false` historical-only node still appeared in the display edge list; edge projection now filters against graph-visible nodes so dependency counts and edge metadata do not reference nodes hidden from the left panel.
- Added a captured supervisor smoke snapshot from an isolated graph.v2 test rig. A red edge-projection test first proved the current code dropped the real `inspect -> scope-check -> summarize` dependency chain and kept only root `tracks` containment edges; display-edge projection now treats `tracks` as containment and bridges visible dependency edges through hidden `scope-check` controls while keeping `run-finalize` hidden as a root badge.

## Formula Construct Research

Relevant Gas City files:

- `/Users/csells/Code/gastownhall/gascity/internal/formula/types.go`
- `/Users/csells/Code/gastownhall/gascity/internal/formula/recipe.go`
- `/Users/csells/Code/gastownhall/gascity/internal/formula/compile.go`
- `/Users/csells/Code/gastownhall/gascity/internal/formula/controlflow.go`
- `/Users/csells/Code/gastownhall/gascity/internal/formula/expand.go`
- `/Users/csells/Code/gastownhall/gascity/internal/formula/graph.go`
- `/Users/csells/Code/gastownhall/gascity/internal/formula/retry.go`
- `/Users/csells/Code/gastownhall/gascity/internal/api/handler_formulas.go`
- `/Users/csells/Code/gastownhall/gascity/internal/api/huma_types_formulas.go`
- `/Users/csells/Code/gastownhall/gascity/internal/api/handler_convoy_dispatch.go`
- `/Users/csells/Code/gastownhall/gascity/internal/api/huma_types_convoys.go`

Graph.v2 constructs in scope for this plan:

- Source formula contracts: `contract: "graph.v2"` only.
- Source formula types: graph.v2 `run` and graph.v2 `expansion`.
- Standard executable step: `Step` with `id`, `title`, `type`, `assignee`, metadata, labels.
- Dependency edge: `depends_on` or `needs`.
- Inline expansion: `expand` and `expand_vars`, when it is visible in source/spec metadata or compiled runtime metadata.
- Conditional step: `condition`, primarily surfaced as skipped or pending runtime state unless source/spec metadata is retained.
- Nested container: `children`, compiled to parent/child or promoted epic/scope semantics.
- Retry control: `retry`, compiled to a control bead plus attempt beads.
- Check-loop control: public formula syntax uses `check`, compiled to a control bead plus iteration/check beads.
- Runtime graph controls: `fanout`, `scope-check`, `run-finalize`, and `spec` nodes inserted during graph control application.

Compiler-supported graph.v2 constructs that are not first-pass implementation scope unless live graph.v2 runtime data exposes them:

- Wait gate: `waits_for`.
- Async gate: `gate`.
- Loop: `loop` with `count`, `until`, `max`, `range`, `var`, and `body`.
- Runtime fanout source rule: `on_complete` with `for_each`, `bond`, `parallel`, `sequential`.
- Branch rules: `compose.branch` with `from`, `steps`, and `join`.
- Gate rules: `compose.gate`.
- Map rules: `compose.map`.
- Aspect/advice rendering.

Important data-source caveat:

Gas City's native run endpoint currently returns physical beads and deps. In `huma_types_convoys.go`, `LogicalNode` and `ScopeGroup` are intentionally empty presentation placeholders, and comments say logical presentation belongs downstream. Gasworks-gui's server is that downstream presentation layer today.

Gas City's formula endpoints are different: `handler_formulas.go` compiles the loaded formula into a `formula.Recipe`, iterates `recipe.Steps` in order, and returns recipe-derived `steps`, `deps`, and `preview` data. That is the correct supervisor/API path for stable source-order or construct metadata if the run snapshot is not enough.

That means this dashboard has two implementation choices:

1. Port the Gasworks presentation enrichment into this repo's backend.
2. Move the presentation enrichment upstream into Gas City, then have this repo consume it.

Recommendation: keep the first dashboard slice as a supervisor-data adapter, not a parser. Start with the run snapshot and add a supervisor formula detail/preview call only when a real snapshot proves that the run detail needs compiled `Recipe.Steps` data that is not already present. Keep the API shape aligned with Gasworks' `RunSnapshot`. If Gas City later owns presentation enrichment, the dashboard adapter can collapse to a pass-through.

## Real-World Formula Pack Observations

Reference pack:

- `/Users/csells/Code/gascity/gas-city-inc/packs/runs/formulas`

These examples are planning research only. They are not an implementation data source for the dashboard, and the dashboard must not reproduce this research with a local formula-file parser.

The pack includes `mol-*` run formulas and `expansion-*` formulas that exercise the graph.v2 shapes this page has to render. Router formulas are out of scope unless the detail route resolves them to a launched graph.v2 run.

Constructs represented in the real examples:

| Construct                       | Notes                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal steps                    | The dominant visible unit.                                                                                                                                                                                    |
| Expansion templates             | Expansion output becomes normal runtime nodes after compile.                                                                                                                                                  |
| Retry-managed steps             | Highest priority non-trivial shape. Release, bugflow, review, and bug-hunt flows all rely on retry-managed steps.                                                                                             |
| Check-loop controls             | High priority, because these are the iterative review/fix loops the operator will care about.                                                                                                                 |
| Child scopes                    | Used mainly inside check loops as scoped loop bodies.                                                                                                                                                         |
| Compose expansion               | Used to inline review/design-review expansions into target steps.                                                                                                                                             |
| Conditions                      | Mostly skip flags such as `skip_gemini` and `skip_human_approval`.                                                                                                                                            |
| Less common graph.v2 vocabulary | Keep `loop`, `waits_for`, `gate`, `compose.branch`, `compose.map`, `compose.gate`, and `on_complete` documented as graph.v2 vocabulary, but do not implement first unless live supervisor data requires them. |

Important examples:

- `mol-adopt-pr-v2` uses a `review-loop` check loop, child steps for the review pipeline and fix application, compose expansion with `expansion-review-pr`, conditional human approval, and a second check loop for CI repair.
- `expansion-review-pr` expands a multi-model PR review fanout into retry-managed Claude/Codex/Gemini review steps, a synthesis step, and a scorecard step. The Gemini lane is conditional.
- `expansion-design-review-core` uses a design review/apply check loop and an explicit runtime fanout control bead through `metadata.gc.kind = "fanout"`, rather than formula-level `on_complete`.
- `mol-bug-report-implementation-v2` composes both design review and PR review expansions, has a code-review check loop, and uses human approval steps represented as normal/retry-managed work rather than formula `gate` sections.
- `mol-release-v1` is mostly a long linear graph with a scope body and retry-managed release gates. "Gate" appears as domain language around CI/GitHub runs, not as the formula `gate` construct.

Planning implication:

The first production slice should optimize for graph.v2 runtime runs that contain `step`, `retry`, check-loop controls, `children/scope`, `compose.expand`, `condition`, `fanout`, `scope-check`, and `run-finalize`. Source-level `loop`, `compose.branch`, `compose.map`, `waits_for`, and `gate` should stay documented as future graph.v2 shapes, not first-pass implementation work.

## Proposed User Experience

### Runs Page

`LaneCard` becomes a navigable row.

- Primary click target: `/runs/:runId`.
- Preserve external PR/issue links as separate links.
- Pass or fetch `scope_kind` and `scope_ref` when available. If the current summary cannot provide them, the detail endpoint should resolve by run id and fall back to the configured city scope.
- Keep the current summary surface quiet. Do not put mini graphs inside every lane.

### Detail Page

Route:

```text
/runs/:runId
```

Optional query params:

```text
?scope_kind=city&scope_ref=<city>&node=<node-id>
```

Recommended behavior:

- Load the run detail from `/api/runs/:runId`.
- Load git diff status from `/api/runs/:runId/diff`.
- If `node` is in the query string and exists, select it. Otherwise start with no selected node.
- Selecting a node updates component state. The selected id is a semantic node id, not a physical bead id or a single execution attempt id. Updating `?node=` is optional for the first pass; useful for shareable detail links.
- Clicking a different node selects it.
- Clicking the selected node clears selection.
- Pressing Escape clears selection.
- The `Session` tab is enabled only when the selected semantic node resolves to at least one execution instance with a session link.
- If selected node has no execution instance with a session, the session panel says that no session is attached to this node.
- If no node is selected, the session panel says to select a node.
- Session content is rendered as a coding-agent transcript:
  - inbound task/request or continuation context
  - assistant responses
  - tool/command invocations
  - stdout/stderr summaries, capped
  - file edit summaries
  - final response or current streaming turn
- Do not auto-select active nodes on first load. Start with no selected node unless `?node=` explicitly names a valid node.

### Layout

Desktop:

- Header: run title, formula, status summary, root bead id, store/scope, snapshot timestamp/version.
- Main content: two-column split.
- Left column: vertically oriented run diagram.
- Right column: evidence panel with tabs:
  - `Diff`
  - `Session`

Mobile/narrow:

- Stack diagram above tabs.
- Keep node selection behavior identical.
- Avoid horizontal graph panning on the initial implementation.

## Visual System

The page should follow `PRODUCT.md` and `DESIGN.md`:

- Light default, dark optional.
- Typography and whitespace carry hierarchy.
- No card grid.
- No neon graph palette.
- Status cannot be carried by color alone.
- Maroon is the rare focus/anomaly mark.

### Node Shapes

Shape priority should follow the graph.v2 formulas in the real-world pack: normal steps, retry, check loops, child scopes, expansion, condition, and fanout first.

First-pass graph.v2 shapes:

| Construct                     | Shape                                                        | Status treatment                                                                     |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Run root                      | Double-outline rectangle                                     | Summary count and finalizer badge                                                    |
| Normal step/task/bug/chore    | Rectangle                                                    | Check glyph when complete, active mark when running                                  |
| Container/children/epic/scope | Rounded grouping band or bracketed region                    | Contains child vertical run, muted when complete                                     |
| Conditional step              | Split diamond or hexagon                                     | Skipped state when condition false, pending when unresolved                          |
| Runtime fanout/on_complete    | Dashed rounded rectangle                                     | Fanout badge with count when known                                                   |
| Retry                         | Stacked capsule plus visible attempt/body nodes when present | Attempt badge such as `2/3`; executable attempt nodes remain selectable              |
| Check loop                    | Capsule with check notch plus visible loop body nodes        | Run/check state and attempt badge; executable loop nodes remain selectable           |
| Expansion                     | Dashed outline group or small expansion badge                | Shows generated nodes without pretending source step was directly run                |
| Scope-check                   | Badge attached to target node                                | Hidden from main graph for v1; may be exposed later through detail/debug affordances |
| Run-finalize                  | Badge on root                                                | Hidden from main graph for v1; may be exposed later through detail/debug affordances |
| Spec/source node              | Hidden by default                                            | Available in debug/metadata only                                                     |

Loop visibility rule:

- Do not make loops opaque rollups. The user must be able to see and select executable nodes inside retry/check-loop bodies.
- The left graph renders the current/latest iteration body nodes only.
- Show prior iterations as a subtle stack/history cue on the loop region or control node, not as selectable left-graph nodes.
- The current/latest iteration can show multiple selectable body nodes, and more than one of those nodes can have an active streaming session when the graph allows parallel work.
- Selecting a body node opens Session panel iteration tabs for that logical node. Those right-panel tabs are how the user navigates prior iterations.
- Previous iterations are historical. Their sessions are static transcript history and do not stream.
- Control nodes may show aggregate status and attempt counts, but they do not replace the body nodes.
- Compiler/housekeeping nodes such as `scope-check`, `run-finalize`, `cleanup`, and `spec` stay hidden or badged for v1 unless they are the only way to expose real operator work.

Deferred graph.v2 shapes:

| Construct                   | Shape                         | Status treatment                                                          |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| Gate/waits_for/compose.gate | Diamond                       | Locked/pending glyph, active outline when waiting                         |
| Loop/range/until            | Loop pill with circular glyph | Attempt/iteration badge                                                   |
| Branch/fork/join            | Hexagon or fork node          | Parallel child rails below it                                             |
| Map/aspect/advice           | Dashed outline group or badge | Shows generated or advisory nodes only when graph.v2 metadata is explicit |

Status vocabulary:

- `done` or `completed`: already run.
- `active` or `running`: running now.
- `pending`: not yet run.
- `ready`: can run now.
- `blocked`: waiting on dependency, gate, human, or tool approval.
- `failed`: terminal failure.
- `skipped`: terminal skipped state.

Each status needs both visual and textual/glyph representation:

- Complete: check glyph plus muted text.
- Running: dark active outline plus "running" label; maroon used only for selected/focus or true anomaly.
- Pending: faint dashed outline plus "pending" label.
- Blocked/failed: explicit word and glyph, not just color.

## Data Contracts

### Semantic Nodes and Execution Instances

Keep the runtime model explicit:

- A semantic node is the formula/logical work unit the operator selects in the graph, for example `review-codex`, `apply-fixes`, or `synthesize`.
- An execution instance is one materialized run of that semantic node, for example `review-codex` in iteration 1, `review-codex` in iteration 2, or retry attempt 2 within iteration 2.
- The left graph renders semantic nodes for the latest visible execution context.
- The right evidence panel navigates execution instances for the selected semantic node.

This distinction prevents UI selection from depending on brittle bead ids, step-ref parsing, or whichever retry/loop attempt happens to be current.

### Run Summary Extension

Current `RunLane` should gain enough detail to link reliably:

```ts
interface RunLane {
  id: string;
  title: string;
  formula: string | null;
  scopeKind?: "city" | "rig" | null;
  scopeRef?: string | null;
  rootStoreRef?: string | null;
  // existing fields unchanged
}
```

If scope/store cannot be populated from the summary collector yet, leave them nullable and resolve on the detail route.

### Run Detail

Add shared types aligned with Gasworks:

```ts
type RunNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "active"
  | "done"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

interface RunSessionLink {
  sessionId: string;
  sessionName: string;
  assignee: string;
  rigId?: string;
}

interface RunExecutionInstance {
  id: string;
  semanticNodeId: string;
  beadId?: string;
  iteration?: number;
  attempt?: number;
  label?: string;
  status?: RunNodeStatus;
  sessionLink?: RunSessionLink | null;
  currentIteration?: boolean;
  historical?: boolean;
  streamable?: boolean;
}

interface RunDisplayNode {
  id: string;
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: RunConstructKind;
  status: RunNodeStatus;
  currentBeadId?: string;
  scopeRef?: string;
  loopControlNodeId?: string;
  /** False for semantic nodes that have transcript history but are not in the latest visible graph. */
  visibleInGraph?: boolean;
  /** True when every execution instance belongs to an older loop iteration or stale expansion. */
  historicalOnly?: boolean;
  visibleIteration?: number;
  iterationCount?: number;
  hasHistoricalIterations?: boolean;
  attemptBadge?: string;
  attemptCount?: number;
  activeAttempt?: number;
  visibleExecutionInstanceId?: string;
  executionInstances: RunExecutionInstance[];
  controlBadges?: Array<{
    id: string;
    label: string;
    status: RunNodeStatus;
  }>;
}

interface RunDisplayEdge {
  from: string;
  to: string;
  kind?: string;
}

interface RunDisplayLane {
  id: string;
  label: string;
  nodeIds: string[];
}

interface FormulaRunDetail {
  runId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: "city" | "rig";
  scopeRef: string;
  title: string;
  formula: string | null;
  executionPath: string | null;
  snapshotVersion: number;
  snapshotEventSeq?: number | null;
  partial: boolean;
  nodes: RunDisplayNode[];
  edges: RunDisplayEdge[];
  lanes: RunDisplayLane[];
}
```

### Backend Endpoints

```text
GET /api/runs/:runId
GET /api/runs/:runId/diff
GET /api/sessions/:id/stream
```

`GET /api/runs/:runId`:

- Calls supervisor run endpoint if available:
  - `/v0/city/{cityName}/run/{runId}`
  - include `scope_kind` and `scope_ref` when supplied.
- Enriches physical beads/deps into display nodes/edges if supervisor returns only raw data.
- Returns the dashboard-specific `FormulaRunDetail`.
- Uses the same timeout and topology-leak posture as existing routes.

`GET /api/runs/:runId/diff`:

- Server resolves the execution path. The browser never supplies a filesystem path.
- The diff represents the current code working tree for that execution folder. It is expected to be mostly source files, tests, package/config files, and docs changed by the selected run.
- It does not attempt to diff the formula definition, bead metadata, or run graph unless those files are actually changed in the execution folder.
- UI copy must describe the diff as the current working tree for the run's execution folder. Do not imply the diff is node-scoped or causally attributable to the selected run until the backend has per-node baselines or commits.
- Resolve the path from supervisor-owned run data:
  - Prefer the formula execution `cwd` when the run detail exposes it.
  - Then use root/run metadata such as `gc.work_dir` or `work_dir`.
  - Then use attached session metadata such as `work_dir`, if that is the only execution path the supervisor exposes.
  - If execution cwd/work-dir metadata is missing, use the run's rig root.
  - If neither execution path nor rig root is available, return `kind: "path_unknown"`.
- Do not infer paths from browser query params, PR URLs, GitHub state, or local checkout conventions.
- Check git with `git -C <path> rev-parse --show-toplevel`.
- If not a git work tree, return `kind: "not_git"`.
- If it is git:
  - `git -C <path> status --porcelain=v1`
  - `git -C <path> diff --no-ext-diff --no-color`
  - optionally `git -C <path> diff --cached --no-ext-diff --no-color`
- Use `execFile`, not shell strings.
- Cap output bytes and use a timeout.
- Return plain unified diff. Colorize in the frontend from diff prefixes rather than rendering raw ANSI.
- Add lightweight file classification in the response if cheap, for example `code`, `test`, `docs`, `config`, `other`, so the UI can summarize changed code files without pretending to understand every language.
- Include truncation metadata.

Example response:

```ts
interface RunDiffResponse {
  kind: "ok" | "not_git" | "path_unknown" | "error";
  rootPath: string | null;
  status: string[];
  changedFiles: Array<{
    path: string;
    status: string;
    kind: "code" | "test" | "docs" | "config" | "other";
  }>;
  unstagedDiff: string;
  stagedDiff: string;
  truncated: boolean;
  error?: string;
}
```

`GET /api/sessions/:id/stream`:

- Proxy supervisor SSE:
  - `/v0/city/{cityName}/session/{id}/stream`
- Use the same same-origin SSE proxy pattern as `/api/events/stream`.
- Accept `Last-Event-ID`.
- If streaming fails, the frontend can fall back to `POST /api/sessions/:id/peek`.
- Treat transcript payloads as coding-agent turns. Preserve enough structure to distinguish user/request text, assistant text, tool calls, tool output, and terminal/final messages when the supervisor provides it. If the supervisor only returns plain text, render it in transcript order without inventing structure.

## Run Presentation Enrichment

The display graph should be derived using Gasworks' model:

1. Map physical bead ids to semantic node ids.
2. Build execution instances from materialized beads, preserving iteration, attempt, session, status, and streamability.
3. Choose the latest/current execution context for the left graph, while preserving historical instances for the evidence panel.
4. Group retry and check-loop attempts under their control node without hiding latest-iteration executable body nodes.
5. Collapse scope-check and run-finalize into control badges where appropriate.
6. Compute logical edges from physical deps, excluding containment/deletion-only edges.
7. Build scope groups/lanes.
8. Build display graph for the React page.

Initial port scope:

- Port enough logic to handle:
  - run root
  - normal steps
  - retry
  - check loops
  - scope-check
  - run-finalize
  - fanout
  - session link resolution
- Preserve richer future fields so loop/branch/expansion can be added without changing the route contract.

Construct shape derivation:

- Prefer a future OpenAPI/top-level `constructKind` only after the supervisor adds it. Do not accept dashboard-invented `metadata.constructKind` aliases.
- Otherwise derive from:
  - `node.kind`
  - bead metadata `gc.kind`
  - metadata `gc.original_kind`
  - metadata `gc.step_ref`
  - `control_badges`
  - formula source/spec nodes when present.

Known limitation:

Some source-level constructs, especially `condition`, `expand`, `map`, and `branch`, may be lost or flattened after compilation unless the source formula/spec is attached. The UI can still show the runtime graph, but exact source-construct labeling needs upstream metadata or source-spec retention.

Historical-only case:

- A semantic node may have execution history but not appear in the latest visible graph because conditions, expansions, or fanout changed between iterations.
- Do not invent a left-graph node for that case in v1.
- If the selected semantic node has historical execution instances that are not represented in the latest graph, the evidence panel should label them as historical-only and keep transcripts available from the right side.

## Frontend Components

Add:

- `frontend/src/routes/FormulaRunDetail.tsx`
- `frontend/src/components/run/RunRunDiagram.tsx`
- `frontend/src/components/run/RunRunNode.tsx`
- `frontend/src/components/run/RunRunEdges.tsx`
- `frontend/src/components/run/RunRunTabs.tsx`
- `frontend/src/components/run/RunDiffPanel.tsx`
- `frontend/src/components/run/RunNodeEvidencePanel.tsx`
- `frontend/src/components/run/RunNodeSessionPanel.tsx`
- `frontend/src/hooks/useFormulaRunDetail.ts`
- `frontend/src/hooks/useSessionStream.ts`

Modify:

- `frontend/src/App.tsx`: add `/runs/:runId`.
- `frontend/src/components/run/LaneCard.tsx`: make row navigable.
- `frontend/src/api/client.ts`: add run detail, diff, and session stream helpers.

Selection behavior:

```ts
setSelectedNodeId((current) =>
  current === clickedNodeId ? null : clickedNodeId,
);
```

The selected node should be visually obvious without becoming the only status signal:

- Focus outline or inset rule.
- `aria-pressed`.
- Keyboard activation with Enter/Space.
- Escape to clear.

## Backend Components

Add:

- `backend/src/routes/runs.ts`
- `backend/src/runs/types.ts`
- `backend/src/runs/enrich.ts`
- `backend/src/runs/diff.ts`
- `backend/src/runs/paths.ts`

Modify:

- `backend/src/gc-client.ts`:
  - `getRun(runId, scope?)`
  - `streamSession(sessionId)` or route-local proxy helper.
- `backend/src/server.ts`: mount `/api/runs` and `/api/sessions/:id/stream`.
- `shared/src/snapshot/types.ts`: shared run-detail types, or create a new shared run-detail module.

Implementation note:

Keep git path resolution server-owned. Do not accept arbitrary `path` query params from the browser.

## Implementation Phases

### Phase 1: Contract and Routing

- Add shared run detail and diff types.
- Add backend `GET /api/runs/:runId`.
- Call supervisor run endpoint.
- Reject or return an unsupported state for run roots that do not resolve to graph.v2.
- If the supervisor returns only raw beads/deps for a graph.v2 root, return a basic enriched graph with one node per bead.
- Add frontend route and loading/error states.
- Make Run lanes clickable.

Exit criteria:

- Clicking a run lane opens a detail page.
- The page can render a basic graph from fixture or live data.
- No git/session work yet.

### Phase 2: Presentation Enrichment

- Port/adapt Gasworks' logical mapping, node aggregation, edge filtering, scope groups, and display graph logic.
- Normalize raw supervisor run snapshots into semantic nodes plus execution instances before rendering.
- Add `constructKind` derivation.
- Render vertical diagram with construct-specific shapes.
- Implement exact one-node selection and toggle-off.
- Add golden snapshot tests: raw supervisor run snapshot in, normalized display graph/evidence model out.

Exit criteria:

- Retry/check attempts collapse correctly.
- Semantic nodes and execution instances are distinct in the shared contract.
- Running/done/pending/blocked/skipped/failed states render distinctly.
- Selection state passes keyboard and click tests.

### Phase 3: Git Diff Panel

- Add backend diff endpoint.
- Resolve execution path from supervisor-owned run data, using execution cwd/work-dir first and rig root if cwd/work-dir metadata is missing.
- Label the diff as current execution-folder working tree state, not node-specific or run-causal evidence.
- Add no-git/path-unknown/skipped states.
- Summarize changed code files from `git status --porcelain=v1`.
- Render staged and unstaged diffs with prefix-based colorization.
- Cap large diffs.

Exit criteria:

- Git work trees show colorized code diffs.
- Non-git folders show a quiet skipped state.
- Large diffs truncate intentionally.

### Phase 4: Session Panel and Streaming

- Resolve execution instances for the selected semantic node.
- If a selected loop body node has execution instances from multiple iterations, show them as tabs or a compact segmented control labeled by iteration number.
- If a selected retry-managed node has multiple attempt execution instances within an iteration, show attempt tabs inside the selected iteration context.
- Default to the current/latest iteration. Within that iteration, default to the active/running attempt session when one exists; otherwise default to the latest completed attempt.
- Reuse transcript rendering conventions from Agent Detail/Peek, but frame the content as coding-agent request/response turns.
- Add `/api/sessions/:id/stream` SSE proxy to supervisor session stream.
- Fall back to existing peek endpoint when SSE is unavailable.
- Stream only while the Session tab is visible and the selected node's selected session is in the current/latest loop iteration and active/running.
- Previous loop iterations never stream. Render their sessions from fetched transcript history.
- When a retry node has multiple attempt tabs, only the open attempt may stream. Other attempts remain static until clicked.
- Surface historical-only execution instances in the evidence panel without adding left-graph nodes.
- Preserve tool-call and command-output boundaries where available. This matters because formula nodes are usually coding tasks, not simple status logs.

Exit criteria:

- Selecting a completed node shows its full transcript.
- Selecting an active node streams new turns.
- The transcript visually distinguishes request/context, assistant response, tool call, and tool output sections.
- Changing selection closes the previous stream.

### Phase 5: Polish and Hardening

- Add light/dark styling.
- Add responsive stacked layout.
- Add empty states:
  - no graph
  - no git repo
  - no selected node
  - selected node without session
  - stale/partial snapshot
- Add screenshot coverage for the detail route.
  - Done for scoped summary clickthrough, no initial selection, selected active session, exact staged/unstaged diff rendering, snapshot version/event-sequence copy, partial snapshot copy, keyboard selection and Escape clearing, iteration tabs, selected-node toggle-off, no-session tab disabling, and historical-only deep-link transcript access via `node scripts/snap-run-detail.mjs --test`.

Exit criteria:

- Typechecks pass.
- Snapshot captures pass for `/runs` and `/runs/:runId`.
- The page still satisfies the Flat Page Rule and Greyscale Test.

## Tests

Backend:

- `runs` route returns 400 for invalid ids/scope.
- `runs` route maps upstream 404 without leaking supervisor URL.
- Enrichment handles retry, check loops, scope-check, run-finalize, fanout, skipped, failed.
- Golden snapshot tests cover raw supervisor snapshots for active and completed graph.v2 runs.
- Golden snapshot tests assert semantic-node ids stay stable while execution-instance ids vary by iteration/attempt.
- Diff endpoint:
  - returns `not_git` outside git.
  - returns status and diff inside git.
  - classifies changed files well enough for code/test/docs/config summaries.
  - caps output.
  - uses fixed server-side paths only.
- Session stream proxy:
  - forwards SSE headers.
  - closes upstream on client disconnect.
  - forwards `Last-Event-ID`.

Frontend:

- `LaneCard` links to detail route while preserving external links.
- Detail page loading, error, partial, and empty graph states.
- Node selection toggles off when clicking selected node.
- Only one node is selected at a time.
- Left graph selects semantic nodes, not physical beads or execution instances.
- Previous loop iterations are represented as subtle stack/history cues, not selectable left-graph nodes.
- Diff colorization for added, removed, hunk, context, and file header lines.
- Session panel states for no selection, no session, completed coding-agent transcript, and active stream.
- Session panel shows iteration/attempt history for the selected semantic node and marks historical-only instances.
- Transcript rendering for request, assistant response, tool call, tool output, and final response blocks.

Visual:

- `npm --workspace frontend run typecheck`
- `npm --workspace backend run typecheck`
- `node scripts/snap.mjs runs --test`
- `node scripts/snap-run-detail.mjs --test`
- `node scripts/e2e-sample-formula-runs.mjs`, expected to pass only when the live sample city has todo and tic-tac-toe planning and implementation runs present.

## Risks

- Current dashboard summary lacks scope/store details, so first detail-route resolution may need to search run roots by id.
- The most likely source of implementation mess is confusing semantic nodes with execution instances. Keep that boundary explicit in shared types, selectors, tests, and component names.
- Exact formula construct type can be impossible to recover from compiled beads unless source/spec metadata is available.
- Gasworks and this dashboard could drift if enrichment logic is copied instead of shared upstream.
- Golden snapshot tests reduce drift but do not eliminate it; long term, presentation enrichment should move upstream or into a shared package.
- Large runs need graph simplification or virtualization.
- Git diffs can be large and potentially sensitive; keep them local, capped, and explicit. They are current working-tree evidence, not proof that a selected node made a change.
- Session streaming adds long-lived connections. It needs cleanup on tab switch, selection change, and route leave.
- Previous loop iterations can contain nodes that no longer exist in the latest visible graph. The right evidence panel must preserve that history without cluttering the left diagram.

## Grill-Me Questions

1. Should the dashboard own run presentation enrichment, or should Gas City own it?

Recommended answer: short term, dashboard owns a small TypeScript port aligned with Gasworks' contract. Medium term, move enrichment upstream or into a shared package so Gasworks and dashboard do not fork semantics.

2. Should `/runs/:runId` be enough, or should scope be part of the route?

Recommended answer: use `/runs/:runId` with optional `scope_kind` and `scope_ref` query params. It keeps the main URL readable and still disambiguates if duplicate run ids appear across stores.

3. Should active node selection happen automatically?

Answer: no. Start with no selected nodes unless `?node=` explicitly names a valid node. The user can click a node when they want session detail.

4. Should the Diff tab show all repo changes or only changes tied to the selected node?

Recommended answer: first version shows the current repo diff for the run execution folder. Node-scoped diffs need per-node baselines or commits, which are not available yet.

5. Should the Session tab stream by default when a selected node is active?

Answer: yes, but only while the Session tab is visible, only for the selected node/session, and only when that node belongs to the current/latest loop iteration. Previous loop iterations render static transcript history.

6. Should control nodes such as scope-check and run-finalize be full nodes?

Answer: no for v1. Render them as badges attached to their target/root, matching Gasworks. Add a detail/debug affordance later if the operator needs to inspect them directly.

7. Should no-git folders be treated as an error?

Recommended answer: no. Show a quiet skipped state. The user explicitly asked to skip if there is no git in the folder.

8. Should the diagram use a graph library?

Recommended answer: not in the first pass. Gasworks already has a layout engine, and this dashboard wants a narrow vertical graph. A simple deterministic layout is easier to control visually. Revisit React Flow only if pan/zoom/large-graph interaction becomes the bottleneck.

9. How should previous loop iterations appear?

Answer: show a subtle stack/history cue on the left graph, but only render/select the latest iteration's body nodes there. Use the Session panel's iteration tabs to navigate prior iterations for the selected logical node.

## Residual External Evidence Gap

The implementation is in place for the v1 dashboard-owned presentation adapter. The remaining gap is not local code structure; it is live fixture evidence from an actual supervisor run.

Runtime bead kinds already cover the first-pass graph.v2 constructs implemented here: normal work, retry, check loops, fanout, scope-check, run-finalize, skipped conditions, and completed/active/ready/failed states. The known uncertainty is source-construct fidelity for source-level forms that may be flattened after compile, especially `condition`, `expand`, `map`, and `compose.branch`.

Current live evidence:

- `formula-detail-demo-city` is the dashboard city currently exposed by `/api/config`.
- `/runs` shows the two planning runs that exist in the live supervisor feed:
  - `todo-p25w`, `Plan Todo App demo`, `rig:todo-app`
  - `ttt-uuum`, `Plan Tic Tac Toe demo`, `rig:tic-tac-toe-app`
- The supervisor-backed detail APIs for both planning runs now expose six visible nodes, eight execution instances, three visible edges, and status counts of three ready nodes and three blocked nodes. There are no active/streamable nodes because the ready work has not been claimed by a worker session.
- The two live sample planning run roots do not currently expose `gc.formula`; their root metadata has `gc.formula_contract`, `gc.kind`, `gc.root_store_ref`, `gc.run_target`, `gc.scope_kind`, and `gc.scope_ref`. The dashboard can use supervisor formula detail/preview ordering for runs that expose `gc.formula`, but these two live roots cannot be formula-ordered yet without upstream metadata.
- The ready planning work is present in the supervisor queue:
  - `todo-ytrc`, `Draft plan iteration 1`, routed to `todo-app/codex`
  - `ttt-bg5j`, `Inspect Tic Tac Toe App scaffold`, routed to `tic-tac-toe-app/codex`
- The current blocker is external to the dashboard code: the four sample Codex pool worker sessions (`todo-app/codex-1`, `todo-app/codex-2`, `tic-tac-toe-app/codex-1`, `tic-tac-toe-app/codex-2`) all stop at the Codex provider usage-limit message before claiming ready work. Rechecked on May 25, 2026 local time: `gc session peek fddc-kxn`, `fddc-2k8`, `fddc-gxp`, and `fddc-g3v` still show the same usage-limit stop, and no `docs/plan.md` or `docs/plan-review.md` files exist under either sample rig root. The plan files are therefore not produced and implementation formulas must not be launched yet.
- `node scripts/snap-run-detail.mjs --test` passes in light and dark themes, including scoped summary clickthrough, graph selection, active/historical session rendering, session stream proxying, and diff states.
- `node scripts/snap.mjs runs --test` passes against the live dashboard, with `/runs` showing the two planning runs and clean `/api/config`, `/api/snapshot`, and `/api/events/stream` calls.
- `npm run typecheck`, `npm run lint`, `npm --workspace backend test`, and `npm --workspace frontend test` pass.
- `node scripts/e2e-sample-formula-runs.mjs` verifies both planning runs through the real dashboard route and supervisor-backed detail/diff APIs. The harness waits for the `/runs` lane link to render before counting it, so it no longer races the snapshot fetch after the page heading appears.
- The same harness fails because the expected implementation runs are absent:
  - missing todo implementation run for `rig:todo-app`
  - missing tic-tac-toe implementation run for `rig:tic-tac-toe-app`
- This should remain a red live-evidence check until the sample city has implementation runs that can be validated without faking data or parsing formula files locally.

Next evidence step when the local supervisor workers can execute real graph.v2 runs:

- Let the two planning formulas complete via the routed pool workers.
- Verify `docs/plan.md` and `docs/plan-review.md` exist in both sample rig roots.
- Only then launch the implementation formulas with `gc sling <target> mol-demo-implementation-review --formula --scope-kind rig --scope-ref <rig>`.
- Re-run `node scripts/e2e-sample-formula-runs.mjs` and require all four planning/implementation runs to pass through summary click, detail rendering, node selection, diff, and session states.
- Capture one active graph.v2 formula run and one completed graph.v2 formula run from the supervisor run endpoint and add those snapshots beside the modeled graph.v2 fixtures.
- If a captured snapshot does not retain enough construct/order metadata, fetch the supervisor formula detail/preview response derived from Gas City's compiled `Recipe.Steps`; do not parse formula files in the dashboard.
