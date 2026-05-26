// Read-side telemetry envelope shared across the snapshot series
// (gascity-dashboard-37u). Ported from demo-dash src/shared/types.ts.
//
// The SourceName union enumerates every source the dashboard may surface;
// individual collectors are wired in later beads. Listing all six names
// here even though only city/workflows/resources have collectors today
// keeps DashboardSources (bead-3) and the fixture (bead-2) able to
// `satisfies` a fully-keyed object without churn when the remaining
// collectors land.

export type SourceName =
  | 'aimux'
  | 'city'
  | 'resources'
  | 'workflows'
  | 'github'
  | 'tokens';

export type SourceStatus = 'fresh' | 'stale' | 'error' | 'fixture';

export interface SourceState<T> {
  source: SourceName;
  status: SourceStatus;
  fetchedAt: string | null;
  staleAt: string | null;
  error: string | null;
  data: T | null;
}

// ── Aggregate snapshot ────────────────────────────────────────────────────

export interface DashboardSnapshot {
  generatedAt: string;
  config: DashboardRuntimeConfig;
  headline: DashboardHeadline;
  sources: DashboardSources;
}

export interface DashboardRuntimeConfig {
  cityRoot: string;
  githubRepo: string;
  useFixtures: boolean;
}

export interface DashboardHeadline {
  activeAgents: number | null;
  maxAgents: number | null;
  activeSessions: number | null;
  activeWorkflows: number | null;
  githubOpenReviews: number | null;
}

export interface DashboardSources {
  aimux: SourceState<AimuxQuotaSummary>;
  city: SourceState<CityStatusSummary>;
  resources: SourceState<ResourceSummary>;
  workflows: SourceState<WorkflowSummary>;
  github: SourceState<GitHubSummary>;
  tokens: SourceState<TokenUsageSummary>;
}

/**
 * Per-source data shape map. Derived from DashboardSources so the two
 * cannot drift; used by fixtureSourceLoader<K> in the snapshot fixtures
 * module to return a precisely-typed data accessor per source name.
 *
 * NonNullable wraps T inside the conditional so the intent ("strip the
 * null that data: T | null carries") is explicit, even though every
 * current T is already non-nullable. The form-vs-coincidence distinction
 * matters if a future source ever types its T as `Foo | null` directly.
 */
export type SourceDataMap = {
  [K in SourceName]: DashboardSources[K] extends SourceState<infer T>
    ? NonNullable<T>
    : never;
};

// ── aimux ─────────────────────────────────────────────────────────────────

export interface AimuxQuotaSummary {
  vendors: AimuxVendorQuota[];
  warnings: string[];
}

export interface AimuxVendorQuota {
  vendor: string;
  accounts: AimuxAccountQuota[];
}

export interface AimuxAccountQuota {
  account: string;
  status: 'available' | 'limited' | 'blocked' | 'unknown';
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  resetAt: string | null;
  warning: string | null;
  error: string | null;
}

export interface QuotaWindow {
  used: number | null;
  available: number | null;
  limit: number | null;
  utilization: number | null;
  resetAt: string | null;
}

// ── city ──────────────────────────────────────────────────────────────────

export interface CityStatusSummary {
  activeAgents: number | null;
  totalAgents: number | null;
  activeSessions: number | null;
  suspendedSessions: number | null;
  maxSessions: number | null;
  sessionsByProvider: CitySessionProvider[];
  rigs: CityRig[];
}

export interface CitySessionProvider {
  provider: string;
  active: number;
  total: number;
}

export interface CityRig {
  name: string;
  path: string;
}

// ── resources ─────────────────────────────────────────────────────────────

export interface ResourceSummary {
  vcpuCount: number;
  loadAverage: [number, number, number];
  loadPerVcpu: number;
  memory: MemorySummary;
  uptimeSeconds: number;
  samples: ResourceSample[];
}

export interface MemorySummary {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilization: number;
}

export interface ResourceSample {
  sampledAt: string;
  vcpuCount: number;
  loadAverage: [number, number, number];
  loadPerVcpu: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryUtilization: number;
}

// ── workflows ─────────────────────────────────────────────────────────────

