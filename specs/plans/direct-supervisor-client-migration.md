# Direct Supervisor Client Migration

Date: 2026-06-01
Status: Planned architecture pivot

## Goal

This project is intended to replace the existing `gc dashboard` implementation
inside `gastownhall/gascity`. The replacement should therefore follow the same
ownership model for Gas City data: the browser uses the GC supervisor API
directly for GC-owned resources, generated from supervisor OpenAPI, and the
custom dashboard service exists only for capabilities that are not supervisor
API responsibilities.

## Target Boundary

### Browser to GC supervisor

Use a generated supervisor client for:

- cities and runtime config that come from supervisor state
- health, agents, sessions, transcripts, and session streams
- beads and bead mutations
- mail reads, threads, and sends
- activity/events and snapshot refresh signals
- formula feeds, formula run snapshots, formula detail, and run event streams
- any future GC primitive once it is exposed in supervisor OpenAPI

The frontend may derive view models in hooks/selectors, but it must not define
a second wire contract for supervisor resources.

### Browser to dashboard service

Keep dashboard-service `/api/*` only for data the supervisor should not own:

- `git` log, status, diff, and execution-folder evidence
- `gh` maintainer triage and contributor history
- local deploy/build logs
- host/process health and dolt-noms local filesystem sampling
- client-error telemetry and dashboard audit rows
- static runtime config needed to discover the supervisor URL or enabled local
  dashboard modules

The dashboard service may also provide a transport-only proxy for `/v0/*` when
same-origin development, CSP, or SSH forwarding requires it. Such a proxy must
not validate, map, strip, cache, rename, or otherwise own supervisor DTOs.

## Non-Goals

- No permanent dashboard-server GC facade.
- No new shared DTO mirrors for supervisor-owned lists or entities.
- No backend "DTO stripping" layer for fields that the browser can safely
  receive from the supervisor.
- No dashboard-side OpenAPI patches as a long-term substitute for fixing
  `gastownhall/gascity` Huma/OpenAPI source.

## Upstream Dependency Rule

When direct use is blocked because the supervisor does not expose a needed
capability or its OpenAPI schema is inaccurate, add or update the gap in
[`../gc-supervisor-api-gaps.md`](../gc-supervisor-api-gaps.md), then implement
the fix in `gastownhall/gascity`. The dashboard may carry temporary migration
glue, but that glue must include a deletion condition tied to the upstream gap.

## Migration Slices

1. **Generated browser client foundation**
   - Generate a browser-consumable supervisor client from the committed
     supervisor OpenAPI.
   - Add a tiny wrapper for base URL discovery, mutation headers, error
     normalization, and test injection.
   - Model this on the current `gascity` dashboard rather than the
     dashboard-server `GcClient`.

2. **Transport**
   - In folded-back `gascity`, use the supervisor/static hosting shape already
     used by the existing dashboard.
   - In this standalone repo, use Vite or the dashboard service as a
     transport-only proxy when direct browser access to `127.0.0.1:8372` is
     inconvenient.
   - Keep CSP explicit. If `connect-src` includes the supervisor origin, name
     it; if the proxy is used, keep `connect-src 'self'`.

3. **Simple reads**
   - Migrate health, cities, sessions, agents, beads, mail, and activity reads
     from dashboard `/api/city/:cityName/*` routes to the generated supervisor
     client.
   - Delete corresponding route code and shared mirror DTOs as each surface
     moves.

4. **Streams**
   - Migrate city events and session streams to direct supervisor EventSource
     when CSP/transport allows.
   - If a same-origin stream proxy remains, it is transport-only and must not
     parse event payloads.

5. **Writes**
   - Migrate claim/send and any already-supported writes directly.
   - Migrate close-with-reason, agent nudge, and agent prime only after the
     supervisor gaps `GC-10`, `GC-11`, and `GC-12` are implemented upstream.

6. **Formula Run Detail**
   - Prefer supervisor-owned run snapshot, formula detail, session identity,
     and graph presentation fields.
   - Keep local view-model derivation only where
     [`../gc-supervisor-api-gaps.md`](../gc-supervisor-api-gaps.md) says the
     supervisor does not yet expose the canonical shape.
   - Keep execution-folder git diff in the dashboard service; it is local
     filesystem evidence, not a supervisor responsibility.

7. **Deletion gates**
   - After a surface migrates, add a grep or structure test preventing the old
     dashboard mirror route from returning.
   - Delete related `GcClient` methods, hand decoders, shared mirror DTOs, and
     route-level mocks in the same slice.

## Implementation Plan

### Phase 0 — Lock The Boundary

Deliverables:

- Add an architecture test or lint/grep check that classifies routes as either
  dashboard-local `/api/*` or transport-only `/v0/*`.
- Document the allowed dashboard-local route inventory in code:
  `git`, `gh`/maintainer, builds, host/process/dolt health, config,
  client-errors, and static frontend serving.
- Add a failing structure test for one GC mirror endpoint proving it still
  exists before migration begins.

Acceptance:

- New GC-owned backend routes require an explicit test failure or spec update.
- The first migrated route can delete its mirror without ambiguity.

### Phase 1 — Browser Supervisor Client Foundation

Deliverables:

