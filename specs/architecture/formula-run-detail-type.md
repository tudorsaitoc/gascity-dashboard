# Formula Run Detail Type Architecture

Status: product naming boundary documented, current implementation aligned
with dashboard run/formula-run vocabulary, and remaining data/API gaps called
out.

Primary implementation files:

- `shared/src/run-detail.ts`
- `backend/src/routes/runs.ts`
- `backend/src/runs/enrich.ts`
- `backend/src/runs/formula-run.ts`
- `backend/src/runs/execution-instances.ts`
- `backend/src/runs/display-state.ts`
- `frontend/src/hooks/useFormulaRunDetail.ts`
- `frontend/src/hooks/useRunDiff.ts`
- `frontend/src/hooks/runEventIdentity.ts`
- `frontend/src/routes/FormulaRunDetail.tsx`
- `frontend/src/components/run/*`

## Purpose

The Formula Run Detail type is the browser contract for one graph.v2 formula
execution over a concrete scope of work. Its job is to turn many
supervisor-facing pieces into one display-ready projection:

- the supervisor run snapshot
- runtime bead state
- formula detail/preview order
- dependency edges
- loop iterations and retry attempts
- hidden control beads rendered as badges
- session links and streamability
- execution folder identity
- aggregate progress counts

The frontend should not infer run semantics from raw beads, raw sessions,
raw dependency rows, or formula files. The backend owns that interpretation and
returns a single, browser-safe Formula Run Detail DTO.

The product vocabulary is:

- **Formula**: the definition of the work graph.
- **Run**: one execution of that formula over a specific set of work.
- **Formula Run**: the detail page/entity that combines both concepts.

The product does not have a user-facing "workflow" concept. When the word
`workflow` appears in current source or wire data, it must be either
authoritative Gas City supervisor vocabulary at the JSON/API edge, graph
metadata produced by Gas City, GitHub Actions directory naming, or archived
historical planning material. Dashboard-owned routes, DTOs, components, hooks,
tests, scripts, CSS classes, and fixtures use run/formula-run vocabulary.

## Naming Boundary

Dashboard-facing names:

- Browser routes are `/runs` and `/runs/:runId`.
- Backend dashboard routes are `/api/runs/:runId` and
  `/api/runs/:runId/diff`.
- UI page copy says **Formula Run**.
- Dashboard DTO identity is `runId`.
- There are no dashboard `/workflows` routes or legacy redirects.

Supervisor-facing names:

- The current Gas City supervisor OpenAPI route for the snapshot is
  `GET /v0/city/{cityName}/workflow/{workflow_id}`.
- The current supervisor response component is `WorkflowSnapshotResponse`.
- The current supervisor snapshot identity field is `workflow_id`.
- Current supervisor event payloads can identify a formula run with
  `workflow_id` and/or `gc.workflow_id`.
- Current graph-root bead rows may still carry `kind: "workflow"` and
  `gc.kind: "workflow"` because that is supervisor graph metadata, not
  product copy.

`GcClient` is the naming translation edge. It must call the supervisor's
`workflow/{workflow_id}` endpoint, validate `WorkflowSnapshotResponse`, and
normalize that payload to the dashboard-internal `GcRunSnapshot.run_id` shape
before any route, enrichment, or React code sees it. Likewise, event identity
collection must normalize `workflow_id`/`gc.workflow_id` into run identity.

`GcClient` is a thin policy facade over a **generated** supervisor SDK, not a
hand-written HTTP client. The supervisor client, endpoint SDK, and
request/response types are generated from
`backend/openapi/gc-supervisor.openapi.json` by `@hey-api/openapi-ts` (the same
generator the upstream `gc dashboard` uses). `GcClient` owns only what the
generator cannot: single-flight URL-keyed coalescing, topology-safe error
redaction, timeouts/output caps, the `workflow_id → run_id` vocabulary
normalization, and sane method names. Strict generated Zod response validation
is the target boundary, but remains gated on upstream OpenAPI accuracy; until
then, the legacy hand-Zod module is only a temporary dashboard DTO adapter over
generated hey-api response types. The migration and its phasing live in
`specs/plans/code-quality-remediation-plan.md` (WS-10).

## Design Goals

1. Keep formula-run semantics out of React.

   React renders nodes, edges, tabs, diffs, and transcripts from an explicit
   DTO shape. It should not know how to group retry attempts, collapse control
   beads, decide whether a pending node is ready or blocked, or resolve a
   physical bead into a semantic formula construct.

2. Use supervisor-owned data as the source of truth.

   The dashboard must not parse formula TOML files. Formula order and construct
   metadata come from the supervisor run snapshot and formula detail API.
   Runtime status comes from supervisor bead/session APIs.

