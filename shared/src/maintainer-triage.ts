import type { IsoTimestamp } from './dashboard-sessions.js';

export type TriageTier = 'regression_breaking' | 'regression' | 'stability';

export type TriageKind = 'issue' | 'pr';

export type ContributorTier = 'core' | 'trusted' | 'regular' | 'new' | 'spam_risk';

export type TriageItemStatus =
  | 'open'
  | 'draft'
  | 'needs_review'
  | 'approved'
  | 'changes_requested'
  | 'merged'
  | 'closed';

/**
 * Agent-vetted triage assessment that overrides the heuristic
 * `triage_score` for sorting and rendering when present
 * (gascity-dashboard-are).
 *
 * Set by the maintainer triage agent via a structured label convention
 * on the GitHub item: `triage/vetted` marker, `triage/severity-<n>`
 * (n in 0..4, lower=more severe), and `triage/simplicity-<low|medium|high>`.
 * All three labels must be present for the parser to produce a vetted
 * assessment; partial labels yield null so the heuristic still applies.
 *
 * `vetted_score` lives on the SAME numeric scale as `TriageItem.triage_score`
 * so comparators sort correctly when a tier mixes vetted + unvetted items.
 *
 * `source` is `'agent'` for every path that lands in this bead today
 * (gascity-dashboard-lmr). A future maintainer-ack path would widen
 * the union when (and only when) a manual signal actually flows; the
 * `'manual'` arm was reserved speculatively and went unused, so it
 * was dropped per YAGNI.
 *
 * `notes` is currently always empty string. When the gh ingest path wires
 * it up (see ParseTriageAssessmentOptions.notes), the contents will be
 * extracted from PR/issue comment bodies, which are third-party-author
 * controllable on incoming PRs. Treat as untrusted: any consumer MUST
 * render it as plain text — React auto-escapes HTML but does NOT strip
 * Unicode formatting characters; Bidi/RTL stripping must happen at the
 * ingest writer per the field-level JSDoc below. Never render via
 * `dangerouslySetInnerHTML`; never render as unescaped markdown or HTML.
 * Non-React consumers (logs, downloads, copy-to-clipboard) inherit the
 * same untrusted-input posture and must apply their own stripping if
 * the ingest contract is bypassed. See gascity-dashboard-8h3 for the
 * full contract.
 */
export interface TriageAssessment {
  vetted_score: number;
  source: 'agent';
  /**
   * Free-form agent-authored note about the assessment. Currently always
   * empty string; populated by the gh ingest path (see
   * ParseTriageAssessmentOptions.notes) from PR/issue comment bodies,
   * which are third-party-author controllable on incoming PRs.
   *
   * Sanitisation contract (gascity-dashboard-8h3 + gascity-dashboard-cnu) —
   * the ingest writer is responsible, every reader assumes it has been
   * enforced:
   *
   *   1. Length-cap (~2000 chars).
   *   2. Strip C0 control bytes (\x00-\x1f except \t/\n), DEL (\x7f),
   *      and C1 control bytes (\x80-\x9f).
   *   3. Strip ALL 12 Unicode Bidi / RTL codepoints from CVE-2021-42574:
   *      U+061C (ALM), U+200E (LRM), U+200F (RLM), U+202A-202E (LRE/RLE/
   *      PDF/LRO/RLO), U+2066-2069 (LRI/RLI/FSI/PDI) — the "trojan
   *      source" vector.
   *   4. Strip ANSI CSI / OSC escape sequences.
   *
   * Every consumer MUST render this as plain text only — never via
   * `dangerouslySetInnerHTML`, never as unescaped markdown or HTML.
   * React's default JSX text rendering satisfies this; any non-React
   * surface (logs, downloads, copy-to-clipboard) inherits the same
   * untrusted-input posture.
   */
  notes: string;
  vetted_at: IsoTimestamp;
}

/**
 * Active sling state for a TriageItem (gascity-dashboard-9qs).
 *
 * Set when the maintainer slings an item to a triage agent. While
 * present, the item is excluded from the One Mark candidate set
 * (`isMarkCandidate` returns false) so the maroon ● moves to the next
 * unhandled item. The frontend renders an inline `· slung →` link to
 * `/agents/<target>` so the operator can verify the agent is working.
 *
 * Self-clearing: once the triage agent applies the structured
 * `triage/vetted` label set, `parseTriageAssessment` returns a
 * non-null `TriageAssessment` and the slung overlay nulls this field
 * out at serve time (vetted is the stronger signal; slung was the
 * placeholder while waiting).
 */