- Add frontend supervisor OpenAPI generation.
- Add a tiny `frontend/src/supervisor/client.ts` wrapper for base URL discovery,
  mutation headers, error shape normalization, and test injection.
- Decide standalone transport:
  - direct `GC_SUPERVISOR_URL` in `connect-src`, or
  - dashboard-service transport-only `/v0/*` proxy.
- Add generated-client drift check to CI.

Acceptance:

- A frontend unit test can mock the wrapper without importing dashboard
  `/api/*`.
- A smoke test can call supervisor health through the generated client.

### Phase 2 — Simple Read Surfaces

Order:

1. health/cities
2. sessions/transcript reads
3. agents
4. beads list/detail
5. mail list/thread
6. activity/events reads

Per-surface red-green loop:

- Start with a failing test that asserts the route/hook still calls
  `api.listX()` or `/api/city/:cityName/x`.
- Move the hook/component to the generated supervisor client.
- Delete the backend mirror route, related `GcClient` method, shared mirror
  DTO, and route test mocks for that surface.
- Add a structure test that the deleted mirror route is not mounted.

Acceptance:

- The UI still renders the same state from generated supervisor types.
- No dashboard-owned DTO exists for the migrated supervisor resource.

### Phase 3 — Streams And Invalidation

Deliverables:

- Move city event streams to direct supervisor EventSource where transport
  allows.
- Move selected-session streams the same way.
- If the proxy remains, rename/shape it as a `/v0/*` transport relay and remove
  event payload parsing from the dashboard service.

Acceptance:

- Event identity matching happens in frontend code over generated supervisor
  event types.
- The backend stream proxy, if present, can be tested as byte forwarding only.

### Phase 4 — Writes And Upstream Gaps

Order:

1. claim and existing supervisor-supported writes
2. mail send
3. close-with-reason after `GC-10`
4. agent nudge after `GC-11`
5. agent prime after `GC-12`

Acceptance:

- No `gc` subprocess wrapper remains in `backend/src/exec.ts`.
- Dashboard-service writes are limited to local dashboard resources.
- Supervisor mutation calls use generated request types and the supervisor's
  browser-safe mutation header/auth model.

### Phase 5 — Formula Run Detail

Deliverables:

- Fetch run snapshot, formula detail, sessions, and event identity through the
  generated supervisor client.
- Keep local git diff as a separate dashboard-service resource.
- Move projection logic client-side only where still necessary, or delete it
  when `GC-1` through `GC-7` provide canonical upstream presentation.
- Delete `/api/runs/:runId` once the browser can compose the page from
  supervisor data plus local diff.

Acceptance:

- Formula Run Detail no longer depends on `backend/src/routes/runs.ts` for
  supervisor data.
- Local diff failure cannot break supervisor run-detail loading.
- The browser harness passes against generated supervisor data and local diff.

### Phase 6 — Shared And Backend Cleanup

Deliverables:

- Delete `backend/src/gc-client.ts` or reduce it to server-only transitional
  calls with a deletion issue.
- Delete `backend/src/gc-supervisor-decoders.ts`.
- Delete supervisor mirror DTO leaves under `shared/src/gc-*.ts` and
  `shared/src/formula-runs.ts` once no consumers remain.
- Shrink `frontend/src/api/client.ts` to dashboard-local service routes only.
- Remove route-level tests that mocked supervisor mirrors; replace with
  generated-client wrapper tests and component tests.

Acceptance:

- `rg "GcClient|gc-supervisor-decoders|/api/city/.*/(agents|beads|mail|sessions|events|snapshot)"` is clean except for archived docs or explicit migration notes.
- `shared/` contains no supervisor wire mirror types.
- The LOC deletion target in this plan is materially achieved.

## Expected Simplification

Measured from current `origin/main`, the production deletion pool is roughly:

- `backend/src/gc-client.ts`: about 1,009 LOC.
- `backend/src/gc-supervisor-decoders.ts`: about 920 LOC.
- GC mirror routes for agents, beads, mail, sessions, events, streams,
  snapshot, and large parts of runs: about 1.4k-2.0k LOC.
- Supervisor mirror DTO leaves in `shared/src/gc-*.ts` and
  `shared/src/formula-runs.ts`: about 650 LOC.
- GC-specific parts of `frontend/src/api/client.ts`: about 250-350 net LOC
  after a smaller dashboard-service client remains.

That gives a conservative production-code simplification of **3.8k-5.4k LOC
net removed**, before counting tests. Test and fixture deletion should be
larger, likely **4k-7k LOC**, because mocked backend routes for supervisor
resources disappear.

The reliability improvement is qualitative as much as numeric:

- one fewer network hop for GC data
- one fewer cache layer to go stale
- no duplicated supervisor DTO contracts
- no partial/degraded metadata copied through route projections
- no generated-type vs hand-Zod vs shared-DTO vs frontend-decoder mismatch
- fewer opportunities to strip or redact the wrong field
- missing capabilities become explicit upstream API gaps instead of hidden
  dashboard compensations

## Red-Green Discipline

Each migration slice starts with a failing test that proves the old dependency
still exists or the new generated-client path is not wired. Then the slice
migrates the smallest coherent surface and deletes the old path before going
green. A slice is not complete if both the direct supervisor path and the old
dashboard mirror remain as permanent alternatives.