3. Make missing and degraded data explicit.

   Required app-owned states use tagged shapes, not silent nulls or empty-list
   coercion. Examples include `RunFormula`, `RunExecutionPath`,
   `RunSnapshotSequence`, `RunSessionAttachment`,
   `RunIteration`, and `RunAttempt`.

4. Model semantic nodes separately from execution instances.

   A formula construct is a stable semantic node. Each concrete bead execution
   of that construct is an execution instance. Loop iterations and retry
   attempts should therefore add instances, not invent unrelated UI concepts.

5. Make the UI a pure projection.

   The left graph renders `RunDisplayNode[]` and `RunDisplayEdge[]`.
   The right evidence tabs render `RunDiffResponse` and the selected
   node's `RunExecutionInstance[]`. Header copy uses `FormulaRunProgress`.

6. Prefer whole-projection refresh over client-side event mutation.

   Supervisor event streams are used as invalidation signals. The backend
   rebuilds the aggregate from current supervisor state. The frontend should not
   patch graph state by interpreting raw streamed bead events.

## Public Wire Shape

`FormulaRunDetail` is the canonical frontend-facing type.

```ts
interface FormulaRunDetail {
  runId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: RunScopeKind;
  scopeRef: string;
  title: string;
  formula: RunFormula;
  formulaDetail: RunFormulaDetailState;
  executionPath: RunExecutionPath;
  snapshotVersion: number;
  snapshotEventSeq: RunSnapshotSequence;
  completeness: FormulaRunCompleteness;
  progress: FormulaRunProgress;
  nodes: RunDisplayNode[];
  edges: RunDisplayEdge[];
  lanes: RunDisplayLane[];
}
```

`FormulaRunCompleteness` is the explicit degraded-state contract:

```ts
type FormulaRunCompleteness =
  | { kind: "complete" }
  | { kind: "partial"; reasons: FormulaRunPartialReason[] };
```

Current partial reasons are supervisor snapshot incompleteness, failed runtime
bead refresh, failed session list load, and exact formula-detail lookup
failures:

- `formula_detail_missing_formula_metadata`
- `formula_detail_missing_run_target`
- `formula_detail_fetch_failed`

This is separate from `FormulaRunProgress.snapshotPartial`, which records only
the supervisor snapshot flag.

`RunFormula` answers the display-level question "do we know the formula
name?" `RunFormulaDetailState` answers the operational question "did the
dashboard fetch the compiled formula detail and, if not, why?"

```ts
type RunFormula =
  | { kind: "known"; name: string }
  | { kind: "unavailable"; reason: "missing_formula_metadata" };

type RunFormulaDetailState =
  | { kind: "available"; name: string; target: string }
  | { kind: "unavailable"; reason: "missing_formula_metadata" }
  | { kind: "unavailable"; reason: "missing_run_target"; name: string }
  | {
      kind: "unavailable";
      reason: "fetch_failed";
      name: string;
      target: string;
      failure:
        | "timeout"
        | "not_found"
        | "invalid_payload"
        | "empty_response"
        | "upstream_error";
    };
```

`RunDisplayNode` is the semantic construct rendered in the graph:

```ts
interface RunDisplayNode {
  id: string;
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: RunConstructKind;
  status: RunNodeStatus;
  currentBeadId: string;
  scope: RunNodeScope;
  visibleInGraph: boolean;
  historicalOnly: boolean;
  iterationSummary: RunIterationSummary;
  attemptSummary: RunAttemptSummary;
  visibleExecutionInstanceId: string;
  executionInstances: RunExecutionInstance[];
  controlBadges: RunControlBadge[];
}
```

`RunExecutionInstance` is the concrete runtime execution of a semantic
node:

```ts
interface RunExecutionInstance {
  id: string;
  semanticNodeId: string;
  beadId: string;
  iteration: RunIteration;
  attempt: RunAttempt;
  label: string;
  status: RunNodeStatus;
  session: RunSessionAttachment;
  currentIteration: boolean;
  historical: boolean;
}
```

This split is the load-bearing part of the design. The graph selects semantic
nodes; the session panel can then expose individual iterations/attempts for the
selected semantic node.

## Backend Projection

The backend's internal aggregate is `RunningFormulaRun` in
`backend/src/runs/formula-run.ts`. It is intentionally richer than the
wire type:

- raw supervisor snapshot
- root identity and scope
- deduped run beads
- semantic node groups
- physical-to-semantic bead id mapping
- control badges keyed by target node
- latest loop iteration by loop control
- session index and session link context
- display nodes, edges, lanes, and progress

The route sequence is:

1. `GET /api/runs/:runId` validates `runId`, `scope_kind`, and
   `scope_ref`.
