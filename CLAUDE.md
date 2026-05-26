# gas-city-dashboard — agent context

The durable conventions, invariants, and gotchas an agent must load to contribute here — the things the code does **not** announce about itself. Anything derivable from the source (file layout, component names, script flags, port numbers) is omitted on purpose: read the code, which is the canonical and non-stale record.

## What it is

An editorial-typographic ambient dashboard surfacing live state from a [Gas City](https://github.com/gastownhall/gascity) (`gc`) supervisor over its HTTP API. npm workspaces: `backend` (Node + Express + TS), `frontend` (React + Vite + Tailwind), and `shared`.

- **`shared` is the single source of truth for wire-shape types.** Both sides import it, so a wire mismatch is a compile error, not a runtime `undefined`. Change a shape there, not ad hoc on either side.
- **The backend binds `127.0.0.1` only, by design.** For remote dev, forward the Vite port over SSH; never expose the backend.

## The contracts (they outrank assumed conventions)

- **`PRODUCT.md`** — what's being built and for whom. Strategic decisions defer to it.
- **`DESIGN.md`** — the binding visual contract; re-read it before any UI or UI-copy change. It defines the named rules and style absolutes and outranks habit. Don't restate it here — it would go stale against the source of truth.
- **`docs/{ARCHITECTURE,SECURITY,EXTENDING}.md`** — how things are wired, the security/impersonation model, and how to add a route or endpoint.

## Remote, CI, and the merge gate

Published at **github.com/sjarmak/gascity-dashboard**. The working remote is named `origin`; land feature work on branches and open PRs against `main`.

`main` is branch-protected — land work via a PR that passes CI (`.github/workflows`); you cannot push straight to `main`. **Match CI locally before pushing or the merge blocks:** the root `npm run typecheck` covers only each workspace's *app* tsconfig, but CI also runs `typecheck:test` (backend + frontend), `frontend run build`, and both test suites. A change to a `shared` wire-shape type breaks `*.test.ts(x)` fixtures the app typecheck never sees — run both `typecheck:test`s too.

## Gotchas the code won't tell you

- **Tailwind config changes need a full Vite restart**, not HMR: `rm -rf node_modules/.vite && npm run dev:frontend`, or stale class definitions are served.
- **The Vite proxy's `changeOrigin: true` is load-bearing** — it makes write requests carry the backend's expected `Origin` and pass its allow-list. Don't remove it.
- **`.env.local` (gitignored) must be sourced** before the backend runs (it defines `GC_CITY_NAME`, `ADMIN_AUDIT_LOG_PATH`, etc.): `set -a; . ./.env.local; set +a`.
- **Workflow run detail has a focused browser harness:** `node scripts/snap-workflow-detail.mjs --test` clicks through `/workflows` into a mocked run detail and fails on any broken `/api/*` call.

## Issue tracking

Work items live in **`bd` (beads)** in an embedded-dolt store at `.beads/`, isolated from the gc supervisor — these beads are **not** in the dashboard's own `/api/beads` view, and `.beads/` has no Dolt remote yet, so bead state is local-only. Anything that outlives the current task goes in `bd` (`bd ready` / `show` / `update --claim` / `close`), not scattered TODO comments.
