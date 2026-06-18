# Exposure — the operator-owned contract

How to reach this dashboard from anywhere other than the machine it runs on.
The short version: **you front it with your own authenticated proxy; the
dashboard itself stays on loopback and ships no auth.**

This guide is the deployment counterpart to the posture spec
[`security.md`](./security.md). That file enumerates the controls and the
test invariants that block merge; this file is the operator runbook for the one
decision the dashboard deliberately leaves to you — network exposure.

Two absolutes frame everything below:

- **No exposure without auth.** There is no supported way to put the raw port on
  a network. If a request can reach the dashboard, an authenticated front must
  have let it through first.
- **Read-only is the inner belt, not the auth boundary.** `DASHBOARD_READONLY=1`
  and the loopback bind shrink the blast radius if the front is breached; they
  log nobody in. The auth front is the boundary — and it protects the
  **dashboard**, not the gc supervisor, which stays unauthenticated on loopback
  (any other process or user on the host reaches it directly, with or without
  the dashboard).

## Default posture (zero configuration)

Out of the box, with no flags and no config file:

- The backend binds `127.0.0.1` only. `HOST` is **ignored** — a non-loopback
  value is logged and discarded (`backend/src/config.ts::parseBindHost`), so
  there is no supported way to bind the raw port to a public interface.
- There is **no auth and no login**. Full functionality is available to
  anything that can reach the loopback port.

This is the supported default and the zero-friction path: a single operator on
their own host needs nothing more. **Do not add auth to use the dashboard
locally** — there is intentionally none to configure.

## Exposure is operator-owned

The dashboard is a zero-auth control plane over the (also unauth) gc supervisor.
There is no safe way to put the raw port on a network. To reach it remotely you
**terminate exposure at a front you own and authenticate**, and let it connect
to the dashboard over loopback:

```
your client ──TLS+auth──▶ your proxy (auth/SSO/allowlist) ──▶ 127.0.0.1:<port> dashboard
```

Any authenticated front works — a reverse proxy with basic-auth or
forward-auth (nginx, Caddy), a tailnet-scoped share (Tailscale Serve), or a
zero-trust gateway (Cloudflare Access), among others. The dashboard does not
care which; it only ever sees a loopback connection.

**Never put the raw port on a public interface.** That means no `0.0.0.0`
bind (the backend refuses it anyway), no port-forward of the listener, and no
Tailscale **Funnel** of the raw port — Funnel publishes to the public internet
with no auth in front. Tailscale **Serve** (tailnet-only) is fine; Funnel is
not.

## The load-bearing rewrite: `Host` **and** `Origin`

This is the single most common misconfiguration — get it right before anything
else. Your front must rewrite **two** request headers to loopback before it
forwards to the backend:

| Header   | Rewrite to                | Why it is required                                                                                                                                                                                              |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Host`   | `127.0.0.1`               | The host-header allow-list (`middleware/security.ts`) rejects any other value — the DNS-rebinding floor. Applies to **every** request, GETs included.                                                          |
| `Origin` | `http://127.0.0.1:<port>` | `originCheck` requires the `Origin` on every state-changing request (anything but `GET`/`HEAD`/`OPTIONS`) to be exactly the backend's own loopback origin. The browser sends the *public* origin (`https://dash.example.com`); un-rewritten, every write `403`s with `{"kind":"origin"}`. |

`<port>` is the **backend's bound port** — `8082` for the systemd production
listener, `8081` for `npm run dev:backend` — **not** your proxy's public `443`.
The backend wants its own loopback origin, whatever port the client actually
reached.

**Do not "fix" the write `403` by adding your public host to
`ADMIN_EXTRA_ALLOWED_HOSTS`.** That widens both the host-header and the `Origin`
allow-lists to your public name, silently dismantling the DNS-rebinding floor
and the Origin belt — the two controls you are exposing *behind*. Rewrite the
headers at the proxy instead, and keep `ADMIN_EXTRA_ALLOWED_HOSTS` empty.

Only a front where you control request headers — **nginx** or **Caddy** below —
can rewrite `Origin`, so only those carry **writes**. The identity-scoped fronts
(Tailscale Serve, Cloudflare Access) forward the client's `Origin`; run them with
`DASHBOARD_READONLY=1`, where the supervisor write surface is already closed and
only `GET`/`HEAD` reads — exempt from the `Origin` check — cross the wire, so the
missing rewrite costs nothing. For read/write exposure, front with nginx or Caddy, or add
a platform header-transform (e.g. Cloudflare Transform Rules) that sets
`Origin: http://127.0.0.1:<port>`.

