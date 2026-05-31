# Grounding: Run Observability in the Gas City Dashboard

This file grounds a research-project (diverge → converge → premortem) pipeline. Read it
fully before producing or critiquing the PRD. It encodes (a) the product/design contract,
(b) the three current overlapping surfaces, (c) the csells run-detail asset, and (d) the
converged thesis from a 30-idea brainstorm. Do NOT re-derive from scratch — pressure-test
and refine THIS direction.

## The operator and the two use modes (from PRODUCT.md)

One operator (`stephanie`), maintainer of a Gas City workspace, keeps the dashboard open in
a peripheral tab. Two modes coexist and are the load-bearing requirement:

- **Ambient glance** — several times an hour, between other tasks. The question is
  **"is anything off?"** not "show me everything." Must be answerable in **under a second
  from peripheral vision**.
- **Triggered investigation** — when something IS off (stuck agent, memory spike, an
  unclaimed bead). Full attention, needs the answer **in two clicks**.

## The design contract (from DESIGN.md — "The Reading Room")

Editorial-typographic, single typeface (Inter), warm paper + warm graphite + ONE maroon
mark. Named rules that constrain every idea:

- **Quiet by default, loud on demand.** Nothing pulls the eye unless something is wrong.
- **The One Mark Rule.** Maroon appears at most once per visible viewport.
- **The Flat Page Rule.** Sections separated by space + type, not containers/cards.
- **Status is a sentence, not a swatch.** Color is last-resort emphasis; greyscale must
  stay readable. Every status pairs with a glyph or word.
- **Typeset numbers, not chart-junk.** Charts only for genuine time-series.
- Explicit anti-references: Datadog/Grafana/Splunk (density theatre), Linear/Vercel/Resend
  (dark-slate + neon + rounded cards), glassmorphism, KPI card grids.

## The three current surfaces (main branch) — and how they OVERLAP

1. **Runs** (`routes/Runs.tsx`, `components/run/{RunMap,LaneCard}.tsx`,
   `snapshot/collectors/runs.ts`). Each run root = one lane row: phase label,
   formula, a fixed 5-step glyph strip (pending/active/done/blocked), active assignees,
   status counts. Read-only, snapshot + `bead.*` SSE. **Rows are NOT clickable; no drill-in.**
   `RunSummary`/`RunLane` in `shared/src/snapshot/types.ts`.

2. **Triage / Maintainer** (`routes/Maintainer.tsx`, `maintainerSelection.ts`,
   `maintainer/{worker,classifier}.ts`). GitHub issues+PRs sorted into severity tiers,
   clustered by shared files, each row has a triage score + per-item action (sling to
   agent). Separate EventSource `/api/maintainer/events`, nightly worker. Action-centric.

3. **Activity** (`routes/Activity.tsx`). Two reverse-chron tables (commits, deploys),
   sortable, **fetch-on-demand, NO SSE**. Past discrete events.

**Overlap / gaps (the actual problem):**

- Runs and Triage both show "active work" but in different shapes (bead-hierarchy lanes
  vs GitHub priority queue) with independently-computed notions of "active/stuck."