2. The backend fetches the supervisor run snapshot.
3. For city-store runs, runtime bead reads overlay current status,
   assignee, cwd/session metadata, `session_id`/`session_name`,
   `gc.session_id`/`gc.session_name`, t3bridge `gc.sessionName`, and other
   presentation fields onto the embedded snapshot rows.
4. For rig-store runs, the embedded run snapshot is treated as
   authoritative because the supervisor does not expose rig-store per-bead
   reads through the city bead endpoint.
5. The backend fetches session summaries so node instances can resolve attached
   sessions to canonical session ids.
6. The backend fetches formula detail/preview when the root bead provides
   `gc.formula` or Gas City's `gc.formula_name` plus a target from
   `gc.run_target`, `gc.routed_to`, or the root assignee. This gives compiled
   formula order without local file parsing. The route also emits
   `formulaDetail` as a first-class tagged state so operators and tests can tell
   missing formula metadata, missing run target, timeout, not-found, invalid
   payload, and upstream-error cases apart without scraping global completeness
   copy.
7. `enrichFormulaRun()` validates graph.v2 identity and calls
   `buildRunningFormulaRun()`.
8. `buildRunningFormulaRun()` groups beads, orders groups, builds execution
   instances, builds edges, applies display status, builds lanes, calculates
   progress, and returns `RunningFormulaRun`.
9. `enrichFormulaRun()` emits the `FormulaRunDetail` DTO.

## Current Supervisor Data Sources

The dashboard can build the current detail view from existing supervisor data.
The important sources are:

- Run snapshot identity: the supervisor currently emits `workflow_id`,
  `root_bead_id`, `root_store_ref`, `resolved_root_store`, `scope_kind`,
  `scope_ref`, snapshot version/sequence, `partial`, beads, and deps.
  `GcClient` normalizes `workflow_id` to dashboard-internal `run_id`.
- Root bead metadata: `gc.formula_contract`, `gc.formula`/`gc.formula_name`,
  `gc.run_target`/`gc.routed_to`, `gc.cwd`/`gc.work_dir`,
  `gc.rig_root`, and optional `gc.workflow_id`/`gc.run_id`/
  `gc.root_bead_id` identity.
- Per-bead graph metadata: `gc.kind`, `gc.original_kind`,
  `gc.logical_bead_id`, `gc.step_id`, `gc.step_ref`, `gc.scope_ref`,
  `gc.control_for`, `gc.iteration`, `gc.attempt`, `gc.max_attempts`, and
  `gc.outcome`. Gas City's graph.v2 compiler, molecule instantiation, run
  snapshot API, event projection, and tests all use this metadata family; these
  fields are authoritative graph data, not dashboard guesses merely because they
  live in a metadata map.
- Runtime bead overlay metadata: unprefixed `session_id`/`session_name`,
  downstream/Gasworks `gc.session_id`/`gc.session_name`, and t3bridge
  `gc.sessionName`, plus cwd/rig-root metadata used for the execution path.
- Session summaries: current supervisor sessions resolve session ids, aliases,
  titles, templates, and runtime session names to canonical transcript links.
- Formula detail: compiled preview/order comes from the supervisor formula API
  once the root bead supplies the formula name and run target.
- City events: exact invalidation is available when an event carries canonical
  envelope identity (`workflow_id`, `run_id`, and/or `root_bead_id`) or bead
  metadata with `gc.workflow_id`, `gc.run_id`, and `gc.root_bead_id`. Events
  without identity remain broad invalidation signals until the supervisor
  guarantees canonical identity on every run-affecting event.

Gasworks uses the same metadata family for its run presentation graph:
logical identity comes from `gc.logical_bead_id`/`gc.step_ref`, scope and loop
state from `gc.scope_ref`/iteration metadata, and session links from
unprefixed or `gc.*` session metadata. Those are therefore implementation data
sources, not missing supervisor API surfaces.

The Gas City implementation adds two important boundary facts:

- Gas City's core supervisor always emits empty `logical_nodes`,
  `logical_edges`, and `scope_groups` arrays today. The Go type comments say
  populated presentation nodes are owned by a downstream run-presentation
  server. This makes Formula Run Detail a legitimate dashboard-owned view model,
  not a weaker duplicate of an existing supervisor projection.
- Gas City's feed projection can recover a formula name from the root bead's
  `ref` before falling back to `gc.formula_name`. The run snapshot bead row
  does not expose `ref`, so the dashboard can use `gc.formula`/`gc.formula_name`
  but still cannot recover formula detail when the only formula identity is root
  `ref`. The canonical frontend fixture intentionally captures this current GC
  producer gap: the root graph metadata has `gc.formula_contract` but no
  `gc.formula`/`gc.formula_name`, so formula detail is unavailable until GC
  persists formula identity on the run graph/root.

