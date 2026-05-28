# Security — posture

This file enumerates the security decisions the dashboard makes and the **test invariants** that block merge.

The product runs on the operator's host, on `127.0.0.1`, with no auth. That is **not** a free pass — multi-user POSIX hosts share `127.0.0.1` across all local users, prompt-injection in agent mail can drive XSS, and the dashboard executes whitelisted shell commands. Each section below names the defense and how to verify it.

## Network posture

- **Bind 127.0.0.1 only.** Not `0.0.0.0`. Enforced by `backend/src/config.ts`: `HOST` is ignored unless it is already `127.0.0.1`, and `backend/src/server.ts` binds `config.bindHost`. The systemd unit further restricts via `RestrictAddressFamilies=AF_UNIX AF_INET`.
- **Host header allowlist** (DNS rebinding defense). `middleware/security.ts::hostHeaderAllowlist`. Allowed: `127.0.0.1`, `localhost` (with optional port). Anything else → **HTTP 421 Misdirected Request**.
- **Origin header check** on state-changing endpoints. Must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Anything else → **HTTP 403**.
- **IPv6 posture**: Node's `app.listen('127.0.0.1', …)` binds IPv4 only, so `::1` is naturally refused.
- **CSP `connect-src` is same-origin.** Browser `EventSource` connections go to this dashboard's `/api/events/stream` and `/api/sessions/:id/stream` proxies. The backend opens the upstream supervisor stream from server-side code, so the page does not need direct browser access to `http://127.0.0.1:8372`.

### Invariants

```
curl -sH 'Host: evil.com' http://127.0.0.1:8081/api/health    # → 421
curl -sX POST -H 'Origin: http://evil.com' http://127.0.0.1:8081/api/sessions/td-foo/peek  # → 403
```

## Frame / content type

- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-...'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

## CSRF

Double-submit cookie pattern (`middleware/csrf.ts`). Token generated per boot, surfaced as a `gascity_admin_csrf` cookie (`SameSite=Strict`, non-HttpOnly), echoed by the frontend as `X-CSRF-Token` on every POST/PATCH/DELETE.

Why not `csurf`: the canonical package is deprecated; rolling a minimal double-submit pattern is reasonable here, and the Host + Origin checks do the heavy lifting. CSRF is the third belt.

### Invariant

```
curl -sX POST http://127.0.0.1:8081/api/sessions/td-foo/peek -H 'Host: 127.0.0.1' -H 'Origin: http://127.0.0.1:8081'
# → 403 {"error":"Missing CSRF token","kind":"csrf"}
```

## Shell-exec posture

Every privileged invocation routes through `backend/src/exec.ts`. **No general-purpose exec helper exists.**

- **Enum whitelist** of allowed commands: `gc bd update <id> --status=... --assignee=...`, `gc bd close <id> [--reason=...]`, `gc bd nudge <id> [--reason=...]`.

  *Peek is no longer in this list:* architect addendum td-wisp-ijk7g (mechanic td-wisp-e1v14) confirmed peek is served by gc supervisor's `GET /v0/city/{name}/session/{id}/transcript` HTTP endpoint as structured turns. The dashboard fetches the transcript via `GcClient.fetchTranscript` and sanitises text fields server-side with the same `sanitiseTerminalOutput` it would have applied to shell output. No `subprocess.spawn` involved — one less attack surface in the privileged-exec path.

- **Param schemas** enforced before any privileged call:
  - Bead id: `^(td|th|jt)-[a-z0-9-]{3,32}$`
  - Session id: `^(gc|td|th|[a-z]{4})-[a-z0-9-]{1,32}$` (case-sensitive, no `/i`; validated via the shared `SESSION_ID_RE` in `lib/sessionId.ts`, used by both the peek and stream routes before the gc HTTP call). The `[a-z]{4}` alternation admits city-scoped prefixes (e.g. `fddc-*`) whose codes are derived per-deployment and can't be enumerated here; the lowercase-only, hyphen-and-alphanumeric body keeps the gate strict.
  - Agent alias: `^[a-z][a-z0-9_./-]{1,63}$`
- **Spawn options**:
  - `shell: false` — non-negotiable. No `sh -c`, no command injection vectors.
  - `env: cleanEnv()` — only `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME`, `LANG`. Inherited env stripped.
  - `stdio: ['ignore', 'pipe', 'pipe']` — child can't block on stdin prompts.
