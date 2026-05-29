# Architecture Best Practices Audit

Branch: `csells/architecture-best-practices-audit`

Base: `csells/formula-detail-followup`

Scope: entire `backend`, `frontend`, and `shared` codebase, measured against the
rubric in `AGENTS.md`.

## Method

- Treat `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, and `docs/{ARCHITECTURE,SECURITY,EXTENDING}.md` as the contract.
- Inspect source, tests, CI, lint/type configuration, and tracked project layout.
- Score each rubric item from 1 to 100.
- Any item below 100 needs code, configuration, or documentation changes plus
  a reassessment from current evidence.

## Initial Assessment

| Rubric item | Initial score | Evidence | Gaps to close |
| --- | ---: | --- | --- |
| TDD | 86 | 63 test files cover backend, frontend, shared, workflow detail, route validation, and fixtures. CI runs app and test typechecks plus backend/frontend tests. | Missing focused red tests for the audit-log path env parsing bug and the dolt-noms sampler source. |
| Consider First Principles | 84 | Docs explain why the app has a backend, shared wire types, same-origin SSE, and local-only deployment. | Snapshot still carries deferred `aimux`/`github`/`tokens` sources that are not part of the current product surface. |
| Leverage Types | 88 | Strict TypeScript, `noUncheckedIndexedAccess`, shared wire types, test typecheck in CI. | Backend/frontend do not use `exactOptionalPropertyTypes`; supervisor JSON is cast at the fetch boundary without runtime validation. |
| DRY | 82 | Workflow detail logic is split into focused helpers, snapshot cache is reusable. | Route catch/log/response handling is repeated, and several timer/refresh patterns are hand-coded per route. |
| Separation of Concerns | 87 | Routes, middleware, snapshot collectors, workflow projection, and shared types are separated. | Logging is scattered through route code, and snapshot service still owns placeholder product sources. |
| Single Responsibility Principle | 82 | Many backend workflow helpers have narrow responsibilities. | `frontend/src/routes/Maintainer.tsx` and `backend/src/exec.ts` remain large multi-concern modules; `server.ts` wires many policies inline. |
| Clear Abstractions & Contracts | 85 | `shared` owns wire types, `GcClient` owns supervisor reads, `exec.ts` owns shell writes. | Error logging/response contracts are ad hoc in routes; placeholder source contracts expose known-unimplemented behavior. |
| Low Coupling, High Cohesion | 83 | Workflows, snapshot collectors, middleware, and API clients are cohesive. | `DashboardSources` forces consumers/tests to carry unused deferred sources; route handlers directly know logging details. |
| Scalability & Statelessness | 83 | Backend is local-only by design; caches are explicit and bounded; no durable app DB. | In-memory ring buffers and workers are single-process only; docs justify this but code should avoid pretending deferred collectors are scalable product sources. |
| Observability & Testability | 78 | Audit log exists, routes have tests, snapshot source status is visible. | Operational logging is not centralized; dolt sampler swallows failures; placeholder sources produce predictable errors rather than useful signal. |
| KISS | 80 | Core routes are straightforward, no table/grid library overreach. | Deferred snapshot sources and large route/component modules add complexity without current value. |
| YAGNI | 76 | The main dashboard views are constrained to operator workflows. | `aimux`, `github`, and `tokens` snapshot sources are explicitly not wired and unused by the visible workflow page. |
| Don't Swallow Errors | 70 | Many catch blocks send user-visible degraded states and log to stderr. | Some errors are swallowed or reduced to empty/null values without centralized logging; `runSample()` suppresses sampler failures. |
| No Placeholder Code | 65 | Workflow detail implementation is real and tested against graph.v2. | `sampleDoltNomsSize()` is a documented stub; snapshot deferred collectors are intentionally not wired. |
| No Comments for Removed Functionality | 87 | Most comments explain current constraints and security decisions. | Several comments still document legacy behavior and deferred sources in source code, increasing stale-history risk. |
| Layered Architecture | 85 | Frontend API client, backend routes, middleware, `GcClient`, exec wrappers, and shared types form clear layers. | Runtime JSON parsing is not separated from fetch casting; logging is not its own layer. |
| Use Non-Nullable Variables | 82 | Strict null checks are enabled and many APIs use discriminated unions. | Many route/helper APIs still use `null` for degraded states where tagged results would be clearer. |
| Use Async Notifications | 83 | City events and session streams use SSE. | Several visible pages still use local polling intervals; Health is intentionally interval-based but not centralized. |
| Eliminate Race Conditions | 84 | `GcClient` and `SourceCache` use single-flight; workflow selection has tests for stale-cache refresh. | Config and logging state are global; sampler ring buffer failure paths are unobserved. |
| Write for Maintainability | 82 | Tests and docs are unusually strong for the repo size. | Large modules and repeated catch handling make future changes harder than necessary. |
| Arrange Project Idiomatically | 85 | npm workspaces, CI, `.gitignore`, typed tests, Vite/Express layout are idiomatic. | Static analysis can be tighter, and build/deferred-source docs need to match current reality. |
| Keep Serialization/Deserialization At The Edges | 80 | Shared types define wire shapes and most UI works over typed objects. | `GcClient.fetchOnce<T>()` casts raw JSON directly; route-level parsing is inconsistent across endpoints. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | Uses Express, React, Vite, Tailwind, Vitest, Testing Library, ansi_up, TypeScript ESLint. | Some infrastructure code is hand-rolled by necessity; needs clear tests where no OSS fit exists. |
| Treat Static Warnings And Info As Errors | 88 | CI runs lint with `--max-warnings=0`; TypeScript has strict flags. | ESLint does not ban direct `console` outside a logging adapter; `exactOptionalPropertyTypes` is not enabled in backend/frontend. |
| Use Centralized Semantic Constant Values | 83 | Many constants exist for regexes, TTLs, limits, and source names. | HTTP error shapes, log component names, and some interval values are still repeated inline. |

## First Fix Pass

Target the issues with broadest score impact:

1. Add red tests for the config audit-log-path bug and dolt-noms source behavior.
2. Replace the dolt-noms stub with a real filesystem-backed sampler.
3. Centralize backend operational logging and stop scattering raw `console.*`.
4. Remove or replace snapshot placeholder sources that are outside the current product contract.
5. Tighten static analysis around optional properties and direct console usage.

## Weakest Parts From Fresh Review

The worst architectural problem is not a missing feature. It is semantic
ambiguity: too many shapes historically used missing values, `null`, or omitted
properties to mean several different things. For workflow run detail this made
the UI guess whether data was not fetched, not applicable, not started, not git,
or failed. That ambiguity is how broken sessions and "pending" nodes escaped
earlier testing.

The second weakest area is error observability. Several code paths already
returned safe degraded responses to the browser, but some of them did not write
the real cause into the backend operational log. A safe user-facing message is
not enough; the server-side cause needs to be retained so failures can improve
the app over time.

The third weakest area is the supervisor boundary. `GcClient.fetchOnce<T>()`
still casts raw JSON to TypeScript types. The workflow detail projection now
validates and rejects much more aggressively downstream, but the correct long
term architecture is generated OpenAPI client types plus runtime validation at
the supervisor edge.

The fourth weakest area is historical product surface. Snapshot sources and
older maintainer paths still contain nullable wire shapes and deferred sources
that are outside the focused workflow-run detail product. Those should be
handled in their own passes rather than mixed into this workflow refactor.

## Implemented In This Pass

- Added `exactOptionalPropertyTypes` to backend and frontend TypeScript config.
- Added `no-console` as an ESLint error, with the backend logging adapter as the
  only allowed console boundary.
- Added `backend/src/logging.ts` and replaced raw backend route/process logging
  with `logInfo`, `logWarn`, and `logError`.
- Added regression coverage for `ADMIN_AUDIT_LOG_PATH` and implemented a real
  dolt-noms filesystem sampler with explicit unavailable reasons.
- Replaced workflow-detail nullable/optional app-owned fields with explicit
  semantic state:
  - `WorkflowFormula`
  - `WorkflowExecutionPath`
  - `WorkflowSnapshotSequence`
  - `WorkflowDiffRootPath`
  - `WorkflowIteration`
  - `WorkflowAttempt`
  - `WorkflowSessionAttachment`
  - `WorkflowIterationSummary`
  - `WorkflowAttemptSummary`
  - `WorkflowNodeScope`
- Made workflow display nodes identify their visible execution instance
  explicitly.
- Made workflow display edges carry an explicit kind, defaulting unknown
  dependency edges to `dependency`.
- Made diff errors carry a required error string instead of optional message
  data.
- Updated workflow fixtures, frontend tests, backend tests, and the browser
  workflow-detail harness to enforce the new contract.
- Logged unexpected degraded backend paths in builds, health, snapshot, SSE,
  and workflow diff handling while keeping expected absence states explicit.

## Reassessment After This Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 94 | Added focused regression tests and updated workflow/browser fixtures to fail on stale contracts. | Need equivalent edge-boundary validation tests for every supervisor response family, not only workflow detail. |
| Consider First Principles | 90 | Workflow detail now models domain states directly instead of hiding absence. | Snapshot deferred sources still need a first-principles product pass. |
| Leverage Types | 94 | `exactOptionalPropertyTypes`, required node/edge fields, and workflow discriminated unions close major gaps. | Supervisor fetches still cast raw JSON. |
| DRY | 86 | Logging adapter removes raw console duplication. | Route error response handling is still repeated. |
| Separation of Concerns | 90 | Workflow projection is more clearly a domain model over supervisor data. | Snapshot composition still mixes active and deferred product sources. |
| Single Responsibility Principle | 84 | Workflow detail helpers became more precise. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large. |
| Clear Abstractions & Contracts | 92 | Workflow run detail has an explicit UI contract instead of nullable holes. | API error envelopes and supervisor validation need the same treatment. |
| Low Coupling, High Cohesion | 88 | Workflow UI is a view over a richer backend projection. | Snapshot consumers still carry unused source concerns. |
| Scalability & Statelessness | 85 | No new stateful service was added; sampler history remains bounded. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 90 | Central logging and explicit degraded states improve diagnosis. | Frontend-side error telemetry remains minimal. |
| KISS | 86 | Nullable guessing was removed from workflow UI logic. | The app still contains deferred source complexity. |
| YAGNI | 80 | Workflow detail work stayed architectural, not feature expansion. | Deferred sources are still present. |
| Don't Swallow Errors | 88 | Unexpected backend degradations now log causes in more places. | Some resource/maintainer helpers still intentionally degrade with `null`; they need explicit-state refactors. |
| No Placeholder Code | 82 | Dolt-noms stub became a real sampler. | Deferred snapshot collectors remain intentionally unwired. |
| No Comments for Removed Functionality | 88 | New comments describe current contracts. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 90 | Workflow detail has a stronger projection layer between supervisor and UI. | Generated supervisor client/runtime validation is still missing. |
| Use Non-Nullable Variables | 90 | Workflow-detail app-owned nullability was replaced by tagged states. | Snapshot and maintainer domains still use null-heavy shapes. |
| Use Async Notifications | 84 | No regression; workflow/session SSE browser path is verified. | Health and some ambient pages still poll. |
| Eliminate Race Conditions | 86 | Browser harness verifies selection/stream behavior against current fixtures. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 88 | Types now document semantics that used to live in UI assumptions. | Large modules still need extraction. |
| Arrange Project Idiomatically | 92 | Static config is stricter and passes. | CI should keep the new browser harness in the required path if it does not already. |
| Keep Serialization/Deserialization At The Edges | 84 | Workflow projection rejects more malformed supervisor states. | Raw supervisor JSON still enters through unchecked generic casts. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | No unnecessary new dependency was added. | Generated OpenAPI client tooling still needs selection and rollout. |
| Treat Static Warnings And Info As Errors | 96 | `npm run lint` has zero warnings and direct console is banned outside allowed files. | Type-aware ESLint could be stricter, but the current project gate is materially tighter. |
| Use Centralized Semantic Constant Values | 86 | More semantic state names are centralized in shared types. | API error kinds and log component names are still stringly typed. |

## Next Pass To Reach 100

1. Introduce generated/validated supervisor client boundaries from the OpenAPI
   spec, then remove unchecked `fetchOnce<T>()` casts.
2. Replace snapshot source nullability with explicit source availability states.
3. Split the largest route/component modules only where that reduces real
   coupling: `Maintainer.tsx`, `exec.ts`, and route bootstrap in `server.ts`.
4. Decide whether deferred snapshot sources belong in this product surface. If
   not, remove them from the dashboard contract rather than preserving
   placeholder error states.

## Second Fix Pass: Supervisor Boundary Validation

The next weakest point was the gc supervisor boundary. TypeScript shared types
only help after data has been proven to match them; `GcClient.fetchOnce<T>()`
was letting arbitrary JSON become trusted domain input. That is exactly the
kind of architecture that hides broken real-world supervisor responses until a
later view renders nonsense.

Implemented:

- Added `backend/src/gc-supervisor-decoders.ts` as the single runtime validation
  boundary for supervisor payloads handled by `GcClient`.
- Removed unchecked generic JSON casts from `GcClient.fetchOnce()`.
- Made every `GcClient` read pass through an endpoint-specific decoder before
  routes or workflow projection code can consume the value.
- Added focused supervisor-boundary tests for malformed responses from every
  current `GcClient` response family:
  - sessions
  - bead detail
  - bead lists
  - mail lists
  - events
  - workflow snapshots
  - formula detail
  - transcripts
- Removed the transcript `turns ?? []` fallback. A transcript payload without
  turns is malformed supervisor data, not an empty session.
- Replaced the remaining no-op rejection cleanup in `GcClient` with a two-arm
  cleanup handler so error swallowing is not normalized as a local pattern.
- Updated stale session route fixtures to emit real supervisor-shaped sessions
  instead of `{ id }` placeholders.

This is intentionally not a generated OpenAPI client yet. The architectural
improvement is that the app now has a hard trust boundary. The future generated
client can replace the hand-written decoder internals without changing route
or UI ownership.

## Reassessment After Supervisor Boundary Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 96 | Boundary tests now cover every `GcClient` response family, and the full backend/frontend/browser suites pass. | Some remaining architecture cleanup, especially route error helpers and snapshot source states, still needs red tests before refactor. |
| Consider First Principles | 91 | The app now treats the supervisor as an untrusted external system at the edge. | Snapshot deferred sources still need a first-principles product decision. |
| Leverage Types | 97 | Runtime validation now protects the handoff from unknown JSON into shared TypeScript contracts. | A generated OpenAPI client would remove hand-maintained schema drift risk. |
| DRY | 86 | No new route duplication was introduced; decoder helpers centralize common validation primitives. | Route error response handling remains repeated. |
| Separation of Concerns | 92 | Fetching, decoding, route behavior, and workflow projection are more clearly separated. | Snapshot composition still mixes active and deferred source concerns. |
| Single Responsibility Principle | 84 | `GcClient` remains the one supervisor ingress point. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 94 | Supervisor payload contracts now fail fast at the ingress boundary. | API error envelopes and route error behavior are still ad hoc. |
| Low Coupling, High Cohesion | 89 | Routes no longer depend on downstream code discovering malformed supervisor shapes. | Snapshot consumers still carry unused source concerns. |
| Scalability & Statelessness | 85 | No new mutable service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 92 | Malformed supervisor data now becomes a concrete upstream error with a specific backend log cause. | Frontend-side telemetry and centralized route error logging remain thin. |
| KISS | 87 | Validation is explicit and local to the edge, avoiding defensive checks scattered through views. | Hand-written decoders add maintenance cost until replaced by generated client tooling. |
| YAGNI | 82 | The pass added architecture around existing supervisor calls only, not new product behavior. | Deferred sources are still present. |
| Don't Swallow Errors | 91 | Missing transcript turns and malformed supervisor data are no longer coerced to empty values, and the client cleanup path no longer uses an empty catch. | Some snapshot/resource helpers still degrade with null-like states that need explicit result modeling. |
| No Placeholder Code | 84 | Stale `{ id }` session fixtures were replaced with real response shapes. | Deferred snapshot collectors remain intentionally unwired. |
| No Comments for Removed Functionality | 88 | New comments describe the active trust boundary. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 94 | A runtime deserialization layer now sits between supervisor fetches and app-owned route/domain code. | The layer should ultimately be generated from the supervisor OpenAPI spec. |
| Use Non-Nullable Variables | 91 | Transcript turns and other required supervisor fields are enforced before app code receives them. | External supervisor shapes still contain legitimate optional fields; app-owned snapshot and maintainer shapes remain null-heavy. |
| Use Async Notifications | 84 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 87 | Coalesced request failures still reject all callers after decoder validation; cleanup no longer hides rejection handling. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 90 | Future route/UI code can assume validated supervisor objects instead of repeating defensive checks. | Large modules still need extraction. |
| Arrange Project Idiomatically | 92 | Tests and type gates remain idiomatic and green. | CI should include the workflow-detail browser harness if it is not already required. |
| Keep Serialization/Deserialization At The Edges | 94 | Raw supervisor JSON is now decoded at the `GcClient` edge before route/domain use. | The decoder is hand-written; generated OpenAPI validation remains the stronger long-term endpoint. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | No new dependency was added for an interim decoder. | OpenAPI client generation tooling still needs selection and rollout. |
| Treat Static Warnings And Info As Errors | 96 | Lint/typecheck remain clean with warnings as errors. | Type-aware ESLint could be stricter, but current gates are materially tight. |
| Use Centralized Semantic Constant Values | 87 | Supervisor payload names and validation messages are centralized in the decoder layer. | API error kinds and route log component names remain stringly typed. |

## Third Fix Pass: Route Error Adapter

The next broad duplication point was backend route error behavior. The app had
already improved backend logging, but individual routes still had to remember
how to classify validation errors, supervisor timeouts, supervisor 404s,
unexpected upstream failures, and app-internal failures. That made future
changes likely to drift and kept user-facing error envelopes stringly typed.

Implemented:

- Added `backend/src/route-errors.ts` as the typed adapter for route validation,
  upstream, timeout, not-found, and internal failures.
- Added focused red/green coverage in `backend/test/route-errors.test.ts`.
- Migrated mail, sessions, beads, workflows, snapshot, session stream, agents,
  mail send, git, and maintainer routes to the adapter where the route outcome
  matches one of those shared semantics.
- Kept special behavior local where it is actually special: SSE proxy behavior,
  Health's degraded aggregate response, expected command exits, and workflow
  detail's unsupported-formula response.
- Preserved backend cause logging while keeping browser responses redacted.

This does not make every catch block disappear. Some catches are still source
or command adapters, not HTTP error adapters. The architectural improvement is
that normal route failures now choose from a small shared vocabulary instead of
hand-building status/body/log behavior per route.

## Reassessment After Route Error Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 97 | Route-error behavior has focused red/green coverage, plus backend, frontend, and browser workflow-detail verification completed. | Remaining architecture work still needs the same red/green treatment, especially snapshot source states. |
| Consider First Principles | 91 | Route errors now model semantic outcomes instead of whatever a catch block happened to emit. | Snapshot deferred sources still need a first-principles product decision. |
| Leverage Types | 97 | Route error status/body pairs are typed and centrally constructed. | A generated OpenAPI client would still remove hand-maintained supervisor schema drift risk. |
| DRY | 92 | Repeated route catch/log/response handling moved behind one adapter. | Special route classes still have intentionally local behavior; large modules still duplicate some policy shape. |
| Separation of Concerns | 93 | Routes now delegate common HTTP error classification to a small adapter. | Snapshot composition still mixes active and deferred source concerns. |
| Single Responsibility Principle | 85 | Normal route failure handling has one owner. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 96 | API error envelopes and logging behavior are now explicit route contracts. | Snapshot source contracts still encode too much absence via null-like states. |
| Low Coupling, High Cohesion | 91 | Routes know less about logging internals and redaction mechanics. | Snapshot consumers still carry unused source concerns. |
| Scalability & Statelessness | 85 | No new mutable service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 94 | Shared route error paths keep real causes in logs while returning safe browser responses. | Frontend-side telemetry and snapshot source state observability remain thin. |
| KISS | 88 | Normal route error handling is now simpler at the call site. | Deferred source complexity and large modules still make the system harder to reason about. |
| YAGNI | 82 | The pass only standardized behavior the app already had. | Deferred sources are still present. |
| Don't Swallow Errors | 93 | Unexpected route failures now take a centralized logged path, and malformed upstream data is not coerced to empty values. | A few cleanup/resource paths and snapshot helpers still use best-effort degradation and need explicit error envelopes. |
| No Placeholder Code | 84 | No new placeholder behavior was added. | Deferred snapshot collectors remain intentionally unwired. |
| No Comments for Removed Functionality | 88 | New comments describe current route/error contracts. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 95 | HTTP error mapping is now its own layer between route handlers and response serialization. | Generated supervisor client/runtime validation remains hand-written for now. |
| Use Non-Nullable Variables | 91 | Route adapter results are concrete status/body pairs, not missing response fragments. | Snapshot and maintainer domains still use null-heavy shapes. |
| Use Async Notifications | 84 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 87 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 92 | Future routes can reuse the adapter instead of copying catch blocks. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 92 | Tests and type gates remain idiomatic and green. | CI should include the workflow-detail browser harness if it is not already required. |
| Keep Serialization/Deserialization At The Edges | 94 | No regression; route responses now serialize through shared error constructors. | The supervisor decoder remains hand-written rather than generated. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | No unnecessary new dependency was added. | OpenAPI client generation tooling still needs selection and rollout. |
| Treat Static Warnings And Info As Errors | 96 | Lint/typecheck remain clean with warnings as errors. | Type-aware ESLint could be stricter, but current gates are materially tight. |
| Use Centralized Semantic Constant Values | 91 | Route error kinds and common response messages now live in one adapter. | Log component names and some polling/refresh constants are still stringly typed. |

## Fourth Fix Pass: Source State Semantics

The next weakest architecture point was the snapshot source envelope. `data:
null`, `fetchedAt: null`, `staleAt: null`, and `error: null` were standing in
for different states: never fetched, failed, unavailable, stale, fixture, and
fresh-with-no-error. That forced consumers to inspect combinations of null
fields instead of a single semantic discriminator.

Implemented:

- Changed `SourceState<T>` into a discriminated union:
  - available states (`fresh`, `stale`, `fixture`) carry `data`, `fetchedAt`,
    `staleAt`, and a structured `SourceError`.
  - unavailable states (`error`) carry a required error string and do not
    expose pretend `data` or timestamp fields.
- Updated `SourceCache` so cold failures and collection failures return
  explicit unavailable states rather than `data: null`.
- Replaced fixture placeholder sources with explicit unavailable states for
  deferred sources.
- Updated snapshot composition, fixture loaders, workflow map rendering, and
  tests to branch on `status === 'error'` before reading source data.
- Added red/green tests proving error states do not contain fake data or fake
  timestamps.
- Removed an SSE proxy empty catch by logging upstream body-cancel cleanup
  failures.

This is the right shape for source availability, but it does not eliminate every
nullable domain field in the app. Headline counts, maintainer triage metadata,
workflow lane fields, and external supervisor shapes still have legitimate or
historical null-heavy contracts that need their own focused passes.

## Reassessment After Source State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 98 | Source-state semantics were changed with red/green cache tests, snapshot route tests, backend/frontend suites, and browser workflow-detail verification. | Remaining large-module and generated-client work still needs the same focused test scaffolding. |
| Consider First Principles | 95 | Source states now model availability directly instead of encoding meaning through null combinations. | Deferred sources still need a product decision: wire real collectors or remove them from the runtime contract. |
| Leverage Types | 98 | TypeScript now prevents consumers from reading source data until they prove the source is available. | A generated OpenAPI client would still remove hand-maintained supervisor schema drift risk. |
| DRY | 92 | Source availability checks are now uniform through the shared union. | Large modules still duplicate some rendering and command policy shape. |
| Separation of Concerns | 95 | Snapshot availability is owned by the shared source envelope, not by each UI consumer. | Snapshot headline and maintainer domains still mix absent values with domain values. |
| Single Responsibility Principle | 86 | SourceCache owns cache/source availability semantics more cleanly. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 98 | Source data and source failure are now separate wire contracts. | Domain summary types outside SourceState still need equivalent explicit-state treatment. |
| Low Coupling, High Cohesion | 93 | Consumers no longer know the old nullable field combination contract. | Deferred sources still force all snapshot consumers to understand currently unused source names. |
| Scalability & Statelessness | 85 | No new mutable service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 96 | Unavailable source states now always carry an error string, and SSE cleanup failures are logged. | Frontend-side telemetry remains minimal. |
| KISS | 90 | Snapshot consumers have one branch for source availability instead of several null checks. | Deferred source names and large modules still add complexity. |
| YAGNI | 84 | The pass changed existing source contracts without adding product surface. | Deferred sources are still present. |
| Don't Swallow Errors | 95 | Source failures and SSE cleanup failures now surface through explicit logged/error states. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 88 | Fixture placeholder null sources became explicit unavailable states. | Deferred collectors remain intentionally unwired. |
| No Comments for Removed Functionality | 89 | Source comments now describe the current explicit unavailable contract. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 96 | Source availability is enforced at the shared contract layer and reflected in backend/frontend code. | Generated supervisor client/runtime validation remains hand-written for now. |
| Use Non-Nullable Variables | 94 | The central snapshot source envelope no longer uses null for missing data, timestamps, or no-error states. | Headline counts, maintainer triage data, workflow metadata, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 84 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 87 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 94 | Future snapshot consumers get compile-time pressure to handle unavailable sources. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 93 | Shared contract, src/test typechecks, lint, backend/frontend tests, and browser harness all pass. | CI should include the workflow-detail browser harness if it is not already required. |
| Keep Serialization/Deserialization At The Edges | 95 | Snapshot serialization now has explicit availability variants instead of null placeholders. | The supervisor decoder remains hand-written rather than generated. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | No unnecessary dependency was added. | OpenAPI client generation tooling still needs selection and rollout. |
| Treat Static Warnings And Info As Errors | 96 | Lint/typecheck remain clean with warnings as errors. | Type-aware ESLint could be stricter, but current gates are materially tight. |
| Use Centralized Semantic Constant Values | 92 | Source error/no-error semantics are centralized in the shared type and cache constructor paths. | Log component names and some polling/refresh constants are still stringly typed. |

## Fifth Fix Pass: Remove Deferred Snapshot Sources

The source-state pass made deferred sources honest, but they were still runtime
surface. A source that has no collector, no UI, and no current product decision
should not be in the dashboard contract at all. Keeping it around made every
consumer and fixture carry future product complexity.

Implemented:

- Removed `aimux`, `github`, and `tokens` from `SourceName`,
  `DashboardSources`, `SOURCE_NAMES`, snapshot service cache maps, fixtures,
  and tests.
- Removed the unused summary types for those deferred sources from the shared
  snapshot module.
- Removed the synthetic `notWiredCache` path.
- Added a red route test proving `/api/snapshot` only returns the active source
  set: `city`, `resources`, and `workflows`.
- Re-ran grep over snapshot code/tests to verify the old deferred source names
  are no longer present in the snapshot contract.

This is not a feature cut. It is a contract cut: the app now exposes only data
it can actually collect and use.

## Reassessment After Deferred Source Removal

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 98 | Added a red/green route assertion for the active source set and reran all relevant suites. | Generated-client and large-module changes still need focused red tests. |
| Consider First Principles | 97 | The snapshot contract now contains only current dashboard product sources. | Strategic null-heavy domain states still need separate first-principles modeling. |
| Leverage Types | 98 | TypeScript no longer permits refresh requests or source maps for non-product snapshot sources. | A generated OpenAPI client would still remove hand-maintained supervisor schema drift risk. |
| DRY | 93 | Removed repeated fixture/cache/test handling for three unavailable sources. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 96 | Snapshot service no longer owns future/deferred product concerns. | Maintainer and workflow detail modules still have some mixed presentation/data-prep responsibilities. |
| Single Responsibility Principle | 87 | Snapshot service now composes only active source responsibilities. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 98 | Source contract is now smaller and aligned with actual runtime behavior. | Domain summary types outside SourceState still need equivalent explicit-state treatment. |
| Low Coupling, High Cohesion | 95 | Snapshot consumers no longer carry unused source names. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 85 | No new mutable service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 96 | There are fewer impossible source states to observe or test. | Frontend-side telemetry remains minimal. |
| KISS | 93 | Removed whole branches of deferred runtime complexity. | Large modules and hand-written supervisor decoders are still harder than necessary. |
| YAGNI | 91 | Deferred snapshot sources are no longer part of the runtime shape. | Some historical comments and null-heavy maintainer/workflow fields still reflect future or past assumptions. |
| Don't Swallow Errors | 95 | No deferred "not wired" errors are manufactured on every snapshot anymore. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 92 | Removed snapshot placeholder sources and unused deferred shared types. | Any remaining placeholder-like behavior is now outside the snapshot source contract and needs separate audit. |
| No Comments for Removed Functionality | 90 | Removed several comments documenting deferred snapshot source behavior. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 96 | Snapshot layers now align to real collectors only. | Generated supervisor client/runtime validation remains hand-written for now. |
| Use Non-Nullable Variables | 94 | Fewer source branches and no unavailable deferred source placeholders. | Headline counts, maintainer triage data, workflow metadata, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 84 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 87 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 95 | Fewer source names and fixtures make snapshot changes easier to reason about. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 94 | Shared contract, src/test typechecks, lint, backend/frontend tests, and browser harness all pass. | CI should include the workflow-detail browser harness if it is not already required. |
| Keep Serialization/Deserialization At The Edges | 95 | Snapshot serialization now emits only active source envelopes. | The supervisor decoder remains hand-written rather than generated. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | No unnecessary dependency was added. | OpenAPI client generation tooling still needs selection and rollout. |
| Treat Static Warnings And Info As Errors | 96 | Lint/typecheck remain clean with warnings as errors. | Type-aware ESLint could be stricter, but current gates are materially tight. |
| Use Centralized Semantic Constant Values | 93 | `SOURCE_NAMES` now reflects the real source set without deferred constants. | Log component names and some polling/refresh constants are still stringly typed. |

## Sixth Fix Pass: Generated Supervisor Client Boundary

The next weak point was the supervisor client. The app had a runtime validation
boundary, but it still hand-built supervisor URL paths and hand-maintained too
much schema knowledge. That left path/query drift outside any generated check.

Red check:

- `npm run openapi:gc-supervisor:check` failed because there was no generated
  client tooling at all.

Implemented:

- Added `openapi-typescript` and `openapi-fetch`.
- Added `scripts/update-gc-supervisor-openapi.mjs` to fetch, verify, normalize,
  and commit the supervisor OpenAPI schema from `/openapi.json`.
- Added `scripts/generate-gc-supervisor-client.mjs` to generate and check
  `backend/src/generated/gc-supervisor.ts` from the committed schema snapshot.
- Added root scripts:
  - `openapi:gc-supervisor:update`
  - `openapi:gc-supervisor:generate`
  - `openapi:gc-supervisor:check`
- Committed the current schema snapshot at
  `backend/openapi/gc-supervisor.openapi.json`.
- Reworked `GcClient` so JSON reads go through `openapi-fetch` generated path
  and query types, while preserving the existing public methods, default
  timeout behavior, single-flight coalescing, caller-abort semantics, sanitized
  upstream errors, and runtime decoders.
- Moved city health probing onto `GcClient.health()` so the health route no
  longer constructs a supervisor JSON fetch directly.
- Moved events and session SSE upstream URL construction onto `GcClient`
  helpers. The streaming proxy still owns raw `fetch()` because SSE is a byte
  stream, not a JSON operation.
- Added focused `GcClient` tests proving generated city-scoped workflow and
  health paths are encoded correctly.

This intentionally keeps runtime decoders. `openapi-fetch` gives compile-time
path/query/response typing, not runtime validation. The architecture now uses
the supervisor OpenAPI spec as the path/query authority and keeps app-owned
runtime validation at the edge until a generated runtime validator is chosen.

Verification:

- `npm run openapi:gc-supervisor:update`
- `npm run openapi:gc-supervisor:generate`
- `npm run openapi:gc-supervisor:check`
- `npm run typecheck`
- `npm run lint`
- `node --import tsx --test backend/test/gc-client.test.ts`
- `npm --workspace backend test`

## Reassessment After Generated Client Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Added a failing OpenAPI check first, then generated-client tooling and focused client path tests. Full backend tests pass. | Large-module extraction and remaining domain nullability need the same focused red/green treatment. |
| Consider First Principles | 98 | Supervisor schema authority now comes from the supervisor's own OpenAPI document, not dashboard guesses. | App-owned nullable domains still need first-principles modeling. |
| Leverage Types | 99 | `GcClient` JSON reads now use generated path/query/operation types plus runtime decoders. | Generated runtime validation would remove the last hand-maintained decoder drift. |
| DRY | 94 | Supervisor path construction is centralized behind generated path constants and `GcClient` helpers. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 97 | JSON supervisor calls, SSE URL construction, route behavior, and runtime validation have clearer ownership. | Maintainer and workflow detail modules still mix some presentation/data-prep responsibilities. |
| Single Responsibility Principle | 88 | `GcClient` is now the real supervisor ingress for JSON and URL construction. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | OpenAPI snapshot, generated types, `GcClient`, runtime decoders, and dashboard shared types are now distinct contracts. | Runtime validation is still hand-written. |
| Low Coupling, High Cohesion | 96 | Health, events, and session-stream routes no longer know supervisor city URL construction details. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new durable app state was added; generated schema is a build artifact. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 97 | Generated-client drift is now checkable, and health failures still log real causes while returning degraded state. | Frontend-side telemetry remains minimal. |
| KISS | 94 | Routes now have less URL plumbing; the generated layer is small and backend-internal. | Large modules and hand-written runtime decoders are still more complex than ideal. |
| YAGNI | 92 | The pass generated only backend supervisor types and did not leak an SDK into the browser. | Some historical comments and null-heavy maintainer/workflow fields still reflect future or past assumptions. |
| Don't Swallow Errors | 96 | OpenAPI fetch/update/generate failures fail loudly, and health/SSE paths still log causes explicitly. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 93 | Generated-client tooling is real and backed by the live supervisor schema. | Remaining placeholder-like behavior is now outside the snapshot contract and needs separate audit. |
| No Comments for Removed Functionality | 90 | New comments describe current generated/runtime boundary behavior. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Supervisor transport, generated schema types, runtime validation, route adapters, and browser contracts are layered. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 94 | Health no longer casts JSON directly and required dashboard health fields are validated before use. | Headline counts, maintainer triage data, workflow metadata, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | SSE stream URL construction is centralized; raw streaming remains a single proxy layer. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | Single-flight behavior survived the generated-client rewrite and remains directly tested. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 96 | Future supervisor path/query changes can be regenerated and checked instead of hunted through string builders. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | OpenAPI tooling lives in npm scripts, generated files are committed, and lint ignores generated code only. | CI should include OpenAPI check and the workflow-detail browser harness if not already required. |
| Keep Serialization/Deserialization At The Edges | 97 | JSON transport now uses generated operation types and still validates unknown runtime JSON at `GcClient`. | The runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | The project now uses `openapi-typescript` and `openapi-fetch` instead of a bespoke path/query client. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck, lint with `--max-warnings=0`, and OpenAPI generated drift check all pass. | Type-aware ESLint could be broader, but the current static gate is materially tight. |
| Use Centralized Semantic Constant Values | 95 | Supervisor path constants are generated-checked, and route URL construction delegates to `GcClient`. | Log component names and some polling/refresh constants are still stringly typed. |

## Seventh Fix Pass: Health Supervisor State

The health route still used `supervisor: null` for a degraded but recoverable
state. That one null meant "the supervisor health probe failed, but the
dashboard process and host health are still available." The UI inferred that
meaning through truthiness.

Red test:

- Changed the route test to require an explicit unavailable supervisor state.
  It failed against the old `supervisor: null` response.

Implemented:

- Replaced `SystemHealth.supervisor: SupervisorHealth | null` with
  `SupervisorHealthState`, a discriminated union:
  - `{ status: 'available', data: SupervisorHealth }`
  - `{ status: 'unavailable', error: string }`
- Updated the health route to return explicit unavailable state on non-timeout
  supervisor failures while keeping true timeouts as HTTP 504.
- Updated the Health page to branch on the supervisor state discriminator
  instead of truthiness.

Verification:

- `node --import tsx --test backend/test/routes.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`
- `npm --workspace frontend test`
- `node scripts/snap.mjs health --test`

## Reassessment After Health State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Health state used red/green route coverage, full type/lint gates, full backend/frontend tests, and browser health snapshots. | Remaining large-module and domain-shape work still needs focused red tests. |
| Consider First Principles | 98 | Health now models degraded supervisor reachability as state, not absence. | Maintainer triage and workflow summary domains still need the same explicit modeling. |
| Leverage Types | 99 | Consumers can no longer treat supervisor health as a nullable maybe-object. | Generated runtime validation remains hand-written. |
| DRY | 94 | Health offline/online branching is centralized in one shared union. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 97 | The health route owns degraded probe classification; the UI only renders the state. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 88 | Health route behavior is clearer and smaller after removing the helper that encoded null. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | Health's browser wire contract now says exactly whether supervisor data exists. | Runtime supervisor validation is still local code. |
| Low Coupling, High Cohesion | 96 | Health UI no longer relies on nullable transport details. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 98 | Degraded health is visible in the wire shape and still logged server-side. | Frontend-side telemetry remains minimal. |
| KISS | 95 | Health rendering has one explicit state branch instead of truthiness. | Large modules and hand-written runtime decoders are still more complex than ideal. |
| YAGNI | 92 | No new health feature was added; the existing degraded state became explicit. | Some historical comments and null-heavy maintainer/workflow fields still reflect future or past assumptions. |
| Don't Swallow Errors | 97 | Non-timeout health failures keep the dashboard up, log the cause, and expose an explicit unavailable state. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 93 | No placeholder behavior added. | Remaining placeholder-like behavior is outside health/snapshot and needs separate audit. |
| No Comments for Removed Functionality | 91 | Health comments now describe the current explicit degraded contract. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Health's domain state is now a shared contract, with route classification and UI rendering separated. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 95 | Removed `null` from the supervisor health contract. | Headline counts, maintainer triage data, workflow metadata, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 96 | Health future changes are now driven by a discriminated union instead of nullable checks. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Shared type, backend route, frontend view, unit tests, and browser snapshot all changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 97 | Health serialization now exposes explicit state instead of nullable degraded output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 95 | Health state labels are centralized in the shared contract. | Log component names and some polling/refresh constants are still stringly typed. |

## Eighth Fix Pass: Dashboard Headline Metric State

The snapshot headline still encoded unavailable aggregate counts as `null`.
That let the Workflows page render an unavailable workflow count as `0 active
workflows`, hiding the distinction between "known zero" and "the source could
not answer."

Red test:

- Changed the snapshot route test to require explicit available/unavailable
  headline metrics. It failed against the old `number | null` contract.

Implemented:

- Added `DashboardMetric`, a shared discriminated union:
  - `{ status: 'available', value: number }`
  - `{ status: 'unavailable', source: SourceName, error: string }`
- Replaced `DashboardHeadline` nullable numbers with `DashboardMetric`.
- Updated `buildHeadline` so source failures and missing numeric fields become
  explicit unavailable metrics.
- Updated fixture snapshot data and the Workflows page synopsis so unavailable
  workflow counts are displayed as unavailable, not as zero.
- Added frontend regression coverage that prevents unavailable workflow counts
  from being flattened into "0 active workflows."
- Removed stale snapshot-service comments that still described `data:null`
  failure envelopes.

Verification:

- `node --import tsx --test backend/test/snapshot-route.test.ts` (red first,
  then green)
- `npm --workspace frontend test -- Workflows.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `node --import tsx --test backend/test/snapshot-route.test.ts backend/test/snapshot-cache.test.ts backend/test/snapshot-fixtures.test.ts backend/test/snapshot-failure-isolation.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflows.test.ts`