## Status Model

Node status is presentation status, not only raw bead status.

The pipeline is:

1. `presentationStatus(bead)` maps supervisor bead status into
   `RunNodeStatus`.
2. `buildRunDisplayNode()` aggregates all execution instances for one
   semantic node and chooses the visible instance.
3. Loop historical state marks older iterations as `historical` and prevents
   them from rendering as left-graph nodes.
4. Session streamability is true only when an instance is attached to a session,
   belongs to the current visible iteration, and has a running status.
5. `applyDisplayNodeStates()` upgrades current pending instances to `ready` or
   `blocked` based on inbound dependency edges.
6. `FormulaRunProgress` counts visible statuses and all-node statuses
   separately.

The UI should read `node.status` for per-node display and
`detail.progress.statusCounts` for aggregate display. It should not recompute
these values by walking raw instances.

## Loop And Retry Model

The graph is intentionally simple on the left:

- only current/latest graph nodes are selectable
- older loop iterations remain available as execution instances
- selected loop nodes expose iteration tabs in the session panel
- attempts within an iteration expose attempt choices when more than one exists

This means a loop produces a subtle stacked visual indication in the graph, but
history navigation happens on the right where transcripts live.

Deep links may still target a historical-only semantic node by `?node=...` so a
saved transcript URL can open directly to its evidence. That does not make the
node selectable on the left: `visibleInGraph === false` still prevents graph
rendering, and normal click selection remains limited to current/latest graph
nodes.

## UI Consumption

The run detail page loads **two independent resources**, each its own hook:

- `useFormulaRunDetail()` → `api.formulaRun(runId, scope)` — the run projection.
- `useRunDiff()` → `api.runDiff(runId, scope)` — the execution-folder diff.

They are separate because the diff is independently refreshable and
independently failable (it has its own `not_git`/`path_unknown`/`error`
states). The page composes both. A diff fetch failure must surface as the diff
resource's own `failed` state — never as a fabricated `RunDiffResponse` and
never by collapsing the detail resource. (Earlier revisions of this spec
described a single `useFormulaRunDetail()` returning a `{detail, diff}` pair;
that is superseded by the two-resource model — see
`specs/plans/code-quality-remediation-plan.md` WS-12.)

`RunDiffResponse` is one renderable unified patch plus comparison metadata:
upstream merge-base when a tracked upstream exists, HEAD fallback when no
upstream can be proven, and unavailable states for unknown paths/non-git/error
cases. The patch includes committed-ahead tracked changes, staged/unstaged
tracked changes, and capped synthesized patches for untracked files such as
generated plans. It deliberately hides Gas City control-plane paths
`.beads/**` and `.gc/**` from status, changed-file metadata, and patch hunks.
It still respects git's ignore rules for all other untracked files, and it
does not special-case `.runtime/**`; the current `.runtime/session_id` file is
a Gas City runtime-hook bug to fix upstream, not dashboard evidence to silently
mask.

The canonical route component should be `FormulaRunDetailPage`. The current
implementation name is `FormulaRunDetailPage` and renders:

- header title and status synopsis from `detail.title` and `detail.progress`
- metadata from `detail.formula`, `detail.rootBeadId`, `detail.scopeKind`,
  `detail.scopeRef`, and `detail.resolvedRootStore`
- partial warning from `detail.completeness`
- left graph from `detail.nodes` and `detail.edges`
- right tabs from `diff` and `selectedNode`
- diff UI as a GitHub-style per-file patch view with a changed-file count, not
  a separate file-status summary list above the hunks

Each resource hook exposes its own tagged load state: idle, loading, ready, or
failed, with a ready state carrying a non-null value and background refresh
state tagged separately so a stale visible value can report refresh failures
without collapsing into a nullable pair. Because detail and diff are separate
resources, a failed diff leaves a ready detail visible and vice versa.

`useRunNodeSelection()` owns the zero-or-one selected semantic node. A
click selects a node; clicking the selected node clears selection. The selected
node is looked up from the latest `detail.nodes`.

Evidence-tab selection (`Diff` vs `Session`) is **explicit user state**. It
responds only to user clicks and route initialization; selecting a graph node
does not change the active tab. This follows from the diff being run-level
evidence (see Invariants): node selection only changes the Session panel's
content, so the tab must not be derived from node selection. (Earlier revisions
auto-switched to `Session` on node selection; that is superseded — see
`specs/plans/code-quality-remediation-plan.md` WS-12.)

`RunNodeSessionPanel` reads the selected node's
`executionInstances`. It groups attached sessions by iteration and attempt,
chooses a streamable instance when available, and delegates transcript loading
to `useSessionStream()`.

