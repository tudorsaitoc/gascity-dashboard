# PRD: Bead-ID linked view — unify beads, PRs, issues, workflows, runs, sessions

## Problem Statement

The dashboard surfaces six entity types — beads, GitHub PRs, GitHub issues, workflow runs, formula/order runs, and agent sessions — but the operator cannot navigate between an entity and everything associated with it. The associations already exist in data: bead metadata carries `gc.root_bead_id`, `gc.parent_bead_id`, `molecule_id`, `pr_review.pr_number`, `bugflow.github_issue_number`, and `gc.scope_kind/scope_ref`; the supervisor's `/beads/graph/{rootID}` already computes a multi-source bead closure; and the codebase has independently built the same "inline cross-link → adjacent read-only surface" pattern three times (AgentDetail's assigned beads, Triage's `· slung →` link, WorkflowRunDetail's per-node session links). What is missing is a single, reusable join layer and a consistent way to present it.

The research is decisive on shape: **do not build a graph visualization.** All four lenses converged on a backend-computed, bead-ID-keyed, bidirectional relation index, rendered as typeset "Related" lists woven into the detail surfaces that already exist — and on quarantining the one regex-derived edge (`Fixes #N` PR-body parsing) behind a provenance tag, since it is the codebase's single ZFC violation and a self-removing `gh`-version workaround. The load-bearing open risk is that the **GitHub→bead direction may not be reliably present in wire data** (the bead→PR direction is authoritative; the reverse requires inverting metadata, and `gh ... list` returns only open items, so merged PRs vanish from the fetched set).

## Goals & Non-Goals

### Goals

- Given any one entity (bead, PR, issue, workflow run, formula/order run, session), surface the directly-adjacent associated entities, each navigable to re-center on it (one-hop drill, not a recursive neighborhood).
- Compute the join once per snapshot in a dashboard-backend aggregation layer over supervisor-provided structure — ZFC-clean, no new read-time heuristics.
- Tag every edge with provenance/confidence (`supervisor` / `external` / `derived`) so the UI renders authoritative links prominently and weak links quietly.
- Render unresolved and ambiguous links as explicit first-class states, never silently dropped.
- Fit the editorial/ambient register in `DESIGN.md` — typeset lists under tracked labels, ≤1 maroon mark, no cards/chips/graph canvas.

### Non-Goals

- No force-directed / node-edge graph visualization (rejected by every lens; conflicts with `DESIGN.md` anti-"information theatre" rules).
- No recursive/transitive closure rendered at once — navigation is hop-by-hop.
- No multi-city aggregation (single city at a time; multi-city is a separate effort, bead `ucc`).
- No new write paths; the dashboard stays read-only.
- No persisted/materialized graph store — the per-snapshot rebuild is deliberate (it sidesteps the stale-relation invalidation bug class that dominates comparable systems).
- No supervisor-side `/related` endpoint (the supervisor has no GitHub knowledge and deliberately returns raw graph primitives).

## Convergence Outcome — resolved v1 / later split

A two-advocate debate (minimal-inline vs generalized-index) converged. Decisions:

- **Build the join layer whole but small in v1.** Decisive argument: the minimal-inline approach does not avoid the hard problems (URL sanitisation at the bead trust boundary, unresolved/ambiguous rendering, cross-clock staleness, the `Fixes #N` ZFC quarantine) — it *distributes* them across 3–5 inline copies with no compiler forcing agreement, and the 4th copy is where one silently forgets the allow-list. The codebase is already at the rule-of-three (the pattern exists 3× unnamed), and `shared/` wire-shape centralization is a stated project invariant. The index is a *promotion* of the extraction already at `snapshot/collectors/workflows.ts:244-321`, not a new subsystem.
- **Scope the index to bead-native / authoritative directions in v1** (parent/child, molecule membership, bead↔PR#, bead↔issue#, bead↔session, bead↔workflow-run) — all from metadata the snapshot already extracts.
- **Render the component on the two surfaces that already have the data** (AgentDetail, WorkflowRunDetail) in v1.
- **Instrument resolution outcomes** (resolved / unresolved / N-candidates per edge type) so deferred directions are promoted on data — this answers Open Questions #2 and #4 empirically.
- **Defer (gated):** rich GitHub→bead join (OQ#2); `closingIssuesReferences` swap (OQ#3) — quarantine the `Fixes #N` edge as `provenance:'derived'` now so the later swap is an additive flip; jump-to-entity command; file-overlap inference; the two "homeless" entity detail surfaces.
- **Non-negotiable v1 floor:** R4 (URL allow-list) and R6 (explicit unresolved/ambiguous states) — adopted unconditionally by both advocates.

## Requirements

### V1 (build-ready) — R1, R2, R3, R4, R5, R6, R7, R11

- **R1 — Backend relation-index module.** A new `backend/src/links/` (or `relations/`) module builds, for the loaded city snapshot, a bidirectional adjacency map keyed by bead ID, inverting bead metadata so reverse lookups (children-of, members-of-molecule, beads-for-PR#, beads-for-session) are O(1). Built from already-extracted fields (promote the extraction at `snapshot/collectors/workflows.ts` ~249-320), not a per-request scan.
  - Acceptance: a unit test feeds a fixture bead set with `gc.parent_bead_id`, `molecule_id`, `pr_review.pr_number`, and session refs, and asserts the forward edge and its inverse both resolve in the index (e.g. `index.beadsForPr(123)` returns the bead whose `pr_review.pr_number === '123'`).

- **R2 — Provenance-tagged edge model in `shared/`.** Add to `shared/src/` a `LinkEdge` with `{ from: LinkNodeRef, to: LinkNodeRef, relation: string, provenance: 'supervisor' | 'external' | 'derived', resolved: boolean }` and `LinkNodeType = 'bead' | 'workflow_run' | 'session' | 'github_pr' | 'github_issue' | 'formula_run' | 'order_run'`, plus `EntityLinkView { focus, nodes, edges, partial, generatedAt }`. Both backend and frontend import it.
  - Acceptance: `tsc --noEmit` passes on `shared`, backend, and frontend (incl. `typecheck:test`); a backend test asserts the `Fixes #N`-derived PR↔issue edge carries `provenance: 'derived'` while a `molecule_id` edge carries `provenance: 'supervisor'`.

- **R3 — `GET /api/links/:ref` endpoint.** Resolves any input ref (`bead-id`, `pr/<n>`, `issue/<n>`, `<session-id>`, `<workflow-id>`) to its bead-id(s), runs the bead closure once, decorates with session/GitHub/run nodes, and returns an `EntityLinkView`. Sets `partial: true` if any contributing fetch fails (mirrors `routes/workflows.ts:79-81`). Node payloads carry only display-summary fields (title, status, type, url), never full bodies.
  - Acceptance: `curl /api/links/<known-bead-id>` returns 200 with a JSON `EntityLinkView` whose `edges[]` include the bead's parent/molecule/PR refs; an unresolvable ref returns 200 with `nodes:[focus-only]` + `partial`/empty edges (not a 500); a malformed ref returns 400.

- **R4 — Every rendered cross-entity URL passes an `^https?://` allow-list.** Bead metadata is a trust boundary (cf. `externalUrl` sanitisation, `workflows.ts` gascity-dashboard-4x3); React does not strip `javascript:` from hrefs.
  - Acceptance: a test feeds a bead with `pr_review.pr_url = 'javascript:alert(1)'` and asserts the resulting node `url` is null/omitted, never rendered as an href.

- **R5 — Reusable `RelatedEntities` section component.** One frontend component rendered near the foot of existing detail surfaces (AgentDetail, BeadDetailModal, WorkflowRunDetail). Pure typography in the established register: a tracked `RELATED` label + count, rows grouped by entity kind, each row a link/button opening the adjacent surface (modal for beads, route for sessions/workflows). ≤1 maroon mark (reserved for a single related entity in a failed/blocked state). No card, chip, or left-stripe.
  - Acceptance: a component test renders a mixed related-set and asserts (a) groups render under tracked labels with no card container class, (b) at most one `StatusBadge` maroon tone appears, (c) clicking a bead row invokes the modal open handler.

- **R6 — Unresolved / ambiguous links are explicit states.** When a ref resolves to 0 entities, render an `unresolved` row (dimmed, with outbound `↗` to `html_url` where available) rather than hiding it. When it resolves to >1 (e.g. retry-duplicate beads, name→multiple-sessions per `session-link.ts:113-119`), render `unresolved (N candidates)` rather than guessing.
  - Acceptance: tests cover (a) a `pr_review.pr_number` whose PR is absent from the fetched (open-only) set → row shows `unresolved` + GitHub `↗`; (b) a session name matching two active sessions → row shows `2 candidates`, not a single link.

- **R11 — Resolution instrumentation.** The backend records per-edge-type resolution outcome (resolved / unresolved / N-candidates) so deferred directions (rich GitHub→bead, more surfaces) are promoted on measured hit-rates, not speculation — directly answering Open Questions #2 and #4.
  - Acceptance: a structured counter/log increments per edge type with its outcome; a test asserts an unresolvable PR ref produces an `unresolved` outcome record and an ambiguous session-name produces an `n-candidates` record.

- **R7 — Staleness stamping across sources.** The `EntityLinkView` carries `generatedAt` and the related-set is stamped with the **oldest** contributing source `fetchedAt` (supervisor 60s vs gh/contributor up to 24h), surfaced as an "as of" line so cross-clock inconsistency is visible, not hidden.
  - Acceptance: a test composing a 60s-fresh bead node with a 24h-old GitHub node asserts the view's displayed timestamp equals the older of the two.

### Later (gated on open questions / measured data)

- **R8 — Replace `Fixes #N` regex with GitHub `closingIssuesReferences`.** If the host `gh` supports the GraphQL `closingIssuesReferences` field, source PR→issue links from it (provenance `external`) and retire `CLOSING_REF_RE` (`triage.ts:202`). The edge flips `derived → external` with no model-side heuristic.
  - Acceptance: with the structured field available, a PR↔issue edge reports `provenance: 'external'` and `triage.ts` no longer references `CLOSING_REF_RE`; gate behind a `gh --version` check with the regex retained only as a flagged fallback.

- **R9 — Jump-to-entity command.** One keyboard-first entry point (e.g. `/` then ref) that resolves a bead-id / session-alias / `pr/<n>` / workflow-id to its detail surface, giving the two "homeless" entities (GitHub PR/issue, formula/order run) a navigable destination.
  - Acceptance: typing a known bead id navigates to the bead's surface with its Related section populated; typing `pr/<n>` opens a minimal read-only PR surface.

- **R10 — Inferred file-overlap bridge at the GitHub↔gc gap, labeled inferred.** Where a workflow run's `changedFiles` overlaps a PR's `blast_files`/`cluster_id`, show a single `possibly related (shared files)` row under a clearly-inferred sub-label, never folded into the confident list (mirrors `phaseConfidence: 'inferred'` discipline). Omit entirely if it feels speculative for v1.
  - Acceptance: a test with overlapping file sets produces exactly one `inferred`-tagged edge; non-overlapping sets produce none.

## Design Considerations

- **Join locus (resolved): dashboard-backend.** Supervisor has no GitHub knowledge and returns raw primitives; client-side would create the N+1 gh fan-out the triage code explicitly avoids (`contributor.ts:22-24` — 30 req/min limit). The backend already centralizes derived signals and forbids frontend recomputation (`index.ts` comment ~566-584).
- **The load-bearing tension — GitHub↔bead direction.** The bead→PR/issue direction is authoritative (bead metadata). The reverse is derivable by inverting metadata, but `gh ... list` returns only OPEN items, so a merged/closed PR linked from a bead won't be in the fetched set → render `unresolved` + `↗`, do not fabricate. Whether a bead also records the PR/branch it produced (e.g. a `gh:pr/123` label) is an open question that determines whether the GitHub half is rich or an honest gap.
- **Provenance tiers mirror GitHub's own model** (structured "linked" vs prose "cross-referenced"). Only the `Fixes #N` body parse is `derived`; it is a documented self-removing `gh` 2.45 workaround (`exec.ts:496`).
- **Snapshot-rebuild over persistence.** Comparable systems' biggest cost is stale-relation invalidation; rebuilding per snapshot avoids that entire bug class. Inherit the existing TTL bands (30–60s); do NOT invent event-driven invalidation (SSE is byte-passthrough today, no cache hook).
- **Retry/duplicate beads.** `execution-instances.ts` already separates historical vs current-iteration beads per semantic node; the index must not re-collapse that distinction and re-surface dead retries as "related."
- **Bead-id uniqueness.** If bead IDs are not globally unique across scopes, the index key needs namespacing (`scope_kind:scope_ref:id`) — open question.

## Open Questions

1. Are bead IDs globally unique across the city, or only within a molecule/workflow? (Determines whether the index key needs `scope:ref` namespacing.)
2. Does a bead record the PR/branch it produced as a structured field/label (so GitHub→bead is a real join, not an inversion of open-only list data)?
3. What is the host's actual `gh` version — does `closingIssuesReferences` exist now (retiring the regex immediately)?
4. Is `metadata['session_id']` reliably present on completed-step beads, or only while running (`session-link.ts:44` early-returns for pending/ready → historical session→bead edges may be sparse)?
5. Does `GET /order/history/{bead_id}` already return a bead-keyed order-run association worth preferring over derivation?
6. Should the Related section auto-refresh on SSE or be static-with-manual-refresh (relations change slowly; static is calmer/cheaper)?

## Risks & Mitigations (premortem)

A 3-lens premortem (data-model, scope, design-integrity) rated all three failure modes High+/High-likelihood, converging on one root theme: **clean fixtures + unanswered open questions made v1 demo well and fail in production.** Mitigations are now part of the spec:

- **PG — Pre-build gates (run BEFORE building R1/R3).**
  - PG1 (closes OQ#1): confirm bead-ID uniqueness across scopes against a live snapshot; if not globally unique, the index key MUST be `scope_kind:scope_ref:id` (treat bare-ID keying as a bug).
  - PG2 (closes OQ#2): count how many bead `pr_review.pr_number` values resolve to a PR *present* in the fetched (open-only) set. If GitHub→bead resolves below a pre-committed threshold (e.g. <40% to a present entity), **do not build the generalized index — ship only targeted reverse inline-links** and stop. This gate can flip the whole v1 decision back to the minimal design; that is the intended safety valve.
    - **Correction (gascity-dashboard-ajs):** deployed molecule formulas write the `evidence.*` namespace (`evidence.pr_url`, `evidence.pr_number`, `evidence.artifact_path=github-pr:<owner>/<repo>/<num>`), NOT `pr_review.*` (a different workflow family). `toIndexBead` now reads `evidence.*` first with `pr_review.*` as fallback; the PG2 probe should count those keys. Molecule beads carry no structured issue key, so issue resolution stays best-effort/R8 (`closingIssuesReferences`).
  - Acceptance: both probes are run and recorded; the build decision cites their numbers.

- **RK1 — Index sources the reconciled model, not raw beads (Critical).** Build edges over the `WorkflowDisplayNode`/execution-instance model so `historical` retry beads are excluded (or rendered under a `superseded` sub-label), never as peers of live edges. Revise R1's acceptance: a multi-iteration fixture asserts dead retries do NOT appear in `beadsForPr`; a rig-scoped fixture asserts cross-scope edges join correctly and distinct rig beads don't collide.

- **RK2 — Staleness is a row-level visual state, not a footnote (High).** Strengthen R7: when a contributing node exceeds its own TTL band (GitHub up to 24h vs supervisor 60s), render *that node* dimmed/`stale` with its own age inline — a single aggregate "as of" line is routinely ignored, so a merged-23h-ago PR must look visibly different from a 60s-fresh bead at the row level.

- **RK3 — Density discipline keeps it inside DESIGN.md (High).** Strengthen R5/R6: cap rows per group with a typeset `+ N more`; collapse unresolved/derived/staleness into ONE summary line (`RELATED · 12 resolved, 3 unresolved, 2 candidates`) with detail behind an expand; render one **aggregate section-level** maroon (a count crossing a threshold — explicitly sanctioned by DESIGN.md §2), never per-row maroon; add a high-volume (40-entity stuck run) fixture and a viewport greyscale + maroon-count assertion to `scripts/snap-workflow-detail.mjs`.

- **RK4 — R11 gets a consumer (High).** Strengthen R11: a surfaced rollup (resolved/unresolved/N-candidate rates with denominators) in the Health/Activity register; a named owner; numeric promote/kill thresholds reviewed on a fixed cadence; and a v1 **sunset condition** — if the RelatedEntities section sees fewer interactions than the three existing inline links over 30 days, it is removed. Also use a nonzero `n-candidates` rate on an *authoritative* direction as a correctness alarm (the key is non-unique).

- **RK5 — Benchmark per-snapshot rebuild at 10× bead volume (Medium).** Before committing to no-persistence, benchmark index build at production scale; if non-linear, build incrementally (diff prior snapshot) or cache the inversion keyed by source `fetchedAt`.

## Research Provenance

Four independent lenses (prior-art, first-principles technical, UX/workflow, failure-modes/contrarian).

- **Convergence (high confidence):** no graph viz — reusable typeset "Related" section + inline cross-links; backend-computed bidirectional bead-ID index built once per snapshot; provenance/confidence-tagged edges; render unresolved/ambiguous explicitly; the `Fixes #N` regex is the one ZFC violation to quarantine and replace with `closingIssuesReferences`.
- **Divergence:** scope — contrarian argued for just targeted reverse inline-links (20% cost) and warned the GitHub↔bead edge may not exist in wire data + cross-clock (60s↔24h) staleness; UX argued the GitHub half degrades honestly and the component is a generalization of three shipped patterns. Resolved by making the index the backing for the same inline-link pattern (not a new abstraction) and treating the GitHub gap as an explicit unresolved state + open question #2.
- **Surprise:** the codebase has already built this view three times unnamed; the per-snapshot rebuild is an architectural advantage; GitHub itself treats prose-parsed links as second-class — validating the ZFC instinct.