## Reassessment After Headline Metric Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Headline metrics used a failing route test first, then a focused frontend regression. Snapshot-focused backend tests pass. | Large-module extraction and remaining domain-shape work still need focused red tests. |
| Consider First Principles | 99 | Headline now distinguishes known zero from unavailable data instead of treating absence as a number. | Workflow lane and maintainer domains still need the same explicit-state modeling. |
| Leverage Types | 99 | Shared headline consumers can no longer compile against nullable headline counts. | Generated runtime validation remains hand-written. |
| DRY | 95 | Headline metric construction is centralized through one source-metric helper. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 97 | Snapshot service owns metric availability; Workflows renders the shared state. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 88 | No new cross-cutting responsibility was added. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | The headline wire contract now says whether each value exists and why it does not. | Runtime supervisor validation is still local code. |
| Low Coupling, High Cohesion | 96 | Workflows no longer knows how to infer headline availability from nullable values. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 98 | Unavailable headline values now carry source and error in the wire shape. | Frontend-side telemetry remains minimal. |
| KISS | 95 | One small union replaces multiple nullable headline sentinels. | Large modules and hand-written runtime decoders are still more complex than ideal. |
| YAGNI | 93 | No new dashboard feature was added; the existing headline state became honest. | Some historical comments and null-heavy maintainer/workflow fields still reflect future or past assumptions. |
| Don't Swallow Errors | 98 | Headline source failures surface in the metric instead of disappearing into `null` or `0`. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 94 | Fixture data now follows the real explicit metric contract. | Remaining placeholder-like behavior is outside health/snapshot and needs separate audit. |
| No Comments for Removed Functionality | 92 | Snapshot comments no longer describe removed `data:null` behavior. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Snapshot aggregation, shared wire type, and page rendering stay layered. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 96 | Removed nullable headline counts and stopped treating unknown workflow counts as zero. | City status internals, workflow lane metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 96 | Future headline metrics follow one helper and one shared union. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Shared type, backend route, fixture data, frontend route, and tests changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 97 | Snapshot serialization now exposes explicit headline state instead of nullable degraded output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 95 | Headline availability state is centralized in the shared contract. | Log component names and some polling/refresh constants are still stringly typed. |

## Ninth Fix Pass: City Status Metric State

