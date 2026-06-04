# Functional Gap Analysis: `demo-dash` to `gascity-dashboard`

Date: 2026-06-04
Status: Source-validated comparison
Source baseline: `/Users/csells/Code/gastownhall/demo-dash`
Target project: `/Users/csells/Code/Forks/sjarmak/gascity-dashboard`

This document identifies functionality present in `demo-dash` that is absent
or materially narrower in this standalone dashboard. It is intentionally
asymmetric: stronger functionality in this dashboard is noted only to avoid
false-positive gaps.

This is not a mandate for broad parity. In particular, `gascity-dashboard`
has an explicit direct-supervisor boundary: GC-owned resources should flow
through the generated supervisor client, while the dashboard backend should
own dashboard-local host capabilities only.

## Method

`demo-dash` source reviewed:

- `src/shared/types.ts`
- `src/server/snapshot.ts`
- `src/server/http.ts`
- `src/server/cache.ts`
- `src/server/collectors/{aimux,cityStatus,resources,github,tokens,workflows}.ts`
- `src/app/{App,api,render,state}.ts`
- `src/components/{CapacityStrip,GitHubThroughput,QuotaPanel,ResourcePanel,SourceHealthBar,TokenUsagePanel,WorkflowMap}.ts`

`gascity-dashboard` source reviewed:

- `README.md`
- `frontend/src/App.tsx`
- `frontend/src/components/Header.tsx`
- `frontend/src/routes/{AmbientHome,Agents,Beads,Runs,FormulaRunDetail,Mail,Activity,Health}.tsx`
- `frontend/src/supervisor/*`
- `frontend/src/api/client.ts`
- `backend/src/app.ts`
- `backend/src/city/runtime.ts`
- `backend/src/routes/*`
- `backend/src/views/modules/maintainer/*`
- `shared/src/*`
- `specs/architecture/cost-token-feasibility.md`

Validation rules:

- A demo capability counts only when it is user-visible or API-reachable in
  `demo-dash`.
- A target capability counts only when it has a reachable route, component,
  backend endpoint, or direct generated-supervisor client workflow wired into
  the app.
- Generated types alone do not count as implemented functionality.
- Package scripts and test/build workflow differences are not product
  functionality gaps.

## Findings Summary

`gascity-dashboard` is broader and deeper for core Gas City operations:
Agents, Beads, Formula Runs, Mail, Activity, Health, multi-city routing, live
supervisor event refresh, and optional Maintainer triage all exist here and
mostly exceed `demo-dash`.

The real missing surface is `demo-dash`'s ambient telemetry dashboard:

1. Aimux API quota/account availability.
2. Token usage from tokscale.
3. Repo-wide GitHub throughput and rate-limit telemetry.
4. Unified source health/freshness with aggregate snapshot and selective
   refresh.
5. One-page operations snapshot combining quotas, resources, capacity,
   GitHub, tokens, source health, and workflow lanes.
6. Session capacity ceiling and provider split overview.

Host load/memory is mostly covered by the current Health page. Formula/workflow
run visibility is also covered, and is likely richer in this dashboard.

## Gap Matrix

| # | Demo capability | Target state | Impact | Disposition note |
| - | --------------- | ------------ | ------ | ---------------- |
| 1 | Aimux API quota/account availability | No current route, API client method, or UI surface for aimux quota/account telemetry. | High | Real product gap if account exhaustion is operationally important. |
| 2 | Token usage telemetry | No user-facing token/cost/usage panel or API in current dashboard. Existing architecture notes say cost/token fields exist but do not flow yet. | High | Real product gap, but target path should probably be supervisor/event data, not a tokscale subprocess mirror. |
| 3 | GitHub throughput dashboard | Activity shows local commits/deploys and supervisor events; optional Maintainer triage is issue/PR triage, not repo throughput. | Medium/High | Real gap if repo throughput belongs in operator telemetry. |
| 4 | Consolidated source health and selective refresh | Current dashboard has route-local freshness/errors and SSE refresh, but no all-source health bar or aggregate refresh API. | Medium | Product-direction question: useful diagnostic surface, but should not reintroduce backend DTO mirrors for supervisor-owned resources. |
| 5 | One-page operations snapshot | Current dashboard is route-based: Home, Agents, Beads, Runs, Mail, Activity, Health, optional Maintainer. No combined snapshot page. | Medium | Deliberate product divergence unless an operator workflow needs dense all-domain scanning. |
| 6 | Session capacity/provider split overview | Agents gives detailed roster state; Home gives active runs and in-progress work. No compact max-session ceiling or provider split overview. | Medium | Could fit Home or Health without recreating the demo page. |
| 7 | Host resource trend affordances | Health covers CPU/load/memory/process; demo has resource panel trend slots for load, load/vCPU, memory. | Low/Medium | Partial gap only; core host pressure data exists. |
| 8 | Broad legacy/non-graph-v2 workflow lane inclusion | Current Runs focuses on supervisor/formula-run data; demo groups broader `bd list` workflow beads. | Conditional | Only a real gap if old non-graph-v2 workflow beads still matter operationally. |

