import {
  resolveSessionForTarget,
  type GcSession,
  type WorkflowCensus,
  type WorkflowLane,
  type WorkflowLaneHealth,
  type WorkflowPhase,
} from 'gas-city-dashboard-shared';

// Workflow-health derivation engine (gascity-dashboard-3ax).
//
// One deterministic derivation, run once in the snapshot read path, that
// annotates each WorkflowLane with health FACTS and computes a
// threshold-independent city census. PRD §6 + risks R1/R2/R5/R8/R9.
//
// R9-strict contract (the load-bearing design choice). The engine emits NO
// staleness-tier enum and NO byStalenessTier census. The time-derived
// staleness crossing is owned by the frontend's 1s selector (kb3) so a
// server-frozen tier would never under-count inside the 60s cache TTL. The
// engine therefore ships only:
//   - structural provenance (phaseConfidence)
//   - bead-state facts (needsOperator, stuckNodeId)
//   - the resolved session's raw fields (for the client age/idle clock)
//   - thrashingDetected — the ONE "failing"-class signal the client cannot
//     recompute, because it is cross-cycle (progress-monotonicity, R1).
//
// The engine is split into two pure functions so the cross-cycle state stays
// honest under the cache's 60s freeze and concurrent reads (see service.ts):
//   - advanceProgressMarks(prev, lanes) — the cross-cycle step. Called ONLY
//     when the workflows cache produced a NEW generation (fetchedAt changed).
//     Pure function of (prev, lanes); two concurrent builds reading the same
//     inputs produce the same marks, so storing is idempotent.
//   - deriveWorkflowHealth({ lanes, sessions, marks, … }) — the per-read
//     derivation. Reads the (already-advanced) streak out of `marks`, so
//     thrashingDetected is stable across every read of one cached generation
//     rather than flipping on the second read.

/** Default attempt climb that counts as one thrash tick. */
const DEFAULT_ATTEMPT_CLIMB_MIN = 1;
/** Default consecutive ticks the predicate must hold before detection (R8 hysteresis). */
const DEFAULT_THRASH_DETECTED_STREAK = 2;

export interface HealthThresholds {
  /** Minimum attempt increase between generations to count as a thrash tick. */
  attemptClimbMin: number;
  /**
   * Consecutive thrash ticks required before `thrashingDetected` flips true
   * (R8 favicon hysteresis — never alarm on a single transient cycle).
   */
  thrashDetectedStreak: number;
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  attemptClimbMin: DEFAULT_ATTEMPT_CLIMB_MIN,
  thrashDetectedStreak: DEFAULT_THRASH_DETECTED_STREAK,
};

/**
 * Per-lane cross-cycle progress mark. Ephemeral process state held by the
 * service (never persisted — PRD R7 bars a persistence layer; this is not
 * one). Captures the inputs to the monotonicity predicate for the LATEST
 * observed cache generation, plus the running streak.
 */
export interface LaneProgressMark {
  activeStepId: string | null;
  activeStageIndex: number | null;
  activeStepAttempt: number | null;
  /** Consecutive generations the climb-while-flat predicate has held. */
  thrashStreak: number;
}

export interface DeriveWorkflowHealthInput {
  lanes: readonly WorkflowLane[];
  sessions: readonly GcSession[];
  /**
   * Whether the sessions read succeeded. When false the join is impossible,
   * so EVERY lane degrades to unresolved → inferred → never drives the maroon
   * One Mark (PRD R2 fail-safe). A sessions failure must NOT throw into the
   * workflows source — it degrades confidence, it does not blank the lanes.
   */
  sessionsAvailable: boolean;
  /** Cross-cycle marks for the LATEST generation (already advanced). */
  marks: ReadonlyMap<string, LaneProgressMark>;
  thresholds?: Partial<HealthThresholds>;
}

export interface DeriveWorkflowHealthResult {
  lanes: WorkflowLane[];
  census: WorkflowCensus;
}

/**
 * Cross-cycle step. Returns fresh marks built from the CURRENT lanes: a lane
 * that thrashed (attempt climbed while active step + stage stayed flat) has
 * its streak incremented; any other transition resets it to 0; lanes absent
 * from the current set are dropped (no stale carry).
 *
 * Call this ONLY on a genuine new cache generation. Calling it on every read
 * of one frozen generation would compare a generation against itself, reset
 * the streak, and re-introduce the R1 silent-miss.
 */