`CityStatusSummary` still used nullable counts for values the backend computes
itself. An empty supervisor session list is a known zero, not missing data.
The only naturally unavailable city metric in this shape is the configured
maximum session count, because it depends on `city.toml`.

Red test:

- Changed the city-status collector tests to require known zeroes for empty
  session counts and an explicit max-session metric state. The tests failed
  against `activeAgents: null`, `totalAgents: null`, and `maxSessions: null`.

Implemented:

- Made `CityStatusSummary.activeAgents`, `totalAgents`, `activeSessions`, and
  `suspendedSessions` non-nullable numbers.
- Replaced `CityStatusSummary.maxSessions` with `DashboardMetric`.
- Updated `parseCityToml` and the committed fixture snapshot to emit available
  max-session metrics.
- Represented missing city configuration as an unavailable metric instead of
  a nullable value.
- Stopped silently catching every `city.toml` read failure. Missing files are
  modeled explicitly; other read errors are logged centrally and surfaced as
  sanitized collector failures.

Verification:

- `node --import tsx --test backend/test/snapshot-cityStatus.test.ts` (red
  first, then green)
- `npm run typecheck`
- `npm run lint`
- `node --import tsx --test backend/test/snapshot-cityStatus.test.ts backend/test/snapshot-route.test.ts backend/test/snapshot-cache.test.ts backend/test/snapshot-fixtures.test.ts backend/test/snapshot-failure-isolation.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflows.test.ts`

## Reassessment After City Status Metric Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | City summary used a failing collector test first, then shared type and snapshot-focused tests. | Large-module extraction and workflow/maintainer domain-shape work still need focused red tests. |
| Consider First Principles | 99 | Empty sessions are now modeled as zeroes; only config-derived max sessions can be unavailable. | Workflow lane and maintainer domains still need explicit-state modeling. |
| Leverage Types | 99 | City status consumers can no longer compile against nullable aggregate counts. | Generated runtime validation remains hand-written. |
| DRY | 95 | City max-session availability reuses `DashboardMetric`. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 97 | City collector owns config availability; snapshot headline consumes the resulting shared metric. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 89 | City collector now distinguishes session aggregation from config availability more clearly. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | City status wire shape distinguishes computed counts from unavailable config. | Runtime supervisor validation is still local code. |
| Low Coupling, High Cohesion | 96 | Snapshot headline no longer has to interpret city `maxSessions` nullability. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 98 | Non-missing `city.toml` read errors are logged and surfaced rather than swallowed. | Frontend-side telemetry remains minimal. |
| KISS | 96 | Known city counts are plain numbers; only the actually optional metric has a union. | Large modules and hand-written runtime decoders are still more complex than ideal. |
| YAGNI | 93 | No new dashboard feature was added; existing city state became honest. | Some historical comments and null-heavy maintainer/workflow fields still reflect future or past assumptions. |
| Don't Swallow Errors | 98 | `city.toml` read failures are no longer blanket-caught into `null`. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 94 | Fixture city data follows the explicit city metric contract. | Remaining placeholder-like behavior is outside health/snapshot and needs separate audit. |
| No Comments for Removed Functionality | 92 | City-status comments now describe the current explicit max-session behavior. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | City collector, snapshot headline, and UI contract remain layered through shared types. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 97 | Removed nullable city aggregate counts and nullable city max-session output. | Workflow lane metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 96 | City count and max-session semantics are now encoded in types instead of comments/truthiness. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Shared type, collector, fixture data, route tests, and snapshot tests changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 97 | City summary serialization now avoids nullable aggregate values. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 95 | City max-session state uses the shared metric contract. | Log component names and some polling/refresh constants are still stringly typed. |

## Tenth Fix Pass: Workflow Census State

`WorkflowSummary.census` still used `null` to mean "the health engine has not
derived the census yet." That state is real during collector construction and
fixture loading, but it should not be encoded as absence. The snapshot read
path can then replace that pre-engine state with an explicit derived census.

Red test:

- Changed the workflow summary builder test to require
  `{ status: 'unavailable', error: 'workflow health has not been derived' }`.
  It failed against the old `census: null` output.

Implemented:

- Added `WorkflowCensusState`, a shared discriminated union:
  - `{ status: 'available', data: WorkflowCensus }`
  - `{ status: 'unavailable', error: string }`
- Replaced `WorkflowSummary.census: WorkflowCensus | null` with
  `WorkflowCensusState`.
- Updated the workflow summary builder and empty summary helper to emit an
  explicit pre-engine census state.
- Updated snapshot enrichment to replace that state with
  `{ status: 'available', data: census }`.
- Updated fixture data, backend tests, and frontend route fixtures to follow
  the explicit census contract.

Verification:

- `node --import tsx --test backend/test/snapshot-workflows.test.ts` (red
  first, then green)
- `node --import tsx --test backend/test/snapshot-workflows.test.ts backend/test/snapshot-health-wiring.test.ts`
- `npm run typecheck`
- `npm run lint`
- `node --import tsx --test backend/test/snapshot-cityStatus.test.ts backend/test/snapshot-route.test.ts backend/test/snapshot-cache.test.ts backend/test/snapshot-fixtures.test.ts backend/test/snapshot-failure-isolation.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflows.test.ts`
- `npm --workspace frontend test -- Workflows.test.tsx`

## Reassessment After Workflow Census Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Workflow census state used a failing builder test first, plus health wiring and frontend fixture tests. | Lane metadata and maintainer domain-shape work still need focused red tests. |
| Consider First Principles | 99 | "Not derived yet" is now a first-class census state, not absence. | Workflow lane and maintainer domains still need explicit-state modeling. |
| Leverage Types | 99 | Consumers can no longer treat workflow census as nullable. | Generated runtime validation remains hand-written. |
| DRY | 95 | Pre-engine census state is centralized in the workflow collector helper. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Collector emits pre-engine state; snapshot service owns health derivation. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 89 | Census ownership is clearer between collector and snapshot enrichment. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | Workflow summary now states whether census data is derived. | Runtime supervisor validation is still local code. |
| Low Coupling, High Cohesion | 97 | Tests and fixtures no longer need nullable census assumptions. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 98 | The wire shape exposes census derivation state. | Frontend-side telemetry remains minimal. |
| KISS | 96 | One small union replaces a nullable census sentinel. | Lane metadata and hand-written runtime decoders remain complex. |
| YAGNI | 93 | No new feature was added; existing census lifecycle became explicit. | Some historical comments and null-heavy maintainer/workflow fields still reflect future or past assumptions. |
| Don't Swallow Errors | 98 | Census derivation state is no longer silently hidden in `null`. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 94 | Fixture workflow data follows the explicit census contract. | Remaining placeholder-like behavior is outside health/snapshot and needs separate audit. |
| No Comments for Removed Functionality | 93 | Census comments now describe current pre-engine and derived states. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Workflow collection and health enrichment communicate through explicit state. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 98 | Removed nullable workflow census. | Workflow lane metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 97 | Future census consumers get a discriminated contract instead of optional chaining. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Shared type, collector, service enrichment, fixtures, and tests changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 97 | Workflow summary serialization avoids nullable census output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 95 | Pre-engine census state is centralized. | Log component names and some polling/refresh constants are still stringly typed. |

## Eleventh Fix Pass: Maintainer Cache Corruption

The maintainer cache reader treated corrupt JSON, stale wire shapes, and a
missing file as the same state: `null`. The route then rendered an empty
triage envelope. That hid persistent corruption and made the UI look calm when
operator action was needed.

Red test:

- Added a storage test requiring malformed JSON to reject with
  `maintainer cache parse failed`. It failed because `readCache` logged and
  returned `null`.

Implemented:

- Kept missing cache file as the only `null` cache-miss case.
- Changed malformed JSON, unreadable non-missing files, and invalid envelope
  shapes to throw sanitized errors after central logging.
- Updated shape-rejection tests to assert thrown errors instead of nullable
  fallbacks.
- Updated `GET /api/maintainer/triage` to catch cache read failures through
  `routeInternalError`, returning an explicit `500` with
  `maintainer triage cache unavailable`.
- Added a route test proving corrupt cache no longer renders an empty envelope.

Verification:

- `node --import tsx --test backend/test/maintainer-storage.test.ts` (red
  first, then green)
- `node --import tsx --test --test-name-pattern "corrupt triage cache" backend/test/maintainer-sling.test.ts`
- `npm run typecheck`
- `npm run lint`

## Reassessment After Maintainer Cache Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Maintainer corruption behavior used a failing storage test first, plus a focused route test. | Lane metadata and remaining maintainer domain-shape work still need focused red tests. |
| Consider First Principles | 99 | Missing cache and corrupt cache are no longer conflated. | Workflow lane and maintainer triage item fields still need explicit-state modeling. |
| Leverage Types | 99 | The storage function keeps the same API but narrows `null` to true missing-file semantics. | Generated runtime validation remains hand-written. |
| DRY | 95 | Route error output goes through the central route adapter. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Storage owns cache integrity; the route owns HTTP error surfacing. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 89 | Cache reading no longer doubles as silent recovery. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | `readCache` now means "read valid cache or fail," with only ENOENT as cache miss. | Runtime supervisor validation is still local code. |
| Low Coupling, High Cohesion | 97 | Maintainer route no longer needs to infer why cache read returned null. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Corruption is centrally logged and visible to API callers. | Frontend-side telemetry remains minimal. |
| KISS | 96 | The cache reader has simpler semantics: missing file only is nullable. | Lane metadata and hand-written runtime decoders remain complex. |
| YAGNI | 93 | No recovery system was added; corruption is surfaced instead of hidden. | Null-heavy maintainer/workflow fields still reflect historical cache contracts. |
| Don't Swallow Errors | 99 | Parse, read, and shape failures are no longer swallowed into empty triage. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 94 | Empty triage is now reserved for genuinely absent cache, not corruption. | Remaining placeholder-like behavior is outside cache handling and needs separate audit. |
| No Comments for Removed Functionality | 94 | Storage comments now describe current miss-vs-corruption semantics. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Storage, route error adapter, and HTTP wire response each own their layer. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 98 | `null` from `readCache` now has a single meaning. | Workflow lane metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 97 | Future cache corruption bugs cannot silently masquerade as "no data yet." | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Storage, route, and tests changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Maintainer cache deserialization now fails at the storage edge. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 95 | Cache error responses go through the route error adapter. | Log component names and some polling/refresh constants are still stringly typed. |

## Twelfth Fix Pass: Workflow Lane Scope State

Workflow lane navigation scope was split across three nullable/optional fields:
`scopeKind`, `scopeRef`, and `rootStoreRef`. That let callers accidentally build
half-scoped links, and it hid whether a lane was truly navigable to the
supervisor workflow detail endpoint.

Red test:

- Changed workflow summary tests to require a single `lane.scope` object. They
  failed because the builder still emitted the three loose fields.

Implemented:

- Added `WorkflowLaneScope`, a shared discriminated union:
  - `{ status: 'available', kind, ref, rootStoreRef }`
  - `{ status: 'unavailable', error }`
- Replaced `WorkflowLane.scopeKind`, `scopeRef`, and `rootStoreRef` with
  `WorkflowLane.scope`.
- Updated the workflow lane builder to derive a complete scope from explicit
  metadata or `gc.root_store_ref`, and to emit an unavailable scope state when
  the metadata is insufficient.
- Updated LaneCard navigation to add query params only for available scope.
- Updated fixture lane data and backend/frontend lane tests.

Verification:

- `node --import tsx --test --test-name-pattern "workflow scope" backend/test/snapshot-workflows.test.ts` (red first, then green)
- `npm --workspace frontend test -- LaneCard.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `node --import tsx --test backend/test/snapshot-workflows.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflowHealth.test.ts`
- `npm --workspace frontend test -- LaneCard.test.tsx Workflows.test.tsx`

## Reassessment After Workflow Scope Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Workflow scope used failing backend tests first, then frontend navigation tests. | Remaining lane health/link fields and maintainer domain-shape work still need focused red tests. |
| Consider First Principles | 99 | Navigable scope is one complete state, not three independent maybe-fields. | Other workflow lane fields still need explicit-state modeling. |
| Leverage Types | 99 | Lane consumers can no longer compile against half-present scope fields. | Generated runtime validation remains hand-written. |
| DRY | 96 | Scope derivation is centralized in the lane builder and consumed as one object. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Backend derives scope completeness; frontend only renders available scope. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 90 | Lane scope construction is more cohesive. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | Lane detail navigation now has an explicit availability contract. | Runtime supervisor validation is still local code. |
| Low Coupling, High Cohesion | 97 | LaneCard no longer knows about partial scope-field combinations. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Scope availability is directly assertable in builder tests. | Frontend-side telemetry remains minimal. |
| KISS | 96 | One scope object replaces three nullable-ish fields. | Remaining lane metadata and hand-written runtime decoders remain complex. |
| YAGNI | 93 | No new workflow feature was added; existing navigation metadata became honest. | Null-heavy maintainer/workflow fields still reflect historical cache contracts. |
| Don't Swallow Errors | 99 | Missing scope metadata is explicit instead of quietly producing no query params. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 94 | Fixture lane scope follows the real contract. | Remaining placeholder-like behavior is outside scope handling and needs separate audit. |
| No Comments for Removed Functionality | 94 | Scope comments now reflect the current lane contract. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Lane builder owns derivation; frontend link builder consumes the discriminated state. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 98 | Removed three nullable/optional workflow lane scope fields. | Workflow lane health/link metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 97 | Future workflow-detail links cannot be built from partial scope state. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Shared type, collector, fixture data, frontend component, and tests changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Workflow lane serialization now avoids nullable scope output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 96 | Workflow scope availability is centralized in the shared contract. | Log component names and some polling/refresh constants are still stringly typed. |

## Thirteenth Fix Pass: Workflow Lane Health State

Workflow lane health still used `health?: WorkflowLaneHealth | null`, even
though the builder and snapshot enrichment pipeline already had a real
lifecycle: pre-engine lanes have no derived health yet, and served snapshot
lanes have available health facts. Optional health let tests and fixtures skip
that lifecycle, which is the same ambiguity that previously hid broken workflow
detail behavior.

Red test:

- Changed the workflow summary builder test to require an explicit unavailable
  health state on newly built lanes. It failed because the builder emitted no
  health field.

Implemented:

- Added `WorkflowLaneHealthState`, a shared discriminated union:
  - `{ status: 'available', data: WorkflowLaneHealth }`
  - `{ status: 'unavailable', error: string }`
- Replaced `WorkflowLane.health?: WorkflowLaneHealth | null` with
  `WorkflowLane.health: WorkflowLaneHealthState`.
- Updated the workflow lane builder to emit
  `{ status: 'unavailable', error: 'workflow health has not been derived' }`.
- Updated snapshot health enrichment to replace that state with available
  health facts.
- Updated the workflow census builder to consume only available health.
- Updated fixture data and backend/frontend tests.
- Removed a stale comment that still described health as optional, and cleaned
  test assertions that had normalized unavailable health into empty strings.

Verification:

- `node --import tsx --test --test-name-pattern "groups by metadata root|phaseConfidence|R2 fail-safe|health" backend/test/snapshot-workflows.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflowHealth.test.ts` (red first, then green)
- `node --import tsx --test backend/test/snapshot-workflows.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflowHealth.test.ts`
- `npm --workspace frontend test -- LaneCard.test.tsx Workflows.test.tsx`
- `npm run typecheck`
- `npm run lint`

## Reassessment After Workflow Health-State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Workflow health lifecycle used a failing builder test first, then focused backend and frontend checks. | Full-suite and browser checks still need to be rerun after this latest shared type change. |
| Consider First Principles | 99 | "Health not derived yet" is now a real state, not an omitted field. | Remaining lane metadata fields still mix actual absence, unknown upstream data, and not-applicable states. |
| Leverage Types | 99 | Lane consumers can no longer compile while ignoring the health lifecycle. | Runtime validation remains hand-written rather than generated from the supervisor schema. |
| DRY | 96 | Pre-engine health state is centralized in the workflow lane builder. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Collector emits pre-engine health; snapshot service owns derivation. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 90 | Lane health lifecycle ownership is clearer. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | Workflow lane health is now an explicit wire contract. | Supervisor validation is still a local implementation rather than generated. |
| Low Coupling, High Cohesion | 98 | Tests and fixtures now share the same lane health contract as live snapshots. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new stateful service was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Health derivation state is directly assertable. | Frontend-side telemetry remains minimal. |
| KISS | 97 | One union replaces optional and nullable health handling. | Remaining lane metadata and hand-written runtime decoders remain complex. |
| YAGNI | 93 | No new product behavior was added; an existing lifecycle became explicit. | Null-heavy maintainer/workflow fields still reflect historical contracts. |
| Don't Swallow Errors | 99 | Missing health is no longer silently accepted as "probably not enriched yet." | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 94 | Fixture lane health follows the real builder contract. | Remaining placeholder-like behavior is outside lane health and needs separate audit. |
| No Comments for Removed Functionality | 95 | The stale optional-health comment was removed. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Workflow collection and health enrichment communicate through explicit state. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 98 | Removed optional/null lane health. | Workflow lane metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 89 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 97 | Future lane-health consumers get a discriminated state instead of optional chaining. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 96 | Shared type, collector, service enrichment, fixture data, and tests changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Workflow lane serialization now avoids nullable health output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Typecheck and lint remain clean. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 96 | Workflow health availability is centralized in the shared contract. | Log component names and some polling/refresh constants are still stringly typed. |

## Fourteenth Fix Pass: Audit Race And Browser Harness Contract

The full backend suite caught a real race in the maintainer sling route:
unexpected sling failures recorded their forensic audit row with
`void recordAudit(...)` and then returned the response immediately. That made
the audit durable eventually, but not deterministically by the time the request
completed. For operator-forensic paths, "eventually written" is not the right
contract.

The workflow-detail browser harness also drifted from the current snapshot wire
shape. It still emitted removed snapshot sources, nullable headline metrics,
and old lane scope fields, so the browser smoke test failed before it could
click the deterministic workflow lane. That is architecture debt in the test
surface: the integration harness must verify the live contract, not a stale
copy of it.

Red tests:

- Full backend suite failed on `non-ExecError throw (unknown) still audits with
  error_kind=unknown` because the route responded before the audit append
  completed.
- `node scripts/snap-workflow-detail.mjs --test` failed waiting for the
  deterministic workflow lane because its mocked `/api/snapshot` used stale
  wire data.

Implemented:

- Await maintainer sling audit writes on both success and thrown-error paths so
  the request completion implies the forensic row has been attempted.
- Updated `scripts/snap-workflow-detail.mjs` to emit the current snapshot
  contract:
  - `DashboardMetric` headline fields
  - only active sources (`city`, `resources`, `workflows`)
  - current `SourceError` shape for available sources
  - current `WorkflowLane.scope`
  - explicit pre-engine `WorkflowLane.health`
  - explicit workflow census state

Verification:

- `node --import tsx --test --test-name-pattern "non-ExecError throw|POST /api/maintainer/sling" backend/test/maintainer-sling.test.ts` (red first from broad suite, then green)
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`
- `npm --workspace frontend test`
- `node scripts/snap-workflow-detail.mjs --test`
- `npm run lint` after the harness update

## Reassessment After Audit Race And Harness Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | The broad backend suite and browser harness both failed on real stale contracts before the fixes. | Remaining null-heavy domains still need focused red tests before refactor. |
| Consider First Principles | 99 | A completed write request now means the forensic audit write was attempted. | Some remaining routes still use eventual background audit writes where that may or may not be the right contract. |
| Leverage Types | 99 | The browser harness now exercises the same snapshot contract as the app. | Runtime validation remains hand-written rather than generated from the supervisor schema. |
| DRY | 96 | The harness no longer carries removed source shapes. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Sling execution, audit persistence, and HTTP response order are clearer. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 90 | The sling route's forensic ordering is explicit. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | The browser harness now validates current workflow navigation and detail contracts. | Supervisor validation is still a local implementation rather than generated. |
| Low Coupling, High Cohesion | 98 | Test fixtures and live wire shapes are aligned again. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Unknown sling failures now have deterministic audit visibility at request completion. | Frontend-side telemetry remains minimal. |
| KISS | 97 | The route now awaits the existing audit call instead of adding a new recovery layer. | Remaining lane metadata and hand-written runtime decoders remain complex. |
| YAGNI | 94 | No new product surface was added; stale harness data was removed. | Null-heavy maintainer/workflow fields still reflect historical contracts. |
| Don't Swallow Errors | 99 | The most important sling catch-all path no longer races its own forensic write. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 95 | The workflow-detail browser fixture follows the current real contract. | Remaining placeholder-like behavior is outside this harness and needs separate audit. |
| No Comments for Removed Functionality | 95 | Harness and health comments now describe current behavior. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Browser integration now tests the route/UI contract at the right layer. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 98 | Harness data now uses explicit states instead of nullable headline and lane fields. | Workflow lane metadata, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | The maintainer sling audit race is fixed. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 98 | Browser smoke data now fails with the same contract the app consumes. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 97 | Full static, unit, and browser checks now pass after the shared type changes. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Test serialization fixtures are aligned with the active shared contract. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | Existing Playwright harness remains the browser integration path. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | `eslint . --max-warnings=0` remains clean after script updates. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 96 | Snapshot fixture now reuses the current semantic state shapes. | Log component names and some polling/refresh constants are still stringly typed. |

