# Workflow Run Detail Type Architecture

Status: current implementation documented, with target-state gaps called out.

Primary files:

- `shared/src/workflow-detail.ts`
- `backend/src/routes/workflows.ts`
- `backend/src/workflows/enrich.ts`
- `backend/src/workflows/formula-run.ts`
- `backend/src/workflows/execution-instances.ts`
- `backend/src/workflows/display-state.ts`
- `frontend/src/hooks/useWorkflowRunDetail.ts`
- `frontend/src/routes/WorkflowRunDetail.tsx`
- `frontend/src/components/workflow/*`

## Purpose

The workflow run detail type is the browser contract for one graph.v2 formula
run. Its job is to turn many supervisor-facing pieces into one display-ready
projection:

- the supervisor workflow snapshot
- runtime bead state
- formula detail/preview order
- dependency edges
- loop iterations and retry attempts
- hidden control beads rendered as badges
- session links and streamability
- execution folder identity
- aggregate progress counts

The frontend should not infer workflow semantics from raw beads, raw sessions,
raw dependency rows, or formula files. The backend owns that interpretation and
returns a single, browser-safe `WorkflowRunDetail`.

## Design Goals

1. Keep formula-run semantics out of React.

   React renders nodes, edges, tabs, diffs, and transcripts from an explicit
   wire shape. It should not know how to group retry attempts, collapse control
   beads, decide whether a pending node is ready or blocked, or resolve a
   physical bead into a semantic formula construct.

2. Use supervisor-owned data as the source of truth.

   The dashboard must not parse formula TOML files. Formula order and construct
   metadata come from the supervisor workflow snapshot and formula detail API.
   Runtime status comes from supervisor bead/session APIs.

3. Make missing and degraded data explicit.

   Required app-owned states use tagged shapes, not silent nulls or empty-list
   coercion. Examples include `WorkflowFormula`, `WorkflowExecutionPath`,
   `WorkflowSnapshotSequence`, `WorkflowSessionAttachment`,
   `WorkflowIteration`, and `WorkflowAttempt`.

4. Model semantic nodes separately from execution instances.

   A formula construct is a stable semantic node. Each concrete bead execution
   of that construct is an execution instance. Loop iterations and retry
   attempts should therefore add instances, not invent unrelated UI concepts.

5. Make the UI a pure projection.

   The left graph renders `WorkflowDisplayNode[]` and `WorkflowDisplayEdge[]`.
   The right evidence tabs render `WorkflowDiffResponse` and the selected
   node's `WorkflowExecutionInstance[]`. Header copy uses `WorkflowRunProgress`.

6. Prefer whole-projection refresh over client-side event mutation.

   Supervisor event streams are used as invalidation signals. The backend
   rebuilds the aggregate from current supervisor state. The frontend should not
   patch graph state by interpreting raw streamed bead events.

## Public Wire Shape

`WorkflowRunDetail` is the frontend-facing type:

```ts
interface WorkflowRunDetail {
  workflowId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: WorkflowScopeKind;
  scopeRef: string;
  title: string;
  formula: WorkflowFormula;
  executionPath: WorkflowExecutionPath;
  snapshotVersion: number;
  snapshotEventSeq: WorkflowSnapshotSequence;
  partial: boolean;
  progress: WorkflowRunProgress;
  nodes: WorkflowDisplayNode[];
  edges: WorkflowDisplayEdge[];
  lanes: WorkflowDisplayLane[];
}
```

`WorkflowDisplayNode` is the semantic construct rendered in the graph:

```ts
interface WorkflowDisplayNode {
  id: string;
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: WorkflowConstructKind;
  status: WorkflowNodeStatus;
  currentBeadId: string;
  scope: WorkflowNodeScope;
  visibleInGraph: boolean;
  historicalOnly: boolean;
  iterationSummary: WorkflowIterationSummary;
  attemptSummary: WorkflowAttemptSummary;
  visibleExecutionInstanceId: string;
  executionInstances: WorkflowExecutionInstance[];
  controlBadges: WorkflowControlBadge[];
}
```

`WorkflowExecutionInstance` is the concrete runtime execution of a semantic
node:

```ts
interface WorkflowExecutionInstance {
  id: string;
  semanticNodeId: string;
  beadId: string;
  iteration: WorkflowIteration;
  attempt: WorkflowAttempt;
  label: string;
  status: WorkflowNodeStatus;
  session: WorkflowSessionAttachment;
  currentIteration: boolean;
  historical: boolean;
}
```

This split is the load-bearing part of the design. The graph selects semantic
nodes; the session panel can then expose individual iterations/attempts for the
selected semantic node.

## Backend Projection

The backend's internal aggregate is `RunningFormulaRun` in
`backend/src/workflows/formula-run.ts`. It is intentionally richer than the
wire type:

- raw supervisor snapshot
- root identity and scope
- deduped workflow beads
- semantic node groups
- physical-to-semantic bead id mapping
- control badges keyed by target node
- latest loop iteration by loop control
- session index and session link context
- display nodes, edges, lanes, and progress

The route sequence is:

1. `GET /api/workflows/:workflowId` validates `workflowId`, `scope_kind`, and
   `scope_ref`.
2. The backend fetches the supervisor workflow snapshot.
3. For city-store workflows, runtime bead reads overlay current status,
   assignee, cwd/session metadata, and other presentation fields onto the
   embedded snapshot rows.
4. For rig-store workflows, the embedded workflow snapshot is treated as
   authoritative because the supervisor does not expose rig-store per-bead
   reads through the city bead endpoint.
5. The backend fetches session summaries so node instances can resolve attached
   sessions to canonical session ids.
6. The backend fetches formula detail/preview when the root bead provides
   enough metadata. This gives compiled formula order without local file
   parsing.
7. `enrichWorkflowRun()` validates graph.v2 identity and calls
   `buildRunningFormulaRun()`.
8. `buildRunningFormulaRun()` groups beads, orders groups, builds execution
   instances, builds edges, applies display status, builds lanes, calculates
   progress, and returns `RunningFormulaRun`.
9. `enrichWorkflowRun()` emits `WorkflowRunDetail`.

## Status Model

Node status is presentation status, not only raw bead status.

The pipeline is:

1. `presentationStatus(bead)` maps supervisor bead status into
   `WorkflowNodeStatus`.
2. `buildWorkflowDisplayNode()` aggregates all execution instances for one
   semantic node and chooses the visible instance.
3. Loop historical state marks older iterations as `historical` and prevents
   them from rendering as left-graph nodes.
4. Session streamability is true only when an instance is attached to a session,
   belongs to the current visible iteration, and has a running status.
5. `applyDisplayNodeStates()` upgrades current pending instances to `ready` or
   `blocked` based on inbound dependency edges.
6. `WorkflowRunProgress` counts visible statuses and all-node statuses
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

## UI Consumption

`useWorkflowRunDetail()` loads:

- `api.workflowRun(workflowId, scope)`
- `api.workflowDiff(workflowId, scope)`

`WorkflowRunDetailPage` then renders:

- header title and status synopsis from `detail.title` and `detail.progress`
- metadata from `detail.formula`, `detail.rootBeadId`, `detail.scopeKind`,
  `detail.scopeRef`, and `detail.resolvedRootStore`
- partial warning from `detail.partial`
- left graph from `detail.nodes` and `detail.edges`
- right tabs from `diff` and `selectedNode`

`useWorkflowNodeSelection()` owns the zero-or-one selected semantic node. A
click selects a node; clicking the selected node clears selection. The selected
node is looked up from the latest `detail.nodes`.

`WorkflowNodeSessionPanel` reads the selected node's
`executionInstances`. It groups attached sessions by iteration and attempt,
chooses a streamable instance when available, and delegates transcript loading
to `useSessionStream()`.

## Notification And Refresh Model

There are two independent stream paths today:

1. City event stream: `/api/events/stream`

   `useGcEventRefresh()` parses supervisor event envelopes, matches event type
   prefixes, coalesces bursts, and calls a refresh callback. This is used on the
   Workflows list to refresh the snapshot when `bead.*` events arrive.

   This stream is an invalidation channel. It does not carry a
   `WorkflowRunDetail` patch, and React should not mutate a detail graph from
   raw event payloads.

2. Session stream: `/api/sessions/:id/stream`

   `useSessionStream()` first loads a transcript snapshot, then appends streamed
   turns or replaces the snapshot when the stream sends a full transcript. This
   updates the selected-node transcript panel only.

Current implementation note: the Workflows list subscribes to the city event
stream. The Workflow Run Detail page currently relies on initial load and
manual refresh for the graph/detail projection, while active selected sessions
can stream transcript content. The ideal architecture is for the detail page to
also subscribe to relevant `bead.*` and `session.*` events, treat them as
invalidation signals, and refetch the whole `WorkflowRunDetail` projection
through the same backend route.

## Current Implementation Against The Ideal

Implemented:

- graph.v2-only validation before enrichment
- dedicated backend aggregate, `RunningFormulaRun`
- browser-owned wire shape, `WorkflowRunDetail`
- semantic node grouping over physical beads
- control badges for hidden workflow controls
- formula-detail order from the supervisor, with snapshot order fallback
- execution instances for loop iterations and retry attempts
- current/latest loop node visibility on the left
- historical instances available in the session panel
- status presentation for pending, ready, running, done, failed, blocked, and
  skipped