export interface WorkflowSummary {
  totalActive: number;
  runCounts: WorkflowRunCounts;
  lanes: WorkflowLane[];
  recentChanges: WorkflowChange[];
  /**
   * City-level health census (gascity-dashboard-3ax). Threshold-INDEPENDENT
   * counts only — derived once in the backend snapshot read path. The
   * time-derived `byStalenessTier` / "failing" counts are deliberately NOT
   * here: per R9 the staleness threshold crossing is owned by the frontend's
   * 1s selector (kb3), so a server-frozen tier census would under-count for
   * up to the cache TTL on a pure-time stall crossing. Null until the engine
   * has run (live path always populates it; fixtures may omit).
   */
  census: WorkflowCensus | null;
}

/**
 * Threshold-independent city census (gascity-dashboard-3ax, PRD §4 / R5).
 * Every field here is derivable from a single snapshot with no wall-clock
 * threshold, so freezing it inside the 60s cache TTL is safe. The frontend
 * adds the time-derived "failing / stalled" count on its 1s clock.
 */
export interface WorkflowCensus {
  /** In-flight (non-complete, non-blocked) lane count per phase. */
  byPhase: Record<WorkflowPhase, number>;
  /** Total in-flight lanes (the census denominator base). */
  totalInFlight: number;
  /**
   * In-flight lanes the engine cannot classify with confidence
   * (phaseConfidence === 'inferred'). R5: drives "1 unverifiable" and must
   * never be folded into a calm count. Excluded from `knownDenominator`.
   */
  unverifiable: number;
  /**
   * In-flight lanes with phaseConfidence === 'known'. R5: the honest
   * denominator behind "nothing failing (of N known)".
   */
  knownDenominator: number;
  /**
   * In-flight lanes where progress-monotonicity tripped (R1 thrashing).
   * Cross-cycle, server-only — the one "failing"-class signal the client
   * cannot recompute, so it is shipped as a count here. Time-derived stalls
   * are added client-side.
   */
  thrashing: number;
}

export type WorkflowPhaseConfidence = 'known' | 'inferred';

/**
 * Per-lane health derived by the backend engine (gascity-dashboard-3ax).
 * R9-strict contract: this carries FACTS and the one server-only signal
 * (`thrashingDetected`), never a frozen staleness-tier enum. The frontend
 * computes the staleness tier + age from `WorkflowLane.updatedAt` (=
 * max bead updated_at) and `sessionLastActive` on its 1s clock.
 *
 * Optional on the lane: present on every live-served lane (the engine runs
 * in the snapshot read path), absent only on un-enriched fixture literals.
 */
export interface WorkflowLaneHealth {
  /**
   * 'known' iff a formula matched AND the active gc.step_id resolved into a
   * known stage; else 'inferred' (generic fallback / the includes('blocked')
   * sniff). A structural fact about which code path fired (ZFC-clean). An
   * 'inferred' lane must never drive the maroon One Mark (R2/R5).
   */
  phaseConfidence: WorkflowPhaseConfidence;
  /**
   * Decision-pending from bead state alone (human-approval gate or blocked).
   * Threshold-independent. The stalled-driven attention signal is added
   * client-side from the staleness tier.
   */
  needsOperator: boolean;
  /**
   * The semantic node id (raw gc.step_id) the lane is parked on, for the
   * `?node=:stuckNodeId` deep link (PRD §5). Null when no active step
   * resolved. Equals `WorkflowLane.activeStepId`.
   */
  stuckNodeId: string | null;
  /**
   * R1 progress-monotonicity: attempt-of-active-step climbed while the
   * lane's graph position (active stage) stayed flat across cache
   * generations. Freshness-independent — the only stall signal robust to a
   * thrashing retry/poll loop. Cross-cycle; cannot be client-derived.
   *
   * WARNING (R2 footgun): this is the RAW structural fact and can be `true`
   * even when `phaseConfidence === 'inferred'`. An inferred lane must NEVER
   * drive the maroon One Mark, so a consumer using this to paint a visual
   * alarm MUST gate on `phaseConfidence === 'known'` first. The server-side
   * census already does this (its `thrashing` count excludes inferred lanes).
   */
  thrashingDetected: boolean;
  /** Whether the lane's assignee resolved to a concrete supervisor session. */
  sessionResolved: boolean;
  /** Resolved session's last_active (ISO), for the client age/idle clock. Null when unresolved. */
  sessionLastActive: string | null;
  /** Resolved session's process-running flag. Null when unresolved or unset upstream. */
  sessionRunning: boolean | null;
  /** Resolved session's coarse activity hint (e.g. 'idle'). Null when unresolved or unset. */
  sessionActivity: string | null;
}