## Recipes

Four concrete fronts, one per common environment. All assume the dashboard is
the systemd-managed production listener on `127.0.0.1:8082` (see
[`deploy/`](../../deploy/README.md)); swap the port if you run it elsewhere.
Each terminates TLS and authenticates at the front, then proxies over loopback.
Pair every one of them with `DASHBOARD_READONLY=1` and the
[hardening checklist](#hardening-checklist-when-exposing) below.

Each rewrites `Host` (and, on the header-controlling fronts, `Origin`) to
loopback per [the load-bearing rewrite](#the-load-bearing-rewrite-host-and-origin)
above — without touching `ADMIN_EXTRA_ALLOWED_HOSTS`. The SSE streams
(`/gc-supervisor/**` events, `/api` event stream) need response buffering off or
they stall.

### nginx — basic-auth reverse proxy

```nginx
# htpasswd -c /etc/nginx/.gcd-htpasswd <user>   # create the credential first
server {
    listen 443 ssl;
    server_name dash.example.com;

    ssl_certificate     /etc/letsencrypt/live/dash.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dash.example.com/privkey.pem;

    location / {
        auth_basic           "gas-city-dashboard";
        auth_basic_user_file /etc/nginx/.gcd-htpasswd;   # fails closed: no file → 403

        proxy_pass         http://127.0.0.1:8082;
        proxy_set_header   Host   127.0.0.1;                  # host-allowlist (every request)
        proxy_set_header   Origin http://127.0.0.1:8082;     # originCheck (writes); backend port, not 443
        proxy_http_version 1.1;
        proxy_set_header   Connection "";                # keep SSE connections open
        proxy_buffering    off;                          # stream events un-buffered
    }
}
```

### Caddy — forward-auth

```caddy
# Caddyfile — delegate auth to your own service (Authelia, tinyauth, …).
# Caddy auto-provisions TLS; forward_auth fails closed if the auth service
# is unreachable, so a blown auth backend denies rather than passes through.
dash.example.com {
    forward_auth 127.0.0.1:9091 {
        uri /api/verify?rd=https://auth.example.com
        copy_headers Remote-User Remote-Email Remote-Groups
    }

    reverse_proxy 127.0.0.1:8082 {
        header_up Host   127.0.0.1                 # host-allowlist (every request)
        header_up Origin http://127.0.0.1:8082     # originCheck (writes); backend port, not 443
        flush_interval -1                          # never buffer SSE
    }
}
```

### Tailscale Serve — tailnet-only

```bash
# Publish to your tailnet ONLY; Tailscale identity is the auth. Never Funnel.
tailscale serve --bg --https=443 http://127.0.0.1:8082

# Verify it is Serve (tailnet-scoped) and NOT Funnel (public internet):
tailscale serve status      # must list the :8082 mapping
tailscale funnel status     # must show NOTHING for this port
```

Serve forwards the client's `Origin`, so writes would fail the `Origin` check.
Run it with `DASHBOARD_READONLY=1` (the recommended pairing) and that is moot —
the supervisor write surface is closed and only `GET`/`HEAD` reads cross the wire.

### Cloudflare Access — zero-trust gateway

```bash
# 1. Outbound-only tunnel from the host — no inbound port is opened:
cloudflared tunnel --hostname dash.example.com --url http://127.0.0.1:8082

# 2. In Cloudflare Zero Trust, add an Access application for dash.example.com
#    with an allow policy (email / SSO / group). Access enforces identity at
#    Cloudflare's edge BEFORE traffic reaches the tunnel; an unauthenticated
#    request never reaches the host.
```

The tunnel forwards the client's `Origin`, so pair it with `DASHBOARD_READONLY=1`
(reads only, `Origin` check exempt). For read/write exposure, add a Cloudflare
Transform Rule that sets `Origin: http://127.0.0.1:8082` on requests to the host.

## Rate-limiting at the front

The dashboard has **no rate limiter of its own**. The only back-pressure in the
codebase is a global four-slot semaphore around host shell-outs
(`MAX_CONCURRENT = 4` in `backend/src/exec-core.ts`) — it serialises
`git`/`gh`/`bd` reads, not HTTP requests, and it is per-process, not per-IP. HTTP
requests, and especially long-lived streams, hit no ceiling at all.

This limiting belongs **at the BYO front, never in transit.** The
`/gc-supervisor/*` proxy is transport-only by contract — it forwards bytes and
nothing else. Putting a rate policy inside it would couple the dashboard to a
supervisor concern it must not own (the same reason `DASHBOARD_READONLY` gates
verbs at the proxy's _edge_, not its body). Enforce every limit below at the
authenticated front, where identity is already known.

### The exhaustion vector: long-lived streams

A request-per-second limiter is necessary but not sufficient, because the
dashboard's costliest traffic is **streams that stay open**, not requests that
return. Each one pins a socket and a file descriptor for its whole lifetime, so a
handful of identities holding many streams exhausts the host long before any
req/s ceiling notices — one stream is a _single_ request that never completes.
This is the scoping review's risk #7: "resource exhaustion against the supervisor
via open proxy GETs — long-lived SSE event/session streams especially."

The streams to bound:

- `GET /api/maintainer/events` — the dashboard's own SSE channel
  (`text/event-stream`, 30 s heartbeats), registered in an **unbounded**
  in-memory client set.
- `GET /gc-supervisor/v0/city/{city}/events` and `…/events/stream` — the
  supervisor event streams, proxied through verbatim.
- `GET /gc-supervisor/v0/city/{city}/session/{id}/stream` — one open stream
  **per session view**, so a single operator with several sessions open already
  holds several.

All are `GET`s, so all cross the wire even under `DASHBOARD_READONLY=1`. A
concurrent-connection cap — not a request-rate limit — is what bounds them.

### The three knobs

| Knob                            | What it bounds                                       | Recommended start, per identity |
| ------------------------------- | --------------------------------------------------- | ------------------------------- |
| Per-identity request rate       | reconnect storms, abusive polling, write floods     | 10 req/s, burst 30              |
| Concurrent-connection cap       | held-open SSE — the real exhaustion vector          | 15 connections                  |
| GET-rate ceiling                | the only verb that crosses in read-only mode        | 20 req/s, burst 50              |

These are starting points for a one-operator (or small, known team) control
plane — scale them by the number of real operators, not by anticipated load. The
request rate is the overall per-identity ceiling; the GET-rate ceiling is a
deliberately looser sub-limit you raise above it **only for `GET`/`HEAD`**, since
under `DASHBOARD_READONLY=1` reads are the entire (and cheap, polling-heavy)
surface. Key every limit on the **authenticated identity** the front already
established
(basic-auth user, forward-auth `Remote-User`, the Access email), falling back to
client IP only where no identity header exists. A browser tab holds roughly the
maintainer stream plus one supervisor event stream plus one stream per open
session, so 15 concurrent connections leaves headroom for a couple of tabs;
tighten toward 5 for a strict single-tab operator.

### Concrete limits per front

**nginx** — `limit_req` for rate, `limit_conn` for the stream cap, both keyed on
the basic-auth user:

```nginx
# These two zone directives live in the http{} context (the conf.d files nginx
# includes are already inside http{}) — NOT inside server{}, where nginx rejects
# them with "directive is not allowed here".
limit_req_zone  $remote_user zone=gcd_req:10m  rate=10r/s;
limit_conn_zone $remote_user zone=gcd_conn:10m;

server {
    # …TLS + auth_basic from the nginx recipe above…
    location / {
        limit_req  zone=gcd_req burst=30 nodelay;   # per-identity request rate
        limit_conn gcd_conn 15;                      # concurrent-connection cap (bounds SSE)
        # …proxy_pass + Host/Origin rewrite + proxy_buffering off…
    }
}
```

`limit_conn` is the load-bearing one here: it counts a held-open SSE stream as a
live connection, which a `limit_req` ceiling never sees.

**Caddy** — standard Caddy ships **no** rate limiting; add the third-party
[`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit) module via a custom
`xcaddy` build, then key on the forward-auth identity. `rate_limit` is a handler
directive — place it inside the `dash.example.com { … }` site block from the
Caddy recipe above:

```caddy
rate_limit {
    zone gcd {
        key    {http.request.header.Remote-User}
        events 600                                 # 600 per window…
        window 60s                                 # …i.e. ~10 req/s per identity
    }
}
```

Caddy has no native concurrent-connection cap; if you need to bound streams
precisely, terminate the cap with an nginx hop on the host or rely on the tight
request rate plus the small, authenticated audience.

**Tailscale Serve** — no rate-limiting primitive; tailnet ACLs gate **who**
connects, not how fast. For a small, trusted tailnet running
`DASHBOARD_READONLY=1`, that membership boundary is usually enough. If you need
hard rate or connection caps, put an nginx hop on the host behind `tailscale
serve` and apply the nginx limits above.

**Cloudflare Access** — add a WAF **Rate Limiting Rule** at the edge, keyed on
`cf-access-authenticated-user-email` so the budget is per operator, not shared
across the team's egress IP:

```
When  http.request.uri.path contains "/"
Rate  > 600 requests per 60s per cf-access-authenticated-user-email
Then  Block (or Managed Challenge)
```

Cloudflare also enforces edge connection limits, but the rule above plus Access
identity is the per-identity ceiling; note that rate-limiting-rule counts are
plan-limited on the free tier.

## Hardening checklist when exposing

Before you point an authenticated front at it:

1. **Enable read-only** — set `DASHBOARD_READONLY=1`. This turns on a
   server-enforced gate on the `/gc-supervisor` transport proxy: every
   non-`GET`/`HEAD` is rejected with `405`, reads are default-denied to an
   explicit allowlist (`404` otherwise), and the write-authorizing
   `x-gc-request` header is stripped unconditionally. It is the single
   load-bearing control that survives a blown-open network layer — see
   [`security.md` §Read-only transport-proxy mode](./security.md). Read-only is
   opt-in; the local default stays read/write. Note: this gates the
   `/gc-supervisor` proxy only — the dashboard's own `/api/*` maintainer writes
   (client-error telemetry, `gh` actions, sling-record) are CSRF+Origin
   protected, not covered by `DASHBOARD_READONLY`, so "read-only" means the
   _supervisor_ surface, not the entire service. The posture is projected onto
   the wire as `DashboardRuntimeConfig.readOnly` (gascity-dashboard-uzhr) so the
   SPA disables (not hides) every supervisor-mutating control — Beads
   create/sling, claim, close, nudge; Mail compose, reply, archive, mark
   read/unread; Agents approve/deny of a pending interaction (session-respond);
   and Maintainer bulk sling — with a read-only affordance, rather
   than letting a click `405` into an unhandled error. Each disabled control
   carries an explanatory title plus a "Read-only" badge (DESIGN.md §States have
   words), and the click handlers guard the write directly as defense-in-depth
   against keyboard/Enter-submit paths. The server gate stays the enforcement;
   the SPA flag is only the affordance. (Dashboard-local `/api/*` writes such as
   the Maintainer "Refresh from gh" and sling-record stay enabled — they are
   CSRF+Origin protected and not behind `DASHBOARD_READONLY`, so they do not
   `405`.)
2. **Keep the gc supervisor on loopback and patched.** The read-only gate sits
   _upstream_ of the supervisor, so it only protects requests that go through
   the dashboard. The supervisor's own port (`:8372` by default) must not be
   independently reachable, and it must carry the host-header rebinding fix.
3. **Your proxy must not fail-open.** If the auth backend is unreachable, the
   front must deny — never pass the request through unauthenticated. The
   dashboard's loopback hard-bind covers the default case, but once you put a
   proxy in front, a fail-open proxy is the whole exposure.
4. **Rate-limit at your proxy.** The dashboard has no per-IP throttle of its
   own (only the in-process exec semaphore); apply a per-identity request rate,
   a concurrent-connection cap, and a GET-rate ceiling at the authenticated edge
   — see [Rate-limiting at the front](#rate-limiting-at-the-front), with the
   concurrent-connection cap doing the load-bearing work against long-lived SSE.
5. **Keep `ADMIN_EXTRA_ALLOWED_HOSTS` minimal.** Add only the `Host` value your
   proxy actually forwards. The `127.0.0.1` / `localhost` floor is always
   allowed; everything else is an opt-in you should keep as small as possible.

## What the dashboard deliberately does not provide

- **No built-in auth or login.** By design — exposure terminates at the front
  you own, not in this codebase.
- **No TLS.** Loopback only; your proxy terminates TLS.

These are not gaps to be filled before exposing; they are the contract. The
dashboard ships the loopback floor and the opt-in read-only gate, and leaves
authentication, TLS, and rate-limiting to the authenticated front you place in
front of it.