## Gap Details

### 1. Aimux API quota/account availability

`demo-dash` has a first-class `aimux` source. The shared snapshot model names
`aimux` as one of six sources and defines account quota windows, reset times,
warnings, and account states (`available`, `limited`, `blocked`, `unknown`):
`/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:1`,
`:35`, and `:44`.

The backend collector runs:

- `aimux status --json`
- source cache TTL: 45 seconds
- vendor/account normalization
- five-hour and seven-day quota windows
- warnings/errors redaction

Evidence:

- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/aimux.ts:38`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/aimux.ts:51`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/aimux.ts:74`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/aimux.ts:97`

The UI renders this both as a headline command signal and as an account
availability panel:

- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:165`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:85`

Current target state:

- `frontend/src/api/client.ts:321` exposes health, git commits, builds,
  config, system health, local tool versions, dolt trend, run diff, and
  maintainer methods. There is no aimux/quota method.
- `backend/src/app.ts:61` mounts top-level health/git/builds/client-errors
  and city-scoped routes, but no aimux/quota route.
- A production-source search for `aimux`, `AimuxQuotaSummary`, and `tokscale`
  found no current dashboard implementation for this capability.

### 2. Token usage telemetry

`demo-dash` has a `tokens` source that reads tokscale output. It first tries
the tokscale TUI cache, then runs the tokscale binary for the configured
clients:

- clients: `opencode`, `claude`, `codex`, `gemini`
- windows: one day, seven days, thirty days
- active days in the last 30 days

Evidence:

- `/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:205`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/tokens.ts:10`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/tokens.ts:61`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/tokens.ts:78`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/tokens.ts:85`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/tokens.ts:118`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:90`

Current target state:

- `specs/architecture/cost-token-feasibility.md:7` says the supervisor
  contract has token/cost fields, but the data does not flow and the dashboard
  does not project these fields into a cost UI.
- `specs/architecture/cost-token-feasibility.md:23` explicitly distinguishes
  the `demo-dash` tokscale path from this dashboard and says tokscale is not
  the intended path here.
- There is no current user-facing token usage panel or typed `/api/*` method
  in `frontend/src/api/client.ts:321`.

This is a real functional gap, but a direct port of `demo-dash`'s tokscale
subprocess collector would conflict with the current architecture unless the
team intentionally accepts that dashboard-local host dependency.

### 3. Repo-wide GitHub throughput dashboard

`demo-dash` has a `github` source with repo-level throughput and demand
metrics:

- open pull request count
- open review demand
- review activity over 1d/7d/30d
- merged pull requests over 1d/7d/30d
- PR commits merged over 1d/7d/30d
- new contributors over 1d/7d/30d
- recent PR/commit/review/release activity
- GitHub API rate limit status

Evidence:

- `/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:173`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/github.ts:91`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/github.ts:111`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/github.ts:201`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:90`

Current target state:

- `frontend/src/routes/Activity.tsx:154` combines supervisor events, deploy
  history, and local git commits. It does not fetch GitHub PR rollups or
  GitHub rate-limit status.
- `backend/src/routes/git.ts:36` exposes `git log` views for local commit
  history, not GitHub PR/review throughput.