export interface SlungState {
  /** When the sling fired (server clock). */
  slung_at: IsoTimestamp;
  /** Resolved `gc sling` target alias the work was sent to. Note: this
   *  is the agent role / pool name the operator configured (e.g.
   *  'chief-of-staff'), which gc supervisor itself resolves to a
   *  concrete session at dispatch time. It is NOT a valid AgentDetail
   *  slug — use `resolved_session_name` for that. The frontend renders
   *  this value in the inline link's title / aria-label so the operator
   *  knows which role the work was sent to, regardless of which session
   *  actually picked it up. */
  target: string;
  /** Bead id parsed from `gc sling` stdout when present. */
  bead_id: string | null;
  /**
   * Concrete supervisor session identifier the `target` role resolved
   * to at sling-write time (gascity-dashboard-55b). The frontend uses
   * this as the AgentDetail route slug (`/agents/<resolved_session_name>`).
   *
   * Resolution order at write time:
   *   1. session.alias === target (exact match)
   *   2. session.pool === target (role pool match)
   *   3. session.alias last segment === target (split on '/' or '.')
   *   4. session.session_name last segment === target (split on '__' or '--')
   * `active` sessions outrank non-active when multiple match.
   *
   * Null when:
   *   - no running session carried the role (sling routed to a not-yet-spawned agent)
   *   - listSessions failed at sling time (sling itself succeeded)
   *
   * Null means the sling succeeded but no running session could be resolved
   * for the target role at write time.
   *
   * Stale-after-restart: this field is captured at sling time and never
   * refreshed. If the resolved session is killed and re-spawned (operator
   * restart, supervisor crash recovery, role re-pool), the persisted id
   * may point at a now-dead session. The frontend's `/agents/<id>` route
   * is expected to fall back gracefully on a 404 — the sling record itself
   * is intentionally NOT re-resolved on read, because the historical
   * sling-time mapping is what the operator slung against and re-resolving
   * would silently rewrite history. Treat this value as "best-known
   * session at sling time", not "currently live session for the role".
   */
  resolved_session_name: string | null;
}

export interface ContributorStat {
  login: string;
  tier: ContributorTier;
  /** Issues opened by this contributor that became accepted bugs / PRs. Null until computed. */
  issues_accepted: number | null;
  issues_opened: number | null;
  /** PRs opened that were merged. Null until computed. */
  prs_merged: number | null;
  prs_opened: number | null;
  computed_at: IsoTimestamp | null;
}

export interface TriageWeakTie {
  /** Human-readable topic / file group name. */
  label: string;
  /** Item count in this weak-tie cluster. */
  count: number;
}

