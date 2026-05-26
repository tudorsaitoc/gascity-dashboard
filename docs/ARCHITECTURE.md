# Architecture — gas-city-dashboard

> Engineer's-eye summary of decisions that affect implementation. For the visual register, read [`PRODUCT.md`](../PRODUCT.md) and [`DESIGN.md`](../DESIGN.md) at the repo root. The architectural shape (the security model, the wire-shape contract, the systemd separation from `gc-supervisor`) is inherited from the [Wldc4rd/citadel](https://github.com/Wldc4rd/citadel) fork and remains intentional here.

## Stack: Node + TypeScript end-to-end

- Backend: Node 20 + Express + TypeScript.
- Frontend: React 18 + Vite + TypeScript + Tailwind. Self-hosted Inter Variable.
- **Shared types**: `shared/` workspace package (`gas-city-dashboard-shared`) exports the wire shapes (Session, Bead, Mail, Events). Imported by **both** backend and frontend. When a `gc` API field-shape changes, a compile error surfaces the breakage instead of an undefined at runtime — the biggest 6-month maintainability investment for a project of this size.

Rejected alternatives:

- **Python + FastAPI** — deploy messier (venv vs system), no shared types, slower to build this shape.
- **Go** — wrong coupling direction (admin tool shouldn't carry gc-the-orchestrator's lang dep).
- **Direct-from-frontend (no backend)** — doesn't work; peek + git + system-health need shell-exec.

## Real-time: same-origin SSE proxy (Phase C — ✅ shipped)

Architect addendum **td-wisp-ijk7g** (mechanic td-wisp-e1v14) corrected the earlier reading: `/v0/city/{name}/events/stream` IS SSE today (the `/stream` suffix; the previous probe missed it). The dashboard now proxies supervisor SSE through the backend instead of opening the supervisor origin directly from the browser.

Why same-origin wins here:

- CSP stays simple: browser `connect-src` remains `self`.
- Remote/SSH-forwarded development needs one browser-visible port, not dashboard plus supervisor.
- EventSource can send cookies but cannot attach custom CSRF headers; keeping streams as GET-only same-origin routes preserves the existing Origin/Host defenses without special frontend CORS paths.
- City events and per-session streams share one backend proxy helper (`backend/src/routes/sse-proxy.ts`) for upstream fetch, heartbeat, backpressure, disconnect cleanup, and `Last-Event-ID` forwarding.

Current flow:

- `frontend/src/hooks/useGcEvents.ts::useGcEventRefresh(prefixes, onMatch)` opens `EventSource('/api/events/stream')`.
- `backend/src/routes/events.ts` proxies `/api/events/stream` to `/v0/city/{name}/events/stream`.
- `frontend/src/hooks/useSessionStream.ts` opens `EventSource('/api/sessions/:id/stream')` only for active selected workflow-node sessions and exposes live/connecting/closed state to the workflow session panel.
- `backend/src/routes/session-stream.ts` proxies that stream to `/v0/city/{name}/session/{id}/stream`.
- The browser forwards `Last-Event-ID` automatically on reconnect; the backend proxy also accepts explicit `?after=` and forwards the cursor upstream.
- Agents, Beads, and Workflows subscribe to matching event prefixes and refresh their cached data. Workflows route event-driven refreshes through `/api/snapshot/refresh` so it bypasses the snapshot TTL.
- Belt-and-braces still applies: every panel has a manual Refresh button for the tab-sleep / laptop-close case.

## Activity + Health (Phase C — ✅ shipped)

- **Activity** (`/activity`): hardcoded git-log "view" enum (`recent-main`, `recent-all`, `today`, `this-week`) on `/api/git/commits?view=<enum>`. The args list lives entirely in `exec.ts::GIT_LOG_VIEWS` — the user picks a view name, not git args. `git log` runs against `$HOME` (overridable via `ADMIN_GIT_REPO`). `/api/builds` parses `$HOME/.dev-deploy-log` line-by-line, classifying each entry into `ok`/`failed`/`in-progress`/`unknown` and surfacing the `.dev-deploy-FAILED` marker as a banner pill.
- **Health** (`/health`): three cards — admin process state (pid/uptime/rss/heap/node version), host state (cpus, 1/5/15 load, mem free, host uptime), gc supervisor's own `/v0/city/{name}/health` response (status/version/uptime). 30 s auto-refresh while tab is visible. Below the cards: a dolt-noms 24 h trend sparkline pulled from `/api/dolt-noms/trend`.

## Dolt-noms ring buffer