- `frontend/src/views/modules/maintainer/Maintainer.tsx:54` and
  `backend/src/views/modules/maintainer/router.ts:53` implement optional
  maintainer issue/PR triage and sling workflows. That is adjacent GitHub
  functionality, but not the same as always-on repo throughput telemetry.

### 4. Consolidated source health/freshness and selective refresh

`demo-dash` uses a single snapshot contract for six sources:

- `aimux`
- `city`
- `resources`
- `workflows`
- `github`
- `tokens`

Each source carries status, fetched timestamp, stale timestamp, error, and data:
`/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:1` and `:5`.

The backend builds one snapshot from per-source caches:

- `/Users/csells/Code/gastownhall/demo-dash/src/server/snapshot.ts:25`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/snapshot.ts:81`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/snapshot.ts:164`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/snapshot.ts:228`

The API exposes:

- `GET /api/snapshot`
- `POST /api/refresh`
- refresh by `source` query/body field, or `all`
- `/health` and `/healthz` with source status summary

Evidence:

- `/Users/csells/Code/gastownhall/demo-dash/src/server/http.ts:52`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/http.ts:62`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/http.ts:73`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/http.ts:114`

The frontend renders a source health bar immediately after command signals:

- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:81`

Current target state:

- `backend/src/app.ts:61` shows no aggregate snapshot or refresh route.
- `frontend/src/api/client.ts:321` shows no aggregate snapshot or selective
  refresh client method.
- `frontend/src/routes/Runs.tsx:139` has route-local freshness labels.
- `frontend/src/routes/Health.tsx:67` refreshes health-related sources as a
  page-local operation.
- `frontend/src/routes/Activity.tsx:81` and `frontend/src/routes/Health.tsx:106`
  use visible-refresh polling; `frontend/src/routes/Runs.tsx:131` uses
  supervisor-event SSE for run refresh.

This means the functionality is partly replaced by route-local cache/error
and real-time behavior, but the all-source diagnostic surface is missing.

### 5. One-page operations snapshot

`demo-dash` is one dense operations page. Its render path includes:

- command signals
- source health
- session/GitHub capacity strip
- quota panel
- resource panel
- GitHub throughput
- token usage
- workflow map
- live browser snapshot state

Evidence:

- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:36`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:79`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:83`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:85`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:90`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:92`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:94`

Current target state:

- `README.md:15` through `README.md:22` define separate Home, Agents, Beads,
  Runs, Mail, Activity, Health, and Maintainer surfaces.
- `frontend/src/App.tsx:72` through `frontend/src/App.tsx:98` route those
  surfaces separately.
- `frontend/src/components/Header.tsx:28` through `frontend/src/components/Header.tsx:37`
  define the core nav routes.

This is a functional difference, but may be intentional product direction.
The target Home route is not a smaller demo dashboard; it is an ambient
attention page focused on abnormal state:

- `frontend/src/routes/AmbientHome.tsx:15`
- `frontend/src/routes/AmbientHome.tsx:163`

### 6. Session capacity and provider split overview

`demo-dash` surfaces session capacity as a top-level operational signal:

- active sessions
- maximum sessions
- active session detail
- provider split
- active workflows
- GitHub PR summary nearby

Evidence:

- `/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:72`
- `/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:82`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/cityStatus.ts:54`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/cityStatus.ts:230`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/cityStatus.ts:265`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/render.ts:147`

Current target state:

- `frontend/src/routes/AmbientHome.tsx:134` through `frontend/src/routes/AmbientHome.tsx:146`
  surfaces active Formula Runs and city-wide in-progress work.
- `frontend/src/routes/Agents.tsx` has the full agent roster, state, provider,
  model, context, pending interaction, and live peek capabilities.
- I did not find a current route/component that renders the demo's compact
  session ceiling or provider-split overview.

This is narrower rather than absent agent functionality. The detailed data is
split across Home and Agents, but the capacity overview is missing.

### 7. Host resource trend affordances

`demo-dash` has a `resources` source with vCPU, load averages, load/vCPU,
memory, uptime, and a samples array:

- `/Users/csells/Code/gastownhall/demo-dash/src/shared/types.ts:93`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/resources.ts:52`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/resources.ts:74`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/resources.ts:85`

Current target state:

- `backend/src/routes/health.ts:24` serves system health with admin process
  and host load/memory/cpu/uptime.
- `frontend/src/routes/Health.tsx:164` renders Host health.
- `frontend/src/routes/Health.tsx:197` renders Admin process health.
- `frontend/src/routes/Health.tsx:215` renders Diagnostics.
- The current Health page additionally shows dolt-noms trend data.

Core host-pressure functionality is present. The narrower gap is the demo's
resource trend presentation for load/load-per-vCPU/memory samples.

### 8. Broad legacy/non-graph-v2 workflow lane inclusion

`demo-dash` builds workflow lanes by reading broad `bd list` results from the
city and a demo rig root, grouping related issues by workflow root, and
mapping phases heuristically:

- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/workflows.ts:55`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/workflows.ts:64`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/workflows.ts:84`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/workflows.ts:111`
- `/Users/csells/Code/gastownhall/demo-dash/src/server/collectors/workflows.ts:182`

Current target state:

- `frontend/src/routes/Runs.tsx:54` renders Formula Runs.
- `frontend/src/supervisor/runSummary.ts:55` builds run summaries from
  supervisor bead/formula-feed/session data.
- `frontend/src/supervisor/runSummary.ts:128` loads active beads, formula
  feed discovery, and scoped recent run beads.

This is likely not a practical gap if all operational runs now use the current
Formula Run graph/supervisor model. It is a conditional gap only if old
workflow bead groups still need to appear in the dashboard.

## Not Gaps

### Formula Run visibility

The target dashboard is stronger here. It has a Formula Runs route, active and
historical lanes, partial-data notices, SSE refresh, and run detail with graph
node evidence, transcript streams, and local git diffs:

- `frontend/src/routes/Runs.tsx:54`
- `frontend/src/routes/Runs.tsx:131`
- `frontend/src/routes/FormulaRunDetail.tsx:41`
- `frontend/src/components/run/RunMap.tsx:33`

### Real-time refresh

`demo-dash` polls its snapshot every 30 seconds:

- `/Users/csells/Code/gastownhall/demo-dash/src/app/state.ts:28`
- `/Users/csells/Code/gastownhall/demo-dash/src/app/state.ts:76`

The target dashboard has route-local polling where appropriate and generated
supervisor SSE refresh for Agents, Beads, Runs, Run Detail, transcript peeks,
and Maintainer:

- `frontend/src/routes/Runs.tsx:35`
- `frontend/src/routes/Runs.tsx:131`
- `frontend/src/routes/Activity.tsx:81`
- `frontend/src/routes/Health.tsx:106`

### Host health

Host CPU/load/memory is not missing. It moved to Health and is joined by
admin process, supervisor, local tool, and dolt-noms diagnostics:

- `backend/src/routes/health.ts:24`
- `frontend/src/routes/Health.tsx:129`

### GitHub maintainer triage

The target dashboard has optional GitHub maintainer triage. That is a separate
workflow from `demo-dash`'s GitHub throughput panel:

- `backend/src/views/modules/maintainer/router.ts:53`
- `frontend/src/views/modules/maintainer/Maintainer.tsx:72`

## Prioritized Fill Candidates

If the goal is to recover the most useful `demo-dash` functionality without
undoing the current product direction, the highest-value sequence is:

1. Add an operator-visible quota/capacity surface for API accounts and session
   ceiling/provider split. This closes the clearest operational blind spot.
2. Add token/cost usage once the supervisor event fields actually carry data.
   Avoid duplicating the demo tokscale subprocess path unless explicitly
   accepted as dashboard-local host telemetry.
3. Add repo throughput as either an Activity subview or a Maintainer-adjacent
   module, depending on whether it is city-operator telemetry or maintainer
   workflow telemetry.
4. Add a small source/diagnostic rollup if operators need cross-source
   freshness. Prefer composing existing route data or supervisor-generated
   resources over introducing a permanent backend snapshot DTO.
5. Do not recreate the one-page command center unless user research shows the
   route-based model is hiding critical operational state.