export interface TriageItem {
  kind: TriageKind;
  number: number;
  title: string;
  status: TriageItemStatus;
  author: ContributorStat;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  /** GitHub labels on the item. Source of truth for priority classification
   *  and area-based clustering. Empty array when gh returns no labels. */
  labels: string[];
  /** Tier classification. Null when not yet computed by the priority classifier. */
  tier: TriageTier | null;
  /** Combined triage score: severity (tier weight) + simplicity-of-fix bonus.
   *  Used to sort items within a tier so the top of each section is "highest
   *  priority by triage skill" — biggest severity AND most-shippable. Higher
   *  is better. Null until 7ts (priority classifier) populates it. */
  triage_score: number | null;
  /** Agent-vetted assessment that overrides `triage_score` for sort + render
   *  when present (gascity-dashboard-are). Null means the item has not been
   *  vetted; the frontend then renders the heuristic `triage_score` in the
   *  faint italic register. Populated by the label parser in
   *  backend/src/views/modules/maintainer/triage-assessment.ts. */
  triage_assessment: TriageAssessment | null;
  /** Active sling state (gascity-dashboard-9qs). Non-null while the item
   *  is in flight to a triage agent and not yet vetted. Excludes the
   *  item from the One Mark candidate set and surfaces an inline link
   *  to the target agent's detail view. See `SlungState` JSDoc. */
  slung: SlungState | null;
  /**
   * Cross-link to this item's formula run-detail route, when one is
   * known (gascity-dashboard-djpk). Tri-state:
   *   - `undefined` — the item was never associated with a formula run
   *     (the common case: it has never been slung). Absent on the wire.
   *   - `null` — the item IS actively slung but the sling carried no
   *     bead id, so there is no `rootBeadId`-keyed run to link to yet.
   *   - `string` — the slung bead id, usable directly as the
   *     `/runs/<id>` route key (run-detail is keyed by the run's
   *     `rootBeadId`, which is exactly `SlungState.bead_id`).
   *
   * Populated at serve time in applySlungOverlay from the persisted
   * `SlungState.bead_id` on active-slung items only — mapIssue/mapPr
   * carry no run id, so non-slung items always leave this `undefined`.
   *
   * Best-known-at-sling-time, NOT live: like `SlungState.bead_id` itself,
   * this is captured when the sling fired and never re-resolved on read.
   * Treat it as "the run this item was slung against", which is what the
   * operator means to navigate to.
   */
  run_id?: string | null;
  /** Primary file-overlap cluster id; items sharing this id sit together. Null when uncomputed. */
  cluster_id: string | null;
  /** Files this item touches / is predicted to touch. Empty array when uncomputed. */
  blast_files: string[];
  /** Lines of diff for PRs; null for issues. */
  lines_changed: number | null;
  /** Cross-cluster topical ties; empty array until semantic enrichment runs. */
  weak_ties: TriageWeakTie[];
  /** For PRs: parent issue numbers if linked via Fixes/Closes. For issues: PR numbers that fix them. */
  linked_numbers: number[];
  html_url: string;
  /** True when bug + breaking + actively shipping. Drives the maroon mark (One Mark Rule). */
  is_marked: boolean;
  /**
   * Backend-computed signal that at least one linked PR in the SAME
   * envelope is in-flight (status not 'merged' / not 'closed') and
   * claims to fix this item via `linked_numbers` (gascity-dashboard-omv).
   *
   * Drives the issue-row "needs PR" indicator and the "Needs PR only"
   * filter chip on the maintainer view. Inverse: `!has_in_flight_pr`
   * is the "nobody has written a fix yet" signal.
   *
   * Always `false` for PR items (the signal is issue-anchored — a PR
   * doesn't need its own PR). Always `false` for issues whose
   * `linked_numbers` are empty, only reference PRs not in the envelope,
   * or only reference merged/closed PRs.
   *
   * Single source of truth: do NOT recompute this on the frontend from
   * `linked_numbers` + the items[] map. The backend ships it so every
   * consumer reads the same value.
   */
  has_in_flight_pr: boolean;
}

export interface TriageCluster {
  cluster_id: string;
  /** Sorted file list that defines this cluster. */
  files: string[];
  items: TriageItem[];
  /** Sum of lines_changed across PRs in this cluster (issues contribute 0). */
  lines_pending: number;
}

export interface TriageTierSection {
  tier: TriageTier;
  /** Clusters within the tier, sorted by item count desc. */
  clusters: TriageCluster[];
  /** Items in the tier that don't share files with anyone else. */
  unclustered: TriageItem[];
}

export interface MaintainerTriage {
  /** ISO of when the enrichment snapshot was computed. Status data may be fresher. */
  computed_at: IsoTimestamp | null;
  /** Repo this triage is for (gastownhall/gascity for v1). */
  repo: string;
  /** Top-level tiers in fixed order: regression_breaking, regression, stability. */
  tiers: TriageTierSection[];
  /**
   * Items currently slung to a triage agent and not yet vetted
   * (gascity-dashboard-2yr). The serve-time slung overlay LIFTS these out
   * of `tiers` so the operator sees in-flight work as one dedicated group
   * rather than inline `slung →` markers scattered across tier rows.
   *
   * Every item here carries non-null `slung`. Sorted by `slung.slung_at`
   * descending so the most-recent batch surfaces on top. Empty when
   * nothing is in flight.
   *
   * Lifecycle: an item is `awaiting` (in a tier) → `slung` (here) →
   * `vetted` (back in its tier; the overlay forces `slung=null` once
   * `triage_assessment` lands, so it leaves this section). Because slung
   * items are removed from `tiers`, the per-tier vetted/awaiting tally and
   * item counts naturally exclude them.
   *
   * Optional so envelopes and fixtures predating this field still
   * typecheck; readers MUST treat `undefined` as an empty section.
   */
  slung_section?: TriageItem[];
  totals: {
    issues_open: number;
    prs_open: number;
  };
}

/** Audit row written to .gc/events.jsonl on every privileged action. */
export interface AdminAuditEvent {
  type: 'dashboard.exec' | 'dashboard.fetch' | 'dashboard.send_mail' | 'dashboard.sling' | string;
  endpoint: string;
  actor: 'stephanie';
  /** Identity the parent was viewing AS at the time. NEVER affects sender. */
  viewing_as?: string;
  parsed_args?: Record<string, string>;
  exit_code?: number;
  duration_ms?: number;
  ts: IsoTimestamp;
}
