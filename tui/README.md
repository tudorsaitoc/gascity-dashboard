# gas-city-dashboard-tui (prototype)

A terminal glance surface for the Gas City dashboard — the smallest viable
prototype to prove or kill the idea of a TUI an operator leaves open in a tmux
split instead of alt-tabbing to the SSH-forwarded browser tab.

## What it is (and is not)

- **Thin client of the backend `/api/*`.** It reuses the `shared` DTOs directly
  (`gas-city-dashboard-shared`), so a contract drift is a compile error here,
  not a runtime `undefined`. It talks only to the backend — never to the gc
  supervisor — so it inherits edge translation, sanitisation, timeouts, CSRF and
  audit for free (`backend/src/gc-client.ts` is the only supervisor seam).
- **Read-only.** No writes (claim/close/sling/respond) — those need the CSRF
  double-submit the web client does; out of scope for the prototype.
- **No tmux pane-attach.** Deliberately rejected: raw `capture-pane` bytes would
  bypass the server-side ANSI/OSC sanitisation that is the load-bearing XSS
  defence, and break the 127.0.0.1-only posture. Session content reaches the
  operator through the backend, not by attaching to panes.

## Views (full-screen toggles)

Each is a full-screen toggle over the same navigable area; the selection
persists across the live refresh. `enter` drills the selected row into a single
reused tmux split (see Peek).

- **Agents** (default): grouped by rig (orchestration layer first; within a rig,
  active before idle), one line each as `agent · ctx% · activity · model ·
  last-active`. Dormant agents show their transition reason (e.g. `city-stop`).
  Greyscale-first, one red mark for what's worth a glance.
- **Beads** (`b`): grouped by status (open → in_progress → blocked → closed),
  priority-ordered. `enter` opens `gc bd show <id>` in the split — the bead's
  instructions/description/labels.
- **Formula runs** (`f`): run lanes grouped by rig, needs-operator first (one red
  mark). `enter` opens the run's bead (`gc bd show`) plus its code diff in the
  split.
- **Health** (`h`): host resources, headline counts, runs needing an operator,
  context-pressure agents (≥75%), and a never-active-by-rig reallocation rollup.
  Costs are shown as *not measured* (the supervisor exposes none yet — see
  `specs/architecture/cost-token-feasibility.md`); never faked.
- **Detail** (`p`, agents only): in-TUI detail for the selected agent — ids, the
  peek commands, that rig's beads and active run lanes.

## Peek (tmux split)

`enter` on a row opens **one reused** tmux split beside the dashboard and points
it at the selected row's drill-in (agent → live `session logs -f`; bead →
`bd show`; run → `bd show` + diff). `enter` retargets that pane to a new
selection (no pile-up); `enter` on the row it's already showing, or `x`, closes
it. Quitting (`q`) tears the peek pane down. All drill-ins READ (logs/show/diff)
— none attaches as a tmux client, so peeking can't resize or disturb an agent.

## Controls

`↑`/`↓` or `j`/`k` move the selection · **mouse wheel** scrolls · `PageUp`/`PageDown`
· `g`/`G` top/bottom · `enter` drill into split · `x` close split · `b` beads ·
`f` runs · `h` health · `p` agent detail · `q` (or `esc`) quit.

## Run

The backend must be running (`npm run dev:backend`) against a live supervisor.

```bash
# from repo root, after `npm install`
set -a; . ./.env.local; set +a   # defines GC_CITY_NAME
npm --workspace tui run start     # or: npm --workspace tui run start -- --city=<name>
```

### Launch inside tmux (so `enter`-peek works)

The live-peek split (`enter`) needs the TUI to be running inside tmux. If you're
already in a tmux session, the command above is enough. From a plain terminal,
use the launcher, which creates/attaches a dedicated `gc-tui` session:

```bash
npm --workspace tui run start:tmux -- <city>     # or ./tui/start-tmux.sh <city>
```

Env: `DASHBOARD_URL` (default `http://127.0.0.1:8081`), `GC_CITY_NAME` or
`--city=<name>` (required — no silent fallback to a default city). Press `q` to
quit.

## Status

Prototype, not yet wired into root CI `typecheck`. If it graduates, add
`npm --workspace tui run typecheck` to the root `typecheck:src` chain so
shared-DTO changes can't silently break this third consumer.