- **Resource limits**: per-exec timeout 10–15 s; output cap 100 KB (truncates + kills child); concurrency cap of 4 parallel via in-process semaphore.
- **Audit log**: every exec writes a `{type: 'dashboard.exec', endpoint, parsed_args, exit_code, duration_ms}` row to `.gc/events.jsonl` (durable channel; survives dolt-hq corruption).

### Invariant

```
curl -sX POST http://127.0.0.1:8081/api/sessions/$(printf "'; rm -rf /")/peek …
# → 400 {"error":"invalid session id","kind":"validation"}
```

The literal arguments never reach a shell; even if they did, `shell: false` would refuse to interpret them.

## XSS posture — LLM-controlled content

Everything rendered in the UI that originated outside the dashboard (mail bodies, bead descriptions, peek output, agent state strings) is **TEXT, NOT HTML**.

- React's default escaping is the friend. `{content}` not `dangerouslySetInnerHTML`. No `innerHTML`, no `document.write`, no `eval`, no `Function()` anywhere in the frontend.
- Peek output: server-side strips ANSI/OSC/control characters (`backend/src/exec.ts::sanitiseTerminalOutput`) and passes only safe SGR. Client renders with `ansi_up` (uses CSS classes, not inline styles, courtesy of `use_classes = true`).
- Mail bodies + bead descriptions render in `<pre>` with full text escaping.

### The one `dangerouslySetInnerHTML` exception

Each transcript turn in `routes/Agents.tsx::TurnBlock` uses `dangerouslySetInnerHTML` to inject the HTML that `ansi_up` produces from the turn's text. This is the canonical pattern for `ansi_up` and is safe for two layered reasons:

1. **Server-side sanitisation runs first** — every turn's text passes through `sanitiseTerminalOutput` before it reaches the browser, which strips OSC sequences, non-SGR CSI sequences, and control characters. The string ansi_up sees contains only printable characters plus safe SGR colour escapes.
2. **`ansi_up` with `use_classes = true` does not pass through arbitrary HTML** — it HTML-escapes `<`, `>`, `&` from the input and emits only `<span class="ansi-...">` wrappers (no inline styles, no event handlers, no `<script>` / `<iframe>` / `<a>`).

The `eslint-disable react/no-danger` comment at the call site cross-references this exception. **Any other use of `dangerouslySetInnerHTML` in the codebase is a bug — flag at review.**

### Banner

The peek modal carries a banner: *"Content is agent-generated and may contain misleading instructions."* Mitigates prompt-injection-in-content for the human reading it.

### Invariant

```
# Mail body containing <script>alert(1)</script>
# Rendered in the UI → escaped to '&lt;script&gt;alert(1)&lt;/script&gt;' as text. No script execution.
```

## Identity-switching for mail (Phase B)

**Physical separation** of read vs send routers (security_researcher's strong preference over code-path discipline):

- `routes/mail.ts` — read paths; takes a `viewing-as` query param.
- `routes/mail-send.ts` — write path; **the send function's signature has no as-identity parameter**. Server is structurally unable to send-as-other.

Frontend renders a visible "Viewing as <agent>" banner with colour; the compose-from field is greyed when viewing-as ≠ the operator so the constraint is visible *before* the user tries.

**Audit log** (`audit.ts`): every fetch records `actor=stephanie, viewing_as=<alias>`. Every send records `actor=stephanie, viewing_as_context=<alias>` so the trail is intact regardless of UI state.

No client-side caching of mail under as-identity (`Cache-Control: no-store`, no `localStorage` retention).

## Kill switch

```
ADMIN_DASHBOARD_DISABLED=1
```

`server.ts` checks this env at boot and refuses to bind the listener. `process.exit(0)`. Also enforceable via systemd `Environment=ADMIN_DASHBOARD_DISABLED=1`.

## What's NOT in v0

- Per-user POSIX permission gate: `127.0.0.1` is shared across all local users on the machine. v1 may switch to a Unix-domain socket with `0600` + os-owner ACL. v0 limitation: trust the host.
- No rate-limiting beyond the in-process semaphore. v1 may add per-IP throttle on the audit log path.
- No TLS — same-machine loopback only.
- No request signing beyond CSRF.

Anything beyond v0 lands as a separate bead. v0 deliberately ships the security floor that the architect + security_researcher named as merge-blocking — not the full enterprise stack.