- progress counts in `WorkflowRunProgress`
- session link resolution from bead metadata and current session summaries
- streamable session marking for current running instances
- current working-tree diff from the execution folder
- route validation for workflow id and scope query pairs
- deterministic browser harness for the detail route

Partially implemented:

- Whole-projection refresh exists, but the detail page does not yet wire global
  city events to automatic detail refresh.
- Formula detail/preview improves ordering, but the dashboard still carries a
  local TypeScript approximation of workflow presentation semantics that should
  eventually be owned by Gas City or shared with Gasworks.
- Runtime bead overlay is complete for city-store workflows, but rig-store
  workflows depend on the embedded snapshot because the current supervisor API
  lacks rig-store per-bead reads.
- Session resolution uses current session summaries plus bead metadata. It can
  still fail when supervisor metadata does not expose a stable session id/name.

Not implemented:

- Generated supervisor client from OpenAPI for these workflow endpoints.
- Runtime validation generated from the OpenAPI schema. Current validation is
  handwritten at the supervisor boundary.
- Incremental event application to the run projection. This is intentionally
  not a goal until the backend can own the event reducer.
- Persistent frontend telemetry for failed detail refreshes or malformed stream
  events.

## Ideal Target State

The ideal design keeps the same public concept but moves more ownership to
stable backend boundaries:

1. Supervisor client generation owns endpoint paths, params, and response
   shapes.
2. Runtime deserialization at `GcClient` rejects malformed supervisor payloads
   before workflow projection sees them.
3. Gas City or a shared presentation package owns graph.v2 display semantics:
   semantic nodes, logical edges, scope groups, display graph, loop/retry
   collapsing, and session-link hints.
4. The dashboard backend maps that canonical presentation data into
   `RunningFormulaRun`, adds dashboard-local evidence such as git diff and
   transcript streamability, then emits `WorkflowRunDetail`.
5. The detail page subscribes to city events only as refresh invalidation,
   coalesces refreshes, and always re-renders from a newly fetched
   `WorkflowRunDetail`.
6. Session transcript streaming remains separate from graph projection refresh,
   but selected-node session availability is refreshed by the detail projection
   when bead/session events arrive.

## Invariants

- `WorkflowRunDetail` is dashboard-owned. Do not expose raw supervisor workflow
  snapshots directly to React for run detail rendering.
- `RunningFormulaRun` is the single backend aggregation point for run-detail
  state.
- `WorkflowDisplayNode.id` is the semantic node id used by selection and graph
  rendering.
- `WorkflowDisplayNode.executionInstances` are the only place loop iterations
  and retry attempts should be exposed to the UI.
- `visibleInGraph === false` means a node can exist for transcript/history
  purposes but should not render in the left graph.
- A streamable session must be attached, running, and current, not historical.
- `partial === true` means the view is degraded and should say so.
- Diff state is evidence for the execution folder, not part of formula graph
  state.
- City SSE events invalidate cached views; they do not directly mutate
  `WorkflowRunDetail` in the browser.

## Architectural Risks

1. Presentation drift from Gasworks and Gas City.

   The local TypeScript projection is useful, but it is not the best permanent
   owner for graph.v2 semantics. Real formula examples and captured supervisor
   fixtures need to keep this honest until a canonical presentation layer is
   available.

2. Event freshness on the detail page.

   The current detail page can show live transcript text for a selected running
   session, but graph status itself does not auto-refresh from city events yet.
   That can make a running formula detail page appear stale unless the operator
   refreshes.

3. Session-link ambiguity.

   When beads do not carry stable session metadata, the dashboard falls back to
   assignee/name matching. That is inherently weaker than a supervisor-owned
   session id attached to each execution instance.

4. Rig-store freshness.

   Rig-store workflow details cannot currently refresh each bead independently
   through the city bead endpoint. The embedded workflow snapshot needs to be
   fresh enough or the supervisor needs an API for scoped runtime bead reads.

5. Handwritten supervisor boundary.

   The current boundary is stricter than raw casts, but it is still maintained
   manually. OpenAPI generation should reduce drift risk.

## Next Implementation Moves

1. Add city-event invalidation to `WorkflowRunDetailPage` using the existing
   `useGcEventRefresh()` pattern and the same whole-projection `refresh()`.
2. Capture real graph.v2 supervisor snapshots for completed, running, blocked,
   retried, and looped runs; use them as backend enrichment fixtures.
3. Add tests that assert every `WorkflowDisplayNode` with a running current
   instance either resolves a streamable session or surfaces an explicit
   unresolved-session state.
4. Move workflow endpoint calls onto the generated supervisor client once the
   OpenAPI client plan lands.
5. Push canonical graph presentation semantics down into Gas City or a shared
   package when the dashboard approximation is stable enough to specify.
