// Single source of truth for the wire shapes the admin dashboard
// consumes from gc supervisor + emits to the browser. Importing this
// package on both sides surfaces wire-shape drift as a compile error
// instead of a runtime undefined.
//
// Comments mark fields that gc supervisor MAY omit; treat them as
// optional and never assume presence in render code.

export type * from './snapshot/types.js';

export type IsoTimestamp = string;
export type BeadId = string;
export type SessionId = string;

// ── Sessions ──────────────────────────────────────────────────────────────

export interface GcSession {
  id: SessionId;
  template: string;
  alias?: string;
  title?: string;
  state: GcSessionState;
  /** Set when state transition has a structured reason (e.g. "city-stop"). */
  reason?: string;
  /** Human-readable display name from the provider (e.g. "Claude Code"). */
  display_name?: string;
  /** tmux/screen session name on disk. */
  session_name?: string;
  created_at: IsoTimestamp;
  /** Last time the session emitted activity; only set after first activity. */
  last_active?: IsoTimestamp;
  /** Whether a human is currently attached to the tmux session. */
  attached: boolean;
  rig?: string;
  pool?: string;
  agent_kind?: 'pool' | 'role' | string;
  /** Process-running state independent of session.state (which is gc-level). */
  running?: boolean;
  model?: string;
  context_pct?: number;
  context_window?: number;
  /** Coarse activity hint: 'idle' | 'thinking' | 'tool_use' | ... */
  activity?: string;
  /**
   * Session provider (e.g. 'codex', 'claude', 'gemini'). Supervisor
   * already has `provider_kind` in session metadata and should populate
   * this field for all sessions; absence is a transitional gap pending
   * gastownhall/gascity#2508. Consumers MUST tolerate undefined
   * (treat the session as "unknown provider") rather than inferring
   * from title text — title-parsing is a brittle heuristic and a
   * violation of ZFC; sessionsByProvider aggregation just undercounts
   * until upstream lands the fix (dkb Q4).
   */
  provider?: string;
}

export type GcSessionState =
  | 'creating'
  | 'active'
  | 'asleep'
  | 'detached'
  | 'failed'
  | 'closed'
  | string;

export interface GcSessionList {
  items: GcSession[];
}

// ── Context-window derivation (wj8) ──────────────────────────────────────
//
// gc supervisor currently emits `context_pct` against a hardcoded
// `context_window` of 200_000, even for sessions running with the [1m]
// extended-context beta header (true window 1_000_000). The result is a
// 5x overestimate for those sessions — mayor in particular shows ~75%
// in the dashboard when the CLI/tmux session reports ~15%.
//
// Until gc upstream tracks the true window per session, the dashboard
// scales gc's value back via this model registry. The scaling is a
// no-op when gc and the registry agree on the window, so this stays
// safe if gc later starts emitting the correct number.

/**
 * Models known to run with the 1M-token extended-context beta header
 * in this deployment. Add new generations as they land.
 */
export const TRUE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
};

/**
 * Returns the session's context usage as a percentage of its TRUE
 * context window (not gc's hardcoded denominator). Returns `undefined`
 * when no usable signal is available; returns the raw gc value
 * unchanged when the model is unknown or `context_window` is missing
 * (fail-open so we don't guess).
 *
 * Always returns an integer in [0, 100].
 */
export function effectiveContextPct(
  session: Pick<GcSession, 'context_pct' | 'context_window' | 'model'>,
): number | undefined {
  const pct = session.context_pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;

  const gcWindow = session.context_window;
  const trueWindow =
    session.model !== undefined ? TRUE_CONTEXT_WINDOWS[session.model] : undefined;

  if (
    typeof gcWindow !== 'number' ||
    typeof trueWindow !== 'number' ||
    gcWindow <= 0 ||
    trueWindow <= 0
  ) {
    // No scale factor available. Fail open to gc's value rather than
    // invent one. Still clamp to [0, 100] for display sanity.
    return clampPct(pct);
  }

  return clampPct(Math.round((pct * gcWindow) / trueWindow));
}