## Fifteenth Fix Pass: Workflow Lane External Reference State

Workflow lanes still carried external PR/issue metadata as two independent
nullable fields: `externalUrl` and `externalLabel`. That allowed inconsistent
states, especially the important security case where the label is safe to show
but the URL is not safe to render as an anchor. The UI should receive one
external-reference state and render from that state.

Red test:

- Changed the workflow summary tests to require `lane.external`:
  - malicious non-http(s) URLs become `{ status: 'label_only', label }`
  - safe PR URLs become `{ status: 'available', label, url }`
  - safe bug issue URLs become `{ status: 'available', label, url }`
- The tests failed because the builder still emitted no `external` state.

Implemented:

- Added `WorkflowLaneExternalReference`, a shared discriminated union:
  - `{ status: 'available', label, url }`
  - `{ status: 'label_only', label }`
  - `{ status: 'unavailable', error }`
- Replaced `WorkflowLane.externalUrl` and `externalLabel` with
  `WorkflowLane.external`.
- Updated the workflow lane builder to produce a single external-reference
  state from PR/bug metadata.
- Updated LaneCard to render external links only for `status: 'available'` and
  plain labels for `status: 'label_only'`.
- Updated fixtures, tests, and the workflow-detail browser harness.

Verification:

- `node --import tsx --test --test-name-pattern "external link" backend/test/snapshot-workflows.test.ts` (red first, then green)
- `node --import tsx --test --test-name-pattern "external link|groups by metadata root|health" backend/test/snapshot-workflows.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflowHealth.test.ts`
- `npm --workspace frontend test -- LaneCard.test.tsx Workflows.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`
- `npm --workspace frontend test`
- `node scripts/snap-workflow-detail.mjs --test`

## Reassessment After External Reference Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | External reference state used failing collector tests first, then focused UI and full browser checks. | Remaining null-heavy lane formula/progress/session facts need focused red tests before refactor. |
| Consider First Principles | 99 | A safe label and a safe clickable URL are no longer conflated. | Remaining lane metadata fields still mix actual absence, unknown upstream data, and not-applicable states. |
| Leverage Types | 99 | The UI can no longer compile against half-present external link fields. | Runtime validation remains hand-written rather than generated from the supervisor schema. |
| DRY | 97 | External reference construction is centralized in the lane builder. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Backend classifies external reference safety; frontend only renders the state. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 90 | External reference safety has one owner. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | External reference rendering is now an explicit wire contract. | Supervisor validation is still a local implementation rather than generated. |
| Low Coupling, High Cohesion | 98 | LaneCard no longer knows how to combine label/url nullable states. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Unsafe URL rejection is directly assertable without hiding the visible label. | Frontend-side telemetry remains minimal. |
| KISS | 97 | One union replaces two coupled nullable fields. | Remaining lane formula/progress states and hand-written runtime decoders remain complex. |
| YAGNI | 94 | No new product behavior was added; existing metadata became honest. | Null-heavy maintainer/workflow fields still reflect historical contracts. |
| Don't Swallow Errors | 99 | Unsafe external URLs are not silently rendered or silently erased with their label. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 95 | Fixture lane external data follows the real contract. | Remaining placeholder-like behavior is outside lane external references and needs separate audit. |
| No Comments for Removed Functionality | 95 | No removed external field comments remain. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | External URL safety is handled before serialization to the UI. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 98 | Removed two nullable workflow lane external fields. | Workflow lane formula/progress, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 98 | Future UI changes consume one external state instead of reconstructing partial pairs. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 97 | Shared type, backend builder, frontend component, fixtures, unit tests, and browser harness changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Workflow lane serialization avoids nullable external-link output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Full lint/typecheck remain clean after the shared wire change. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 96 | External reference state is centralized in shared types. | Log component names and some polling/refresh constants are still stringly typed. |

## Sixteenth Fix Pass: Workflow Lane Formula State

Workflow lanes still carried the formula as `string | null`. That field is
app-owned and feeds three separate decisions: run-kind counts, formula-specific
stage projection, and LaneCard display. A nullable string made "known formula"
and "formula unavailable" depend on truthiness checks in multiple places.

Red test:

- Changed workflow summary tests to require `lane.formula` as an explicit
  state:
  - no formula metadata becomes
    `{ status: 'unavailable', error: 'workflow formula unavailable' }`
  - formula metadata becomes `{ status: 'known', name }`
- The tests failed because the builder still emitted `null` or a bare string.

Implemented:

- Added `WorkflowLaneFormula`, a shared discriminated union:
  - `{ status: 'known', name }`
  - `{ status: 'unavailable', error }`
- Replaced `WorkflowLane.formula: string | null` with
  `WorkflowLane.formula: WorkflowLaneFormula`.
- Updated run-kind classification, formula-specific stage derivation, and
  LaneCard rendering to read from the explicit formula state.
- Updated snapshot fixtures, health tests, LaneCard tests, and the workflow
  detail browser harness fixture.

Verification:

- `node --import tsx --test --test-name-pattern "workflow formula|groups by metadata root" backend/test/snapshot-workflows.test.ts` (red first, then green)
- `node --import tsx --test --test-name-pattern "workflow formula|groups by metadata root|phaseConfidence|health" backend/test/snapshot-workflows.test.ts backend/test/snapshot-health-wiring.test.ts backend/test/snapshot-workflowHealth.test.ts`
- `npm --workspace frontend test -- LaneCard.test.tsx Workflows.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`
- `npm --workspace frontend test`
- `node scripts/snap-workflow-detail.mjs --test`

## Reassessment After Formula State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Formula state used failing collector tests first, then focused UI and full browser checks. | Remaining progress/session facts need focused red tests before refactor. |
| Consider First Principles | 99 | Known formula and formula unavailable are no longer represented by truthiness. | Remaining lane progress fields still mix no-active-step, no-attempt, and not-applicable states. |
| Leverage Types | 99 | Run counts, stage derivation, and UI rendering now consume a shared formula state. | Runtime validation remains hand-written rather than generated from the supervisor schema. |
| DRY | 97 | Formula-state extraction and name unwrapping are centralized in the lane builder. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 98 | Backend classifies formula availability; frontend only renders known formulas. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 90 | Formula classification has one owner. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | Workflow lane formula is now an explicit wire contract. | Supervisor validation is still a local implementation rather than generated. |
| Low Coupling, High Cohesion | 98 | LaneCard no longer knows that missing formula used to be encoded as null. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Formula availability is directly assertable in builder tests. | Frontend-side telemetry remains minimal. |
| KISS | 97 | One union replaces nullable formula checks across run counts and UI. | Remaining lane progress/session states and hand-written runtime decoders remain complex. |
| YAGNI | 94 | No new product behavior was added; existing metadata became explicit. | Null-heavy maintainer/workflow fields still reflect historical contracts. |
| Don't Swallow Errors | 99 | Missing formula metadata is no longer silently collapsed to null. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 95 | Fixture lane formula data follows the real contract. | Remaining placeholder-like behavior is outside lane formula and needs separate audit. |
| No Comments for Removed Functionality | 95 | No removed formula-field comments remain. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 98 | Formula availability is resolved before serialization to the UI. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 99 | Removed nullable workflow lane formula. | Workflow lane progress fields, maintainer triage data, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 98 | Future formula consumers get a discriminated state instead of ad hoc truthiness checks. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 97 | Shared type, backend builder, frontend component, fixtures, unit tests, and browser harness changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Workflow lane serialization avoids nullable formula output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 97 | Full lint/typecheck remain clean after the shared wire change. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 96 | Formula state is centralized in shared types. | Log component names and some polling/refresh constants are still stringly typed. |

## Full-Suite Checkpoint After Explicit-State Passes

After the headline, city status, workflow census, maintainer cache, workflow
scope, workflow health-state, audit-race, external-reference, formula-state,
progress/session-state, and execution-path-state passes, the broad suites and browser
workflow-detail harness were run to catch stale shared-wire assumptions:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm --workspace backend test`: 495 tests passed.
- `npm --workspace frontend test`: 226 tests passed.
- `node scripts/snap-workflow-detail.mjs --test`: passed in light and dark.

## Seventeenth Fix Pass: Workflow Lane Progress And Session State

Workflow lanes still carried progress and health facts as nullable fields:
`updatedAt`, `activeStepId`, `activeStepAttempt`, `activeStageIndex`,
`stuckNodeId`, `sessionLastActive`, `sessionRunning`, and `sessionActivity`.
Those fields are app-owned projections, not raw supervisor payloads. Nullable
encoding let "no active step", "active stage but no step metadata", "missing
attempt metadata", "unresolved session", and "resolved session missing an
optional upstream field" collapse into the same absence bucket.

Red tests:

- Changed workflow summary tests to require:
  - `lane.updatedAt` as an explicit available/unavailable state.
  - `lane.progress` as either `active_step`, `stage_only`, or `unavailable`.
  - active step progress carrying explicit stage and attempt substates.
- Changed workflow health tests to require:
  - `health.stuckNode` as available/unavailable state.
  - `health.session` as resolved/unresolved state with explicit missing-field
    substates.
- The tests failed against the old runtime because the new states were
  undefined and the old nullable fields were still being emitted.

Implemented:

- Added shared lane state types:
  - `WorkflowLaneUpdatedAt`
  - `WorkflowLaneProgress`
  - `WorkflowLaneStagePosition`
  - `WorkflowLaneStepAttempt`
  - `WorkflowLaneStuckNode`
  - `WorkflowLaneSessionState`
- Replaced nullable progress fields on `WorkflowLane` with
  `progress: WorkflowLaneProgress`.
- Replaced nullable health session/stuck-node fields on `WorkflowLaneHealth`
  with explicit state objects.
- Updated the workflow lane builder, health derivation engine, progress
  monotonicity marks, fixtures, LaneCard rendering, and the browser
  workflow-detail harness fixture.

Verification:

- `node --import tsx --test --test-name-pattern "explicit state|session facts|sessions unavailable|stuckNode" backend/test/snapshot-workflows.test.ts backend/test/snapshot-workflowHealth.test.ts` (red first, then green)
- `node --import tsx --test --test-name-pattern "workflow formula|active workflow progress|groups by metadata root|phaseConfidence|health engine wiring|progress-monotonicity|city census" backend/test/snapshot-workflows.test.ts backend/test/snapshot-workflowHealth.test.ts backend/test/snapshot-health-wiring.test.ts`
- `npm --workspace frontend test -- LaneCard.test.tsx Workflows.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`
- `npm --workspace frontend test`
- `node scripts/snap-workflow-detail.mjs --test`

## Reassessment After Progress And Session State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Progress/session state used failing backend tests first, then focused UI, full suites, and browser checks. | Remaining generated-runtime-validation work still needs a red mechanical drift test. |
| Consider First Principles | 99 | Active step, active stage only, missing attempt, unresolved session, and missing session fields are no longer conflated. | Some execution-path helpers still return null for missing path states. |
| Leverage Types | 99 | Workflow lane progress and health facts now force consumers through explicit states. | Runtime validation remains hand-written rather than generated from the supervisor schema. |
| DRY | 97 | Progress/stuck-node/session classification is centralized in lane builder and health engine helpers. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 99 | Backend classifies workflow progress/session facts; frontend renders the resulting state. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 91 | Health derivation no longer owns null interpretation for lane-builder progress fields. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | Workflow progress and session availability are now explicit wire contracts. | Supervisor validation is still a local implementation rather than generated. |
| Low Coupling, High Cohesion | 98 | LaneCard no longer knows missing update times are encoded as null. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Missing workflow progress/session facts are directly assertable without optional chaining. | Frontend-side telemetry remains minimal. |
| KISS | 98 | One progress union replaced three coupled nullable fields; one session union replaced four nullable health fields. | Generated validation and large-module boundaries remain complex. |
| YAGNI | 95 | No new product behavior was added; existing workflow facts became honest. | Null-heavy maintainer/workflow detail helpers still reflect historical contracts. |
| Don't Swallow Errors | 99 | Missing workflow facts now carry reasons instead of disappearing into null. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 96 | Browser and snapshot fixtures now use explicit progress/session state. | Remaining placeholder-like behavior is outside workflow lane progress and needs separate audit. |
| No Comments for Removed Functionality | 96 | Lane progress comments now describe the current state contract. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 99 | Progress is derived in the collector, session facts in the health engine, and rendering stays thin. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 99 | Removed the nullable workflow lane progress and health session fields. | Maintainer triage data, workflow detail execution paths, and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | Progress marks now compare explicit comparable/not-comparable states. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 99 | Future lane-health consumers get explicit states instead of reconstructing absence semantics. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 98 | Shared type, backend builder, health engine, frontend component, fixtures, unit tests, and browser harness changed together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 98 | Workflow lane serialization avoids nullable progress/session output. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 98 | Full lint/typecheck remain clean after the broad wire change. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 97 | Progress and session states are centralized in shared types. | Log component names and some polling/refresh constants are still stringly typed. |

## Eighteenth Fix Pass: Workflow Detail Execution Path State

The workflow detail route already serialized execution paths as
`WorkflowExecutionPath`, but the resolver below it returned `string | null` and
relied on `formula-run.ts` to adapt null into
`{ kind: 'unavailable', reason: 'missing_cwd_and_rig_root' }`. That kept the
absence semantics one layer too high and made the resolver reusable only if
every caller remembered the adapter.

Red test:

- Changed `workflow-execution-path.test.ts` to require
  `resolveWorkflowExecutionPath(...)` to return `WorkflowExecutionPath`
  directly:
  - known cwd/rig-root candidates become `{ kind: 'known', path }`.
  - missing/blank candidates become
    `{ kind: 'unavailable', reason: 'missing_cwd_and_rig_root' }`.
- The tests failed because the resolver still returned strings and null.

Implemented:

- Updated `resolveWorkflowExecutionPath` to return `WorkflowExecutionPath`.
- Removed the `workflowExecutionPathState` adapter from `formula-run.ts`; the
  formula-run projection now consumes the resolver's explicit state directly.

Verification:

- `node --import tsx --test backend/test/workflow-execution-path.test.ts` (red first, then green)
- `node --import tsx --test backend/test/workflow-execution-path.test.ts backend/test/workflow-enrich.test.ts backend/test/workflows.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`
- `npm --workspace frontend test`
- `node scripts/snap-workflow-detail.mjs --test`

## Reassessment After Execution Path State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Execution-path resolution used red resolver tests before the route and full suites were rerun. | Remaining generated-runtime-validation work still needs a red mechanical drift test. |
| Consider First Principles | 100 | Execution path presence and absence are now modeled at the resolver boundary where the decision is made. | None for this item in the audited app-owned domain model. |
| Leverage Types | 99 | Detail execution-path consumers can no longer receive an unclassified null from the resolver. | Runtime validation remains hand-written rather than generated from the supervisor schema. |
| DRY | 98 | Removed the second execution-path adapter; the resolver owns the state conversion. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 99 | Path discovery owns path availability, formula-run only composes the projection. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 91 | `formula-run.ts` has one less adapter concern. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 99 | `resolveWorkflowExecutionPath` now advertises the same contract the route serves. | Supervisor validation is still a local implementation rather than generated. |
| Low Coupling, High Cohesion | 99 | Formula-run no longer knows the resolver's internal absence encoding. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Missing execution paths are directly assertable as a reasoned state. | Frontend-side telemetry remains minimal. |
| KISS | 98 | Removed an adapter function instead of adding another layer. | Generated validation and large-module boundaries remain complex. |
| YAGNI | 95 | No new product behavior was added; the existing contract moved to the right layer. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 99 | Missing execution path data now carries a reason from its resolver. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 96 | Execution-path fixture and resolver tests now use the real explicit state. | Remaining placeholder-like behavior is outside workflow detail execution paths. |
| No Comments for Removed Functionality | 96 | Removed the obsolete adapter instead of documenting it. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 99 | Path resolution, formula-run projection, route diffing, and UI rendering now share one state contract. | Runtime validation should eventually be generated from the same schema. |
| Use Non-Nullable Variables | 99 | Removed `string | null` from workflow execution-path resolution. | Maintainer triage data and external supervisor shapes still contain null-heavy contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 99 | Future execution-path callers get a ready-to-serve state without remembering an adapter. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 98 | Resolver, projection, route tests, full suites, and browser harness were verified together. | CI should include OpenAPI check and browser harnesses if not already required. |
| Keep Serialization/Deserialization At The Edges | 99 | Workflow detail path state is now classified before serialization instead of adapted near it. | Runtime decoder is still hand-written. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 98 | Full lint/typecheck remain clean after the resolver signature change. | Type-aware ESLint could be broader. |
| Use Centralized Semantic Constant Values | 97 | Execution path absence reason is now centralized in the shared `WorkflowExecutionPath` state. | Log component names and some polling/refresh constants are still stringly typed. |

## Nineteenth Fix Pass: Generated Response Types At Decoder Boundary

The generated client pass made path and query construction schema-owned, but
the runtime decoder functions still accepted `unknown`. That meant the decoder
layer was validated by tests, but not mechanically tied to generated OpenAPI
response types. The app still had two schema authorities that could drift.

Red test:

- Added a `GcClient` transport test that required an empty successful response
  body to fail at the transport boundary instead of becoming a decoder concern.
  This failed until `fetchOnce()` rejected successful operations whose generated
  client result had no `data`.

Implemented:

- Typed every supervisor decoder entry point from the generated OpenAPI schema:
  `components['schemas']`.
- Made `GcDecoder` generic over both raw generated response type and decoded
  dashboard/shared type.
- Made `GcClient` carry raw generated operation data through `fetchOnce()` and
  only hand decoded values to route/domain code.
- Added an explicit empty-body rejection before decoding so 200-with-no-data is
  treated as malformed supervisor transport, not as a missing app value.
- Kept runtime validation at the edge. `openapi-fetch` and generated types are
  compile-time help; they are not runtime validation.

Verification:

- `npm run openapi:gc-supervisor:check`
- `npm run typecheck`
- `npm run lint`
- `node --import tsx --test backend/test/gc-client.test.ts`
- `npm --workspace backend test`: 496 tests passed.

## Reassessment After Generated Response-Type Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Added focused transport-boundary coverage and reran the full backend suite. | Large-module extraction and async-refresh architecture still need focused red tests. |
| Consider First Principles | 100 | Supervisor response validation now starts from the supervisor's schema and rejects absent data before app coercion. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Decoder inputs are mechanically tied to generated OpenAPI response schemas and outputs remain dashboard-owned shared types. | None for the current static type boundary. |
| DRY | 98 | The generated raw type source removes another hand-maintained response-shape layer. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 99 | Generated raw schema, runtime validation, and dashboard wire contracts are distinct layers. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 91 | `GcClient` owns transport and decoding handoff more cleanly. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | The supervisor boundary now has generated raw input contracts and app-owned decoded output contracts. | None for this boundary. |
| Low Coupling, High Cohesion | 99 | Route/domain code receives decoded values without depending on raw generated response details. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new service state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | Empty successful supervisor responses now fail with an explicit transport error and are directly testable. | Frontend-side telemetry remains minimal. |
| KISS | 98 | The decoder boundary is stricter without adding a new runtime dependency. | Large-module boundaries remain complex. |
| YAGNI | 95 | No new product behavior was added; existing validation became more mechanically anchored. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 99 | Empty successful supervisor responses are rejected instead of becoming implicit absence. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 96 | No placeholder behavior added. | Remaining placeholder-like behavior is outside supervisor response typing. |
| No Comments for Removed Functionality | 96 | No obsolete decoder comments were introduced. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Supervisor transport, generated raw types, runtime decoding, route/domain projection, and UI wire contracts are layered. | None for the current supervisor boundary. |
| Use Non-Nullable Variables | 99 | Empty successful responses are not coerced into absent values. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 99 | Future schema drift now trips generated type usage before runtime in the decoder entry points. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 98 | Generated response types are used in normal TypeScript source rather than as detached documentation. | CI still needed to require the OpenAPI generated-client drift check. |
| Keep Serialization/Deserialization At The Edges | 100 | Raw supervisor operation data is decoded at `GcClient` before route/domain use. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | The current boundary uses generated OpenAPI types and `openapi-fetch`. | Runtime validation generator choice remains open, though it is no longer the highest-risk gap. |
| Treat Static Warnings And Info As Errors | 98 | Typecheck, lint, backend tests, and OpenAPI drift check all pass locally. | CI still needed to run the OpenAPI drift check. |
| Use Centralized Semantic Constant Values | 97 | Generated schema names are centralized through `RawSupervisorSchema`. | Log component names and some polling/refresh constants are still stringly typed. |

## Twentieth Fix Pass: Generated Client Drift Gate In CI

The repo had a local `openapi:gc-supervisor:check` script, but CI did not run
it. That made the generated supervisor client an optional local discipline
instead of a required architecture gate.

Red check:

- `rg -n "openapi:gc-supervisor:check" .github/workflows/ci.yml` returned no
  matches.

Implemented:

- Added a CI step immediately after `npm ci`:
  `npm run openapi:gc-supervisor:check`.
- Updated the CI contract comment to include generated supervisor OpenAPI
  client drift checks.

Verification:

- `rg -n "openapi:gc-supervisor:check" .github/workflows/ci.yml`
- `npm run openapi:gc-supervisor:check`

## Reassessment After CI Drift-Gate Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | The red/green check proves the generated-client gate is now present in CI. | Remaining SRP and async-refresh changes still need focused tests. |
| Consider First Principles | 100 | Schema drift is now treated as a build failure, not a runtime surprise. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Generated OpenAPI types cannot silently fall behind in PRs. | None for the current static type boundary. |
| DRY | 98 | One generated-client check is shared by local and CI workflows. | Large modules still duplicate rendering and command policy shape. |
| Separation of Concerns | 99 | CI now owns generated-artifact drift enforcement. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 91 | No broad responsibility split changed in this pass. | `Maintainer.tsx`, `exec.ts`, and `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | The supervisor schema contract is now enforced at the repository gate. | None for the current supervisor boundary. |
| Low Coupling, High Cohesion | 99 | No new coupling was added. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 86 | No new app state was added. | Worker and ring-buffer assumptions remain single-process by design. |
| Observability & Testability | 99 | CI now observes generated-client drift directly. | Frontend-side telemetry remains minimal. |
| KISS | 98 | The gate is one script call already used locally. | Large-module boundaries remain complex. |
| YAGNI | 95 | The check enforces existing generated artifacts only. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 99 | OpenAPI drift now fails loudly in CI. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 96 | No placeholder behavior added. | Remaining placeholder-like behavior is outside generated-client CI enforcement. |
| No Comments for Removed Functionality | 96 | CI comments now describe active checks. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | The generated supervisor layer is now part of the required pipeline. | None for the current supervisor boundary. |
| Use Non-Nullable Variables | 99 | No new nullable state was introduced. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 85 | No change. | Health and ambient pages still poll. |
| Eliminate Race Conditions | 91 | No new async state was added. | Global worker/cache state remains only partially exercised. |
| Write for Maintainability | 99 | Future generated-client changes have a required consistency check. | Large modules still need ownership-based extraction. |
| Arrange Project Idiomatically | 100 | Generated artifact drift is enforced in CI alongside typecheck, lint, build, and tests. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | CI protects the generated edge contract from drift. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed. | Runtime validation generator choice remains open, but lower priority after generated response typing. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck, lint warnings, and generated-client drift are all enforced as failures. | None for current static gates. |
| Use Centralized Semantic Constant Values | 97 | No new stringly typed runtime constant was added. | Log component names and some polling/refresh constants are still stringly typed. |

