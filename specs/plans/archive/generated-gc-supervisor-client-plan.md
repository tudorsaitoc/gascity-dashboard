# Generated GC Supervisor Client Plan

## Goal

Replace the dashboard's hand-written GC supervisor fetch surface with a generated TypeScript client based on the supervisor OpenAPI spec exposed at:

```text
http://127.0.0.1:8372/openapi.json
```

The dashboard should keep its own `/api/*` browser contract stable. Generated supervisor types stay backend-internal unless a type is deliberately mapped into `gas-city-dashboard-shared`.

## Recommendation

Use `openapi-typescript` plus `openapi-fetch`.

- `openapi-typescript` generates exact TypeScript types from the supervisor OpenAPI schema.
- `openapi-fetch` provides a small typed fetch wrapper without generating a bulky SDK.
- Keep a thin handwritten wrapper around the generated client so existing callers keep using methods like `listSessions()`, `listBeads()`, `getRun()`, and `fetchTranscript()`.
- Keep SSE stream mechanics handwritten for now, but derive path/parameter types from the generated `paths` type where possible.

Avoid Orval for this phase. It is stronger when generating React hooks or MSW mocks, but the supervisor must stay behind this backend.

Avoid OpenAPI Generator `typescript-fetch` for this phase. It works, but it generates a larger class-based SDK than this backend needs.

## Current Hand-Written Supervisor Surface

JSON fetches in [backend/src/gc-client.ts](../backend/src/gc-client.ts):

- `GET /v0/city/{cityName}/sessions`
- `GET /v0/city/{cityName}/bead/{id}`
- `GET /v0/city/{cityName}/beads?limit=...`
- `GET /v0/city/{cityName}/mail?box=...&alias=...&limit=...`
- `GET /v0/city/{cityName}/events?after=...`
- `GET /v0/city/{cityName}/run/{run_id}?scope_kind=...&scope_ref=...`
- `GET /v0/city/{cityName}/session/{id}/transcript`

Direct supervisor fetch outside `GcClient`:

- [backend/src/routes/health.ts](../backend/src/routes/health.ts): `GET /v0/city/{cityName}/health`

SSE proxies:

- [backend/src/routes/events.ts](../backend/src/routes/events.ts): `GET /v0/city/{cityName}/events/stream`
- [backend/src/routes/session-stream.ts](../backend/src/routes/session-stream.ts): `GET /v0/city/{cityName}/session/{id}/stream`

## Target File Layout

```text
backend/
  openapi/
    gc-supervisor.openapi.json          # committed schema snapshot fetched from supervisor
  src/
    generated/
      gc-supervisor.ts                  # committed generated TS types, do not edit
    gc-client.ts                        # existing public wrapper, backed by openapi-fetch
scripts/
  update-gc-supervisor-openapi.mjs      # fetch + normalize schema snapshot
```

Generated files should be committed so CI and local typechecking do not require a live supervisor.

## Dependency And Script Changes

Add:

```bash
npm install --save-dev --ignore-scripts --no-audit --no-fund openapi-typescript
npm install --workspace backend --save --ignore-scripts --no-audit --no-fund openapi-fetch
```

Add root scripts:

```json
{
  "scripts": {
    "openapi:gc-supervisor:update": "node scripts/update-gc-supervisor-openapi.mjs",
    "openapi:gc-supervisor:generate": "openapi-typescript backend/openapi/gc-supervisor.openapi.json -o backend/src/generated/gc-supervisor.ts",
    "openapi:gc-supervisor:check": "npm run openapi:gc-supervisor:generate && git diff --exit-code backend/openapi/gc-supervisor.openapi.json backend/src/generated/gc-supervisor.ts"
  }
}
```

`update-gc-supervisor-openapi.mjs` should read:

- `GC_SUPERVISOR_OPENAPI_URL`, default `http://127.0.0.1:8372/openapi.json`
- output path `backend/openapi/gc-supervisor.openapi.json`

It should fetch the schema, verify `openapi` and `paths` exist, JSON-normalize it with stable formatting, and fail loudly on non-200 responses.

## Implementation Phases

### Phase 1: Schema Snapshot And Generated Types

1. Add `scripts/update-gc-supervisor-openapi.mjs`.
2. Fetch the current supervisor schema from `/openapi.json`.
3. Generate `backend/src/generated/gc-supervisor.ts`.
4. Add a file header to the generated output through the generation script or a postprocess step:

```ts
/* eslint-disable */
// Generated from backend/openapi/gc-supervisor.openapi.json. Do not edit.
```

5. Ensure `npm run lint` ignores or tolerates the generated file without weakening rules for source code.

Acceptance:

- `npm run openapi:gc-supervisor:update`
- `npm run openapi:gc-supervisor:generate`
- `npm run typecheck`
- `npm run lint`

### Phase 2: Introduce The Generated Wrapper Without Changing Callers

Keep the exported `GcClient` class and method names. Replace only the internals.

Target shape:

```ts
import createClient from 'openapi-fetch';
import type { paths } from './generated/gc-supervisor.js';

const client = createClient<paths>({ baseUrl });
```

Preserve these existing behaviors:

