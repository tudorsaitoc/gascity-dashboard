// Read-side telemetry envelope shared across the snapshot series
// (gascity-dashboard-37u).
//
// The SourceName union enumerates the sources this dashboard actually serves.
// Sources stay out of the runtime contract until they have real collectors and
// visible product surface.

export type SourceName =
  | 'city'
  | 'resources'
  | 'workflows';

export type SourceStatus = 'fresh' | 'stale' | 'error' | 'fixture';

export type SourceError =
  | { kind: 'none' }
  | { kind: 'message'; message: string };

export interface SourceAvailableState<T> {
  source: SourceName;
  status: Exclude<SourceStatus, 'error'>;
  fetchedAt: string;
  staleAt: string;
  error: SourceError;
  data: T;
}

export interface SourceUnavailableState {
  source: SourceName;
  status: 'error';
  error: string;
}

export type SourceState<T> = SourceAvailableState<T> | SourceUnavailableState;

// ── Aggregate snapshot ────────────────────────────────────────────────────

export interface DashboardSnapshot {
  generatedAt: string;
  config: DashboardRuntimeConfig;
  headline: DashboardHeadline;
  sources: DashboardSources;
}

export interface DashboardRuntimeConfig {
  cityName: string;
  cityRoot: string;
  githubRepo: string;
  useFixtures: boolean;
}

export type DashboardMetric =
  | {
      status: 'available';
      value: number;
    }
  | {
      status: 'unavailable';
      source: SourceName;
      error: string;
    };

export interface DashboardHeadline {
  activeAgents: DashboardMetric;
  maxAgents: DashboardMetric;
  activeSessions: DashboardMetric;
  activeWorkflows: DashboardMetric;
}

export interface DashboardSources {
  city: SourceState<CityStatusSummary>;
  resources: SourceState<ResourceSummary>;
  workflows: SourceState<WorkflowSummary>;
}

/**
 * Per-source data shape map. Derived from DashboardSources so the two
 * cannot drift; used by fixtureSourceLoader<K> in the snapshot fixtures
 * module to return a precisely-typed data accessor per source name.
 *
 * SourceState only exposes data on available states; unavailable states carry
 * a required error instead of a nullable data sentinel.
 */
export type SourceDataMap = {
  [K in SourceName]: DashboardSources[K] extends SourceState<infer T>
    ? NonNullable<T>
    : never;
};

// ── city ──────────────────────────────────────────────────────────────────

export interface CityStatusSummary {
  activeAgents: number;
  totalAgents: number;
  activeSessions: number;
  suspendedSessions: number;
  maxSessions: DashboardMetric;
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
   * up to the cache TTL on a pure-time stall crossing.
   */
  census: WorkflowCensusState;
}

export type WorkflowCensusState =
  | {
      status: 'available';
      data: WorkflowCensus;
    }
  | {
      status: 'unavailable';
      error: string;
    };

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
 * max bead updated_at) and the resolved session's `lastActive` fact on its
 * 1s clock.
 *
 * Every lane carries an explicit health state. The lane builder emits an
 * unavailable pre-engine state; the snapshot read path replaces it with these
 * available health facts.
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
   * `?node=:stuckNodeId` deep link (PRD §5). Unavailable when no active step
   * resolved.
   */
  stuckNode: WorkflowLaneStuckNode;
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
  /** Resolved session facts. Unresolved and missing upstream fields are explicit states. */
  session: WorkflowLaneSessionState;
}

export type WorkflowLaneHealthState =
  | {
      status: 'available';
      data: WorkflowLaneHealth;
    }
  | {
      status: 'unavailable';
      error: string;
    };

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
  formula: WorkflowLaneFormula;
  scope: WorkflowLaneScope;
  external: WorkflowLaneExternalReference;
  phase: WorkflowPhase;
  phaseLabel: string;
  statusCounts: Record<string, number>;
  activeAssignees: string[];
  updatedAt: WorkflowLaneUpdatedAt;
  stages: WorkflowStage[];
  progress: WorkflowLaneProgress;
  /**
   * Provenance fact (gascity-dashboard-3ax): the lane's stages came from a
   * RECOGNISED formula AND the active gc.step_id mapped into one of those
   * formula stages — i.e. not the generic 5-stage fallback or the
   * includes('blocked') sniff. The engine ANDs this with session-resolution
   * to set phaseConfidence (PRD §6 / R2). Bead-side only; the builder owns it.
   */
  formulaStageResolved: boolean;
  /**
   * Engine-derived health (gascity-dashboard-3ax). The lane builder emits
   * an explicit unavailable pre-engine state; the snapshot read path replaces
   * it with available health facts.
   */
  health: WorkflowLaneHealthState;
}

export type WorkflowLaneUpdatedAt =
  | {
      status: 'available';
      at: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneProgress =
  | {
      status: 'active_step';
      /** Raw gc.step_id of the active primary step. */
      stepId: string;
      stage: WorkflowLaneStagePosition;
      attempt: WorkflowLaneStepAttempt;
    }
  | {
      status: 'stage_only';
      stage: WorkflowLaneStagePosition;
      error: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneStagePosition =
  | {
      status: 'available';
      index: number;
      key: string;
      label: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneStepAttempt =
  | {
      status: 'available';
      value: number;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneStuckNode =
  | {
      status: 'available';
      id: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneSessionState =
  | {
      status: 'resolved';
      lastActive: WorkflowLaneSessionLastActive;
      running: WorkflowLaneSessionRunning;
      activity: WorkflowLaneSessionActivity;
    }
  | {
      status: 'unresolved';
      error: string;
    };

export type WorkflowLaneSessionLastActive =
  | {
      status: 'available';
      at: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneSessionRunning =
  | {
      status: 'available';
      value: boolean;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneSessionActivity =
  | {
      status: 'available';
      value: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneFormula =
  | {
      status: 'known';
      name: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneExternalReference =
  | {
      status: 'available';
      label: string;
      url: string;
    }
  | {
      status: 'label_only';
      label: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

export type WorkflowLaneScope =
  | {
      status: 'available';
      kind: 'city' | 'rig';
      ref: string;
      rootStoreRef: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

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