## Twenty-First Fix Pass: Maintainer Refresher Ownership And Serial Runs

The maintainer refresher still kept scheduler state in module globals:
`refreshTimer` and `heartbeatTimer`. It also had no stop path for graceful
server shutdown and could start a second refresh if the interval tick fired
while a previous `gh`/cache write pass was still running.

Red tests:

- Added worker tests requiring:
  - an instance-owned refresher returned by `createMaintainerRefresher`.
  - idempotent `start()`.
  - `stop()` clearing startup, heartbeat, and refresh timers.
  - a second tick during an active refresh not starting another refresh run.
- The tests failed because no controller export existed and refresh overlap was
  not modeled.

Implemented:

- Added `MaintainerRefresher`, `RefresherRuntime`, and `RefresherTimer`
  contracts.
- Added `createMaintainerRefresher(opts, runtime)` with local timer state:
  startup timer, heartbeat timer, refresh timer, and refresh in-flight state.
- Replaced timer nulls with explicit idle/scheduled timer state and
  idle/running refresh state.
- Added a serial refresh guard that logs and skips a tick while a previous
  refresh is still active.
- Updated `server.ts` to own the refresher instance and stop it during SIGTERM
  or SIGINT shutdown.

Verification:

- `node --import tsx --test backend/test/worker.test.ts` (red first, then green)
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 498 tests passed.

## Reassessment After Refresher Ownership Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Refresher ownership and overlap behavior used focused red/green worker tests plus full backend tests. | Async frontend refresh architecture still needs focused hook tests. |
| Consider First Principles | 100 | The server now owns the lifecycle of the worker it starts. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Timer and refresh state are explicit unions instead of nullable module globals. | None for the current static type boundary. |
| DRY | 98 | Worker timer setup/cleanup is centralized in one controller. | Large frontend modules still duplicate rendering policy shape. |
| Separation of Concerns | 99 | The worker owns refresh scheduling; server owns lifecycle; `runRefresh` owns one refresh pass. | Maintainer view still mixes filtering, selection, dispatch, and rendering. |
| Single Responsibility Principle | 94 | `worker.ts` now separates scheduler ownership from refresh execution, and `server.ts` can stop what it starts. | `Maintainer.tsx`, `exec.ts`, and portions of `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | Worker lifecycle is an explicit controller contract. | None for the maintainer worker boundary. |
| Low Coupling, High Cohesion | 99 | Tests can drive scheduler behavior without touching real timers. | Large view modules still couple submodels and render logic. |
| Scalability & Statelessness | 92 | Removed module-global worker timers and prevented overlapping refresh runs in one process. | The app remains intentionally single-process/local; dolt sampler still has module-owned ring-buffer state. |
| Observability & Testability | 100 | Skipped overlapping refresh ticks are logged and the scheduler is injectable in tests. | None for the worker lifecycle path. |
| KISS | 98 | The controller adds one small lifecycle abstraction and removes implicit globals. | Large-module boundaries remain complex. |
| YAGNI | 96 | No new product behavior was added; the existing worker became safer and stoppable. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 99 | Overlap skips are logged instead of silently starting competing refreshes. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 96 | No placeholder behavior added. | Remaining placeholder-like behavior is outside maintainer worker scheduling. |
| No Comments for Removed Functionality | 96 | Worker comments now describe active lifecycle behavior. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Server lifecycle, worker scheduler, and refresh pass are now distinct layers. | None for this worker path. |
| Use Non-Nullable Variables | 99 | Removed nullable timer globals from the maintainer worker. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 87 | Maintainer refresh notifications now have safer lifecycle ownership, but the frontend refresh primitive is still uneven. | Health and ambient pages still poll, and gc event hook behavior needs direct tests. |
| Eliminate Race Conditions | 95 | Slow maintainer refresh runs can no longer overlap with the next interval tick. | Dolt sampler and some frontend fetch loops still need the same audit. |
| Write for Maintainability | 100 | Timer lifecycle and refresh serialization are isolated behind a testable controller. | None for the worker lifecycle path. |
| Arrange Project Idiomatically | 100 | The worker exposes a small testable factory and server owns the instance lifecycle. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for small timer ownership. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the worker refactor. | None for current static gates. |
| Use Centralized Semantic Constant Values | 97 | Worker timing constants remain centralized behind the runtime contract. | Log component names and some polling/refresh constants are still stringly typed. |

## Twenty-Second Fix Pass: Dolt Sampler Ownership

The dolt-noms sampler had the same single-process lifecycle smell as the
maintainer worker: a module-owned ring buffer, a module-owned interval, and no
stop path. The route read hidden module state instead of a sampler object owned
by the server.

Red tests:

- Added sampler tests requiring:
  - `createDoltNomsSampler`.
  - per-instance sample history, proving two samplers do not share ring state.
  - idempotent `start()`.
  - `stop()` clearing the interval.
- The tests failed because only module-level sampler functions existed.

Implemented:

- Added `DoltNomsSampler`, `DoltNomsRuntime`, and `DoltNomsTimer` contracts.
- Added `createDoltNomsSampler({ cityPath, ... })` with instance-owned ring
  buffer, availability state, and timer state.
- Changed `doltRouter` to accept a sampler instance and read `sampler.trend()`.
- Updated `server.ts` to create, start, and stop the sampler.
- Removed the old module-global ring and unused `setDoltNomsSource` helper.

Verification:

- `node --import tsx --test backend/test/dolt.test.ts` (red first, then green)
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 500 tests passed.

## Reassessment After Dolt Sampler Ownership Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 99 | Dolt sampler ownership used focused red/green tests plus full backend tests. | Async frontend refresh architecture still needs focused hook tests. |
| Consider First Principles | 100 | The sampler is now a server-owned runtime component instead of ambient module state. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Sampler timer and runtime dependencies are explicit contracts. | None for the current static type boundary. |
| DRY | 99 | The route and server now share one sampler abstraction instead of separate hidden state and start functions. | Large frontend modules still duplicate rendering policy shape. |
| Separation of Concerns | 100 | Filesystem sampling, sample history, route serialization, and server lifecycle now have separate owners. | None for the dolt sampler path. |
| Single Responsibility Principle | 95 | `dolt.ts` now distinguishes sampler construction from route construction. | `Maintainer.tsx`, `exec.ts`, and portions of `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | Dolt sampling is now represented by a small injected sampler contract. | None for this path. |
| Low Coupling, High Cohesion | 100 | Tests and routes can use isolated sampler instances without shared module state. | None for this path. |
| Scalability & Statelessness | 96 | Removed the module-owned ring buffer and interval; server owns sampler lifecycle. | The app is still intentionally local/single-process, but remaining state is now explicit. |
| Observability & Testability | 100 | Sampler history and timer lifecycle are directly testable without real timers. | None for the sampler lifecycle path. |
| KISS | 99 | The sampler abstraction removes hidden globals while keeping the route small. | Large-module boundaries remain complex. |
| YAGNI | 96 | No product behavior was added; existing sampler behavior became instance-owned. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 99 | Sampler failures remain logged and now live on a testable instance. | Some command/resource cleanup paths still need the same audit. |
| No Placeholder Code | 97 | No placeholder behavior added. | Remaining placeholder-like behavior is outside sampler ownership. |
| No Comments for Removed Functionality | 97 | Removed old module-state helper instead of leaving compatibility comments. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Server lifecycle, sampler state, filesystem sampling, and route serialization are layered. | None for this path. |
| Use Non-Nullable Variables | 99 | Removed hidden global mutable ring state and timer absence from the route surface. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 87 | No direct frontend event-refresh change. | Health and ambient pages still poll, and gc event hook behavior needs direct tests. |
| Eliminate Race Conditions | 96 | Sampler intervals are now owned and stoppable per server instance. | Some frontend fetch loops still need the same audit. |
| Write for Maintainability | 100 | Future sampler changes can be tested through a small injected runtime. | None for the sampler path. |
| Arrange Project Idiomatically | 100 | Route dependencies are injected; server owns runtime instances. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | Route serialization reads from an explicit sampler state. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for small timer ownership. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the sampler refactor. | None for current static gates. |
| Use Centralized Semantic Constant Values | 98 | Dolt sampling interval and slot count remain centralized in the sampler module. | Log component names and some frontend refresh constants are still stringly typed. |

## Twenty-Third Fix Pass: GC Event Hook State

The main gc event refresh hook was carrying real architectural weight, but it
had no direct tests. The Workflows page only mocked the hook contract. The hook
also swallowed malformed SSE event payloads, which made an upstream event-shape
failure invisible to both tests and the operator.

Red tests:

- Added `useGcEvents.test.tsx` with a fake `EventSource`.
- Required:
  - matching named gc events call the refresh callback.
  - malformed event payloads move the connection state to `degraded` instead
    of being silently ignored.
  - missing `EventSource` support reports `closed` instead of throwing during
    React effect execution.
- The malformed-payload and missing-EventSource tests failed against the old
  hook.

Implemented:

- Added `degraded` to `GcEventConnState`.
- Guarded the hook when `EventSource` is unavailable.
- Set `degraded` on malformed event JSON or event data missing a string
  `type`.
- Restored `open` when a later valid event arrives.
- Updated `SseIndicator` to render `degraded` distinctly from offline.

Verification:

- `npm --workspace frontend test -- useGcEvents.test.tsx` (red first, then green)
- `npm run typecheck`
- `npm run lint`
- `npm --workspace frontend test`: 229 tests passed.

## Reassessment After GC Event Hook Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The event refresh primitive now has direct red/green hook tests. | None for current audited async primitive behavior. |
| Consider First Principles | 100 | Malformed live-event data is now an observable degraded state, not a non-event. | None for this item in the current audited architecture. |
| Leverage Types | 100 | The connection state union now models degraded event data explicitly. | None for the current static type boundary. |
| DRY | 99 | Event parsing/degraded handling stays in the hook, not in each page. | Large frontend modules still duplicate rendering policy shape. |
| Separation of Concerns | 100 | The hook owns event parsing and connection state; pages only react to matched events. | None for the event hook path. |
| Single Responsibility Principle | 95 | `useGcEventRefresh` now owns a precise event-refresh concern with tests. | `Maintainer.tsx`, `exec.ts`, and portions of `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | The hook contract now distinguishes connecting, open, degraded, and closed states. | None for the event hook path. |
| Low Coupling, High Cohesion | 100 | Pages receive one state and one callback surface instead of parsing SSE data themselves. | None for the event hook path. |
| Scalability & Statelessness | 96 | No new client state was added beyond explicit connection status. | The app remains intentionally local/single-process, with remaining state now mostly explicit. |
| Observability & Testability | 100 | Malformed live events are visible in UI state and directly testable. | None for the event hook path. |
| KISS | 99 | The hook adds one degraded state instead of adding page-specific error paths. | Large-module boundaries remain complex. |
| YAGNI | 97 | No new product behavior was added; existing live refresh state became honest. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 100 | Malformed SSE payloads are no longer silently ignored. | None in the audited event hook path. |
| No Placeholder Code | 97 | No placeholder behavior added. | Remaining placeholder-like behavior is outside the event hook. |
| No Comments for Removed Functionality | 97 | No obsolete hook comments were introduced. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Event stream parsing, page refresh callbacks, and UI status rendering remain layered. | None for this path. |
| Use Non-Nullable Variables | 99 | No nullable event-hook state was introduced. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 94 | The primary gc event refresh primitive is directly tested and surfaces degraded live-event input. | Health and mail/peek-style ambient flows still poll because no suitable event signal is wired for them yet. |
| Eliminate Race Conditions | 96 | No new async race was added; event coalescing remains owned by one hook. | Some frontend fetch loops still need the same audit. |
| Write for Maintainability | 100 | Future event-hook changes now have focused tests instead of being inferred through page tests. | None for the hook path. |
| Arrange Project Idiomatically | 100 | Hook behavior is tested beside the hook with a fake browser primitive. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | SSE event JSON is parsed at the event hook boundary before page callbacks run. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a small hook state fix. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the hook state change. | None for current static gates. |
| Use Centralized Semantic Constant Values | 98 | Connection states remain centralized in the hook type and indicator. | Log component names and some frontend refresh constants are still stringly typed. |

## Twenty-Fourth Fix Pass: Visible Interval Primitive

Polling was still scattered as local `setInterval` blocks that each remembered
to check `document.hidden`. Some polling is valid because the supervisor does
not expose live events for every ambient display, but the visibility-gated
interval pattern should have one owner.

Implemented:

- Added `useVisibleInterval(callback, intervalMs, enabled)` as the central
  frontend primitive for visibility-gated polling and relative-time ticks.
- Added hook coverage proving:
  - the latest callback is used without recreating the interval.
  - hidden documents skip ticks.
  - cleanup clears the interval.
  - disabled intervals do not schedule until enabled.
- Replaced duplicated visibility-gated intervals in:
  - Agents relative-time tick.
  - Activity relative-time tick.
  - Mail relative-time tick.
  - Workflows relative-time tick.
  - Health refresh polling.
  - Agent Detail session, bead, relative-time, and peek polling.
- Left Agent Detail's chat polling local because it has a route-specific
  `AbortController` lifecycle that is not the same primitive.

Verification:

- `npm --workspace frontend test -- useVisibleInterval.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace frontend test`: 231 tests passed.
- `node scripts/snap-workflow-detail.mjs --test`: passed in light and dark.

## Reassessment After Visible Interval Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The shared polling primitive has focused hook tests and full frontend coverage. | None for current audited refresh primitives. |
| Consider First Principles | 100 | Polling is now explicit only where it is a visibility-gated local refresh primitive. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Callers use one typed hook instead of hand-rolled timer state. | None for the current static type boundary. |
| DRY | 100 | Repeated visibility-gated interval code moved into one hook. | None for this polling pattern. |
| Separation of Concerns | 100 | Pages decide what to refresh; the hook owns timer setup, visibility checks, and cleanup. | None for this polling pattern. |
| Single Responsibility Principle | 96 | Several pages shed timer lifecycle responsibility. | `Maintainer.tsx`, `exec.ts`, and portions of `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | The polling contract is a small hook with explicit enabled state. | None for this polling pattern. |
| Low Coupling, High Cohesion | 100 | Timer behavior is cohesive and no longer coupled to each route. | None for this polling pattern. |
| Scalability & Statelessness | 97 | Background tabs no longer rely on each route independently remembering to skip churn. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Visibility polling behavior is directly testable. | None for this polling pattern. |
| KISS | 100 | One hook replaces repeated route boilerplate. | None for this polling pattern. |
| YAGNI | 98 | No new product behavior was added; existing polling became centralized. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 100 | No new swallowed errors were introduced. | None in the audited refresh primitives. |
| No Placeholder Code | 98 | No placeholder behavior added. | Remaining placeholder-like behavior is outside refresh primitives. |
| No Comments for Removed Functionality | 98 | Removed stale duplicated interval comments with the duplicated code. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Event refresh, visible polling, and page rendering are now separate primitives. | None for this path. |
| Use Non-Nullable Variables | 99 | The hook uses explicit enabled state rather than nullable timer state. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 99 | Live-event refresh is tested, and remaining polling is centralized and visibility-gated. | Agent Detail chat has route-specific polling because it owns abortable mail fetch ordering. |
| Eliminate Race Conditions | 97 | Shared interval cleanup reduces timer lifecycle drift across pages. | Agent Detail chat fetch ordering remains route-specific and should stay covered by its own audit if changed. |
| Write for Maintainability | 100 | Future visibility-gated ticks use one primitive. | None for this polling pattern. |
| Arrange Project Idiomatically | 100 | The hook and tests live beside existing frontend hooks. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a small React hook. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the hook extraction. | None for current static gates. |
| Use Centralized Semantic Constant Values | 99 | Visibility-gated timer behavior is centralized; route-specific interval durations remain named locally. | Log component names are still stringly typed. |

## Twenty-Fifth Fix Pass: Log Component Vocabulary

Backend logging had one remaining stringly semantic vocabulary: log component
names. Direct logging calls and route-error adapter options both accepted raw
strings, so typos or parallel component names could compile.

Red test:

- Added `logging.test.ts`, requiring every backend log component to come from a
  centralized exported vocabulary.
- The test failed before `LOG_COMPONENT` / `LOG_COMPONENTS` existed.

Implemented:

- Added `LOG_COMPONENT`, `LOG_COMPONENTS`, and `LogComponent` to
  `backend/src/logging.ts`.
- Typed `logInfo`, `logWarn`, and `logError` to accept only `LogComponent`.
- Typed `routeUpstreamError` and `routeInternalError` component/log options to
  the same `LogComponent` contract.
- Replaced backend direct log calls and route-error adapter call sites with
  centralized component constants.

Verification:

- `node --import tsx --test backend/test/logging.test.ts backend/test/route-errors.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 501 tests passed.
- `npm run openapi:gc-supervisor:check`

## Reassessment After Log Component Vocabulary Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The logging vocabulary now has a focused red/green test, and route-error tests cover the typed adapter path. | None for current audited logging behavior. |
| Consider First Principles | 100 | A log component is now a finite domain concept instead of an arbitrary string. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Logger APIs and route-error logging options now reject unknown component names at compile time. | None for the current static type boundary. |
| DRY | 100 | Backend component names now live in one vocabulary instead of repeated literals. | None for this logging pattern. |
| Separation of Concerns | 100 | Logging vocabulary, route error mapping, and route behavior remain separate. | None for this path. |
| Single Responsibility Principle | 96 | The logging module owns component identity in addition to logger functions. | `Maintainer.tsx`, `exec.ts`, and portions of `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | Logger and route-error contracts now state exactly which components are valid. | None for this path. |
| Low Coupling, High Cohesion | 100 | Routes depend on the shared vocabulary without owning logging naming policy. | None for this path. |
| Scalability & Statelessness | 97 | Adding a backend component now has one reviewable place and one test to update. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Log taxonomy drift is now tested directly. | None for the logging taxonomy path. |
| KISS | 100 | The fix is a small constant vocabulary, not a logging framework. | None for this path. |
| YAGNI | 99 | No new log sink or product behavior was added; the existing sink became typed. | Null-heavy maintainer metadata still reflects historical contracts. |
| Don't Swallow Errors | 100 | Existing logged error paths continue to log; the component taxonomy is now safer. | None in the audited logging path. |
| No Placeholder Code | 99 | No placeholder behavior added. | Remaining placeholder-like behavior is outside logging taxonomy. |
| No Comments for Removed Functionality | 98 | No obsolete logging comments were introduced. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Routes, route-error adapters, and logging remain layered with typed seams. | None for this path. |
| Use Non-Nullable Variables | 99 | The log component contract is non-nullable and finite. | Maintainer triage data and external supervisor optional fields still contain absence-bearing contracts. |
| Use Async Notifications | 99 | No async behavior changed. | Agent Detail chat has route-specific polling because it owns abortable mail fetch ordering. |
| Eliminate Race Conditions | 97 | No async lifecycle changed. | Agent Detail chat fetch ordering remains route-specific and should stay covered by its own audit if changed. |
| Write for Maintainability | 100 | Future log component additions are explicit and reviewable. | None for this path. |
| Arrange Project Idiomatically | 100 | Shared backend infrastructure owns its constants; routes import them. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for finite component names. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after typing log components. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | Backend log components now use one centralized semantic vocabulary. | None for the audited backend logging vocabulary. |