- Default timeout via `GC_CLIENT_TIMEOUT_MS`, still captured in `GcClient`.
- `GcClient.isTimeoutError()`.
- Single-flight coalescing for identical GET requests.
- Sanitized upstream errors: never include supervisor URL, host, port, or city name in browser-facing messages.
- Caller abort behavior: caller `AbortSignal` should reject only that caller and not cancel a shared in-flight fetch used by other callers.

Use a typed operation helper internally, for example:

```ts
private async getOperation<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T>
```

Then each public method becomes a thin generated call:

```ts
const { data, error, response } = await this.client.GET('/v0/city/{cityName}/sessions', {
  params: { path: { cityName: this.cityName } },
  signal,
});
```

Map `!response.ok` or `error` to the same sanitized `Error('gc supervisor returned <status>')` style used today.

Acceptance:

- Existing backend route tests pass without changing route callers.
- Add one focused unit test proving generated path params are used correctly for `cityName`, `run_id`, and session `id`.

### Phase 3: Move Health Onto `GcClient`

Add:

```ts
async health(signal?: AbortSignal): Promise<SupervisorHealth>
```

Then update [backend/src/routes/health.ts](../backend/src/routes/health.ts) to use `gc.health(signal)` instead of constructing its own supervisor URL.

Preserve health-specific behavior:

- Route-level `GC_HEALTH_TIMEOUT_MS`.
- Timeout maps to `504`.
- Non-timeout upstream failure maps to `supervisor: null`, not a route failure.

Acceptance:

- Existing health timeout tests pass.
- No direct JSON `fetch()` to supervisor remains outside `GcClient`.

### Phase 4: Type The SSE Proxies Without Pretending They Are JSON

Do not force `openapi-fetch` to own SSE streaming unless the generated type surface makes that natural.

Instead:

1. Add typed URL builders in `GcClient`:

```ts
eventsStreamUrl(after?: string): URL
sessionStreamUrl(sessionId: string, after?: string): URL
```

2. Use generated path names and path parameter types in those helpers.
3. Keep `fetch()` streaming manually in the Express proxy routes.
4. Keep heartbeat, backpressure, `Last-Event-ID`, and client-disconnect cleanup exactly as tested today.

Acceptance:

- Existing `events.test.ts` passes.
- Existing `runs.test.ts` session stream test passes.
- No duplicated city-path construction remains in `events.ts` or `session-stream.ts`.

### Phase 5: Decide What To Do With Shared Types

Do not blindly replace dashboard/browser wire types with supervisor-generated types.

Rules:

- Generated supervisor types are backend input types.
- `gas-city-dashboard-shared` types are dashboard output types.
- Backend routes map supervisor shapes into dashboard shapes.
- Only promote generated-derived types into `shared` when the browser contract is intentionally identical to supervisor output.

Initial likely mappings:

- `GcSessionList`, `GcBeadList`, `GcMailList`, `GcEventList` can be validated against generated supervisor response types.
- `FormulaRunDetail` should remain dashboard-owned because it is enriched display data.
- `RunDiffResponse` remains dashboard-owned because it is produced by this backend, not supervisor.

Acceptance:

- Any retained manual shared supervisor-ish type has a comment explaining why it is not generated-derived yet.
- Type tests or `satisfies` checks catch obvious drift between generated operation responses and dashboard mappings.

### Phase 6: Generated-Client Drift Gate

Add a CI/local check script:

```bash
npm run openapi:gc-supervisor:check
```

This should fail if:

- The committed schema snapshot differs from the normalized fetched schema after `openapi:gc-supervisor:update`.
- The generated TS differs after `openapi:gc-supervisor:generate`.

For normal CI, use the committed snapshot only. Do not require CI to reach `127.0.0.1:8372`.

## Tests To Add Or Preserve

Preserve:

- `npm run lint`
- `npm run typecheck`
- `npm --workspace backend test`
- `npm --workspace frontend test`

Add backend tests:

- `GcClient` maps generated client non-OK results to sanitized errors.
- `GcClient` still coalesces identical generated GET calls.
- `GcClient` still distinguishes timeout from caller abort.
- `healthRouter` uses `gc.health()` and preserves timeout/null behavior.
- SSE URL builders preserve `after` behavior and path encoding.

Add a static drift check:

- `npm run openapi:gc-supervisor:generate && git diff --exit-code backend/src/generated/gc-supervisor.ts`

## Known Risks

- The supervisor schema may include broad `string` or weak `unknown` shapes for graph.v2 run details. If so, generation still helps with path/query/response status correctness, but the run detail enricher will still need runtime-tolerant parsing.
- SSE `text/event-stream` may not generate useful payload helpers. Treat stream transport as a deliberate manual wrapper, not a failure of the generated client.
- Fetching `/openapi.json` from a live supervisor can accidentally pick up unreviewed upstream changes. The committed schema snapshot plus drift check makes that explicit.
- Turning on `exactOptionalPropertyTypes` for backend/frontend is a separate cleanup. Do not block generated-client migration on it.

## Suggested First PR Scope

Keep the first PR intentionally narrow:

1. Add schema snapshot and generated types.
2. Add `openapi-fetch`.
3. Rework `GcClient` internals for JSON endpoints only.
4. Leave route callers unchanged.
5. Leave SSE manual.

Do not combine this with run UI changes, browser e2e setup, or broad shared-type refactors.
