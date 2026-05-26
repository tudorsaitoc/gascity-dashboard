# PRD — Workflow Observability in the Gas City Dashboard

**Status:** Converged draft (post diverge → converge). Risk annotations appended by premortem.
**Source pipeline:** `/brainstorm 30` (30 shape-unique ideas, see
`workflow-observability-brainstorm.md`) → 3-lens diverge (IA, backend, product) → converge
(this doc) → premortem (Risks §).
**Grounding:** `workflow-observability-grounding.md` (sibling), `DESIGN.md`, `PRODUCT.md`,
csells branch `csells/workflows-formula-runs` (run-detail plan + SVG mockup at
`specs/plans/workflow-run-detail-plan.md` on that branch).

---

## 1. Problem

The operator's primary question — **"is anything off?"**, asked several times an hour from a
peripheral tab, answerable in under a second — has **no single home**. She must scan three
surfaces (Workflows lane strips, Maintainer triage queue, Activity log) and mentally OR them.
Her secondary question — **"what's happening with X?"**, answerable in two clicks — is
**unmet**: Workflows rows are not clickable and there is no run-detail surface. The three
surfaces also independently re-derive overlapping notions of "active / stuck," so they can
disagree.

## 2. Decision (the resolved thesis)

Do **not** add a fourth overlapping surface, and do **not** build a speculative ambient layer
first. Instead:

1. **Ship two NEW things, keep/repurpose the rest.** The two genuinely new surfaces are an
   **adaptive home (`/`)** that answers "is anything off?" and the **csells run-detail
   (`/workflows/:id`)** that answers "what's happening with X?". Everything else is kept and
   demoted or enriched, not deleted.
2. **Attention has three conceptual depths but only two scan-surfaces.** The brainstorm's
   "L1 Needs-You" is **not a third route** — it renders as the *concern region of the home
   page* (IA lens) and is *also* a default view over the existing Maintainer surface
   (product lens). It is a lens, not a new place.
3. **One shared health derivation, computed once in the backend snapshot collector**, feeds
   the home signal, the favicon, and (later) the run-detail annotations — so the surfaces
   stop disagreeing. MVP ships the *minimal* version of this engine, not the full census.
4. **The glance is deterministic, never LLM-generated.** Trust is the whole product; a
   hallucinated or latency-bound "nothing is failing" is fatal.

### Why not "just ship csells L2 and stop"
L2 only serves the *less frequent* investigation mode; you reach it only once you already know
something is off. The ambient-glance mode is the operator's primary, several-times-an-hour
behavior and is the one job no existing surface does. So L2 alone fails the more common case.

### Why not the full 3-layer / full-engine build
Leading with an LLM Standing Sentence + a census/confidence/forecast engine is "platform
before product." The value concentrates in two cheap pieces (favicon signal + a deterministic
status line) plus finishing an asset that is already ~70% built.

## 3. Surface architecture (resolved)

| Surface | Route | Disposition | Job |
| --- | --- | --- | --- |
| **Home (Standing)** | `/` (new default; today redirects to `/agents`) | **NEW** | "Is anything off?" — hybrid glance: a deterministic phase-census line + a template status sentence; concern region materializes decision-pending items inline. |
| **Run-detail** | `/workflows/:workflowId` | **NEW (csells)** | "What's happening with X?" — vertical graph.v2 graph + Diff/Session split. Terminal drill-in. |
| Workflows index | `/workflows` | KEPT, demoted | Thin index; rows become deep links into run-detail. |
| Maintainer / Triage | `/maintainer` | KEPT, + "Needs you" default view | Full triage (tiers, clusters, sling, draft-PR) stays; a composed default filter surfaces decision-pending items, cross-linked to run-detail. |
| Activity | `/activity` | KEPT, phase-2 enrich | Later: "Annotated Edition" interpretive layer + SSE. |
| Agents / Health / Beads / Mail | unchanged | KEPT | — |

**Honest win statement:** route count does not drop (it nets ~flat). The win is reducing the
number of surfaces the operator must **scan to answer "is anything off?"** from three to one.

## 4. The home glance, designed (Reading-Room compliant)

Two typographic registers in one component:

- **Line 1 — phase-census (the <1s pattern-match target).** Headline scale, tabular figures,
  interpunct separators: `3 in flight · 1 waiting · nothing failing`. Deterministic counts,
  **no model call**. Its *shape* changes when state changes (`nothing failing` → **`1 failing`**
  in maroon), which is what peripheral vision actually catches. This is the trust anchor.
- **Line 2 — template status sentence (the lean-in read).** Body scale, ≤70ch, prose
  assembled from structured facts: *"adopt-pr-271 has waited on a review verdict for 22 min;
  nothing is blocked, nothing is waiting on you."*

**One Mark Rule:** at most one maroon per viewport. It lands on the single most-severe **run-id
token** (rank-broken by oldest stall), and that token *is* the deep link. Other concern clauses
use weight 600, not color. Greyscale-safe (carried by lede-position + weight + the word
"waited 22 min").

**Concern region:** when items need a decision, they materialize *beneath the sentence on the
same page* via opacity (reserved space, never animate height; respects
`prefers-reduced-motion`). Each row is the same deep link + an inline sling action. A persistent
quiet tail link **"· 14 more in triage"** shows the filter's denominator so "calm" is never
silently scoped.

## 5. Drill mechanics — the two-click contract

- **Path A (alerted, primary):** the maroon run-id token in the sentence is
  `<a href="/workflows/:id?node=:stuckNodeId">`. The engine already derived *which node*
  stalled, so it deep-links the selection. **One click → run-detail with the offending node
  selected, Session tab live.** This is the concrete reason the home layer beats shipping
  csells alone: it collapses 3 clicks (row → arrive → hunt+select node) to 1.
- **Path B (decision region):** inbox row primary text = same deep link (1 click); sling is a
  separate same-row affordance.
- **Path C (browse):** `/workflows` row → run-detail (no node preselected) → click a node.
  Two clicks, correctly slower than the alert path.

**Requirement:** the health engine must emit, per stalled run, the **semantic node id** of the
stall (not just "this run is stuck"). `WorkflowLane` gains a `stuckNodeId?` field.

## 6. Data & feasibility (the load-bearing engineering reality)

- **gc emits NO heartbeat and NO per-entity progress event (CONFIRMED, spike `6eu`).** The city
  stream carries only discrete state-change events (`KnownEventTypes`, gascity
  `internal/events/events.go:126-151`); `HeartbeatEvent` is an SSE keep-alive only;
  `SessionActivityEvent` (idle/in-turn) emits only on transitions. **This closes the R2 escape
  hatch** — staleness cannot be re-keyed onto a per-entity progress SSE; it must be derived.
- **`bead.updated_at` bumps on EVERY metadata write (CONFIRMED).** gascity
  `beads/internal/storage/issueops/update.go:156` sets `updated_at = ?` unconditionally, so a
  wedged retry loop rewriting `gc.attempt` looks perpetually fresh. **Bead-time alone is NOT a
  usable staleness signal** (R1 confirmed).
- **`session.last_active` bumps on ANY tmux pane I/O (CONFIRMED).** `runtime/tmux/tmux.go:1898-1915`
  counts streaming output AND send-keys, so long *noisy* compute correctly stays "active"; only a
  truly *silent* step trips a false idle (R8 largely mitigated). It is the closest real activity
  signal we have (`shared/src/index.ts:29-31`).