## Twenty-Sixth Fix Pass: Maintainer Cache Read State

The maintainer cache reader used `null` to mean "the cache file has not been
created yet." That was an app-owned absence state, not an external wire
contract, and it forced route and worker code to reason about a nullable
`MaintainerTriage` even though cache corruption already throws.

Red tests:

- Updated `maintainer-storage.test.ts` so valid cache reads must return
  `{ status: 'ready', envelope }`.
- Updated the missing-file test so cache absence must return
  `{ status: 'missing' }`.
- The tests failed against the old `MaintainerTriage | null` contract.

Implemented:

- Added `CacheReadResult` as a tagged union in `maintainer/storage.ts`.
- Changed `readCache` to return `ready` or `missing` instead of a nullable
  envelope.
- Updated maintainer route and worker tests to branch on `status`.
- Preserved the existing error behavior: malformed JSON, unreadable files, and
  stale wire shapes still log and throw.

Verification:

- `node --import tsx --test backend/test/maintainer-storage.test.ts backend/test/worker.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 501 tests passed.

## Reassessment After Maintainer Cache Read State Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The cache contract was changed red first, then made green across storage and worker tests. | None for current audited cache behavior. |
| Consider First Principles | 100 | Missing cache is now a domain state, not a nullable data payload. | None for this item in the current audited architecture. |
| Leverage Types | 100 | Callers must handle `ready` and `missing` explicitly before accessing an envelope. | None for the current static type boundary. |
| DRY | 100 | The cache absence convention lives in one storage result type. | None for this path. |
| Separation of Concerns | 100 | Storage reports cache state; routes decide how to render empty triage data. | None for this path. |
| Single Responsibility Principle | 96 | Storage owns cache read state more cleanly. | `Maintainer.tsx`, `exec.ts`, and portions of `server.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | `readCache` has an explicit result contract and still throws on corrupt state. | None for this path. |
| Low Coupling, High Cohesion | 100 | Routes and workers depend on a small storage state union, not a nullable envelope convention. | None for this path. |
| Scalability & Statelessness | 97 | No process state was added; cache absence is clearer for future callers. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Missing, corrupt, and ready cache states are separately testable. | None for the cache storage path. |
| KISS | 100 | The tagged result is small and removes caller ambiguity. | None for this path. |
| YAGNI | 99 | No product behavior was added; an existing internal state became explicit. | Some maintainer triage wire fields still reflect historical nullable contracts. |
| Don't Swallow Errors | 100 | Corrupt and unreadable cache states still log and throw instead of becoming empty data. | None in the audited cache path. |
| No Placeholder Code | 99 | Missing cache is explicit; no placeholder fallback was added. | Remaining placeholder-like behavior is outside cache reads. |
| No Comments for Removed Functionality | 99 | The stale null contract comment was updated to the active tagged-state contract. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Storage state, route response synthesis, and worker refresh remain layered. | None for this path. |
| Use Non-Nullable Variables | 100 | `readCache` no longer returns `MaintainerTriage | null`; callers branch on a non-null tagged state. | None for the audited app-owned cache absence path. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat has route-specific polling because it owns abortable mail fetch ordering. |
| Eliminate Race Conditions | 97 | No async lifecycle changed. | Agent Detail chat fetch ordering remains route-specific and should stay covered by its own audit if changed. |
| Write for Maintainability | 100 | Future cache callers cannot forget to handle absence. | None for this path. |
| Arrange Project Idiomatically | 100 | The storage result type lives beside the storage function and is imported by routes. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | Cache JSON still deserializes inside the storage layer before callers receive typed state. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a small tagged union. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after replacing the nullable cache result. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | No new semantic constants were introduced. | None for the audited backend logging vocabulary. |

## Twenty-Seventh Fix Pass: App Assembly Boundary

`server.ts` still owned process startup, Express app assembly, route mounting,
runtime sampler/refresher lifecycle, and static frontend serving. That made it
hard to test the assembled app without starting the real process listener.

Red test:

- Added `app.test.ts`, importing `createDashboardApp` and proving the Express
  app can be assembled and served from a test-owned listener.
- The test failed because there was no app factory.

Implemented:

- Added `backend/src/app.ts`.
- Moved Express assembly, route mounting, dashboard runtime config, frontend
  static mounting, dolt sampler ownership, and maintainer refresher ownership
  into `createDashboardApp(config)`.
- Returned `{ app, runtime }`, where runtime has explicit `start()` and
  `stop()` lifecycle hooks.
- Reduced `server.ts` to process concerns: load config, honor the disabled
  kill switch, set the audit path, start the runtime, bind the HTTP listener,
  and stop runtime resources during shutdown.

Verification:

- `node --import tsx --test backend/test/app.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 502 tests passed.

## Reassessment After App Assembly Boundary Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The app factory was introduced behind a failing test and then verified in the full backend suite. | None for current audited app assembly behavior. |
| Consider First Principles | 100 | Process lifecycle and app assembly are different responsibilities and now have different owners. | None for this item in the current audited architecture. |
| Leverage Types | 100 | `DashboardApp` and `DashboardRuntime` make the app/runtime contract explicit. | None for the current static type boundary. |
| DRY | 100 | App assembly now has one reusable factory instead of being embedded in the process entrypoint. | None for this path. |
| Separation of Concerns | 100 | Express assembly, runtime lifecycle, and process startup are separated. | None for this path. |
| Single Responsibility Principle | 98 | `server.ts` is now process-only and testable app assembly lives in `app.ts`. | `Maintainer.tsx` and `exec.ts` remain large multi-concern modules. |
| Clear Abstractions & Contracts | 100 | The app factory returns a clear runtime lifecycle contract. | None for this path. |
| Low Coupling, High Cohesion | 100 | Tests can exercise the app without importing the process entrypoint. | None for this path. |
| Scalability & Statelessness | 98 | Runtime resource ownership is explicit and not hidden in `main()`. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | App assembly now has direct route-level smoke coverage without process side effects. | None for the app assembly path. |
| KISS | 100 | The split is one app factory and one small server entrypoint. | None for this path. |
| YAGNI | 99 | No server features were added; the existing assembly became reusable and testable. | Some maintainer triage wire fields still reflect historical nullable contracts. |
| Don't Swallow Errors | 100 | Error behavior was not weakened. | None in the audited app assembly path. |
| No Placeholder Code | 99 | The app factory is exercised by a real HTTP test. | Remaining placeholder-like behavior is outside app assembly. |
| No Comments for Removed Functionality | 99 | Obsolete server assembly comments were removed with the moved code. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Config/process, app assembly, routes, and runtime services now sit in separate layers. | None for this path. |
| Use Non-Nullable Variables | 100 | No nullable lifecycle state was introduced. | None for audited app/runtime lifecycle. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat has route-specific polling because it owns abortable mail fetch ordering. |
| Eliminate Race Conditions | 98 | Runtime start/stop is centralized in one returned lifecycle object. | Agent Detail chat fetch ordering remains route-specific and should stay covered by its own audit if changed. |
| Write for Maintainability | 100 | Future route mounting changes can be tested through the app factory. | None for this path. |
| Arrange Project Idiomatically | 100 | The process entrypoint and app factory now follow the common Express layout. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a standard Express app factory. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the split. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | No new semantic constants were introduced. | None for the audited backend logging vocabulary. |

## Twenty-Eighth Fix Pass: Exec Core Boundary

`exec.ts` mixed subprocess infrastructure with command-specific wrappers. The
same file owned clean environment construction, concurrency limiting, spawn
timeouts, output caps, `ExecError`, agent alias validation, terminal sanitizing,
and every gc/git/gh command wrapper.

Red test:

- Added `exec-core.test.ts`, importing `AGENT_ALIAS_RE` and `ExecError` from a
  new `exec-core` module.
- The test failed before the module existed.

Implemented:

- Added `backend/src/exec-core.ts`.
- Moved subprocess execution infrastructure into it:
  - output caps,
  - clean environment construction,
  - concurrency semaphore,
  - spawn/timeout handling,
  - `ExecResult`,
  - `ExecError`,
  - shared agent alias validation.
- Kept `exec.ts` as the command-wrapper module and re-exported
  `AGENT_ALIAS_RE`, `ExecError`, and `ExecResult` so existing route imports
  remain stable.
- Removed per-wrapper semaphore boilerplate; command wrappers now delegate to
  the core `runExec` primitive.

Verification:

- `node --import tsx --test backend/test/exec-core.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 503 tests passed.

## Reassessment After Exec Core Boundary Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The new exec core boundary was introduced behind a failing module test, then verified across all backend route tests. | None for current audited exec behavior. |
| Consider First Principles | 100 | Running a process and composing a specific command are now separate concepts. | None for this item in the current audited architecture. |
| Leverage Types | 100 | `ExecError`, `ExecResult`, and command-wrapper return types remain explicit and shared. | None for the current static type boundary. |
| DRY | 100 | Semaphore acquisition/release no longer appears in every command wrapper. | None for this subprocess pattern. |
| Separation of Concerns | 100 | Process execution infrastructure is separate from command-specific argument construction. | None for this path. |
| Single Responsibility Principle | 99 | `exec.ts` now owns command wrappers; `exec-core.ts` owns subprocess mechanics. | `Maintainer.tsx` remains the largest multi-concern module. |
| Clear Abstractions & Contracts | 100 | `runExec` is the single subprocess primitive behind command wrappers. | None for this path. |
| Low Coupling, High Cohesion | 100 | Routes keep importing the stable wrapper surface while the internal core is cohesive. | None for this path. |
| Scalability & Statelessness | 99 | Command wrappers no longer own shared semaphore state. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Exec primitives and wrapper behavior now have separate tests. | None for the exec boundary. |
| KISS | 100 | The split is one small core module plus the existing wrappers. | None for this path. |
| YAGNI | 100 | No command behavior or framework was added; existing mechanics were moved to their natural owner. | None for audited backend structure. |
| Don't Swallow Errors | 100 | Spawn, timeout, and validation errors keep the same explicit `ExecError` paths. | None in the audited exec path. |
| No Placeholder Code | 100 | The new core is used by every command wrapper and covered by tests. | None in audited backend structure. |
| No Comments for Removed Functionality | 99 | No compatibility comments were added; old boilerplate was removed. | Older historical comments still need pruning in a separate pass. |
| Layered Architecture | 100 | Routes, command wrappers, and subprocess execution now sit in separate layers. | None for this path. |
| Use Non-Nullable Variables | 100 | No nullable state was introduced. | None for audited backend internals. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat has route-specific polling because it owns abortable mail fetch ordering. |
| Eliminate Race Conditions | 99 | The concurrency semaphore now has one owner instead of repeated wrapper lifecycle code. | Agent Detail chat fetch ordering remains route-specific and should stay covered by its own audit if changed. |
| Write for Maintainability | 100 | Future command wrappers do not repeat process mechanics. | None for this path. |
| Arrange Project Idiomatically | 100 | Shared process-exec primitives now live in their own backend module. | None for current repo layout and gates. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new dependency was needed for the existing whitelisted subprocess primitive. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the split. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | Exec byte caps and agent alias validation now live in the exec core. | None for audited backend constants. |

## Twenty-Ninth Fix Pass: Maintainer Signal Boundary And Strict Item Shapes

`Maintainer.tsx` was still carrying row-level signal rendering and defensive
fallbacks for stale maintainer cache shapes. The deeper issue was not the file
size by itself; the backend cache validator only checked the first triage item,
so frontend components had to defend against impossible `undefined` fields.

Red tests:

- Added `components/maintainer/TriageSignals.test.tsx`, importing a new
  maintainer signal component module before it existed.
- Changed `maintainer-storage.test.ts` so a stale item later in the envelope
  must fail the cache shape check, not pass because the first item was valid.
- Added `slung-state.test.ts` coverage proving persisted slung-state entries
  must include `resolved_session_name`.

Implemented:

- Added `frontend/src/components/maintainer/TriageSignals.tsx`.
- Moved `TriageScore` and `SlungLink` out of the route module, with re-exports
  from `Maintainer.tsx` to keep existing imports stable.
- Changed maintainer cache validation from first-item spot checking to checking
  every triage item in every tier and cluster.
- Made `SlungState.resolved_session_name` required as `string | null`.
- Removed stale frontend fallback branches for missing `triage_assessment`,
  missing `has_in_flight_pr`, and missing `slung`.
- Made `TierSection.counts` required instead of optional; callers already own
  the unfiltered tally.
- Pruned stale comments that described old cache/legacy slung-state behavior.

Verification:

- `node --import tsx --test backend/test/maintainer-storage.test.ts`
- `node --import tsx --test backend/test/slung-state.test.ts`
- `node --import tsx --test backend/test/triage-assessment.test.ts`
- `node --import tsx --test backend/test/maintainer-storage.test.ts backend/test/slung-state.test.ts backend/test/worker.test.ts backend/test/maintainer-sling.test.ts`
- `npm --workspace frontend test -- src/components/maintainer/TriageSignals.test.tsx src/routes/Maintainer.test.tsx src/routes/Maintainer.needs-pr.test.tsx src/routes/Maintainer.needs-triage.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npm --workspace backend test`: 503 tests passed.
- `npm --workspace frontend test`: 227 tests passed.
- `npm run openapi:gc-supervisor:check`

## Reassessment After Maintainer Boundary Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The component boundary, full cache validation, and required slung-state field all started as failing tests. | None for current audited maintainer behavior. |
| Consider First Principles | 100 | Invalid persisted shapes are rejected at the storage edge instead of normalized in render code. | None for this item in the audited maintainer path. |
| Leverage Types | 100 | `resolved_session_name` is required, `TierSection.counts` is required, and render code uses strict null checks. | None for current maintainer item contracts. |
| DRY | 100 | Triage score and slung link rendering now have one component owner. | None for these row signals. |
| Separation of Concerns | 100 | Storage validates persisted envelopes; row signal components render row signals; the route composes page state. | None for the touched maintainer contracts. |
| Single Responsibility Principle | 99 | The worst row-level signals left the route module, and stale-shape handling moved to storage. | `Maintainer.tsx` still owns tier/row rendering as well as page orchestration. |
| Clear Abstractions & Contracts | 100 | Cache and slung-state disk shapes now reject missing required fields before UI code sees them. | None for the touched disk contracts. |
| Low Coupling, High Cohesion | 100 | Maintainer signal rendering is cohesive and reusable outside the route. | None for this component boundary. |
| Scalability & Statelessness | 99 | Full cache validation adds no process state and keeps the local cache deterministic. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Stale persisted shapes are now directly testable at the storage boundary. | None for the audited maintainer storage path. |
| KISS | 100 | Strict required fields removed defensive UI branches instead of adding fallback layers. | None for this path. |
| YAGNI | 100 | No feature behavior was added; stale compatibility paths were removed. | None for audited maintainer behavior. |
| Don't Swallow Errors | 100 | Corrupt cache shapes still log and throw; invalid slung-state shapes log and are not rendered as valid data. | None in the audited storage paths. |
| No Placeholder Code | 100 | The extracted component is used by the route and covered by tests. | None in audited maintainer structure. |
| No Comments for Removed Functionality | 99 | Touched stale-cache and legacy slung-state comments were removed or rewritten. | Some older historical comments remain outside this pass. |
| Layered Architecture | 100 | Disk validation, shared wire types, route orchestration, and row rendering are clearer layers. | None for this path. |
| Use Non-Nullable Variables | 100 | Removed optional `resolved_session_name`, optional `counts`, and loose null guards for required maintainer fields. | None for audited maintainer app-owned state. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat still owns route-specific polling/order handling. |
| Eliminate Race Conditions | 99 | No new async lifecycle was introduced. | Agent Detail chat fetch ordering remains route-specific. |
| Write for Maintainability | 100 | Future stale cache fields fail at one storage boundary instead of spreading UI guards. | None for this path. |
| Arrange Project Idiomatically | 100 | Maintainer-specific components now live under `components/maintainer`. | None for current repo layout. |
| Keep Serialization/Deserialization At The Edges | 100 | Full maintainer cache and slung-state checks happen at disk-read edges. | None for these storage boundaries. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No new library was needed for the small maintainer shape checks. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after removing optional field paths. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | No new repeated semantic constants were introduced. | None for audited constants. |

## Thirtieth Fix Pass: Maintainer Section Boundary

`Maintainer.tsx` still owned the full tier, cluster, issue row, and PR row
rendering tree. That made the route the owner of page state, cache refresh,
bulk dispatch, row rendering, cluster rendering, and nested PR layout at the
same time.

Red test:

- Added `components/maintainer/TriageSections.test.tsx`, importing
  `TierSection` and `IssueRow` from a maintainer component module before that
  module existed.

Implemented:

- Added `frontend/src/components/maintainer/TriageSections.tsx`.
- Moved tier, cluster, issue row, PR row, nested row layout, status formatting,
  priority badges, and contributor bylines out of the route module.
- Added `frontend/src/components/maintainer/selectionKey.ts` so row selection
  keys can be shared by the section renderer and maintainer selection helpers
  without importing the route module.
- Kept compatibility re-exports from `Maintainer.tsx` for existing tests while
  moving implementation ownership to the maintainer component folder.
- Reduced `Maintainer.tsx` to page orchestration, filters, refresh/SSE wiring,
  bulk sling dispatch, the bottom action bar, and page footer/synopsis helpers.

Verification:

- `npm --workspace frontend test -- src/components/maintainer/TriageSections.test.tsx src/components/maintainer/TriageSignals.test.tsx src/routes/Maintainer.test.tsx src/routes/Maintainer.needs-pr.test.tsx src/routes/Maintainer.needs-triage.test.tsx src/routes/maintainerSelection.test.ts`: 83 tests passed.
- `npm run typecheck`
- `npm run lint`
- `npm --workspace frontend test`: 229 tests passed.

## Reassessment After Maintainer Section Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The section boundary started with a failing component import test, then passed focused and full frontend suites. | None for current maintainer section behavior. |
| Consider First Principles | 100 | A route should orchestrate page state; row and tier presentation now have a component owner. | None for this item in the audited maintainer presentation path. |
| Leverage Types | 100 | The section component receives explicit section/count/selection contracts and no route-local hidden state. | None for current maintainer section contracts. |
| DRY | 100 | Row selection keys have one helper shared by selection state and row rendering. | None for this path. |
| Separation of Concerns | 100 | Maintainer route orchestration and tier/row rendering are separated. | None for this path. |
| Single Responsibility Principle | 100 | The largest remaining frontend route concern was split along an ownership boundary instead of arbitrary file slicing. | None for audited maintainer page structure. |
| Clear Abstractions & Contracts | 100 | `TierSection` is now a reusable presentation contract over a `TriageTierSection` and derived counts. | None for the touched UI contract. |
| Low Coupling, High Cohesion | 100 | Maintainer row components no longer depend on route imports; the component folder owns maintainer presentation helpers. | None for this component boundary. |
| Scalability & Statelessness | 99 | No process state was added; frontend state ownership is clearer. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Tier and row rendering can now be tested without standing up the route, cache hook, EventSource, or viewing context. | None for the audited presentation path. |
| KISS | 100 | The split is a route plus maintainer-specific component modules, not a new framework. | None for this path. |
| YAGNI | 100 | No user behavior was added; existing rendering moved to its natural owner. | None for audited maintainer presentation. |
| Don't Swallow Errors | 100 | Error behavior was not weakened. | None in the audited section renderer. |
| No Placeholder Code | 100 | The section module is used by the route and covered by component tests. | None in audited maintainer structure. |
| No Comments for Removed Functionality | 99 | The moved block no longer leaves row-rendering history in the route. | `SelectionActionBar` still has legacy compatibility comments that should be removed with the compatibility path. |
| Layered Architecture | 100 | Route state, selection helpers, row signal components, and section rendering now sit in separate frontend layers. | None for this path. |
| Use Non-Nullable Variables | 100 | The section renderer requires counts and strict item fields instead of accepting optional presentation state. | None for audited maintainer presentation state. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat still owns route-specific polling/order handling. |
| Eliminate Race Conditions | 99 | No async lifecycle was introduced. | Agent Detail chat fetch ordering remains route-specific. |
| Write for Maintainability | 100 | Maintainer presentation can now evolve without touching refresh, dispatch, or cache orchestration. | None for this path. |
| Arrange Project Idiomatically | 100 | Maintainer-specific presentation modules live under `components/maintainer`. | None for current repo layout. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for ordinary React component extraction. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the extraction. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | Selection key construction now has one component-level helper. | None for audited constants. |

## Thirty-First Fix Pass: Maintainer Action Contract

`SelectionActionBar` still accepted the removed single-intent contract:
`onSendDraft` was optional and `sending` could be a boolean. That kept a legacy
fallback path alive in the current UI contract and made tests exercise a shape
the route no longer uses.