## Notification And Refresh Model

There are two independent stream paths today:

1. City event stream: `/api/events/stream`

   `useGcEventRefresh()` parses supervisor event envelopes, matches event type
   prefixes, coalesces bursts, and calls a refresh callback. This is used on the
   Runs list to refresh the snapshot when `bead.*` events arrive.

   This stream is an invalidation channel. It does not carry a
   Formula Run Detail patch, and React should not mutate a detail graph from
   raw event payloads.

2. Session stream: `/api/sessions/:id/stream`

   `useSessionStream()` first loads a transcript snapshot, then appends streamed
   turns or replaces the snapshot when the stream sends a full transcript. This
   updates the selected-node transcript panel only.

Current implementation note: the Runs list subscribes to `bead.*` city
events, and the Formula Run Detail page subscribes to both `bead.*` and
`session.*` city events. The detail page filters matching events to the current
run when the event envelope carries canonical identity (`workflow_id`,
`run_id`, `root_bead_id`) or when nested run/bead/root payload metadata carries
`gc.workflow_id`, `gc.run_id`, or `gc.root_bead_id`; otherwise it falls back to
broad invalidation and refetches the whole backend-owned projection. Active
selected sessions also open their own transcript stream; that stream updates
only the transcript panel, not the graph projection.

Visible refresh hooks have distinct responsibilities:

- `useVisibleInterval()` is only for synchronous local ticks such as clocks.
- `useVisibleRefresh()` is for non-abortable async refresh callbacks that own
  their own state elsewhere; it is interval-driven and intentionally does not
  run an initial tick.
- `useAbortableVisibleRefresh()` is for refreshes that own render state and
  need cancellation.

## Current Implementation Against The Ideal

This list reflects the implementation after the WS-10 G-1b transport cutover.
The old `openapi-fetch` client, old generated `openapi-typescript` artifacts,
custom schema-map extractor, and AJV component overlay have been deleted.
Strict generated Zod response validation remains a G-3 target after upstream
OpenAPI accuracy fixes; the remaining hand-Zod module is a temporary dashboard
DTO adapter over generated hey-api response types.

Implemented:

- graph.v2-only validation before enrichment
- dedicated backend aggregate, `RunningFormulaRun`
- browser-owned DTO shape, exported as `FormulaRunDetail`
- dashboard `/runs` and `/api/runs` routes with no `/workflows` redirects
- supervisor-edge normalization from
  `GET /v0/city/{cityName}/workflow/{workflow_id}` and
  `WorkflowSnapshotResponse.workflow_id` into dashboard run identity
- semantic node grouping over physical beads
- control badges for hidden run controls
- formula-detail order from the supervisor, with snapshot order fallback
- execution instances for loop iterations and retry attempts
- current/latest loop node visibility on the left
- historical instances available in the session panel
- status presentation for pending, ready, running, done, failed, blocked, and
  skipped
- progress counts in `FormulaRunProgress`
- session link resolution from unprefixed and `gc.*` bead metadata plus current
  session summaries
- streamable session marking for current running instances
- city-event invalidation on the detail page for `bead.*` and `session.*`
  changes, filtered by run/root identity when event metadata provides it,
  using whole-projection refresh rather than client-side mutation
- local-change patch from the execution folder, including committed-ahead,
  staged, unstaged, and untracked files when git can expose them
- local-change filtering that always excludes `.beads/**` and `.gc/**` while
  leaving other non-ignored untracked files visible
- explicit run completeness with partial reasons instead of a generic
  `partial` boolean
- tagged run-detail load state in React, with non-null ready detail and
  diff values
- route validation for run id and scope query pairs
- deterministic browser harness for the detail route
- generated hey-api endpoint SDK, request path/query handling, and response
  types for supervisor calls
- temporary hand-Zod dashboard DTO adapter for supervisor payloads that feed
  run detail projection: session lists, run snapshots, formula details,
  transcripts, and health
- temporary hand-Zod dashboard DTO adapter for bead, bead-list, mail-list, and
  event-list payloads, including currently-observed degraded supervisor shapes
  that strict generated validation cannot accept until the upstream OpenAPI is
  fixed
- centralized client-error reporting for run detail load failures, diff
  failures, malformed city event payloads, and malformed selected-session
  stream events
- tests asserting that current running execution instances either have an
  attached streamable session or expose `session_unresolved`
- visible dependency edge identities in the detail graph header
- lane labels rendered without reordering the supervisor/formula node order
- session-panel iteration and attempt controls over all execution instances,
  including current instances with unresolved or not-yet-started sessions
- selected execution instance and bead identity exposed in the session panel
- active retry-attempt state exposed on graph nodes when the backend marks an
  attempt running