- **Resolution — the bead×session join + progress-monotonicity is the PRIMARY signal, not a
  fallback.** Since neither bead-time (unusable, Q1) nor a progress SSE (does not exist, Q2) is
  available, classify a lane *stalled* from: `max(bead.updated_at)` old **AND** the assigned
  session idle (`last_active` old / `activity==='idle'` / `running===false`), **PLUS** the
  freshness-independent progress-monotonicity predicate (R1: `attempt`/`iteration` climbs while
  the node's graph position does not advance). Deterministic, shippable now; the inference layer
  carries the load until a real gc heartbeat exists.
- **`gc.outcome` is UNRELIABLE (CONFIRMED).** Empirically near-empty on closed beads (0/2032 in
  gascity, 0/14460 in gc-db, ~11% in codeprobe and all of those just `"pass"`); set only by
  `internal/dispatch/*.go`, never by `bd close`. **Treat absence as `outcome: unknown`, never as
  "failed" or "missing data"** (R4).
- **Confidence (#22) is derivable today as provenance, not judgment:** `phaseConfidence =
  'known'` iff a formula matched AND an active `gc.step_id` resolved into a stage; else
  `'inferred'` (the generic 5-stage fallback / the `includes('blocked')` string-sniff at
  `phaseMapping.ts:46`). ZFC-clean (a structural fact about which code path fired).
- **Heartbeat roadmap (Q5):** `gastownhall/gascity#1855` (P3, open) proposes a `gc bd heartbeat`
  wrapper writing `metadata.gc.last_heartbeat_at`; `#324` is the downstream consumer, `#571` a
  controller sweep. No `phase_known` flag is planned. **Design the confidence/staleness field to
  CONSUME `metadata.gc.last_heartbeat_at` when #1855 lands** — until then the join +
  progress-monotonicity inference is load-bearing, not optional.
- **Engine location: backend snapshot read path** (resolved in P2a `gascity-dashboard-3ax`,
  corrected from the original "inside the workflows load"). The derivation runs in the
  service composition layer *after* both the workflows source and a **shared sessions cache**
  settle — the workflows loader fetches only beads and must not gain a 2nd `listSessions`
  (R2), so the bead×session join cannot live inside it. Shipped on `/api/snapshot`; inherits
  the existing 60s TTL + bypass-refresh + `bead.*` SSE flow for free. **R9-strict (resolved in
  P2a):** the server ships *facts* — raw ISO timestamps, session liveness fields,
  `phaseConfidence`, and the one cross-cycle signal it alone can compute (`thrashingDetected`,
  the R1 progress-monotonicity result) — plus a *threshold-independent* census (`byPhase`,
  confidence-scoped denominators). It does **not** ship a staleness-tier enum or a
  by-staleness-tier census: the staleness threshold crossing and *age display* are computed in
  the 1s-ticking frontend selector (kb3), because a server-frozen tier would under-count for up
  to the cache TTL on a pure-time stall crossing (R9).
- **Standing Sentence = deterministic template** in the collector, emitted as
  `standingSentence: string[]` (clauses, each carrying its lane id + stuck node id). Enforces
  the no-em-dash style rule trivially. **No API key, no cache layer, no hallucination path.**
- **csells reuse:** adopt `enrichWorkflowRun` (`enrich.ts`) as the L2 backbone as-is — it
  already produces the node-status vocabulary (`pending|ready|running|active|done|completed|
  failed|blocked|skipped`), `attemptBadge` ("2/3"), iteration counts, session links, and the
  `session-stream.ts` SSE proxy. **Extract its status/attempt pure functions into a shared
  `shared/src/workflow-status.ts`** imported by both the list-driven L0 collector and the
  per-run L2 enricher, so "blocked / attempt-N" means one thing everywhere. Data *paths* stay
  separate (city-wide list-beads for L0; per-run `getWorkflow` for L2); *vocabulary* unifies.

## 7. Sequencing

- **Phase 0 — Smooth the path for L2 (no branch rebase).** `csells/workflows-formula-runs` is
  actively owned by csells; we do **not** rebase or rewrite it. Our actionable piece: land the
  `sse-proxy.ts` extraction on `main` (bead `pyg`, done — commit `b83ea14`) so their next merge of
  main into their branch picks up an identical module as a no-op. L2 itself reaches `main` via
  *their* PR, on their schedule (bead `syl`, csells-owned). Everything above L2 deep-links *into*
  run-detail, so we don't build the home layer's deep-links until L2 is on main.
- **Phase 1 — Finish & ship L2.** Complete run-detail per the csells plan's first-pass scope
  (graph.v2 only; step/retry/check-loop/scope/expansion/condition/fanout). Make `LaneCard`
  navigable. "Two clicks" promise: unmet → met.
- **Phase 2 — Thin L0.** Add the one shared staleness/confidence field + `stuckNodeId` to the
  snapshot collector; wire favicon + tab-title ambient signal (#14); add the phase-census line
  + template status sentence on the new `/` home. Additive; no L2 rework.
- **Phase 3 — L1 as a Maintainer refinement.** Add a "Needs you" default view over the
  existing Maintainer filters (changes-requested + human-approval-gate + stall predicates);
  cross-link items ↔ run-detail. No new route, no new EventSource.
- **Phase 4+ (evidence-gated).** Full health engine *only if a 2nd/3rd consumer appears*
  (YAGNI); Activity "Annotated Edition"; and the one phase-2 analytic bet (§9).

## 8. MVP scope

**In:** finished+merged csells L2; clickable Workflows rows; favicon/tab ambient signal; one
phase-census line + one template status sentence on `/`; the single shared staleness+confidence
field (bead×session join) + `stuckNodeId`, computed once in the collector.

**Explicitly NOT in MVP:** LLM-generated prose; the full census/confidence/forecast engine;
L1 as a new route; Activity annotation; Calm/Concern whole-page flip; all §9 analytics.

## 9. Anti-scope and the one phase-2 bet

Traps (all need a historical baseline or dependency-edge graph the dashboard lacks; several
flirt with the Datadog/Grafana density the design contract bans): **#8 forecast**,
**#6 jam map**, **#24 question-driven view**, **#25 semantic zoom**.

**Highest-leverage phase-2 bet: #9 run-vs-typical deviation** — and only because once L2
renders per-run node timings, "typical duration per step" is a near-zero-marginal-cost
byproduct. It sharpens staleness from absolute ("waited 22 min") to relative ("3× typical for
this step"). It is the only analytic whose data dependency is *created by the MVP* rather than
requiring new infrastructure.

## 10. Success metrics (audience of one)

Weight the asymmetry: **a missed alarm ≫ a false alarm ≫ slight latency.**

- **Median tab-dwell-time per visit goes DOWN, visit-frequency flat/up** (glance works: read
  and leave). Rising dwell = she's hunting = signal failed.
- **Click-to-answer depth ≤ 2** from a favicon-alerted visit to the relevant run-detail node.
- **Favicon false-alarm rate** (signal goes concern, operator does not drill) — alarm fatigue
  is fatal; tune thresholds against this.
- **Three-surface-scan elimination** (route-nav logs: a "checking" session used to touch
  Agents+Health+Workflows; after, it touches `/` and stops).
- **Misses tracked explicitly** (something was off, signal stayed calm) — the killer defect.
- n=1 qualitative two-week self-report is legitimate and high-value here.

## 11. Data questions — ANSWERED (spike `gascity-dashboard-6eu`, code-grounded against gascity)

1. **`bead.updated_at` on metadata-only rewrites?** — Bumps on EVERY write
   (`beads/internal/storage/issueops/update.go:156`, unconditional `updated_at = ?`). **Bead-time
   alone is NOT usable.** R1 confirmed.
2. **Per-entity progress/activity event on the city stream?** — NO. Only discrete state-change
   events (`internal/events/events.go:126-151`); `HeartbeatEvent` is SSE keep-alive,
   `SessionActivityEvent` emits only on transitions. **The R2 escape hatch is closed** — staleness
   cannot be re-keyed onto SSE arrival-time; the bead×session join is inherited as the path.
3. **`session.last_active` cadence?** — Bumps on ANY tmux pane I/O (`runtime/tmux/tmux.go:1898-1915`:
   streaming output AND send-keys). Long noisy compute stays "active"; only truly silent steps trip
   a false idle. R8 partially mitigated.
4. **`gc.outcome` reliable on closed beads?** — UNRELIABLE. 0/2032 (gascity), 0/14460 (gc-db),
   ~11% (codeprobe, all `"pass"`); set only by `internal/dispatch/*.go`, not by `bd close`. **Treat
   absence as `unknown`, not "failed".** R4 resolved.
5. **gc-native heartbeat / `phase_known` roadmap?** — Heartbeat planned but unimplemented:
   `gastownhall/gascity#1855` (P3, open, the canonical worker-heartbeat issue) proposes
   `metadata.gc.last_heartbeat_at`; `#324` downstream consumer, `#571` controller sweep. No
   `phase_known` flag planned. **Consume `metadata.gc.last_heartbeat_at` when #1855 lands.**

**Net design implication:** the primary staleness signal is the **bead×session join +
progress-monotonicity predicate** — neither bead-time (Q1) nor a per-entity progress SSE (Q2)
exists today, so the inference layer is load-bearing. Watch #1855 for a real heartbeat to consume.

## 12. Risks & forced design changes (premortem-annotated)

The premortem surfaced findings that **change the spec above**, not just risks to watch. The
spec-changing ones are marked **[SPEC CHANGE]**.

### R1 — Silent miss on thrashing retry/poll loops (CRITICAL, most likely cause of death)
The §6 bead×session join classifies stalled only when **both** bead-time is old AND session is
idle. The dominant real stall — a check-loop/retry node spinning attempts, or an agent in a
`gh pr checks --watch` poll — keeps **both** signals fresh (bead `gc.attempt` rewrites every
cycle; session emits a tool call every tick), so the join scores the deadest run as the
healthiest. The home then asserts `nothing failing` in a confident headline for hours; the
first such miss permanently demotes the surface to "one more thing that lies."
**[SPEC CHANGE] Add a third, freshness-independent predicate to §6: progress-monotonicity.**
`stalled-thrashing` = `attempt`/`iteration` count climbs ≥N while the node's graph position
does not advance, OR node-elapsed > K× the §9 typical for that step. Ship in Phase 2 with the
join, not deferred. *Leading indicator:* first entry in the §10 Misses metric.

### R2 — The bead×session join is a cross-collector dependency the cache doesn't model (CRITICAL)
`collectors/workflows.ts` fetches **only beads**; `session.last_active` lives in a *separate*
`cityStatus` collector with its own `SourceCache`. The only bridge is `bead.assignee →
session`, the lossy 4-step `resolved_session_name` resolution the codebase already flags
(`shared/src/index.ts:471-495`); role-pool dispatch routinely fails it, leaving the idle-half
`undefined` → lane scored not-stalled.
**[SPEC CHANGE — updated by spike `6eu`]** The hoped-for escape hatch (re-key onto a per-entity
progress SSE) is **closed**: Q2 confirmed the city stream has no progress event, and `bead.*`
state-change arrival ≈ `updated_at` churn (equally fooled by thrashing). So the join **cannot be
eliminated** — it is the inherited path. Mitigations stand and are now mandatory: (a) any lane
whose assignee does not resolve to a live session is `phaseConfidence:'inferred'` and **must not**
drive the maroon One Mark (degrade to weight-600); (b) do **not** add a second `gc.listSessions()`
to the workflows loader — read the existing cityStatus session data via the service layer;
(c) the join is backstopped by the R1 progress-monotonicity predicate, which is the only signal
robust to the thrashing case. When `gc#1855` lands, consume `metadata.gc.last_heartbeat_at` as the
direct liveness key and demote the join to a fallback.

### R3 — csells SSE proxy module + branch integration (HIGH) — RESOLVED on the our-side half
csells `backend/src/routes/session-stream.ts` imports `./sse-proxy.js`; on main the proxy was
*inline* in `events.ts:82-119` (incl. a documented disconnect-while-backpressured connection-leak
guard). A hand re-implementation could reintroduce that leak (one orphaned upstream fetch +
dangling heartbeat timer per abandoned drill-in — and the operator abandons constantly).
**Corrected framing (see beads `zg1`/`syl`): we do NOT rebase the csells branch — it is actively
owned by csells.** Instead we extracted `events.ts:82-119` into `backend/src/routes/sse-proxy.ts`
on main (bead `pyg`, commit `b83ea14`), byte-identical to the module their branch authored and
imports. When *they* next merge main into their branch (their schedule), it reconciles as a near
no-op. The branch's `SESSION_ID_RE` allow-list is preserved in their copy. Our half is done; the
remaining half is their PR landing L2 on main.
*Leading indicator:* admin `rss_bytes` climbing across a day of drilling = the leak guard was lost
in their merge — re-check `sse-proxy.ts` survived intact.

### R4 — The shared `workflow-status.ts` extraction is unsound for status (HIGH)
L0 `phaseMapping.ts:46` derives phase from a substring sniff (`includes('blocked')`) → 8-value
*lane* phase. L2 `enrich.ts presentationStatus` keys off `gc.outcome` → 9-value *node* status.
Different cardinality, different granularity. Unifying drives **false maroon** (a description
containing "unblocked" → `1 failing` in the census) or **flattens the graph** (loses
failed/skipped coloring).
**[SPEC CHANGE to §6 — Q4 now answered]** Extract **only the attempt/iteration arithmetic** into
the shared module; keep two status vocabularies. Never route the `includes('blocked')` sniff into
a maroon-driving field. Spike `6eu` confirmed `gc.outcome` is effectively absent (0/2032 closed
gascity beads), so L0 **cannot** derive `failed` from it — the unification is decided against:
treat a closed bead with no outcome as `unknown`, never `failed`. Even L2's node coloring must not
paint `failed` from a missing outcome.

### R5 — "Calm" silently scoped over inferred-confidence runs (HIGH)
The "· N more in triage" denominator covers the *triage* slice, but inferred-confidence
*workflow* runs (unmatched formula → generic fallback) fall in neither the census nor the
concern region nor the triage denominator — a third epistemic bucket presented with the same
calm as known-good.
**[SPEC CHANGE to §4]** The census carries its **own confidence-scoped denominator**: when any
in-flight lane is `inferred`, it reads `3 in flight · 1 unverifiable · nothing failing (of 2
known)`. One inferred run changes the sentence *shape*. Never report calm over a population the
engine admits it can't classify.

### R6 — Deterministic template asserts absence it can't verify (HIGH, slow erosion)
Negative reassurance clauses ("nothing is blocked, nothing is waiting on you") are true-by-
clause but false-by-gestalt (e.g. a CI verdict already failed but hasn't transitioned the bead
to a "needs-you" state). Determinism removes hallucination, not misleading composition.
**[SPEC CHANGE to §4]** **The sentence may report what it sees, never certify what it doesn't.**
Drop all negative reassurance clauses; state only positive directly-derived facts. Absence of a
concern clause *is* the calm signal. *Leading indicator:* dwell-time rises on visits whose
sentence ended in a reassurance clause (she's re-checking it).

### R7 — §9 deviation bet starves the MVP (HIGH — most likely *design/scope* death)
"Near-zero-marginal-cost" is the lie: per-step "typical" needs a persistence layer (the
dashboard has none), a baseline backfill, outlier handling, and a *semantic* "what is typical"
decision the team will relitigate — while the cheap trust anchor (favicon + census) slips.
**Mitigation (hard merge-gate):** no persistence layer lands until all five §8 MVP bullets are
green **and** the operator self-reports the glance working for one full week. Note the tension
with R1, which wants the §9 "typical" for its K× predicate — resolve by shipping R1's predicate
first on *absolute* attempt-velocity (no baseline needed), adding the K×-typical refinement only
in Phase 4.

### R8 — Alarm fatigue disarms the recovery channel (MEDIUM → downgraded by spike `6eu`)
The fear was: if `last_active` ticked only on state-transitions, a healthy 9-min test step would
read idle and train the operator to ignore the maroon. **Q3 answered: `last_active` bumps on ANY
tmux pane I/O (streaming output AND send-keys), so long noisy compute stays "active"** — only a
*truly silent* step trips a false idle, a much narrower window. The acute version of this risk is
mitigated. Residual mitigation still worth keeping: **favicon hysteresis** — require the stall
predicate to hold two consecutive snapshot cycles AND a positive signal (no pane I/O AND no diff
change AND flat attempt count), not mere `last_active` age. The favicon is the trust instrument of
last resort; flip it only on high-confidence multi-signal multi-cycle concurrence.

### R9 — Frozen stall-tier inside the 60s TTL (MEDIUM)
Tier is computed once and frozen in the cached snapshot for up to `WORKFLOWS_CACHE_TTL_MS=60s`
(`workflows.ts:40`); a stall crossing at second 5 stays green until second 60 while the client
ticks the age label past the threshold — the worst trust signal (the number that should alarm,
shown calm). Worse, `Workflows.tsx:63` skips bypass-refresh when source is `stale`, pinning the
tier to pre-stall data exactly when gc is degraded (`cache.ts:175` stale-while-error).
**[SPEC CHANGE to §6]** Compute the stall **tier** in the same 1s client selector that computes
the **age** (it has the raw ISO timestamp + a constant threshold) so tier and age share one
clock. Server ships facts; client owns the threshold crossing.

### R10 — Two-surface overlap (`/` vs `/workflows`) never resolved → merges back into sprawl (MEDIUM)
§3 admits route count nets flat and never defines what `/workflows` shows that `/` withholds, so
`/` accretes healthy runs "while we're here" and `/workflows` becomes vestigial — re-creating
"everything competes for attention."
**[SPEC CHANGE to §3] Withholding contract:** `/` shows ONLY the census line + items that need a
decision or are failing/stalled; it **never lists a healthy in-flight run**. `/workflows` is the
only place a calm in-flight run is enumerated. Test: on a fully-calm city, `/` shows the census
line and nothing else; `/workflows` shows N healthy rows. A calm run on `/` = rejected PR.

### R11 — Drift to Datadog: census line → labeled KPI count-grid (MEDIUM)
The csells page header *already* uses a four-column labeled count strip (`STATUS / DONE / PENDING
/ SELECTED`) — the precedent is in the adopted asset. Column-aligning + per-count labels +
per-count color dots is individually defensible at each step and lands on the "five KPIs across
the top" anti-reference, breaking **The One Mark Rule** (two colored buckets) and **Status is a
sentence, not a swatch**.
**Mitigation (CI gate):** make `scripts/snap.mjs` + the **Greyscale Test** a CI gate on `/` and
`/workflows/:id`; assert **≤1 maroon-class element per viewport** in the DOM. Rule: Line 1 is a
sentence with interpunct separators — no per-count label, no per-count color, ever; severity
lives in the single maroon run-id token. (This one gate also catches R10, R12, and stray marks.)

### R12 — The run-detail graph is a foreign object (LOW, but erodes rule authority)
A 15-node nested-scope-box DAG inside a "bookish, flat, no-chartjunk" system structurally
violates **The Flat Page Rule** (scope boxes *are* containers). The SVG's color restraint masks
that it can't be flat. Tolerated silently, it teaches reviewers the Reading Room rules are
optional.
**Mitigation:** write a **named, bounded exception** into DESIGN.md: the run-detail graph is the
one place containers are structural (a run *is* a dependency graph; space+type can't encode
edges). Constraints that still bind: one maroon (selected node only); node state via
stroke+weight only (the SVG's `.done`/`.running`/`.pending`), never fill-color; no shadows on
scope boxes; monospace only inside the transcript.

### R13 — Needs-You fractures into a 4th route (LOW, cleanest to prevent)
Because the concern region sits below the fold, pressure to deep-link "just my decisions" spawns
`/needs-you` → a nav entry → four scan-surfaces, *more* than the original three.
**Mitigation (merge-block, already implied by §7 Phase 3):** no new route, no new EventSource for
Needs-You. Discoverability = a `/#needs-you` fragment anchor + the `/maintainer?view=needs-you`
filter. Review test: *does this add a router entry? Then it's a place, and it's rejected.*

### The single highest-leverage guardrail
Make `scripts/snap.mjs` + Greyscale Test a **CI gate on `/` and `/workflows/:id`** with a "≤1
maroon element per viewport" DOM assertion. It catches four of the visible design death-modes
(R10, R11, R12, stray marks) before merge. The two non-visual killers (R1 silent-miss, R7
scope-starve) are caught by the Misses metric tripwire and the §8-all-green merge-gate
respectively.

### Through-line
Every trust failure (R1, R5, R6, R8) is one root cause in four masks: **the home page makes
claims about *absence* its data can't guarantee, in a voice calibrated to be trusted absolutely.**
The unifying fix: report presence with confidence; report the *boundary of your own knowledge*
explicitly (confidence-scoped denominators, no negative certifications, multi-signal alarms, a
stall predicate that never trusts freshness as a proxy for progress).