export interface WorkflowRunCounts {
  total: number;
  visible: number;
  prReview: number;
  designReview: number;
  bugfix: number;
  blocked: number;
  other: number;
}

export interface WorkflowLane {
  id: string;
  title: string;
  formula: string | null;
  externalUrl: string | null;
  externalLabel: string | null;
  phase: WorkflowPhase;
  phaseLabel: string;
  statusCounts: Record<string, number>;
  activeAssignees: string[];
  updatedAt: string | null;
  stages: WorkflowStage[];
  /**
   * Raw gc.step_id of the step the lane is currently active on
   * (gascity-dashboard-3ax). NOT the coarse stage key — L2's graph nodes
   * key on the raw step id, so this is the `?node=` deep-link target. Null
   * when no in_progress step carries a gc.step_id.
   *
   * Required-with-null (not optional): the lane builder ALWAYS sets it, and
   * making it required forces every WorkflowLane producer (incl. fixtures) to
   * commit to a value rather than silently degrading the engine via undefined
   * (typescript-reviewer HIGH-2).
   */
  activeStepId: string | null;
  /**
   * Attempt/iteration count of the ACTIVE step (gascity-dashboard-3ax),
   * keyed to `activeStepId` — not the lossy lane-wide max. The engine's
   * monotonicity predicate needs per-step attempt so it fires on a wedged
   * retry of one step, not on a normal stage transition. Null when no
   * attempt encoded.
   */
  activeStepAttempt: number | null;
  /**
   * Index of the active stage within `stages` (gascity-dashboard-3ax). The
   * engine's "graph position flat" check compares this across cache
   * generations. Null when no stage is active.
   */
  activeStageIndex: number | null;
  /**
   * Provenance fact (gascity-dashboard-3ax): the lane's stages came from a
   * RECOGNISED formula AND the active gc.step_id mapped into one of those
   * formula stages — i.e. not the generic 5-stage fallback or the
   * includes('blocked') sniff. The engine ANDs this with session-resolution
   * to set phaseConfidence (PRD §6 / R2). Bead-side only; the builder owns it.
   */
  formulaStageResolved: boolean;
  /**
   * Engine-derived health (gascity-dashboard-3ax). Present on every
   * live-served lane; null/absent only on un-enriched fixture literals (the
   * engine runs in the snapshot read path, so the served wire always carries
   * it). Optional because the lane BUILDER does not set it — only the engine.
   */
  health?: WorkflowLaneHealth | null;
}

export type WorkflowPhase =
  | 'intake'
  | 'implementation'
  | 'review'
  | 'approval'
  | 'finalization'
  | 'blocked'
  | 'complete'
  | 'active';

export interface WorkflowStage {
  key: string;
  label: string;
  status: 'pending' | 'active' | 'complete' | 'blocked';
}

export interface WorkflowChange {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

// ── github ────────────────────────────────────────────────────────────────

export interface GitHubSummary {
  repo: string;
  openPullRequests: number | null;
  openReviewDemand: number | null;
  reviewActivity: WindowedCounts;
  mergedPullRequests: WindowedCounts;
  commitsToMain: WindowedCounts;
  newContributors: WindowedCounts;
  recentActivity: GitHubActivity[];
  rateLimit: GitHubRateLimit | null;
}

export interface WindowedCounts {
  oneDay: number | null;
  sevenDays: number | null;
  thirtyDays: number | null;
}

export interface GitHubActivity {
  kind: 'pull_request' | 'commit' | 'review' | 'release';
  title: string;
  url: string | null;
  actor: string | null;
  occurredAt: string;
}

export interface GitHubRateLimit {
  remaining: number;
  limit: number;
  resetAt: string | null;
}

// ── tokens ────────────────────────────────────────────────────────────────

export interface TokenUsageSummary {
  windows: WindowedCounts;
  clients: string[];
  activeDays: number;
}