- diff rendering through `react-diff-view` rather than a hand-rolled hunk
  renderer

## Current Implementation Gap Analysis

`frontend/src/test/fixtures/formula-run-detail.json` is the richest current
browser fixture for this route. It models a real formula run detail with seven
semantic nodes, four dependency edges, one lane, four transcript snapshots, one
active session stream, hidden control badges, historical-only evidence,
retry/loop instances, no-graph and degraded diff variants in the harness, and
both attached and unresolved session states.

Aligned with this spec:

- Browser navigation and dashboard API routes now use `/runs` and `/api/runs`.
- The backend GC client calls the supervisor's authoritative
  `/workflow/{workflow_id}` endpoint and normalizes `workflow_id` to internal
  `run_id`.
- Event identity matching accepts supervisor `workflow_id` and
  `gc.workflow_id` as run identity.
- Header and metadata consume the fixture's title, formula state, root bead,
  scope, resolved store, snapshot version/sequence, completeness, and progress
  counts.
- The graph consumes visible nodes, construct kinds, statuses, bounded attempt
  badges, stacked iteration summaries, hidden-control badges, and
  `visibleInGraph`/`historicalOnly`.
- Dependency edge identities and lane labels render while preserving the
  backend-provided node order.
- The evidence panel consumes local-change patch states, transcript snapshots,
  active stream turns, historical iteration transcripts, failed retry transcript
  links, unresolved-session empty states, and not-started empty states.
- Selected execution-instance and bead identity are visible so operators can
  correlate UI evidence back to supervisor/runtime records.
- Diff rendering uses `react-diff-view`, while backend diff generation reports
  committed-ahead, staged, unstaged, and untracked local changes from the
  execution folder. The diff contract hides `.beads/**` and `.gc/**` as
  GC/control-plane state, keeps non-ignored untracked files visible, and leaves
  `.runtime/**` visible until the upstream GC `.runtime` writer bug is fixed.

Remaining implementation gaps against the updated spec:

1. **Formula identity is still missing for the fixture/live demo run.**

   The fixture intentionally captures the current GC producer gap: the root
   graph bead has `gc.formula_contract=graph.v2` but lacks
   `gc.formula`/`gc.formula_name`. Gas City can recover a formula name from the
   root bead `ref` in other feed projections, but `WorkflowSnapshotResponse`
   bead rows do not expose `ref`. The dashboard therefore cannot
   authoritatively fetch formula detail for that run until GC emits formula
   identity, exposes root `ref`, or puts an equivalent typed formula field on
   the snapshot.

2. **Graph presentation ownership is still local.**

   The dashboard derives semantic nodes, hidden-control badges, loop/retry
   grouping, historical visibility, and display statuses from authoritative
   graph.v2 metadata. That metadata is real GC data, not a weak fallback, but
   the projection code itself is still dashboard-owned TypeScript. The cleaner
   target is a Gas City/shared presentation package or populated
   `logical_nodes`, `logical_edges`, and `scope_groups`.

3. **Rig-store runtime freshness is snapshot-bound.**

   City-store runs can refresh each bead through `/bead/{id}`. Rig-store runs
   cannot, because the supervisor does not expose scoped rig-store bead reads
   through the city bead endpoint. For rig-store runs the embedded snapshot is
   authoritative for the detail request, but freshness depends on the snapshot
   being current.

4. **Session resolution still has an ambiguity path.**

   When beads carry `session_id`/`session_name`, `gc.session_id`/
   `gc.session_name`, or t3bridge `gc.sessionName`, the dashboard can resolve
   sessions robustly. When those fields are absent, it still falls back to
   assignee/name matching against session summaries and may surface
   `session_unresolved`.

5. **Event refresh still broad-invalidates identity-less events.**

   Events with `workflow_id`, `run_id`, `root_bead_id`, or corresponding
   metadata are filtered to the current detail. Events without identity remain
   broad invalidation signals. This is deliberate, but it is still a gap from
   the ideal event contract where every run-affecting event carries canonical
   run/root identity.

6. **OpenAPI drift is reduced, not eliminated.**

   The generated supervisor client has been refreshed to the current
   `WorkflowSnapshotResponse` schema, and payloads are runtime-validated. The
   dashboard still carries an explicit generated-schema overlay for observed
   nullable `Bead.priority` drift until upstream OpenAPI marks that field
   nullable.

7. **Diff is dashboard-local evidence, not supervisor run state.**

   The diff view is now an OSS-backed rendering of local git state. It is
   intentionally outside the GC supervisor API. It can be unavailable when the
   execution path is unknown or not a git work tree, and large generated
   untracked patches can be capped/truncated by the backend. The dashboard
   applies only two hard visibility exclusions: `.beads/**` and `.gc/**`.
   Everything else follows git visibility, including non-ignored untracked
   files.