export function advanceProgressMarks(
  previous: ReadonlyMap<string, LaneProgressMark>,
  lanes: readonly WorkflowLane[],
  thresholds: Partial<HealthThresholds> = {},
): Map<string, LaneProgressMark> {
  const { attemptClimbMin } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const next = new Map<string, LaneProgressMark>();

  for (const lane of lanes) {
    const stepId = lane.activeStepId ?? null;
    const stageIndex = lane.activeStageIndex ?? null;
    const attempt = lane.activeStepAttempt ?? null;
    const prior = previous.get(lane.id);

    const positionFlat =
      prior !== undefined &&
      prior.activeStepId === stepId &&
      prior.activeStageIndex === stageIndex;
    const climbed =
      prior !== undefined &&
      attempt !== null &&
      prior.activeStepAttempt !== null &&
      attempt - prior.activeStepAttempt >= attemptClimbMin;

    const thrashStreak = positionFlat && climbed ? prior.thrashStreak + 1 : 0;

    next.set(lane.id, {
      activeStepId: stepId,
      activeStageIndex: stageIndex,
      activeStepAttempt: attempt,
      thrashStreak,
    });
  }

  return next;
}

/**
 * Per-read derivation. Pure and idempotent given the same (lanes, sessions,
 * marks). Annotates each lane with `health` and returns the threshold-
 * independent census.
 */
export function deriveWorkflowHealth(
  input: DeriveWorkflowHealthInput,
): DeriveWorkflowHealthResult {
  const { thrashDetectedStreak } = { ...DEFAULT_THRESHOLDS, ...input.thresholds };

  const lanes = input.lanes.map((lane) => {
    const session = input.sessionsAvailable
      ? resolveLaneSession(lane, input.sessions)
      : null;
    const sessionResolved = session !== null;

    // R2: an unresolved assignee can never be 'known' (must not drive maroon),
    // regardless of the bead-side provenance. Confidence = formula resolved
    // AND the assignee resolves to a live session.
    const phaseConfidence: WorkflowLaneHealth['phaseConfidence'] =
      lane.formulaStageResolved === true && sessionResolved ? 'known' : 'inferred';

    const thrashStreak = input.marks.get(lane.id)?.thrashStreak ?? 0;

    const health: WorkflowLaneHealth = {
      phaseConfidence,
      // Decision-pending from bead state alone — threshold-independent. The
      // stalled-driven attention signal is added client-side from the facts.
      needsOperator: lane.phase === 'approval' || lane.phase === 'blocked',
      stuckNodeId: lane.activeStepId ?? null,
      thrashingDetected: thrashStreak >= thrashDetectedStreak,
      sessionResolved,
      sessionLastActive: session?.last_active ?? null,
      sessionRunning: session?.running ?? null,
      sessionActivity: session?.activity ?? null,
    };

    return { ...lane, health };
  });

  return { lanes, census: buildCensus(lanes) };
}

/**
 * First assignee that resolves to a session (active sessions preferred by the
 * shared resolver). The lossy role→session join PRD R2 flags as load-bearing.
 */
function resolveLaneSession(
  lane: WorkflowLane,
  sessions: readonly GcSession[],
): GcSession | null {
  for (const assignee of lane.activeAssignees) {
    const session = resolveSessionForTarget(assignee, sessions);
    if (session !== null) return session;
  }
  return null;
}

/**
 * Zero-initialised phase counts. Written as an explicit object literal (not
 * Object.fromEntries + cast) so the compiler enforces exhaustiveness: adding a
 * member to the WorkflowPhase union without a key here is a type error, rather
 * than silently producing an incomplete Record that increments `undefined` →
 * NaN at runtime (typescript-reviewer HIGH-1).
 */
function zeroByPhase(): Record<WorkflowPhase, number> {
  return {
    intake: 0,
    implementation: 0,
    review: 0,
    approval: 0,
    finalization: 0,
    blocked: 0,
    complete: 0,
    active: 0,
  };
}

/**
 * Threshold-independent census over the (enriched) lanes. "In flight" excludes
 * `complete`. R5: `unverifiable` (inferred) and `knownDenominator` (known)
 * partition the in-flight set; `thrashing` is gated to KNOWN confidence so an
 * unverifiable lane can never inflate the "failing"-class count (R2).
 */
function buildCensus(lanes: readonly WorkflowLane[]): WorkflowCensus {
  const byPhase = zeroByPhase();

  let totalInFlight = 0;
  let unverifiable = 0;
  let knownDenominator = 0;
  let thrashing = 0;

  for (const lane of lanes) {
    byPhase[lane.phase] += 1;
    if (lane.phase === 'complete') continue;

    totalInFlight += 1;
    const known = lane.health?.phaseConfidence === 'known';
    if (known) {
      knownDenominator += 1;
      if (lane.health?.thrashingDetected === true) thrashing += 1;
    } else {
      unverifiable += 1;
    }
  }

  return { byPhase, totalInFlight, unverifiable, knownDenominator, thrashing };
}