function clampPct(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * One turn in a session's transcript. Architect th-1i30ih addendum
 * (td-wisp-ijk7g) confirmed peek is an HTTP API endpoint with structured
 * turns — NOT shell-exec — via GET /v0/city/{name}/session/{id}/transcript.
 *
 * `role` strings vary by provider; the renderer treats unknown values as
 * "other" and falls through to a neutral pill. `text` is LLM-generated
 * content; server-side strips ANSI/OSC/control chars before it reaches
 * the browser per the XSS posture in SECURITY.md.
 */
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | string;
  text: string;
}

export interface TranscriptResult {
  session_id: SessionId;
  template?: string;
  provider?: string;
  format?: 'conversation' | string;
  turns: TranscriptTurn[];
  /** Total characters across all turns after sanitisation. */
  total_chars: number;
  /** ISO timestamp of when the snapshot was taken. */
  captured_at: IsoTimestamp;
  /** True if any individual turn was truncated at the per-turn cap. */
  truncated: boolean;
}

// ── Beads ─────────────────────────────────────────────────────────────────

export type BeadStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'closed'
  | 'deferred'
  | string;

export type BeadIssueType =
  | 'feature'
  | 'bug'
  | 'task'
  | 'docs'
  | 'session'
  | 'message'
  | 'convoy'
  | string;

export interface GcBead {
  id: BeadId;
  title: string;
  status: BeadStatus;
  issue_type: BeadIssueType;
  priority: number;
  description?: string;
  owner?: string;
  assignee?: string;
  created_at: IsoTimestamp;
  updated_at?: IsoTimestamp;
  closed_at?: IsoTimestamp;
  labels?: string[];
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  metadata?: Record<string, unknown>;
  /** Supervisor-supplied reference handle. On formula templates this is
   *  the formula name (e.g. "mol-focus-review"). Absent on most beads. */
  ref?: string;
}

export interface GcBeadList {
  items: GcBead[];
  /** gc supervisor's own total count for the requested scope (independent of the fetch limit). */
  total?: number;
}

/** Frontend-side filter contract. v0 hardcodes; ?showAll=1 disables. */
export interface BeadFilterParams {
  showAll?: boolean;
}

export type BeadAction = 'claim' | 'close' | 'nudge';

export interface BeadActionRequest {
  /** Optional reason / note attached to the action. */
  reason?: string;
}

// ── Mail (Phase B but type-locked now so Phase A frontend compiles) ──────

export interface GcMailItem {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  created_at: IsoTimestamp;
  read: boolean;
  thread_id?: string;
  rig?: string;
}

export interface GcMailList {
  items: GcMailItem[];
  total?: number;
}

/** Frontend "viewing as" context state. Default identity is the operator ('stephanie'). */
export interface ViewingAs {
  alias: string;
  /** True iff alias === the operator alias (the sole identity that can send). */
  isOperator: boolean;
}

/**
 * Compose payload — the SINGLE wire shape the mail-send router accepts.
 * The server hardcodes the operator identity. The frontend cannot trick
 * the server into sending as someone else because there's no slot in the
 * shape.
 */
export interface MailComposeRequest {
  to: string;
  subject: string;
  body: string;
}

export interface MailSendResult {
  ok: true;
  message_id?: string;
}

// ── Activity view: commits + builds (Phase C) ─────────────────────────────

/** One of the hardcoded git log "views". The backend enum is the auth boundary — strings outside this set are rejected. */
export type GitView = 'recent-main' | 'recent-all' | 'today' | 'this-week';

export interface GitCommit {
  sha: string;
  short_sha: string;
  author: string;
  date: IsoTimestamp;
  subject: string;
  /** Optional refs/branches that point at this commit, e.g. "HEAD -> main". */
  refs?: string;
}

export interface GitCommitList {
  view: GitView;
  items: GitCommit[];
}

export type DeployStatus = 'ok' | 'failed' | 'in-progress' | 'unknown';

export interface DeployRecord {
  at: IsoTimestamp;
  status: DeployStatus;
  /** "old-sha -> new-sha" when status=ok, "stage: X" when failed, raw line otherwise. */
  detail: string;
}

export interface DeployList {
  items: DeployRecord[];
  /** Path the backend parsed; null when the file isn't present. */
  source: string | null;
  /** True if .dev-deploy-FAILED marker is currently present. */
  failed_marker: boolean;
}