## Gas City And Shared Change Tracker

These are the changes outside this repository that would move the architecture
from dashboard-owned projection to an even cleaner target boundary:

1. **Canonical graph.v2 presentation package.** Gas City or a shared package
   should own semantic node ids, construct kinds, external display names,
   hidden-control collapsing, control badge targeting, loop/retry grouping,
   visible graph nodes, logical edges, scope groups, and compiled display order.
   The dashboard should consume that shape instead of deriving it from bead
   metadata in TypeScript.
2. **Formula identity in supervisor snapshots.** Gas City already knows the root
   bead `ref` and uses it as the first-choice formula name in feed projections,
   but `WorkflowBeadResponse` does not expose `ref`. Expose root `ref`, a typed
   `formula_name`, or equivalent on `WorkflowSnapshotResponse` so dashboard
   formula-detail lookup does not depend on optional metadata.
3. **Scoped runtime bead reads or fresh scoped snapshots.** The supervisor
   should expose rig-store bead reads or guarantee that scoped run
   snapshots include current runtime status for non-city stores.
4. **OpenAPI schema alignment.** The supervisor OpenAPI schema should match
   observed payloads, especially nullable `Bead.priority`, so dashboard schema
   overlays can be removed.
5. **Optional canonical execution-instance fields.** Existing metadata is
   sufficient for the current detail page, but a canonical upstream/shared
   presentation shape could expose execution instance ids, semantic node ids,
   loop iteration, retry attempt, current/historical flags, and attached
   session identity directly so the dashboard no longer derives them.

Items that are not current supervisor API gaps after validating the Gas City and
Gasworks implementations:

- Run/root identity for projection invalidation is available from
  top-level supervisor data or bead metadata `gc.workflow_id`/`gc.run_id`/
  `gc.root_bead_id`;
  events without identity still fall back to broad refresh.
- Session identity is usable through `session_id`/`session_name`, current
  session summaries, and t3bridge `gc.sessionName`; the dashboard also accepts
  downstream/Gasworks `gc.session_id`/`gc.session_name`.
- Formula detail target selection can use root-bead `gc.run_target`,
  `gc.routed_to`, or assignee; no local formula-file parsing is required. The
  remaining formula gap is identity exposure when only root `ref` knows the
  formula name.
- Logical grouping, loop scope, retry attempts, and hidden-control targeting
  have usable metadata sources: `gc.logical_bead_id`, `gc.step_ref`,
  `gc.scope_ref`, `gc.control_for`, `gc.iteration`, `gc.attempt`, and
  `gc.max_attempts`.

Intentionally outside the current dashboard-owned implementation target:

- Incremental event application to the run projection. This is intentionally
  not a goal until the backend can own the event reducer.
- Durable analytics or metrics beyond the existing centralized client-error
  log.

## Ideal Target State

The ideal design keeps the same public concept but moves more ownership to
stable backend boundaries:

1. Supervisor client generation owns endpoint paths, params, and response
   shapes. The client, types, and runtime validators are generated from the
   committed OpenAPI by `@hey-api/openapi-ts` (plugins `client-fetch`,
   `typescript`, `sdk`, plus the `zod` plugin); `GcClient` is a thin facade for
   dashboard-only policy (coalescing, redaction, timeouts, `workflow_id → run_id`).
2. Runtime deserialization at `GcClient` rejects malformed supervisor payloads
   before run projection sees them, via the generated Zod response validators
   wired into the SDK (`validator: { response: 'zod' }`) — not hand-written
   decoders. Schema-accuracy gaps (e.g. nullable `Bead.priority`, legacy bead
   fields, phantom event keys) are fixed **upstream in the Gas City OpenAPI
   source** so generation stays faithful, rather than papered over with a
   dashboard-side validation overlay.
3. Gas City or a shared presentation package owns graph.v2 display semantics:
   semantic nodes, logical edges, scope groups, display graph, loop/retry
   collapsing, and session-link hints.
4. The dashboard backend maps that canonical presentation data into
   `RunningFormulaRun`, adds dashboard-local evidence such as git diff and
   transcript streamability, then emits Formula Run Detail.
5. The detail page subscribes to city events only as refresh invalidation,
   filters by canonical run/root event identity when present, coalesces
   refreshes, and always re-renders from a newly fetched Formula Run Detail.
6. Session transcript streaming remains separate from graph projection refresh,
   but selected-node session availability is refreshed by the detail projection
   when bead/session events arrive.

## Invariants

- Formula Run Detail is dashboard-owned. Do not expose raw supervisor run
  snapshots directly to React for run detail rendering.
