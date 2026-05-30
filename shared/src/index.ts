// Single source of truth for the wire shapes the admin dashboard
// consumes from gc supervisor + emits to the browser. Importing this
// package on both sides surfaces wire-shape drift as a compile error
// instead of a runtime undefined.
//
// Comments mark fields that gc supervisor MAY omit; treat them as
// optional and never assume presence in render code.

export type * from './snapshot/types.js';
export {
  resolveSessionForTarget,
  matchesSessionTarget,
  lastSegment,
} from './session-resolve.js';
export * from './workflow-detail.js';
export type * from './workflow-snapshot.js';
export * from './links.js';
export type * from './views.js';

export type IsoTimestamp = string;
export type BeadId = string;
export type SessionId = string;

// ── Sessions ──────────────────────────────────────────────────────────────

export interface GcSession {
  id: SessionId;
  template: string;
  /** Supervisor's tmux/screen session name on disk. Required per OpenAPI
   *  SessionResponse; present in 73/73 live sessions. */
  session_name: string;
  /** Required per OpenAPI SessionResponse; present in 73/73 live sessions. */
  title: string;
  alias?: string;
  state: GcSessionState;
  /** Set when state transition has a structured reason (e.g. "city-stop"). */
  reason?: string;
  /** Human-readable display name from the provider (e.g. "Claude Code"). */
  display_name?: string;
  created_at: IsoTimestamp;
  /** Last time the session emitted activity; only set after first activity. */
  last_active?: IsoTimestamp;
  /** Whether a human is currently attached to the tmux session. */
  attached: boolean;
  rig?: string;
  pool?: string;
  agent_kind?: 'pool' | 'role' | string;
  /** Process-running state independent of session.state (which is gc-level).
   *  Required per OpenAPI SessionResponse; present in 73/73 live sessions. */
  running: boolean;
  model?: string;
  context_pct?: number;
  context_window?: number;
  /** Coarse activity hint: 'idle' | 'thinking' | 'tool_use' | ... */
  activity?: string;
  /** Session provider (e.g. 'codex', 'claude', 'gemini'). Required per
   *  OpenAPI SessionResponse; present in 73/73 live sessions. */
  provider: string;
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
  /** Supervisor's own total count for the requested scope. Required per
   *  OpenAPI ListBodySessionResponse. */
  total: number;
  /** True when the supervisor reports the list is incomplete (one or more
   *  backends failed during aggregation). Wire shape is `items: null` +
   *  `partial: true`; the decoder normalizes items to `[]` so consumers
   *  always have an array, but the degradation signal survives here. */
  partial?: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partial_errors?: readonly string[];
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

// ── Agents (gascity-dashboard-ay6) ───────────────────────────────────────

/**
 * One entry from `GET /v0/city/{name}/agents`. Mirrors the supervisor's
 * `AgentResponse` schema narrowed to the fields the Agents list view
 * actually consumes — adding a field means widening both the decoder
 * Zod schema (backend/src/gc-supervisor-decoders.ts) and this type.
 *
 * The agents endpoint is the canonical roster: it surfaces every
 * configured agent regardless of whether a session is currently
 * running, which the previous session-derived path under-counted.
 * `session` is present only when an agent currently has a running
 * supervisor session; orphan agents (configured but not running) carry
 * everything except `session`.
 */
export interface GcAgent {
  /** Stable alias (e.g. 'mayor', 'thriva/devpipeline.architect'). Required. */
  name: string;
  /** Human-readable display name when supervisor sets one. */
  display_name?: string;
  /** Whether the agent is currently available to dispatch (config + runtime). */
  available: boolean;
  /** Whether the underlying process is running. Independent of `state`. */
  running: boolean;
  /** Whether the agent is suspended in city config. */
  suspended: boolean;
  /** gc-level lifecycle state (e.g. 'active', 'asleep', 'closed'). */
  state: string;
  /** Provider (e.g. 'codex', 'claude', 'gemini'). Optional per OpenAPI. */
  provider?: string;
  /** Model identifier (e.g. 'claude-opus-4-7'). */
  model?: string;
  /** Pool / role bucket (e.g. 'orchestration', 'research'). */
  pool?: string;
  /** Rig the agent is scoped to. Empty string for cross-rig agents (mayor). */
  rig?: string;
  /** Coarse activity hint ('idle' | 'thinking' | 'tool_use' | ...). */
  activity?: string;
  /** Raw context-pct as gc reports it. Use effectiveContextPct() for display. */
  context_pct?: number;
  /** gc's reported context-window denominator for the pct above. */
  context_window?: number;
  /** When available===false, the reason string the supervisor surfaces. */
  unavailable_reason?: string;
  /** Embedded SessionInfo when a session is currently bound to this agent. */
  session?: GcAgentSession;
}

/**
 * Subset of supervisor `SessionInfo` carried under `GcAgent.session`. Used to
 * drive the Agents view's peek-modal target + last-activity column when an
 * agent has a running session.
 */
export interface GcAgentSession {
  /** Session id / name on the supervisor (peek-modal target). Required. */
  name: string;
  /** True when a human is currently attached to the tmux session. Required. */
  attached: boolean;
  /** ISO timestamp of the session's most recent activity. */
  last_activity?: IsoTimestamp;
}

export interface GcAgentList {
  items: GcAgent[];
  /** True when the supervisor reports the list is incomplete (one or more
   *  backends failed during aggregation). Wire shape is `items: null` +
   *  `partial: true`; the decoder normalizes items to `[]` so consumers
   *  always have an array, but the degradation signal survives here. */
  partial?: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partial_errors?: readonly string[];
}

// ── Rigs (gascity-dashboard-19w) ─────────────────────────────────────────

/**
 * Per-rig shape returned by `GET /v0/city/{name}/rigs`. The supervisor's
 * RigResponse carries more fields (agent_count, running_count, git status,
 * suspended, last_activity, default_branch, prefix); only name + path are
 * exposed here because that's all the snapshot collector's CityRig
 * downstream contract needs. Other fields are intentionally dropped at
 * the decoder edge — adding one means widening both the decoder Zod
 * schema and the consumer (CityRig in snapshot/types.ts).
 */
export interface GcRig {
  name: string;
  path: string;
}

export interface GcRigList {
  items: GcRig[];
  /** True when the supervisor reports the list is incomplete (one or more
   *  backends failed during aggregation). Wire shape is `items: null` +
   *  `partial: true`; the decoder normalizes items to `[]` so consumers
   *  always have an array, but the degradation signal survives here. */
  partial?: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partial_errors?: readonly string[];
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

/**
 * Dependency edge inside the OpenAPI `Bead.dependencies` list. Mirrors the
 * supervisor's `Dep` schema. Surfaced so workflow-graph collectors can read
 * dependencies without an `as any` cast.
 */
export interface GcBeadDep {
  depends_on_id: string;
  issue_id: string;
  type: string;
}

export interface GcBead {
  id: BeadId;
  title: string;
  status: BeadStatus;
  issue_type: BeadIssueType;
  /** Supervisor sends `priority: null` for non-engineering beads (messages,
   *  sessions, …) and the OpenAPI spec declares the field optional. Treat
   *  this as nullable on the wire; callers that need a sortable number must
   *  coalesce. */
  priority: number | null;
  description?: string;
  assignee?: string;
  created_at: IsoTimestamp;
  labels?: string[];
  /** OpenAPI Bead.metadata is declared as `{[key: string]: string}` — values
   *  are strings only. Callers needing typed numbers/booleans must parse
   *  explicitly. */
  metadata?: Record<string, string>;
  /** Supervisor-supplied reference handle. On formula templates this is
   *  the formula name (e.g. "mol-focus-review"). Absent on most beads. */
  ref?: string;
  /** Parent bead id (OpenAPI Bead.parent). */
  parent?: string;
  /** Originating actor / source id (OpenAPI Bead.from). */
  from?: string;
  /** True when the supervisor marks the bead as ephemeral. */
  ephemeral?: boolean;
  /** Bead ids this bead needs before it can run (OpenAPI Bead.needs). */
  needs?: string[] | null;
  /** Structured dependency rows (OpenAPI Bead.dependencies). */
  dependencies?: GcBeadDep[] | null;
}

export interface GcBeadList {
  items: GcBead[];
  /** gc supervisor's own total count for the requested scope (independent of
   *  the fetch limit). Required per OpenAPI ListBodyBead. */
  total: number;
  /** True when the supervisor reports the list is incomplete (one or more
   *  backends failed during aggregation). Wire shape is `items: null` +
   *  `partial: true`; the decoder normalizes items to `[]` so consumers
   *  always have an array, but the degradation signal survives here. */
  partial?: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partial_errors?: readonly string[];
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

// ── Supervisor write wire-shapes (gascity-dashboard-mq2) ─────────────────
// Request/response bodies for the supervisor's HTTP write endpoints the
// dashboard adopts in place of `gc` CLI subprocesses. These are the
// supervisor↔backend contract (mirroring SlingInputBody / SlingResponse in
// the supervisor's OpenAPI), distinct from the browser↔backend shapes; the
// GcClient is the only consumer.

/**
 * Body for `POST /v0/city/{city}/sling`. Only `target` is required
 * upstream; `bead` carries the free-text bead body (what the `gc sling
 * <target> <text>` CLI passed positionally). The formula/scope fields are
 * part of the upstream schema but unused by v1 text-only slings — kept off
 * this type until the formula-driven follow-up (bead 6fp) needs them.
 */
export interface SlingInput {
  target: string;
  /** Free-text bead body. */
  bead?: string;
}

/**
 * Response from `POST /v0/city/{city}/sling`. `root_bead_id` is the routed
 * bead the dashboard records in slung-state (replaces the `^Slung <id>`
 * stdout parse). Other fields are surfaced by the supervisor but unused
 * here; typed optional so a schema addition upstream doesn't break parsing.
 */
export interface SlingResponse {
  root_bead_id?: string;
  bead?: string;
  workflow_id?: string;
  target?: string;
  status?: string;
}

/**
 * Body for `PATCH /v0/city/{city}/bead/{id}` (gascity-dashboard-mq2;
 * replaces the `gc bd update` CLI subprocess on the bead-CLAIM path). Mirrors
 * the supervisor's `BeadUpdateBody` schema. The dashboard's claim action sets
 * `status: 'in_progress'` + `assignee: 'stephanie'`; the rest of the upstream
 * schema (title/description/labels/priority/…) is unused by the dashboard and
 * left off this type until a use case needs it. NOTE: bead CLOSE deliberately
 * stays on the CLI — the supervisor's `/bead/{id}/close` endpoint has no reason
 * field and the dashboard's close-reason UI would silently lose it.
 */
export interface BeadUpdateInput {
  status?: BeadStatus;
  assignee?: string;
}

/**
 * Body for `POST /v0/city/{city}/mail` (gascity-dashboard-mq2; replaces the
 * `gc mail send` CLI subprocess). Mirrors the supervisor's `MailSendInputBody`.
 * The server pins `from: 'human'` (gc's canonical operator identity); the
 * browser-facing shape (`MailComposeRequest`) has no `from` slot, so there is
 * no path to send-as-someone-else. `to`/`subject` are required upstream.
 */
export interface MailSendInput {
  to: string;
  subject: string;
  body: string;
  from: string;
  rig?: string;
}

/**
 * Response from `POST /v0/city/{city}/mail` (the supervisor's `Message`
 * schema; returns 201). Only `id` is consumed by the dashboard (surfaced as
 * `message_id` on the browser-facing `MailSendResult`); the rest is typed
 * optional so a schema addition upstream doesn't break parsing.
 */
export interface MailSendResponse {
  id: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  created_at?: IsoTimestamp;
  read?: boolean;
  thread_id?: string;
  rig?: string;
  /** Optional supervisor-assigned priority (OpenAPI Message.priority). */
  priority?: number;
  /** Optional CC list (OpenAPI Message.cc). */
  cc?: string[] | null;
  /** Optional reply-to header (OpenAPI Message.reply_to). */
  reply_to?: string;
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
  /** Optional supervisor-assigned priority (OpenAPI Message.priority). */
  priority?: number;
  /** Optional CC list (OpenAPI Message.cc). */
  cc?: string[] | null;
  /** Optional reply-to header (OpenAPI Message.reply_to). */
  reply_to?: string;
}

export interface GcMailList {
  items: GcMailItem[];
  /** Supervisor's own total count for the requested scope. Required per
   *  OpenAPI MailListBody. */
  total: number;
  /** True when one or more rig providers failed and the list is not
   *  authoritative. Wire shape is `items: null` + `partial: true`; decoder
   *  normalizes items to `[]` so consumers always have an array. */
  partial?: boolean;
  /** Per-provider errors when partial is true. */
  partial_errors?: readonly string[];
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
  /** gc supervisor's own city health probe. */
  supervisor: SupervisorHealthState;
}

export interface SupervisorHealth {
  status: string;
  /** Supervisor version. Optional per the supervisor's OpenAPI; present in
   *  practice today. Absence is itself a wire-drift signal — surface it
   *  rather than coalescing silently. */
  version?: string;
  /** City name. Optional per the supervisor's OpenAPI; present in practice
   *  today. Absence is itself a wire-drift signal — surface it rather than
   *  coalescing silently. */
  city?: string;
  uptime_sec: number;
}

export type SupervisorHealthState =
  | {
      status: 'available';
      data: SupervisorHealth;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export interface DoltNomsSample {
  ts: IsoTimestamp;
  bytes: number;
}

export type DoltNomsUnavailableReason =
  | 'city_path_missing'
  | 'city_path_not_absolute'
  | 'noms_directory_missing'
  | 'noms_path_not_directory'
  | 'sample_failed';

export type DoltNomsTrend =
  | {
      available: true;
      /** Up to 144 samples (24 h at 10-min cadence). */
      samples: DoltNomsSample[];
      source: string;
    }
  | {
      available: false;
      /** Historical samples, if the source became unavailable after sampling. */
      samples: DoltNomsSample[];
      reason: DoltNomsUnavailableReason;
    };

// ── Events (SSE; Phase C wires; type-locked early) ──────────────────────

export interface GcEvent {
  seq: number;
  type: string;
  ts: IsoTimestamp;
  /** Required across every TypedEventStreamEnvelope variant in OpenAPI;
   *  present in 200/200 sampled live events. */
  actor: string;
  /** Required across every TypedEventStreamEnvelope variant in OpenAPI;
   *  per-variant payload shape varies (BeadEventPayload, NoPayload, …)
   *  so the surface type stays a generic record. */
  payload: Record<string, unknown>;
  subject?: string;
  message?: string;
}

export interface GcEventList {
  items: GcEvent[];
  /** Supervisor's own total count for the requested scope. Required per
   *  OpenAPI ListBodyWireEvent. */
  total: number;
  /** True when the supervisor reports the list is incomplete (one or more
   *  backends failed during aggregation). Wire shape is `items: null` +
   *  `partial: true`; decoder normalizes items to `[]` so consumers always
   *  have an array. */
  partial?: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partial_errors?: readonly string[];
}

/**
 * One entry from the supervisor's `/v0/city/<city>/formulas/feed` endpoint —
 * a cross-rig view of every formula run the supervisor knows about, including
 * runs whose root beads live in rig stores (which `/v0/city/<city>/beads`
 * does NOT return). The dashboard uses this to discover rig-stored workflow
 * roots that listBeads alone would miss — see gascity-dashboard-ej9y. The
 * shape mirrors the supervisor's `MonitorFeedItemResponse`.
 */
export interface GcFormulaRun {
  id: string;
  /** Always `'formula'` for items in this feed. */
  type: string;
  /** Lifecycle status (e.g. `'pending'`, `'done'`). */
  status: string;
  /** Formula name (e.g. `'mol-focus-review'`). */
  title: string;
  scope_kind: 'city' | 'rig' | (string & {});
  scope_ref: string;
  /** Absolute workspace path the formula is operating on. */
  target: string;
  started_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  /** Workflow root bead id (when the formula instantiated a workflow). */
  workflow_id?: string;
  root_bead_id?: string;
  /** e.g. `'rig:gascity'` — needed to discover which rig's bead store the
   *  workflow lives in for downstream listBeads queries. */
  root_store_ref?: string;
  attached_bead_id?: string;
  logical_bead_id?: string;
  bead_id?: string;
  store_ref?: string;
  detail_available?: boolean;
  run_detail_available?: boolean;
}

export interface GcFormulaRunList {
  items: GcFormulaRun[];
  /** True when the supervisor reports the list is incomplete (one or more
   *  backends failed during aggregation). Wire shape is `items: null` +
   *  `partial: true`; decoder normalizes items to `[]` so consumers always
   *  have an array.
   *
   *  Required (not optional) because the supervisor's OpenAPI declares
   *  `FormulaFeedBody.partial` as required `boolean` — distinct from the
   *  other List* envelopes whose `partial` is optional. Tracked in
   *  gascity-dashboard-mfb9. */
  partial: boolean;
  /** Human-readable errors from backends that failed during aggregation. */
  partial_errors?: readonly string[];
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
