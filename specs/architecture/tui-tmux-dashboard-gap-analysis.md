# TUI gap analysis vs the gc tmux operator console

Source of inspiration: the custom tmux dashboard from "My Gas City Setup: Adversarial
Agents, TDD, and a Custom tmux Dashboard" (`/home/ds/gas-city/pngs/dashboard_tmux_example.png`,
video `https://www.youtube.com/watch?v=bYPkQisCag8`). That console is the `gc`
supervisor's own operator surface — the exact thing `tui/` exists to replace with a
calmer, honest, read-only glance surface (`tui/README.md` "What it is and is not").

This is an audit, not a plan. It maps every pane in the screenshot to current TUI
coverage, judges portability against the binding register (`DESIGN.md`), records what the
`shared` DTOs actually back, and ends in a prioritized candidate list. It does **not**
authorize any UI to merge — each candidate still owes its own bead, test, and (for
anything rendered) a `DESIGN.md` review via `gascity-dashboard-review-pr`.

## The register that bounds any port

`DESIGN.md` is written for the web client but the TUI inherits the same absolutes (its
README cites the Greyscale Test and the no-color-as-signal rule). Every borrow below is
judged against:

- **The Greyscale Test / One Mark Rule.** Strip color: every state must still read. Maroon
  (here: the single red mark) appears at most once per viewport. The screenshot's
  red/amber/green status-dot grid violates this directly and cannot be ported as-is.
- **Status is a sentence / paired with a word or glyph.** Counts and states are typeset,
  not encoded in hue.
- **Read-only + 127.0.0.1 posture.** No pane-attach (`capture-pane` bypasses the
  server-side ANSI/OSC sanitisation that is the load-bearing XSS defence); no writes
  (claim/close/sling/respond/compose need the CSRF double-submit the web client has).
- **Honest signal.** Never fabricate a value the wire doesn't back (the TUI already does
  this for cost: Health says *not measured*, `tui/src/panes.tsx:418`).
- **No em dashes in UI copy** (commas/colons/periods/parentheses).

## Pane-by-pane inventory