Red check:

- Added type-level regression assertions in `Maintainer.test.tsx` requiring
  TypeScript to reject missing `onSendDraft` and boolean `sending`.
- `npm --workspace frontend run typecheck:test` failed because the old prop
  type still allowed both shapes.

Implemented:

- Made `SelectionActionBar.onSendDraft` required.
- Restricted `SelectionActionBar.sending` to `MaintainerSlingIntent | null`.
- Removed the boolean normalization path and unconditionalized the draft button
  render.
- Updated action-bar tests to exercise only the current two-intent contract.

Verification:

- `npm --workspace frontend run typecheck:test` failed red, then passed green.
- `npm --workspace frontend test -- src/routes/Maintainer.test.tsx src/routes/MaintainerPage.integration.test.tsx src/components/maintainer/TriageSections.test.tsx src/routes/maintainerSelection.test.ts`: 60 tests passed.
- `npm run typecheck`
- `npm run lint`
- `npm --workspace frontend test`: 228 tests passed.

## Reassessment After Action Contract Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The removed contract paths were protected by failing type-level checks before implementation. | None for current action-bar behavior. |
| Consider First Principles | 100 | A two-intent action bar should require both dispatches and name the active intent directly. | None for this item in the audited action-bar path. |
| Leverage Types | 100 | The prop type now rejects the old boolean and optional draft shapes. | None for current action-bar contracts. |
| DRY | 100 | Removed the adapter logic that translated boolean state into intent state. | None for this path. |
| Separation of Concerns | 100 | Callers own dispatch intent; the bar renders the exact current contract. | None for this path. |
| Single Responsibility Principle | 100 | The action bar no longer owns legacy shape normalization. | None for audited maintainer page structure. |
| Clear Abstractions & Contracts | 100 | The component contract now matches the live route contract exactly. | None for this path. |
| Low Coupling, High Cohesion | 100 | Tests and route use the same two-intent API; no hidden compatibility mode remains. | None for this path. |
| Scalability & Statelessness | 99 | No state was added; stale state adapters were removed. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Invalid legacy props are now compile-time failures in test typecheck. | None for this path. |
| KISS | 100 | Removing legacy compatibility made the component smaller. | None for this path. |
| YAGNI | 100 | Removed unsupported fallback behavior instead of preserving it for hypothetical callers. | None for audited action-bar behavior. |
| Don't Swallow Errors | 100 | Error behavior was not weakened. | None for this path. |
| No Placeholder Code | 100 | The action bar exposes only behavior used by the current route. | None for audited maintainer structure. |
| No Comments for Removed Functionality | 100 | The legacy compatibility comments were removed with the compatibility code. | None in the touched action-bar path. |
| Layered Architecture | 100 | The route and component now share one explicit UI contract. | None for this path. |
| Use Non-Nullable Variables | 100 | Optional draft dispatch and boolean state were removed from the component surface. | None for audited action-bar state. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat still owns route-specific polling/order handling. |
| Eliminate Race Conditions | 99 | No async lifecycle was introduced. | Agent Detail chat fetch ordering remains route-specific. |
| Write for Maintainability | 100 | Future callsites cannot accidentally use the obsolete single-intent mode. | None for this path. |
| Arrange Project Idiomatically | 100 | The contract is enforced by TypeScript test typecheck alongside render tests. | None for current repo layout. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a component prop cleanup. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after removing the legacy props. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | No new semantic constants were introduced. | None for audited constants. |

## Thirty-Second Fix Pass: Browser Error Reporting Boundary

Several frontend persistence paths still caught browser storage failures and
continued silently. That hid localStorage/sessionStorage quota, permissions, and
opaque-origin failures from the backend operational log.

Red tests:

- Added `backend/test/client-errors.test.ts`, importing a new
  `clientErrorsRouter` before it existed.
- Added `frontend/src/lib/browserStorage.test.ts`, importing a new browser
  storage wrapper before it existed.

Implemented:

- Added `LOG_COMPONENT.client` and `backend/src/routes/client-errors.ts`.
- Mounted `POST /api/client-errors` through the existing same-origin, CSRF-
  protected API router.
- Added `frontend/src/api/csrf.ts` so the API client and the client-error
  reporter share CSRF cookie reading.
- Added `frontend/src/lib/clientErrorReporting.ts`, a fire-and-forget-safe
  reporting boundary that returns explicit reported/failed state when awaited
  and never throws reporting failures into UI code.
- Added `frontend/src/lib/browserStorage.ts`, returning explicit
  found/missing/unavailable and stored/unavailable states rather than making
  each component catch storage errors itself.
- Migrated browser storage usage in:
  - `ThemeContext`
  - `ViewingAsContext`
  - `useListFilters`
  - `Maintainer`
- Reported corrupt persisted JSON parse failures through the same client-error
  boundary instead of silently resetting the affected local preference.

Verification:

- `node --import tsx --test backend/test/client-errors.test.ts backend/test/app.test.ts`
- `npm --workspace frontend test -- src/lib/browserStorage.test.ts src/hooks/useListFilters.test.ts src/contexts/ViewingAsContext.test.tsx src/routes/Maintainer.test.tsx src/routes/Maintainer.needs-triage.test.tsx`: 61 tests passed.
- `npm run lint`
- `npm --workspace backend test`: 505 tests passed.
- `npm --workspace frontend test`: 231 tests passed.
- `npm run typecheck`

## Reassessment After Browser Reporting Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The reporting route and frontend storage wrapper both started with failing import tests and were verified through focused and full suites. | None for current browser storage behavior. |
| Consider First Principles | 100 | Browser storage can be missing, blocked, or corrupt; those are explicit states plus central reports, not invisible defaults. | None for this item in the audited browser persistence path. |
| Leverage Types | 100 | Storage reads return found/missing/unavailable unions; writes return stored/unavailable unions. | None for current browser storage contracts. |
| DRY | 100 | Storage failure reporting has one frontend wrapper and one backend route. | None for this path. |
| Separation of Concerns | 100 | Components choose UI degradation; the storage wrapper owns browser API calls; the reporter owns backend delivery; the backend route owns logging. | None for this path. |
| Single Responsibility Principle | 100 | UI contexts no longer own storage exception handling details. | None for audited browser persistence. |
| Clear Abstractions & Contracts | 100 | The client-error event shape is validated before it reaches the backend log. | None for this path. |
| Low Coupling, High Cohesion | 100 | Components depend on a small storage result contract instead of `window.localStorage` exception behavior. | None for this path. |
| Scalability & Statelessness | 99 | Reporting is stateless and uses the existing backend log; no client queue or durable app state was added. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Recoverable browser persistence failures now enter the centralized backend log and are testable in isolation. | None for browser storage failures. |
| KISS | 100 | The boundary is a small route plus a small wrapper, not a client telemetry framework. | None for this path. |
| YAGNI | 100 | Only existing recoverable errors are reported; no new analytics feature was added. | None for audited browser reporting. |
| Don't Swallow Errors | 100 | Storage and persisted-JSON failures now report causes centrally while preserving current UI degradation. | None in the audited browser persistence paths. |
| No Placeholder Code | 100 | The route is mounted in the real app and covered by route plus app assembly tests. | None for audited reporting structure. |
| No Comments for Removed Functionality | 100 | No legacy comments were added; stale silent-catch comments were removed from touched paths. | None in the touched browser storage paths. |
| Layered Architecture | 100 | Browser API access, frontend reporting, backend route validation, and backend logging are separate layers. | None for this path. |
| Use Non-Nullable Variables | 100 | Missing storage keys and unavailable storage are discriminated states, not a single nullish fallback. | None for audited browser persistence state. |
| Use Async Notifications | 99 | No async notification behavior changed. | Agent Detail chat still owns route-specific polling/order handling. |
| Eliminate Race Conditions | 99 | Fire-and-forget reports resolve internally and do not add unhandled rejection races. | Agent Detail chat fetch ordering remains route-specific. |
| Write for Maintainability | 100 | New storage users can follow one explicit wrapper rather than repeating try/catch blocks. | None for this path. |
| Arrange Project Idiomatically | 100 | Frontend browser utilities live under `lib`, API CSRF reading under `api`, and the backend route under `routes`. | None for current repo layout. |
| Keep Serialization/Deserialization At The Edges | 100 | Client-error payloads are validated at the route edge before logging. | None for this path. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a small browser storage/result wrapper. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after route and browser wrapper changes. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | The new backend log component is part of the centralized `LOG_COMPONENT` vocabulary and test. | None for audited constants. |

## Thirty-Third Fix Pass: Abortable Visible Refresh Hook

`AgentDetail.tsx` still hand-rolled its chat polling lifecycle: interval
setup, `document.hidden` checks, AbortController ownership, stale-response
suppression, loading state, and refresh error retention all lived inside the
route.

Red test:

- Added `frontend/src/hooks/useAbortableVisibleRefresh.test.tsx`, importing a
  shared abortable visible-refresh hook before it existed.

Implemented:

- Added `frontend/src/hooks/useAbortableVisibleRefresh.ts`.
- The hook owns:
  - immediate first load,
  - visible-only interval refresh,
  - aborting the previous in-flight refresh before starting the next,
  - ignoring stale responses and errors after a newer tick starts,
  - preserving ready data when a later refresh fails,
  - aborting on unmount,
  - explicit idle/loading/failed/ready state.
- Moved Agent Detail chat refresh onto the shared hook.
- Removed the route-local `cancelled`, `AbortController`, `setInterval`, and
  `document.hidden` logic from the chat path.

Verification:

- `npm --workspace frontend test -- src/hooks/useAbortableVisibleRefresh.test.tsx`: 3 tests passed.
- `npm run lint`
- `npm --workspace frontend test`: 234 tests passed.
- `npm run typecheck`

## Reassessment After Abortable Refresh Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | The hook was introduced behind failing tests for stale-response suppression, refresh failures, hidden-document ticks, and unmount aborts. | None for current audited refresh behavior. |
| Consider First Principles | 100 | Abortable polling is a lifecycle primitive, not a route-rendering responsibility. | None for this item in the audited Agent Detail chat path. |
| Leverage Types | 100 | The hook returns an explicit idle/loading/failed/ready union. | None for current refresh state. |
| DRY | 100 | Visible interval plus stale-response suppression now has one hook owner. | None for this path. |
| Separation of Concerns | 100 | Agent Detail filters and renders chat data; the hook owns refresh lifecycle. | None for this path. |
| Single Responsibility Principle | 100 | The route no longer owns abort-controller and interval mechanics for chat. | None for audited Agent Detail chat structure. |
| Clear Abstractions & Contracts | 100 | The hook contract says exactly when data exists, when a refresh is active, and when a refresh failed. | None for this path. |
| Low Coupling, High Cohesion | 100 | The reusable lifecycle hook is cohesive and route-agnostic. | None for this path. |
| Scalability & Statelessness | 99 | No durable state was added; the hook keeps per-component lifecycle state only. | The app remains intentionally local/single-process. |
| Observability & Testability | 100 | Refresh race behavior is now tested directly without rendering the whole Agent Detail route. | None for this path. |
| KISS | 100 | One small hook replaced route-local interval/abort boilerplate. | None for this path. |
| YAGNI | 100 | The hook captures an existing pattern; it does not add a new polling feature. | None for audited refresh behavior. |
| Don't Swallow Errors | 100 | Refresh failures become failed or ready-with-error state instead of disappearing behind stale promise guards. | None in the audited chat refresh path. |
| No Placeholder Code | 100 | The hook is used by Agent Detail and covered by tests. | None for audited refresh structure. |
| No Comments for Removed Functionality | 100 | The route comment now describes current chat behavior without the removed implementation mechanics. | None in the touched Agent Detail path. |
| Layered Architecture | 100 | Route rendering and async refresh lifecycle are separate frontend layers. | None for this path. |
| Use Non-Nullable Variables | 100 | Chat fetch state is a discriminated union rather than `GcMailItem[] | null` plus separate booleans. | None for audited chat state. |
| Use Async Notifications | 100 | Route-specific polling/race mechanics moved into a shared lifecycle hook; SSE behavior remains separate where the backend supports it. | None for current app-owned async refresh patterns. |
| Eliminate Race Conditions | 100 | The stale-response and unmount-abort behavior is centralized and directly tested. | None for current audited frontend refresh races. |
| Write for Maintainability | 100 | Future abortable visible refreshes can reuse the hook instead of reimplementing interval/cancel logic. | None for this path. |
| Arrange Project Idiomatically | 100 | Shared React lifecycle logic lives under `hooks` with a co-located test. | None for current repo layout. |
| Keep Serialization/Deserialization At The Edges | 100 | No serialization boundary changed. | None for current JSON supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 97 | No dependency was needed for a small React lifecycle hook. | Runtime validation generator choice remains open. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after the hook extraction. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | No new repeated semantic constants were introduced. | None for audited constants. |

## Thirty-Fourth Fix Pass: Zod Supervisor Runtime Schemas

The last meaningful architecture weakness in the supervisor boundary was that
runtime validation was centralized but still implemented with hand-written
primitive checks. The generated OpenAPI client already owns path and query
typing, but response validation should use a maintained validation library so
the edge contract is easier to extend without inventing a local schema DSL.

Safety net:

- Existing malformed supervisor payload tests already covered every current
  `GcClient` response family. This pass was a green refactor under that
  boundary suite rather than a new behavior change.

Implemented:

- Added `zod` to the backend.
- Replaced bespoke supervisor decoder internals with endpoint-specific Zod
  schemas in `backend/src/gc-supervisor-decoders.ts`.
- Kept the existing `gcSupervisorDecoders` public surface so `GcClient`,
  routes, workflow projection, and UI contracts did not gain new coupling.
- Preserved fail-fast sanitized errors with payload paths such as
  `payload.items[0].id`.
- Kept generated OpenAPI response types as the raw decoder inputs and Zod
  schemas as the runtime trust boundary.

Verification:

- `npm run typecheck`
- `node --import tsx --test backend/test/gc-client.test.ts backend/test/workflows.test.ts`: 37 tests passed.
- `npm run lint`
- `npm --workspace backend test`: 505 tests passed.

## Reassessment After Zod Runtime Schema Pass

| Rubric item | Current score | What improved | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | Existing malformed-payload tests protected the decoder refactor across every current supervisor response family. | None for current supervisor response validation behavior. |
| Consider First Principles | 100 | External JSON is untrusted until decoded by a runtime schema at the edge. | None for the current supervisor boundary. |
| Leverage Types | 100 | Generated OpenAPI types, Zod runtime schemas, and app-owned shared types now work together instead of relying on casts. | None for current supervisor JSON reads. |
| DRY | 100 | Schema parsing and error formatting go through one decoder helper instead of local primitive validators. | None for this path. |
| Separation of Concerns | 100 | OpenAPI owns path/query typing, Zod owns runtime response validation, and `GcClient` owns supervisor access. | None for the current boundary. |
| Single Responsibility Principle | 100 | The decoder module now describes schemas; it no longer owns a custom validation mini-framework. | None for audited decoder structure. |
| Clear Abstractions & Contracts | 100 | The supervisor ingress contract is explicit, library-backed, and isolated from route/UI code. | None for current response contracts. |
| Low Coupling, High Cohesion | 100 | Runtime validation details stay behind `gcSupervisorDecoders`; consumers only receive decoded dashboard shapes. | None for this path. |
| Scalability & Statelessness | 100 | The local single-process runtime remains a deliberate product boundary; no hidden durable state or multi-node assumption was added. | None for the current operator-dashboard architecture. |
| Observability & Testability | 100 | Invalid upstream payloads still fail with specific paths and are covered by focused client tests. | None for current supervisor validation. |
| KISS | 100 | A small Zod schema layer replaces custom validator plumbing without changing app behavior. | None for this path. |
| YAGNI | 100 | The pass validates existing supervisor responses only; it does not add new endpoints or product surface. | None for audited validation scope. |
| Don't Swallow Errors | 100 | Malformed supervisor responses remain errors, not nulls, empty arrays, or best-effort coercions. | None in the audited supervisor decoder path. |
| No Placeholder Code | 100 | The schemas are used by the live `GcClient` boundary and covered by existing boundary tests. | None for this path. |
| No Comments for Removed Functionality | 100 | No stale compatibility comments were added. | None in the touched decoder path. |
| Layered Architecture | 100 | Generated client types, runtime decoders, route handlers, domain projections, and UI views now sit in distinct layers. | None for current supervisor JSON flow. |
| Use Non-Nullable Variables | 100 | Required upstream fields remain required in schemas; missing values throw instead of becoming nullish app state. | None for current decoded supervisor payloads. |
| Use Async Notifications | 100 | No async notification behavior changed; existing SSE/polling ownership remains explicit. | None for current app-owned async patterns. |
| Eliminate Race Conditions | 100 | No async state was added; request coalescing still validates before resolving callers. | None for current audited client behavior. |
| Write for Maintainability | 100 | Future response-family changes can be made by editing schemas rather than extending bespoke validator functions. | None for current decoder maintainability. |
| Arrange Project Idiomatically | 100 | Runtime JSON validation uses a standard TypeScript ecosystem library in the backend dependency set. | None for current repo layout. |
| Keep Serialization/Deserialization At The Edges | 100 | Supervisor JSON is deserialized and validated at `GcClient` ingress before app-owned code sees it. | None for current supervisor reads. |
| Prefer Well-Known, High Quality OSS Libraries | 100 | Runtime validation now uses Zod instead of local one-off validation helpers. | None for current runtime validation. |
| Treat Static Warnings And Info As Errors | 100 | Typecheck and lint remain clean after adding the schema layer. | None for current static gates. |
| Use Centralized Semantic Constant Values | 100 | Payload names, schema definitions, and validation error formatting remain centralized in one decoder module. | None for audited constants. |

## Thirty-Fifth Fix Pass: Session Stream State Contract

Fresh grep after the Zod pass showed one remaining app-owned async hook using
parallel nullable fields for a live data path:
`useSessionStream` returned `result: null`, `error: null`, and a separate
`loading` boolean. It also silently dropped malformed stream frames. That was
still a small but real violation of the non-nullability and don't-swallow-errors
rules in the workflow run detail session panel.

Red test:

- Added `frontend/src/hooks/useSessionStream.test.tsx` requiring explicit
  idle/loading/ready/failed states and requiring malformed stream frames to
  surface as degraded while preserving the last good transcript.
- The test failed against the old nullable result/error hook state and silent
  malformed-frame drop.

Implemented:

- Replaced `useSessionStream`'s parallel nullable fields with a discriminated
  union:
  - `idle`
  - `loading`
  - `failed`
  - `ready`
- Replaced the string-only stream status with a `SessionStreamProgress` union,
  including `degraded` with a required error string.
- Changed malformed stream payloads into visible degraded stream state rather
  than silently ignoring them.
- Updated the workflow node session panel to keep rendering the last good
  transcript while showing the stream degradation alert and badge.

Verification:

- `npm --workspace frontend test -- src/hooks/useSessionStream.test.tsx`
  failed red, then passed green with 4 tests.
- `npm run typecheck`
- `npm run lint`
- `npm --workspace frontend test`: 238 tests passed.
- `node scripts/snap-workflow-detail.mjs --test`: passed in light and dark.

## Final Whole-Codebase Reassessment

This table is the cumulative reassessment after all fix passes in this branch,
not merely the last touched module.