- `RunningFormulaRun` is the single backend aggregation point for run-detail
  state.
- `RunDisplayNode.id` is the semantic node id used by selection and graph
  rendering.
- `RunDisplayNode.executionInstances` are the only place loop iterations
  and retry attempts should be exposed to the UI.
- `visibleInGraph === false` means a node can exist for transcript/history
  purposes but should not render in the left graph.
- A streamable session must be attached, running, and current, not historical.
- `FormulaRunDetail.completeness.kind === "partial"` means the view is
  degraded and should say why.
- Diff state is evidence for the execution folder, not part of formula graph
  state.
- Diff state hides `.beads/**` and `.gc/**` control-plane files even when git
  reports them as changed; other visibility comes from git status plus
  `.gitignore`.
- City SSE events invalidate cached views; they do not directly mutate
  Formula Run Detail in the browser.
- Run detail and run diff are independent browser resources. A failed diff fetch
  surfaces as the diff resource's own `failed` state; it must never fabricate a
  `RunDiffResponse` nor null out the detail resource.
- Evidence-tab selection is explicit user state. It is driven only by user
  clicks and route initialization, never derived from node selection.
- The supervisor client, types, and runtime response validators are generated
  from the committed OpenAPI by `@hey-api/openapi-ts`. `GcClient` is a thin
  policy facade; it does not hand-roll HTTP, response decoding, or per-endpoint
  schemas. Supervisor schema-accuracy fixes belong upstream in the Gas City
  OpenAPI source, not in a dashboard-side validation overlay.

## Architectural Risks

1. Presentation drift from Gasworks and Gas City.

   The local TypeScript projection is useful, but it is not the best permanent
   owner for graph.v2 semantics. Real formula examples and captured supervisor
   fixtures need to keep this honest until a canonical presentation layer is
   available.

2. Event freshness on the detail page.

   The detail page now refetches the whole projection when relevant city events
   arrive. This avoids stale graph status without inventing a browser-side
   reducer, but it still depends on the backend projection route being fast
   enough and on SSE delivery staying connected.

3. Session-link ambiguity.

   When beads do not carry stable session metadata, the dashboard falls back to
   assignee/name matching. That is inherently weaker than a supervisor-owned
   session id attached to each execution instance.

4. Rig-store freshness.

   Rig-store run details cannot currently refresh each bead independently
   through the city bead endpoint. The embedded run snapshot needs to be
   fresh enough or the supervisor needs an API for scoped runtime bead reads.

5. Supervisor schema drift and the cross-repo accuracy dependency.

   The target boundary generates the supervisor client, types, and Zod response
   validators from the committed OpenAPI (`@hey-api/openapi-ts`). The dominant
   risk is schema *accuracy*: where the OpenAPI is stricter than observed
   supervisor output (nullable `Bead.priority`, legacy bead fields, phantom
   event keys, `description`-required formula detail), generated strict
   validation would reject valid degraded payloads — the same gaps that forced
   the temporary hand-Zod DTO adapter to stay lenient in ~15 places.

   The fix lives **upstream in the Gas City OpenAPI source**, which this repo
   re-pulls via `npm run openapi:gc-supervisor:update`. That makes strict
   runtime validation a cross-repo dependency: the migration (see
   `specs/plans/code-quality-remediation-plan.md` WS-10) ships generation with
   lenient/`passthrough` validation first, lands the upstream accuracy fixes,
   then flips on strict response validation. Until the upstream spec is
   accurate, validation stays lenient rather than reintroducing a dashboard-side
   overlay.

6. Formula detail diagnostics live at the dashboard boundary.

   `RunFormulaDetailState` is a view-model state. It redacts supervisor
   topology while still distinguishing target/configuration failures from
   upstream/API failures. If Gas City later exposes a canonical formula-detail
   status in the run snapshot, the dashboard should consume that instead
   of deriving lookup state from route calls.

7. Legacy run route tests.

   New run-detail route coverage belongs in focused route test files. The
   historical `backend/test/runs.test.ts` file should remain a thin smoke
   suite and not regain formula lookup, diff, session stream, or runtime-refresh
   detail cases.

## Future Implementation Moves

1. Capture real graph.v2 supervisor snapshots for completed, running, blocked,
   retried, and looped runs; use them as backend enrichment fixtures.
2. Replace local graph.v2 presentation derivation with the canonical Gas City or
   shared package once available.
3. Remove the generated-schema `Bead.priority` nullable overlay once the
   upstream supervisor OpenAPI schema matches the observed wire shape.
4. Remove broad run-detail invalidation for identity-less city events once
   the supervisor guarantees canonical run/root identity on all
   run-affecting events.