- No drill-in from Runs → run/bead/session detail.
- No cross-link Triage ↔ Runs (an issue's run membership is invisible).
- Agent _progress_ (what a session is doing now) is invisible from Runs/Triage; you
  must visit `/agents/{session}` separately.
- Activity is uncorrelated with runs and not live.
- "Is anything off?" has **no single home** — the operator must scan three surfaces.

## The csells asset (`csells/runs-formula-runs` branch)

A proposed **run-detail graph.v2 view** (plan: `specs/plans/run-run-detail-plan.md`,
mockup SVG: `specs/plans/assets/run-run-detail-graphv2-adopt-pr.svg`). One run = a
vertical node-link graph with construct-specific node shapes (step / retry / check-loop /
scope / fanout / conditional), nodes styled by state (done / running / pending / selected /
skipped / blocked), plus a right-side split panel: **Diff tab** (git working-tree diff for
the run's execution folder) and **Session tab** (streaming coding-agent transcript for the
selected node). Backend enrichment (`runs/enrich.ts`, `runs/diff.ts`,
`routes/session-stream.ts`) ports the gasworks-gui `RunSnapshot` + `display_graph`
contract into TS. The SVG confirms the Reading-Room register (warm paper, maroon only on
the selected node + the "2 of 3" retry badge, tabular type, no chartjunk).

**This is the strongest existing answer to the "triggered investigation" mode** — but only
for one run at a time, and only graph.v2. It does NOT address the ambient-glance mode or the
three-surface overlap.

## Converged thesis (from the 30-idea brainstorm — top-rated, clustered)

**Do not add a fourth overlapping surface. Stratify observability into three concentric
layers keyed to attention depth, sharing one health-derivation engine.**

- **L0 — Ambient ("is anything off?", sub-second, peripheral):**
  - **#1 The Standing Sentence** (13/15): the home state is ONE live-generated prose
    paragraph narrating the whole city ("Three runs in flight; adopt-pr-271 has waited on a
    review verdict for 22 min; nothing is failing"). Literal application of "status is a
    sentence."
  - **#14 Out-of-canvas ambient signal** (13/15): city state encoded in tab title / favicon
    (+ optional chime) for the peripheral-tab glance — zero on-screen cost.
  - **#16 Calm/Concern whole-page flip** + **#2 Circled-Word anomaly-only**: page is calm
    until something is off, then it raises its voice with a single mark.

- **L1 — Attention ("what needs ME?"):**
  - **#7 Needs-You decision inbox** (12/15): only items requiring an operator decision
    (human-approval gates, changes-requested, stalls needing a nudge). Narrows the Triage
    surface's operator-facing part; keeps agent-dispatch. Empty state is the goal.

- **L2 — Investigation ("what's happening with X?", two clicks, full attention):**
  - The **csells run-detail graph** (existing asset) is the terminal drill-in, reached from
    any L0 sentence clause or L1 inbox item. Enriched with **#4 Margin Notes** (delta since
    last look) and the L-shared confidence/staleness annotations.

- **Cross-cutting engine (the real unifier):** a single shared **health derivation** —
  **#3 Staleness / time-since-last-progress**, **#22 Epistemic uncertainty/confidence**
  (heartbeat age, inferred-vs-known phase), and **#18 Phase-population census** — computed
  ONCE and consumed by all three layers, so Runs/Triage/Activity stop independently
  re-deriving "active/stuck."

**Reconciliation of the three existing surfaces under this model:**

- **Runs** lane strip → a thin INDEX whose rows finally drill into the csells
  run-detail (closes the no-drill-in gap).
- **Activity** → **#30 Annotated Edition**: an interpretive layer over commits/deploys
  ("this deploy unblocked 2 runs"), wired to SSE.
- **Triage/Maintainer** → narrows to the **#7 Needs-You** operator slice + keeps its
  agent-dispatch machinery.

**Honorable-mention / later (high novelty, lower feasibility — flag as phase 2+):**
#8 where-it'll-stall forecast, #9 run-vs-typical deviation, #6 jam map, #24 question-driven
view, #25 continuous semantic zoom. All need a historical-baseline or dependency-edge data
source the dashboard does not yet have.

## What the PRD must decide / pressure-test

1. Is "three layers + one health engine" actually better than shipping the csells run-detail
   alone and calling it done? What does L0/L1 add that justifies the build?
2. Where does the health-derivation engine live — backend snapshot collector, or frontend?
   What is the data source for "time-since-last-progress" and "heartbeat age" (does gc emit
   it)? This is the #1 feasibility risk for the whole thesis.
3. Does the Standing Sentence (LLM-generated prose) belong in a dashboard that must answer
   in <1s and must be trustworthy? Generation latency, caching, hallucination, and the ZFC
   rule (delegate semantic judgement to the model, keep orchestration mechanical) all bite
   here. Could it be template-driven instead of model-generated?
4. Does collapsing Triage → Needs-You lose the maintainer's existing triage run?
5. Migration/sequencing: what ships first, and does it strand the csells branch or build on
   it?
