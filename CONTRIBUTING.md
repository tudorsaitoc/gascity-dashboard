# Contributing

Thanks for opening a PR. This is the human-facing contributor doc. It covers
how to get the dashboard running locally, what every PR is expected to pass,
and where the style and architectural decisions live so you can match them.

If you are looking for Claude Code session notes, those are in
[`CLAUDE.md`](CLAUDE.md). The two docs overlap on commands, but Claude reads
its own context differently, so this file is the one to follow when you are
writing the PR yourself.

## Who this is for

External contributors opening PRs against `sjarmak/gascity-dashboard`. The
dashboard is a single-operator tool (see [Operator context](#operator-context)
below), but PRs from anyone are welcome.

## Quick start

```bash
git clone https://github.com/sjarmak/gascity-dashboard.git
cd gascity-dashboard
npm install
npm run build:shared        # types must build first; backend + frontend import from shared/dist

cp .env.example .env.local  # then edit .env.local if any default does not match your setup
set -a; . ./.env.local; set +a

# Terminal 1: backend on :8081
npm run dev:backend

# Terminal 2: Vite dev server on :5174, proxies /api to :8081
npm run dev:frontend
```

Open `http://127.0.0.1:5174`. The dashboard expects a Gas City `gc supervisor`
reachable at `http://127.0.0.1:8372` by default (override with
`GC_SUPERVISOR_URL`).

The backend binds to `127.0.0.1` by design. For remote development over SSH,
forward port 5174 from the host:

```bash
ssh -L 5174:127.0.0.1:5174 user@host
```

The full env-knob reference lives in
[`README.md`](README.md#configuration) and is generated from
[`backend/src/config.ts`](backend/src/config.ts).
[`.env.example`](.env.example) at the repo root has every key with a comment
and the default value commented out.

## Quality gates

Every PR runs the gates in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Run them locally before pushing. The full sequence:

```bash
npm install
npm run build:shared
npm run typecheck                              # shared + backend + frontend src
npm --workspace backend run typecheck:test     # test files type-check too
npm --workspace frontend run typecheck:test
npm --workspace frontend run build             # Vite catches things tsc misses
npm --workspace backend test                   # node --test via tsx
npm --workspace frontend test                  # vitest in jsdom
```

If you touched anything that renders, also re-run the visual snap harness on
the affected views. The harness is documented in
[`CLAUDE.md`](CLAUDE.md#design-iteration-tooling):

```bash
node scripts/snap.mjs                 # all 5 routes, both themes, to /tmp/cp-snaps/
node scripts/snap.mjs <route>         # one route, both themes
node scripts/snap.mjs <route> light   # one route, one theme
```

The snap harness is not in CI (Playwright is heavy and there is no golden
source yet). It is on the contributor to run it for visual changes and to
include before/after PNGs in the PR description when the change is
non-trivial.

## Style absolutes

Visual design is governed by [`DESIGN.md`](DESIGN.md). The Named Rules there
(One Mark Rule, Flat Page Rule, One Voice Rule, Greyscale Test) are quotable
and binding. Re-read DESIGN.md before any change that touches CSS, layout,
typography, or copy.

The loudest don'ts, so a first PR does not bounce on them:

- No em dashes in UI copy. Use commas, colons, semicolons, periods, or
  parentheses.
- No `#000` or `#fff`. Every neutral tints toward hue 75 (warm amber).
- One typeface family (Inter Variable). No serif accent, no monospace except
  inside the Peek modal's ANSI transcript blocks.
- No gradient text, no glassmorphism, no card-grid hero metrics, no bordered
  cards as a structural default.

The full list, with rationale, lives in DESIGN.md and is summarised in the
[style absolutes section of `CLAUDE.md`](CLAUDE.md#style-absolutes-from-designmd-summarised).
If you are not sure whether a change clears the bar, the Greyscale Test in
DESIGN.md is the fastest way to find out.

## Scope and shape of PRs

Small, focused PRs land faster than sweeping ones. Some defaults:

- One change per PR. If you are fixing a bug and noticed an unrelated typo,
  open two PRs.
- Tests ship in the same commit as the source change. Splitting them across
  commits fragments review.
- New env knobs go through [`backend/src/config.ts`](backend/src/config.ts)
  and into [`.env.example`](.env.example) and the README config table in
  the same PR.
- New routes or backend endpoints follow the patterns in
  [`docs/EXTENDING.md`](docs/EXTENDING.md).
- Security-touching changes (auth, CSRF, exec, host allow-list) need a
  matching update to [`docs/SECURITY.md`](docs/SECURITY.md) in the same PR.

Commits use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`,
`test:`, `chore:`, `perf:`, `ci:`). The PR title is usually the same as the
top commit.

## Filing issues

Use [GitHub Issues](https://github.com/sjarmak/gascity-dashboard/issues).

The repo also has a `.beads/` directory at the root. That is the maintainer's
local `bd` work queue, sitting on top of an embedded Dolt store. It is
operator-local: it does not have a remote, it is not the public bug tracker,
and external contributors should not assume anything they write into `.beads/`
will be seen. Everything you want the maintainer to read goes through GitHub.

## Operator context

This is a single-operator dashboard. The operator alias `stephanie` is
hardcoded in
[`frontend/src/contexts/ViewingAsContext.tsx`](frontend/src/contexts/ViewingAsContext.tsx)
and [`backend/src/audit.ts`](backend/src/audit.ts).

The dashboard supports a "Reading as <X>" state for inspecting other agents'
mailboxes. When `X` is not the operator, that state is impersonation: it is
read-only for mail, and sends always go from the operator. The
`OPERATOR_ALIAS` constant and the `ViewingAs.isOperator` field are the source
of truth. Do not soften that boundary.

If your change touches the impersonation model, expect close review.
[`CLAUDE.md`](CLAUDE.md#the-operator) and
[`docs/SECURITY.md`](docs/SECURITY.md) have the longer version.

## Where to look next

- [`PRODUCT.md`](PRODUCT.md): strategic context. Who the operator is, what
  the dashboard is and is not, the brand and anti-references.
- [`DESIGN.md`](DESIGN.md): the visual system. Palette, type, the Named
  Rules, Do's and Don'ts.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how the pieces fit. The
  systemd-separated-from-supervisor decision, the shared types story.
- [`docs/EXTENDING.md`](docs/EXTENDING.md): adding a new route or backend
  endpoint, the conventions to follow.
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model, CSRF, host
  allow-list, exec whitelist.

## License

By contributing, you agree your contributions are licensed under the project
license: [MIT](LICENSE).