| # | Screenshot pane | What it is | Current TUI coverage | Portable in register? | Data backing |
|---|---|---|---|---|---|
| 1 | Live agent pane (webcam + Claude scrollback) | Attached tmux client of a working agent | **None, by design** | **No** — pane-attach is explicitly rejected (XSS/sanitisation, 127.0.0.1) | n/a |
| 2 | Agent task list ("4 tasks: 1 done, 1 in progress, 2 for agents") | The agent's own todo breakdown | None | Maybe — only if read-only and backed | Not exposed by `/api/*` today (no per-session task list DTO) |
| 3 | "User declined to answer questions" Q&A | Awaiting-human-decision gate | None | Yes, but it's a **write** affordance | Backed (`PendingInteraction`), already scoped by the tmai/amux PRD as dashboard-local write work |
| 4 | Footer: version current/latest, `97998 tokens` | Build version + token/cost counter | Health shows *not measured* | Counter: only if data flows | Cost fields exist on `WorkerOperationEventPayload` but are "currently always absent" (`cost-token-feasibility.md`) |
| 5 | **rig × lifecycle-state count matrix** (rigs × review/ok'd/ready/active/stalled/PR/block/**done**/others, with per-row totals) | Whole-city-at-a-glance board | **None** — Beads groups by status (one axis); Health is a vertical list | **Partly** — in-flight phases port as a greyscale count grid + one red mark; the `done`/total/`others` columns do **not** (see caveat) | **In-flight phases backed today** (`RunLane.health.data.phase: RunPhase` + `byPhase: Record<RunPhase, number>`, `shared/src/snapshot/types.ts:254,348`; per-rig grouping via `groupRuns`/`laneRig`, `tui/src/derive.ts:316,253`). **`done`/total NOT backed**: historical `complete` lanes are capped in the snapshot DTO (`shared/src/snapshot/types.ts:213`), so the big cumulative counts (371/609/total) are not in the data the TUI fetches |
| 6 | Workers panel (`coherence/workers.worker-opus`, ids + ages) | Pool/worker roster per rig | **Agents** view (`AgentRow`, grouped by rig) | Already shipped | `GcSession` |
| 7 | control-dispatcher panel + "awaiting gc prime initialization" + "(+3 more sessions)" | Orchestration agent + activity + fold | **Agents** (orch `△`) + `activityPhrase` + `+ N more` | Already shipped | `GcSession.activity`/`reason` |
| 8 | NEEDS REVIEW panel | Items flagged for the operator | **Ledger** + Health "runs needing operator" | Already shipped | `RunLane.health.needsOperator` |
| 9 | Per-session age / last-active (`28d; 1h ago`) | Recency | `relativeTime` everywhere | Already shipped | `GcSession.last_active` |
| 10 | outbox / compose (`Ctrl+F11 send`, autosaved draft) | Compose & send mail | **None, by design** | **No** — write affordance, read-only guard | Backend mail is read-only in TUI |

## Findings

**Already covered (no work):** panes 6, 7, 8, 9. The TUI's Agents/Ledger/Health views
already render the worker roster, orchestration activity, the needs-review queue, and
recency, in-register. The screenshot's versions are denser and louder; ours are the calmer
translation that was the point.

**Out of scope by standing constraint (do not build):** panes 1 and 10 (pane-attach,
compose/send) violate the read-only + 127.0.0.1 + sanitisation guards. These are not
"not yet" — they are deliberate rejections recorded in the README.

**Already owned by the tmai/amux PRD (do not re-litigate here):** panes 3 (awaiting
decision) and 4 (token/cost). Both are scoped, with feasibility findings committed
(`awaiting-decision-signal-feasibility.md`, `cost-token-feasibility.md`). The decision gate
is buildable dashboard-local write work gated on a `DESIGN.md` review; cost rendering is
gated on the supervisor populating the always-absent fields. The TUI is read-only, so the
decision gate would land in the **web** client first; the TUI could later show a read-only
"awaiting decision" *sentence* (no affordance) once the signal is plumbed.

**Genuinely new and liftable:** pane 5, the rig × phase matrix. It is the one idea with no
current TUI equivalent, it is backed by DTOs we already fetch, and it translates cleanly
into the register as a greyscale count grid.

## Prioritized candidate improvements

### P1 — City board: rig × phase count matrix (new TUI view)

The standout borrow. A compact grid: rigs as rows, run phases as columns, tabular counts in
cells, a single red mark on the column/cell that means a human is needed.

- **Data:** pure derivation over `RunLane[]` the TUI already has. Group by `laneRig`
  (`tui/src/derive.ts:253`), count by `RunLane.health.data.phase` per group. The phase
  vocabulary is **ours**, not the screenshot's: `intake / implementation / review /
  approval / finalization / blocked / complete / active` (`shared/src/snapshot/types.ts:462`).
  Map to readable column heads (e.g. `intake→ready`, `implementation→active`,
  `approval→ok'd`, `finalization→PR`, `blocked→block`). Do **not** invent a column the
  phase enum can't back.
- **Caveat 1 — "stalled" is not a phase.** In our model it's a time-derived signal the
  frontend computes from `RunLane.updatedAt` + resolved session activity on a 1s clock
  (`shared/src/snapshot/types.ts:301`, `phaseConfidence === 'known'` gate). The TUI today
  only reads `needsOperator`, not a computed stalled tier. So a faithful `stalled` column
  is one piece needing new derivation; ship the matrix with `needsOperator` as the red-mark
  source first, add a computed stalled column only if it earns its place.
- **Caveat 2 — `done`/total/`others` are not backed (honest-signal blocker).** The
  screenshot's large `done` counts (371, 609) and per-row totals are cumulative history.
  The dashboard's live `RunLane[]` snapshot carries *active* lanes; historical `complete`
  lanes are **capped** in the DTO (`shared/src/snapshot/types.ts:213`), so those totals are
  not in the data the TUI fetches. Mapping `RunPhase = 'complete'` to a `done` column would
  show a confident, wrong number. **Omit `done`/total/`others`** from the first build; a
  faithful historical column needs a separate aggregate source that `/api/*` does not expose
  today (a spike, not a build, same path as cost/decision). `others` has no clean phase
  mapping and is dropped, not invented.
- **Scope to in-flight phases only:** build over `intake/implementation/review/approval/
  finalization/blocked/active` (the live `byPhase`), not `complete`.
- **Register:** greyscale counts (tabular figures, aligned). One red mark total — on the
  `block`/needs-operator column when nonzero. Column heads are tracked labels, not tinted.
  No grid borders if whitespace alignment carries it; Ink box widths already do this in
  `panes.tsx`.
- **Risk:** low. Read-only, no new dep, no backend change. Erosion risk is column sprawl —
  keep to phases the enum backs.
- **Owes:** a bead, `derive.ts` unit tests for the per-rig×phase counter (TDD, the
  `derive.test.ts` pattern), a `DESIGN.md` review for the rendered grid.

### P2 — Read-only "awaiting decision" sentence in the TUI

Once the web client's decision gate (tmai/amux PRD) plumbs `PendingInteraction` through the
backend, surface it in the TUI's Ledger as a **read-only sentence** ("agent X is awaiting a
decision on Y"), no accept/decline affordance (that stays in the CSRF-protected web client).

- **Data:** backed (`PendingInteraction`), but **blocked on** the web-side plumbing landing
  first. Not startable standalone.
- **Register:** status-is-a-sentence; folds into the existing Ledger "waiting on you"
  section; red mark only if it crosses the existing needs-operator threshold.
- **Risk:** low once unblocked. Owes: bead dependency on the PRD's decision work.

### P3 — Per-session task breakdown (investigate only)

Pane 2 (the agent's todo list) is appealing but **unbacked**: no `/api/*` DTO carries a
per-session task list today. This is a feasibility spike, not a build: confirm whether the
supervisor exposes a session task/todo structure over `GcClient` HTTP. If absent, it routes
to the same upstream-filing path as cost/decision, with a committed `specs/` finding — not a
fabricated list. **Do not** synthesize tasks from transcript scraping (honest-signal rule;
same reasoning as the deliberately-deferred session summary, `tui/README.md` Sessions).

## Non-goals (carried from constraints, recorded so they are not re-proposed)

- No tmux pane-attach / `capture-pane` rendering (pane 1).
- No compose/send or any write affordance in the TUI (pane 10); writes belong to the web
  client with CSRF.
- No faked token/cost counter (pane 4) until the supervisor populates the fields.
- No status-by-color: the screenshot's dot grid is re-expressed as greyscale counts + at
  most one red mark.
- No synthesized per-session task list (pane 2) absent a real DTO.
- No `done`/total/`others` columns in the city board until a historical aggregate source is
  confirmed over `/api/*` (the live snapshot caps historical lanes); first build is
  in-flight phases only.

## Recommended next step

Build **P1** behind a bead, TDD-first (`derive.ts` counter + tests before the pane), with a
`DESIGN.md` review on the rendered grid. P2 waits on the web decision work; P3 is a spike,
not a build.
