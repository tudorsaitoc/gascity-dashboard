# Direct Supervisor Boundary

This is the durable boundary after the direct-supervisor migration. The
archived execution plan is only history; this file is the current contract.

## Ownership Rule

GC-owned resources are owned by the GC supervisor API and consumed in the
browser through generated OpenAPI client types. The dashboard service owns only
local host capabilities and static/runtime support.

Use the generated browser supervisor client for:

- city discovery, city health, and city status
- agents, sessions, transcripts, pending interactions, and session streams
- beads, bead detail, claim/update, close, create, sling, and agent nudge
- mail list/thread reads, send, reply, archive, read, and mark-unread
- supervisor/city event history and event streams
- formula feeds, workflow snapshots, formula detail, and formula-run streams

Use dashboard-service `/api/*` only for:

- static runtime config and enabled dashboard modules
- git, gh, build/deploy, and local execution-folder evidence
- host/process/local-tool diagnostics
- dolt-noms sampling derived from supervisor status plus local dashboard state
- maintainer-local records, client-error telemetry, and audit rows
- Formula Run Detail's local execution-folder diff

Do not add permanent dashboard-server routes or shared DTOs for supervisor-owned
resources. If a GC-owned capability or schema is missing, update
[`../gc-supervisor-api-gaps.md`](../gc-supervisor-api-gaps.md) and fix the
supervisor/OpenAPI source.

## Transport Proxy

Standalone development may use `/gc-supervisor/*` to keep one same-origin port
for local and SSH-forwarded browsers. The proxy forwards only supervisor
`/health` and `/v0/*` paths.

The proxy must not parse, validate, map, strip, cache, rename, or otherwise own
supervisor DTOs. It may strip unsafe transport/request headers and forward the
upstream response bytes and headers.

## Backend Supervisor Touches

The remaining backend supervisor client is host-local only. Its allowed surface
is:

- `GET /v0/cities` for multi-city registry/discovery
- `GET /v0/city/{cityName}/status` for dashboard-local dolt-noms sampling

It must not grow agent, bead, mail, session, event, formula, transcript, or
mutation methods. Those belong in the generated browser supervisor client.

## Shared Package Contract

`shared/` is for dashboard-owned `/api/*` DTOs, UI/module contracts, and pure
view-model helpers. It must not carry shared supervisor wire DTO mirrors when
the generated supervisor client already exposes the shape.

Allowed shared projections are named as dashboard/view-model contracts, not as
GC wire contracts. Current examples:

- `DashboardBead` and `DashboardSession` projection inputs for pure selectors
  and relationship helpers.
- `RunSnapshot` and `FormulaDetail` projection inputs used by the formula-run
  presentation layer.
- `SystemHealth`, `LocalToolVersions`, and `DoltNomsTrend` for dashboard-local
  host/process/tooling facts.

Generated supervisor values are normalized into these projections at frontend
edges. The dashboard service must not perform this normalization for
browser-facing supervisor entity routes.

## Transitional Projection Debt

Formula-run graph presentation still has client/shared projection logic because
the supervisor does not yet expose every canonical presentation fact. Deletion
conditions are tracked in [`../gc-supervisor-api-gaps.md`](../gc-supervisor-api-gaps.md):

- `GC-1`: canonical formula identity in workflow snapshots
- `GC-2`: canonical graph.v2 presentation
- `GC-3`: rig-store runtime freshness
- `GC-4`: per-execution session identity
- `GC-5`: event identity on every run-affecting event
- `GC-6`: OpenAPI schema accuracy
- `GC-7`: canonical execution-instance fields
- `GC-8`: native heartbeat/progress signal
- `GC-9`: formula-detail status in snapshots
- `GC-13`: optional clock-window mail query

Until those upstream gaps close, keep projection code browser/shared-only,
typed, pure where possible, and explicitly tied to the upstream deletion
condition.

## Regression Guards

The boundary is guarded by:

- generated supervisor-client drift checks
- backend tests that deleted `/api/city/*` supervisor mirrors stay unmounted
- frontend tests asserting supervisor-owned reads and writes use `/gc-supervisor`
- browser smoke coverage for city-scoped Home, Agents, Beads, Runs, Mail,
  Activity, Health, enabled first-party modules, and Formula Run Detail