// ── Health view (Phase C) ─────────────────────────────────────────────────

export interface SystemHealth {
  /** Backend process state — totally local to the admin dashboard's node process. */
  admin: {
    pid: number;
    uptime_sec: number;
    rss_bytes: number;
    heap_used_bytes: number;
    node_version: string;
  };
  /** Machine-level state from Node's os module. */
  host: {
    load_avg_1: number;
    load_avg_5: number;
    load_avg_15: number;
    total_mem_bytes: number;
    free_mem_bytes: number;
    /** Number of logical CPUs. */
    cpu_count: number;
    uptime_sec: number;
  };
  /** gc supervisor's own /v0/health response, when reachable. */
  supervisor: SupervisorHealth | null;
}

export interface SupervisorHealth {
  status: string;
  version: string;
  city: string;
  uptime_sec: number;
}

export interface DoltNomsSample {
  ts: IsoTimestamp;
  bytes: number;
}

export interface DoltNomsTrend {
  /** Up to 144 samples (24 h at 10-min cadence). */
  samples: DoltNomsSample[];
  /** Null when the metric source isn't wired yet (mechanic surgical-ask td-ulgrt6). */
  source: string | null;
  available: boolean;
}

// ── Events (SSE; Phase C wires; type-locked early) ──────────────────────

export interface GcEvent {
  seq: number;
  type: string;
  ts: IsoTimestamp;
  actor?: string;
  subject?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface GcEventList {
  items: GcEvent[];
  /** Cursor to pass back as ?after=<cursor> to resume. */
  next?: number;
}

// ── Admin-dashboard internal API responses ───────────────────────────────

/** Wrapped error returned by the backend on any 4xx/5xx. */
export interface ApiError {
  error: string;
  /** Optional machine-readable kind (e.g. "validation", "not_found"). */
  kind?: string;
  /** Optional details object — never leaks raw stderr to the browser. */
  details?: Record<string, string>;
}

// ── Maintainer triage view (gascity-dashboard-hq2 + downstream) ─────
//
// Read-only triage surface for the maintainer of gastownhall/gascity.
// Aggregates GitHub issues + PRs into a tiered, cluster-organised page.
// Live status overlays a nightly-computed enrichment snapshot.

export type TriageTier =
  | 'regression_breaking'
  | 'regression'
  | 'stability';

export type TriageKind = 'issue' | 'pr';

export type ContributorTier =
  | 'core'
  | 'trusted'
  | 'regular'
  | 'new'
  | 'spam_risk';

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
 * `source` is `'agent'` for the only path that lands in this bead. The
 * `'manual'` arm is reserved for a future maintainer ack path; no manual
 * signal lands today.
 */
export interface TriageAssessment {
  vetted_score: number;
  source: 'agent' | 'manual';
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
  /** Resolved `gc sling` target alias the work was sent to. The
   *  frontend uses this as the AgentDetail slug for the inline link. */
  target: string;
  /** Bead id parsed from `gc sling` stdout when present. Persisted for
   *  forward-compat with a future per-bead drill-in; not rendered in v1
   *  (the AgentDetail page surfaces the bead list naturally). */
  bead_id: string | null;
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
   *  backend/src/maintainer/triage-assessment.ts. */
  triage_assessment: TriageAssessment | null;
  /** Active sling state (gascity-dashboard-9qs). Non-null while the item
   *  is in flight to a triage agent and not yet vetted. Excludes the
   *  item from the One Mark candidate set and surfaces an inline link
   *  to the target agent's detail view. See `SlungState` JSDoc. */
  slung: SlungState | null;
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
  totals: {
    issues_open: number;
    prs_open: number;
  };
}

/** Audit row written to .gc/events.jsonl on every privileged action. */
export interface AdminAuditEvent {
  type:
    | 'dashboard.exec'
    | 'dashboard.fetch'
    | 'dashboard.send_mail'
    | 'dashboard.sling'
    | string;
  endpoint: string;
  actor: 'stephanie';
  /** Identity the parent was viewing AS at the time. NEVER affects sender. */
  viewing_as?: string;
  parsed_args?: Record<string, string>;
  exit_code?: number;
  duration_ms?: number;
  ts: IsoTimestamp;
}
