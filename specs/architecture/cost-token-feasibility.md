# Spike finding: per-run / per-session token & cost data

Exit artifact for the cost/token feasibility spike in `prd_incorporate-tmai-amux-components.md`. Verified against committed repo artifacts on 2026-06-01.

## Verdict

**PARTIAL — the contract EXISTS, the data does not flow yet.** The committed supervisor OpenAPI snapshot defines five cost/token fields on `WorkerOperationEventPayload` (a `worker.operation` SSE event payload), every one documented "best-effort, currently always absent." Transport is the supervisor HTTP API/event stream through the generated client/proxy — **not** a `tokscale` subprocess. The dashboard does not project these fields into a cost UI today.

## Evidence

- `backend/openapi/gc-supervisor.openapi.json:12835–12893` — `cache_creation_tokens`, `cache_read_tokens`, `completion_tokens` (`int64`), `cost_usd_estimate` (`double`), `prompt_tokens` (`int64`), all "currently always absent." `cost_usd_estimate` references upstream **#1255** (pricing seam); `prompt_sha`/`prompt_version` reference **#1256**.
- No `spend`/`price`/`dollars`/`cents` keys anywhere in the spec.
- Generated backend and frontend clients carry them: `*/src/generated/gc-supervisor-client/zod.gen.ts` (`zWorkerOperationEventPayload`) and `types.gen.ts` (`cost_usd_estimate?: number`, token fields).
- Grep for the cost/token field names across `shared/src`, `backend/src`, `frontend/src` returns nothing translated into dashboard-owned view state.
- Transport is supervisor HTTP through `/gc-supervisor/v0/city/.../events` and `/events/stream`.

## Wire-shape determination (corrects the PRD's a-priori worry)

Cost lands as a **NUMBER**, not a wire string. `cost_usd_estimate` is `type: number`/`format: double`; tokens are `int64` integers. The old hand-written decoder layer is gone, so the generated OpenAPI schema is the dashboard's wire contract here. **Do not string-coerce cost.**

## `tokscale` claim adjudication

**TRUE for the competing `demo-dash` repo, FALSE/irrelevant for this dashboard.** `tokscale` / `/data/projects` appear only in `.claude/rfc-drafts/rfc-2-tokens-endpoint.md` and `rfc-4` prose (describing demo-dash's `src/server/collectors/tokens.ts`), never in `backend/`, `frontend/`, or `shared/`. This dashboard's path to cost is the supervisor's HTTP SSE event, so the PRD's "absent if the only source is the subprocess" exit condition is **not triggered**.

## Recommended projection approach (when fields are populated)

1. Narrow `worker.operation` events to a typed payload schema (discriminate on `type`) instead of widening the opaque record.
2. Treat values as **optional, non-fatal, number-typed**: `cost_usd_estimate` finite number, tokens non-negative integers. Never a required field that throws and takes down a focused view.
3. Honor the "zero ≠ free" warning (openapi:12888): surface absent/`undefined` as "not measured," distinct from `0` — do not coalesce `undefined → 0`.
4. Translate to dashboard-owned display state before rendering; do not add a backend mirror route.

## Upstream ask (if wanted sooner)

Against the supervisor (`gastownhall/gascity`, which owns `gc-supervisor.openapi.json`): **populate the existing `WorkerOperationEventPayload` cost/token fields** (refs #1255 pricing seam, #1256 prompt_sha/version). No new field or namespace needed — activation of an existing contract that already flows over the supervisor HTTP/event API. Do **not** conflate this with rfc-2's separate `GET .../tokens` (tokscale rolling-window) proposal targeted at demo-dash.