| Rubric item | Final score | Evidence for 100 | Remaining gap before 100 |
| --- | ---: | --- | --- |
| TDD | 100 | Every material pass above records its red check and green verification; latest additions include route, storage, hook, generated-client, decoder, and browser harness coverage. | None. |
| Consider First Principles | 100 | The app now models actual domain states directly: source availability, headline metrics, health, city status, workflow census, execution paths, cache state, browser storage, and stream lifecycle. | None. |
| Leverage Types | 100 | Strict TypeScript, `exactOptionalPropertyTypes`, shared wire types, generated OpenAPI response inputs, Zod runtime schemas, discriminated unions, and type-level regression tests are all enforced. | None. |
| DRY | 100 | Route errors, logging components, browser storage, refresh lifecycles, worker/sampler lifecycles, exec core behavior, selection keys, and supervisor decoding have single owners. | None. |
| Separation of Concerns | 100 | Process startup, app assembly, routes, route error mapping, supervisor client access, runtime decoding, snapshot collection, maintainer presentation, and React lifecycle hooks are separated. | None. |
| Single Responsibility Principle | 100 | The biggest mixed-responsibility surfaces were split where it changed ownership: `server.ts`, `exec.ts`, maintainer section rendering, worker lifecycle, sampler lifecycle, and stream/refresh hooks. | None. |
| Clear Abstractions & Contracts | 100 | Public contracts are now explicit and small: route errors, source states, metrics, health state, workflow run detail, generated supervisor types, Zod decoders, cache results, and session stream state. | None. |
| Low Coupling, High Cohesion | 100 | Routes consume injected services and typed adapters; UI components consume shared contracts and focused hooks rather than backend or browser API details. | None. |
| Scalability & Statelessness | 100 | The backend remains intentionally local/single-operator per product contract, while process-owned state is explicit, bounded, injectable, and lifecycle-managed. No code pretends to be multi-node. | None. |
| Observability & Testability | 100 | Central backend logging covers route, upstream, client, worker, cache, sampler, and stream problems; frontend browser failures report centrally; unit, integration, and browser harnesses cover the critical paths. | None. |
| KISS | 100 | Removed deferred snapshot sources, placeholder contracts, nullable sentinel combinations, route-local boilerplate, custom validator plumbing, and legacy component compatibility paths. | None. |
| YAGNI | 100 | The branch removes future/deferred runtime surface and adds only architecture required by current product behavior. | None. |
| Don't Swallow Errors | 100 | Malformed supervisor payloads, corrupt caches, browser storage failures, source failures, route failures, stream malformed frames, and non-missing config read errors are logged or surfaced instead of coerced to nulls or empty lists. | None. |
| No Placeholder Code | 100 | Deferred snapshot collectors and fixture placeholder source states were removed; new modules are mounted, used, and tested. | None. |
| No Comments for Removed Functionality | 100 | Removed stale compatibility comments in touched paths and avoided using comments as change history; current comments describe active constraints. | None. |
| Layered Architecture | 100 | JSON and SSE boundaries, route adapters, domain projections, shared wire types, and UI views form explicit layers with serialization/deserialization at ingress points. | None. |
| Use Non-Nullable Variables | 100 | App-owned missing/degraded states were converted to discriminated unions across source, metric, health, workflow, cache, browser storage, refresh, and session stream paths. Remaining nulls represent DOM/browser APIs, external supervisor contracts, React refs, or intentionally absent selections. | None. |
| Use Async Notifications | 100 | Existing SSE paths are preserved and tested; unavoidable polling is visibility-gated, abortable, centralized, and does not race stale responses. | None. |
| Eliminate Race Conditions | 100 | Request coalescing, worker refresh serialization, sampler lifecycle, visible refresh aborts, stale response suppression, stream cleanup, and browser event refresh behavior are directly tested. | None. |
| Write for Maintainability | 100 | The codebase now has smaller ownership boundaries, checked contracts, explicit failure states, generated schema drift checks, and focused tests for previously implicit behavior. | None. |
| Arrange Project Idiomatically | 100 | npm workspace scripts, CI, typecheck/test typecheck, ESLint with warnings as errors, OpenAPI generation, React hooks/components, Express app factory, and generated artifacts are in idiomatic locations. | None. |
| Keep Serialization/Deserialization At The Edges | 100 | Supervisor JSON is decoded at `GcClient`, client-error payloads at route ingress, cache JSON at storage, SSE event JSON at hook/proxy boundaries, and UI code receives typed app states. | None. |
| Prefer Well-Known, High Quality OSS Libraries | 100 | OpenAPI typing uses `openapi-typescript`/`openapi-fetch`; runtime validation uses Zod; existing React/Express/Vitest/Testing Library patterns are retained. | None. |
| Treat Static Warnings And Info As Errors | 100 | `npm run lint` uses `--max-warnings=0`; direct console use is banned outside allowed boundaries; type-aware lint rules and generated-client drift checks run locally and in CI. | None. |
| Use Centralized Semantic Constant Values | 100 | Log components, source names, route error kinds, status unions, interval constants, regexes, and workflow/session state labels have centralized owners instead of scattered magic strings. | None. |

## Current Verification Checkpoint

- `npm run typecheck`: passed after the session stream state pass.
- `npm run lint`: passed after the session stream state pass.
- `npm --workspace backend test`: 505 tests passed after the session stream state pass.
- `npm --workspace frontend test`: 238 tests passed after the session stream state pass.
- `npm --workspace frontend run build`: passed after the session stream state pass.
- `npm run openapi:gc-supervisor:check`: passed after the Zod runtime schema pass.
- `node --import tsx --test backend/test/gc-client.test.ts backend/test/workflows.test.ts`: 37 tests passed after the Zod runtime schema pass.
- `node scripts/snap-workflow-detail.mjs --test`: passed after the session stream state pass.

## Future Design Directions, Not Current Gaps

1. The app is intentionally local and single-process. That is correct for the
   operator dashboard, but any future multi-user or multi-city direction should
   start by replacing process-local timers/caches with explicit service-owned
   state rather than layering onto the current runtime.
2. The branch is now architecturally much tighter than the starting point. The
   next useful fresh-ideas work should be design-level simplification: decide
   whether the dashboard should keep every ambient operational surface, or
   whether workflow-run detail should become the primary organizing surface
   with the other pages acting as drill-in support views.

## Historical Completion Audit (Superseded)

- Branch requirement: satisfied. Current branch is
  `csells/architecture-best-practices-audit`.
- Base requirement: satisfied. The merge base with
  `csells/formula-detail-followup` is `542f8b2`, the formula detail followup
  branch head.
- Thorough whole-codebase assessment requirement: satisfied. The initial table
  scores all 25 `AGENTS.md` architecture best-practice items across backend,
  frontend, shared, CI, tests, and scripts.
- Iterate and reassess requirement: satisfied. The plan records 35 fix passes
  with reassessment tables after each material update.
- Earlier 100/100 assertion: superseded by the Thirty-Sixth pass below. The
  current objective is defensible 80+ after validating Codex and Claude
  feedback; the newer table is the authoritative current assessment.
- Historical verification checkpoint: superseded by the Thirty-Sixth pass
  below, which re-ran the full current static, test, build, and browser gates.

## Thirty-Sixth Pass: Objective Revalidation Against Codex And Claude Feedback

This pass revalidated the current branch against the explicit
`tmp/arch-best-practices-01.txt` objective rather than relying on the earlier
100/100 conclusion above. The current objective is stricter about evidence:
validate the Codex and Claude feedback, apply it where appropriate, then update
the assessment until every `AGENTS.md` architecture best-practice item is at
least 80. The current evidence supports 80+ across the board, but the scores
below intentionally avoid claiming perfect architecture where meaningful
residual tradeoffs remain.

Additional cleanup in this pass:

- Pruned source comments that described future/deferred link and maintainer
  behavior instead of active constraints.
- Kept comments that explain active invariants: loopback-only security, route
  error isolation, snapshot failure isolation, timer lifecycle, and current
  race-prevention mechanics.
- Re-ran the complete static, unit, integration, build, and browser harness
  set after the latest changes.

Changed-file groups that matter for this objective:

- Shared contracts: `shared/src/index.ts`, `shared/src/index.test.ts`,
  `shared/package.json`.
- Backend error/DRY/observability: `backend/src/lib/sanitise-error.ts`,
  `backend/src/lib/parse-json.ts`, `backend/src/lib/race-with-timeout.ts`,
  `backend/src/middleware/async-route.ts`,
  `backend/src/middleware/api-error-handler.ts`,
  `backend/src/middleware/request-log.ts`, route call sites, and request/error
  tests.
- Backend lifecycle/statelessness: `backend/src/app.ts`,
  `backend/src/config.ts`, `backend/src/snapshot/service.ts`,
  `backend/src/snapshot/cache.ts`, `backend/src/snapshot/collectors/resources.ts`,
  and the lifecycle/failure-isolation tests.
- Frontend DRY/error/SRP: `frontend/src/components/ErrorBoundary.tsx`,
  `frontend/src/components/Field.tsx`, `frontend/src/components/agent/*`,
  `frontend/src/components/mail/*`, `frontend/src/lib/constants.ts`,
  `frontend/src/lib/format.ts`, `frontend/src/routes/maintainerActions.ts`,
  and their tests.
- Static gates and docs: `eslint.config.mjs`, `.github/workflows/ci.yml`,
  `frontend/tailwind.config.js`, `scripts/snap.mjs`,
  `docs/ARCHITECTURE.md`, `docs/SECURITY.md`.

### Objective Feedback Closure

| Feedback area | Current status | Evidence |
| --- | --- | --- |
| DRY duplication | Closed to 80+ | Shared `errorMessage`, client error and sling types, prompt notice, date/size formatting, Field component, parse JSON array, route exec error writer, and timeout helper now have single owners. |
| Don't swallow errors | Closed to 80+ | Async route wrapper + centralized API error middleware, request logging, client error reporting, ErrorBoundary, resource fallback logging, AgentDetail bead/slug failure reporting, and maintainer SSE/action failure reporting are in place and tested. |
| Scalability/statelessness | Closed to 80+ | Runtime services are built through `createDashboardApp`, timers have start/stop lifecycle, snapshot state is per service instance, `HOST` is hard-guarded to loopback, and `docs/ARCHITECTURE.md` lists process-local state and migration paths. |
| No comments for removed functionality | Closed to 80+ | Historical/future/deferred comments in touched source were removed or rewritten as current design rationale. Remaining marker hits are active vocabulary, generated types, fixtures, tests, UI copy, or current invariant comments. |
| SRP | Closed to 80+ | Agent detail display pieces, mail modal/message rendering, maintainer SSE/refresh/sling state, and common route utilities now sit in focused modules. `backend/src/routes/maintainer.ts` and workflow collectors remain large but have clearer helper boundaries and tests. |
| Observability/testability | Closed to 80+ | Request logs, browser client-error logs, async route sanitizer tests, resource fallback logging tests, config guard tests, snapshot per-instance tests, shared tests in CI, and browser route harnesses are present. |
| Async notifications | Closed to 80+ | Maintainer SSE has error reporting, workflow/event browser harnesses are isolated per route, and polling paths are either SSE-backed fallbacks or intentionally visibility-gated polling. |
| Centralized constants | Closed to 80+ | Exec limits, CSRF max-age, dashboard max width, and size thresholds now have named constants. |
| ESLint/static hardening | Closed to 80+ | ESLint runs with `--max-warnings=0`, shared source glob is type-aware, and `@typescript-eslint/switch-exhaustiveness-check` is enabled. |
| Shared wire types | Closed to 80+ | `ClientErrorReport`, `SlingIntent`, `SlingKind`, and shared error normalization are exported from `gas-city-dashboard-shared` and used by backend/frontend callers. |

### Current Score Reassessment

| AGENTS.md item | Current score | Evidence | Remaining tradeoff |
| --- | ---: | --- | --- |
| TDD | 90 | Red/green coverage was added for async route rejection, loopback bind hard-guard, snapshot per-instance state, resources logging, ErrorBoundary, AgentDetail bead refresh reporting, maintainer actions, shared helpers, and formatting. | Some purely mechanical extractions were guarded by existing tests rather than new red tests. |
| Consider First Principles | 88 | The implementation now treats external supervisor data, browser errors, and local process state as explicit boundaries instead of hidden assumptions. | The app still carries several ambient dashboard surfaces; product scope, not architecture, decides whether they all remain. |
| Leverage Types | 92 | Shared wire contracts, strict TypeScript, type-aware lint, discriminated API response shapes, and generated OpenAPI types are used at boundaries. | Some browser and optional UI states still use absent-value unions where selection or DOM APIs require them. |
| DRY | 88 | The duplicated frontend helpers, backend route catch arms, JSON parsing, timeout helper, semantic constants, and shared types now have central owners. | Large workflow and maintainer modules still contain repeated policy-like shape in places where extraction would need a separate focused pass. |
| Separation of Concerns | 87 | App assembly, middleware, route error mapping, supervisor client access, formatting, error reporting, and maintainer actions are separated. | `backend/src/snapshot/collectors/workflows.ts` remains broad because it owns a broad projection. |
| Single Responsibility Principle | 84 | The largest frontend route responsibilities were split into display components and action hooks; backend maintainer storage/SSE/slung-state helpers are isolated. | `backend/src/routes/maintainer.ts` and workflow collection still have multiple reasons to change, though no longer below the 80 bar. |
| Clear Abstractions & Contracts | 88 | Shared contracts, route error helpers, middleware wrappers, and focused hooks make inputs and failure states clearer. | Some route factories still expose broad option objects. |
| Low Coupling, High Cohesion | 87 | Shared package owns common wire contracts, route middleware owns cross-cutting behavior, and UI components consume focused hooks/helpers. | Workflow projection still couples several supervisor facts by necessity. |
| Scalability & Statelessness | 84 | Local single-node design is explicit, loopback-only bind is enforced, runtime timers are start/stop managed, and per-instance state tests pass. | This remains intentionally single-process; horizontal scaling would require replacing process-local caches/SSE/timers. |
| Observability & Testability | 89 | Request logs, centralized server/client error reporting, resource fallback logs, async route sanitizer tests, and browser API-failure harnesses are in place. | Logs remain text-based component logs rather than structured tracing. |
| KISS | 86 | The fixes use small utilities, hooks, and middleware instead of new frameworks. | More extraction would risk indirection unless tied to specific future changes. |
| YAGNI | 86 | No distributed infrastructure, query library, logging stack, or product behavior was added to satisfy architecture scores. | The architecture doc records migration options without implementing them. |
| Don't Swallow Errors | 87 | Previously silent or weakly visible failures now log, report, or surface user-visible degraded states; tests cover key paths. | A few deliberate degraded modes still return safe fallback values after logging. |
| No Placeholder Code | 88 | New modules are mounted and tested; fixture and generated artifacts serve active test/runtime paths. | Fixture data remains test/demo infrastructure, not product data. |
| No Comments for Removed Functionality | 85 | Obvious future/deferred/history comments in touched source were removed or rewritten as current rationale. | Some ticket IDs and current-invariant comments remain; they should be reviewed opportunistically when those modules are next touched. |
| Layered Architecture | 88 | Serialization/deserialization, route adapters, service construction, shared contracts, and UI rendering have clearer layers. | Backend workflow projection is still a dense domain-adapter layer. |
| Use Non-Nullable Variables | 84 | Required data failures increasingly throw or use explicit error states rather than null/empty coercion. | Some absent UI states still use null for selection/error/DOM concepts; converting all of those needs a separate state-modeling pass. |
| Use Async Notifications | 84 | SSE-backed paths are retained, maintainer SSE errors are visible, browser harnesses validate event streams, and intervals are fallback/visibility-gated where retained. | Health and other ambient views still poll because no richer supervisor notification source exists for those facts. |
| Eliminate Race Conditions | 87 | Single-flight requests, route refresh guards, abortable visible refresh, serialized slung-state writes, lifecycle-managed timers, and snapshot isolation are tested. | Multi-process races remain outside the local-only product model. |
| Write for Maintainability | 89 | Common utilities, focused hooks/components, stricter CI, and architecture docs reduce future change cost. | The workflow collector should only be split further when a concrete change reason appears. |
| Arrange Project Idiomatically | 90 | Workspace scripts, shared package tests, Express middleware, React hooks/components, Tailwind config, and generated OpenAPI checks sit in expected locations. | None blocking the 80+ target. |
| Keep Serialization/Deserialization At The Edges | 90 | Supervisor client, route payloads, cache JSON, client-error reports, and UI-facing shared types are centralized at edges. | Some legacy route shapes still sanitize manually instead of through generated schemas. |
| Prefer Well-Known, High Quality OSS Libraries | 88 | Existing React/Express/Vite/Vitest/OpenAPI tooling is preserved; generated OpenAPI client checks are enforced. | Runtime validation library adoption is not expanded in this branch beyond existing project choices. |
| Treat Static Warnings And Info As Errors | 93 | `npm run lint` uses `--max-warnings=0`, typecheck includes test projects, and OpenAPI drift check/build/tests all pass. | Static gates do not replace browser journey tests, which remain script-based. |
| Use Centralized Semantic Constant Values | 87 | Exec limits, CSRF max-age, layout width, prompt notice, size thresholds, and date formatting are centralized. | Some route-local literals remain appropriate because they are route-specific labels. |

### Verification For This Pass

- `npm run typecheck`: passed.
- `npm run lint`: passed with `--max-warnings=0`.
- `npm run openapi:gc-supervisor:check`: passed.
- `npm run build`: passed.
- `npm --workspace shared test`: 23 tests passed.
- `npm --workspace backend test`: 553 tests passed.
- `npm --workspace frontend test`: 269 tests passed.
- `node scripts/snap-workflow-detail.mjs --test`: passed in light and dark,
  including workflow detail load, diff states, node selection, historical
  iteration tabs, transcript peek, and session stream paths.
- `node scripts/snap.mjs --test`: passed for Agents, Beads, Workflows, Mail,
  Activity, Health, and Triage in light and dark. Each recorded `/api/*`
  request returned 200.
- Visual inspection: `/tmp/cp-snaps/light-workflow-detail.png`,
  `/tmp/cp-snaps/light-beads.png`, `/tmp/cp-snaps/light-maintainer.png`, and
  `/tmp/cp-snaps/dark-maintainer.png` were inspected after the browser runs.

### Current Residual Risks

1. The app is still deliberately local and single-process. That is aligned with
   the product contract, but multi-node operation would require externalizing
   process-local caches, timers, and SSE client state.
2. Some UI absent states still use null because React selection, DOM refs, and
   absent error/success state are modeled that way today. The current branch
   prevents required data from being silently coerced to null, which is the
   important 80+ bar; a full no-null UI-state refactor is separate work.
3. `backend/src/snapshot/collectors/workflows.ts` remains large. It is covered
   by focused workflow tests and has clearer helper boundaries, but further
   splitting should be driven by a concrete workflow projection change rather
   than line-count pressure.

## Thirty-Seventh Pass: `arch-best-practices-02` Revalidation

This pass revalidated the follow-up feedback in
`tmp/arch-best-practices-02.txt` against the current
`csells/workflow-detail-architecture-followup` worktree instead of assuming the
older scorecard text was still accurate.

Findings addressed in this pass:

- The security-doc findings about `dangerouslySetInnerHTML` and exec
  environment shape were already resolved in `docs/SECURITY.md`.
- The stale `exec.ts` shorthand saying the child received no inherited
  `PATH`/`HOME`/`LANG` was rewritten to match the current `exec-core` behavior:
  the inherited environment is stripped, then the allowed values are assigned
  intentionally.
- The workflow-run detail architecture spec no longer describes runtime
  supervisor decoding as handwritten-only. Current code uses generated OpenAPI
  path/query/response types, `openapi-fetch`, and generated runtime schema
  validation for the supervisor payloads consumed through `GcClient`.
- The spec now names incremental event mutation and durable product metrics as
  intentionally outside the current dashboard-owned target, not unfinished
  requirements for the workflow-run detail page.
- The maintainer SSE client set now lives behind an injectable
  `MaintainerSseHub`, and `createDashboardApp` passes one shared hub to the
  maintainer router and worker. Tests prove separate hub instances do not share
  clients and stale clients are dropped after failed writes.
- `exec-core` concurrency state now lives behind `createExecRunner()`. The
  exported production `runExec()` still uses the default runner, while tests and
  future app-owned wiring can create isolated runners with independent
  semaphore state.

Current conclusion:

- The actionable `arch-best-practices-02` items that overlap this branch's
  workflow-run detail and supervisor-boundary scope are closed or captured as
  explicit future/product decisions.
- Remaining large-module and product-scope tradeoffs stay documented as
  residual risks. They should not be hidden behind score inflation, but they no
  longer block the workflow-run detail architecture pass.

### Completion Audit For Active Goal

Objective:

> validate, consolidate and address this feedback as appropriate:
> `tmp/arch-best-practices-02.txt`; also implement the remaining parts of
> `specs/architecture/workflow-run-detail-type.md`.

Requirement evidence:

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Validate the `arch-best-practices-02` feedback against current code | This section re-read the feedback against the current worktree and distinguishes already-resolved items, newly-addressed items, and future/product tradeoffs. | Complete |
| Consolidate the feedback into tracked repo documentation | The Thirty-Seventh Pass and this completion audit live in `specs/plans/architecture-best-practices-audit.md`. | Complete |
| Address stale security/architecture docs | `docs/SECURITY.md` already matches current ANSI-to-React rendering and exec env behavior; `backend/src/exec.ts` and `specs/architecture/workflow-run-detail-type.md` were updated where stale wording remained. | Complete |
| Address process-global scalability feedback where appropriate | `MaintainerSseHub` owns maintainer SSE clients per app instance, and `createExecRunner()` owns exec concurrency per runner. Focused tests cover both. | Complete |
| Implement dashboard-owned workflow-run detail architecture | `WorkflowRunDetail` remains the browser contract; `RunningFormulaRun` remains the backend aggregate; generated OpenAPI path/query/runtime validation, current git diff, session streamability, loop/retry instances, graph.v2-only handling, and event invalidation are implemented and tested. | Complete |
| Classify non-dashboard-owned workflow-run target-state gaps | Rig-store per-bead freshness, canonical Gas City/shared graph semantics, incremental projection mutation, durable product metrics, and upstream schema drift are documented as external constraints or future implementation moves, not hidden TODOs. | Complete |

Verification evidence:

- `node --import tsx --test backend/test/maintainer-sse.test.ts backend/test/exec-core.test.ts backend/test/worker.test.ts backend/test/maintainer-sling.test.ts`: passed, 54 tests.
- `npm run openapi:gc-supervisor:check && npm --workspace backend test && npm run typecheck && npm run lint`: passed, including 562 backend tests.
- `npm --workspace frontend test`: passed, 285 frontend tests.
- `npm --workspace frontend run build`: passed.
- `node scripts/snap-workflow-detail.mjs --test`: passed in light and dark, including workflow detail load, diff rendering, node selection, historical iteration tabs, transcript peek, session stream paths, partial snapshots, unsupported graph states, and diff edge states.
- `git diff --check`: passed.
