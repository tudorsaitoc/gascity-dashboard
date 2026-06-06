# Exposure — the operator-owned contract

How to reach this dashboard from anywhere other than the machine it runs on.
The short version: **you front it with your own authenticated proxy; the
dashboard itself stays on loopback and ships no auth.**

This guide is the deployment counterpart to the posture spec
[`security.md`](./security.md). That file enumerates the controls and the
test invariants that block merge; this file is the operator runbook for the one
decision the dashboard deliberately leaves to you — network exposure.

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

## Hardening checklist when exposing

Before you point an authenticated front at it:

1. **Enable read-only** — set `DASHBOARD_READONLY=1`. This turns on a
   server-enforced gate on the `/gc-supervisor` transport proxy: every
   non-`GET`/`HEAD` is rejected with `405`, reads are default-denied to an
   explicit allowlist (`404` otherwise), and the write-authorizing
   `x-gc-request` header is stripped unconditionally. It is the single
   load-bearing control that survives a blown-open network layer — see
   [`security.md` §Read-only transport-proxy mode](./security.md). Read-only is
   opt-in; the local default stays read/write.
2. **Keep the gc supervisor on loopback and patched.** The read-only gate sits
   _upstream_ of the supervisor, so it only protects requests that go through
   the dashboard. The supervisor's own port (`:8372` by default) must not be
   independently reachable, and it must carry the host-header rebinding fix.
3. **Your proxy must not fail-open.** If the auth backend is unreachable, the
   front must deny — never pass the request through unauthenticated. The
   dashboard's loopback hard-bind covers the default case, but once you put a
   proxy in front, a fail-open proxy is the whole exposure.
4. **Rate-limit at your proxy.** The dashboard has no per-IP throttle of its
   own (only an in-process semaphore); apply limits at the authenticated edge.
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