The ring buffer scaffolding is wired (`backend/src/routes/dolt.ts`): 144 slots, 10-minute sampling cadence. The actual metric source (`sampleDoltNomsSize()`) is a stub — mechanic surgical-ask is filed for "expose a dolt-noms metric endpoint or document where to read the disk size." Until that lands, `/api/dolt-noms/trend` returns `{samples: [], available: false, source: null}` and the Health page renders a calm "metric source pending" panel instead of fake zeros. Once mechanic ships the source, the only code change is swapping `sampleDoltNomsSize()` — the endpoint shape doesn't move.

## Peek is HTTP, not shell-exec

Same architect addendum: `GET /v0/city/{name}/session/{id}/transcript` returns structured JSON with `turns: [{role, text}, ...]`. The dashboard fetches the transcript via the backend's `GcClient.fetchTranscript`, sanitises each turn's text server-side (ANSI/OSC/control-char strip, per-turn 16 KB cap, total 256 KB cap), and the frontend renders each turn as a role-tagged block.

Why we still go through the backend for peek (rather than calling gc direct from the browser):

- The frontend's CSRF / audit posture stays uniform across read + write paths.
- Server-side sanitisation is the load-bearing XSS defence; doing it in one place (`routes/sessions.ts::buildTranscriptResult`) avoids the temptation to skip it on a client-only path.
- Future SSE upgrade for live-tail can swap from the polled transcript to the streaming endpoint without re-architecting the consumer.

## Deploy: systemd user unit (NOT `gc [[services]]`)

Three load-bearing reasons (per `security_researcher` td-wisp-eb0pn + `senior_developer` td-wisp-uvmru):

1. **Adoption-as-symmetry is a smell.** The Services card on the gc dashboard is correctly empty for this city.
2. **`[[services]]` is underexercised.** Admin dashboard is too operator-critical to be the first adopter of an untested lifecycle primitive.
3. **Inverted dependency.** gc-managed services restart with the gc-supervisor — but the dashboard is *exactly what the operator wants open when gc is misbehaving*. Dashboard must outlive supervisor outages.

systemd is boring, well-understood, and `journalctl`-debuggable. `ExecStartPre` includes a port-in-use check (`senior_developer` gotcha #5). Revisit `[[services]]` in v1+ when it has battle-tested adopters elsewhere.

## Process model

```
   operator (browser)
        │
        │  HTTP/loopback :8081
        ▼
   ┌──────────────────────┐
   │  Express server      │  ← single process, supervised by systemd
   │  - /api/*            │
   │  - SPA at /          │  (express.static, immutable cache on hashed assets)
   │  - SSE at /api/events│  (Phase C)
   │  - Audit → events.jsonl
   └──────────┬───────────┘
              │
              ├── HTTP → gc supervisor (:8372)  — reads
              │
              └── spawn() → `gc` CLI            — whitelisted writes
```

## Trust boundaries

- **Browser ↔ backend**: same-origin, Host-allowlist, Origin check, CSP, CSRF on writes. See `SECURITY.md`.
- **Backend ↔ gc supervisor**: loopback HTTP. Trusts the supervisor's responses (typed via shared/types, but no signature verification).
- **Backend ↔ shell (`gc` CLI)**: whitelisted commands only, `shell: false`, clean env, param schemas. See `SECURITY.md`.

## Phasing

Five views ship in three milestones. Each milestone has an acceptance gate:

- **Phase A (this commit)** — skeleton + Agents view + Beads view. *Gate*: the operator can identify any session's state + peek tmux content without a shell; can see filtered beads + claim/close from the browser.
- **Phase B** — Mail with identity-switching (view-as-X, sends-as-operator via separate router). *Gate*: the operator can read any agent's thread cross-agent; verify every send logs `actor=stephanie`.
- **Phase C** — Activity (commits + builds) + Health (process + dolt-noms 24 h trend) + SSE wiring. *Gate*: the operator can spot the refinery's last merge + memory pressure trend without terminal.

Internal tool — the "anti-scope-reduction reflex" doesn't apply here. The five views are loosely coupled; phasing is logical build order, not feature cuts.

## Reversibility

Stop the systemd unit and drop the repo. No persistent state to clean up. The audit log entries written to `.gc/events.jsonl` are read-only signal and won't break gc itself.

## What's deferred

- **PIN-quick-path for parent mode** is not this project (different bead).
- **Per-event-class notification opt-out** is not this project.
- **TanStack Table** — premature dep at our scale; the in-house `<Table>` covers sortable columns + filter chips + click-row in <200 LOC.
- **xterm.js** for peek — overkill (no need for terminal emulation, just a snapshot view). `ansi_up` (~3 KB) is sufficient.
- **Light theme / system-pref auto** — the operator can request in v1 if dark-default bites.
