import {
  resolveSessionForTarget,
  type GcSession,
  type RunCensus,
  type RunLane,
  type RunLaneHealth,
  type RunPhase,
} from 'gas-city-dashboard-shared';

// Run-health derivation engine (gascity-dashboard-3ax).
//
// One deterministic derivation, run once in the snapshot read path, that
// annotates each RunLane with health FACTS and computes a
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
//     when the runs cache produced a NEW generation (fetchedAt changed).
//     Pure function of (prev, lanes); two concurrent builds reading the same
//     inputs produce the same marks, so storing is idempotent.
//   - deriveRunHealth({ lanes, sessions, marks, … }) — the per-read
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
  progress: LaneProgressComparison;
  /** Consecutive generations the climb-while-flat predicate has held. */
  thrashStreak: number;
}

export type LaneProgressComparison =
  | {
    status: 'comparable';
    stepId: string;
    stageIndex: number;
    attempt: number;
  }
  | {
    status: 'not_comparable';
    error: string;
  };

export interface DeriveRunHealthInput {
  lanes: readonly RunLane[];
  sessions: readonly GcSession[];
  /**
   * Whether the sessions read succeeded. When false the join is impossible,
   * so EVERY lane degrades to unresolved → inferred → never drives the maroon
   * One Mark (PRD R2 fail-safe). A sessions failure must NOT throw into the
   * runs source — it degrades confidence, it does not blank the lanes.
   */
  sessionsAvailable: boolean;
  /** Cross-cycle marks for the LATEST generation (already advanced). */
  marks: ReadonlyMap<string, LaneProgressMark>;
  thresholds?: Partial<HealthThresholds>;
}

export interface DeriveRunHealthResult {
  lanes: RunLane[];
  census: RunCensus;
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
  lanes: readonly RunLane[],
  thresholds: Partial<HealthThresholds> = {},
): Map<string, LaneProgressMark> {
  const { attemptClimbMin } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const next = new Map<string, LaneProgressMark>();

  for (const lane of lanes) {
    const progress = comparableProgress(lane);
    const prior = previous.get(lane.id);

    const positionFlat =
      prior !== undefined &&
      prior.progress.status === 'comparable' &&
      progress.status === 'comparable' &&
      prior.progress.stepId === progress.stepId &&
      prior.progress.stageIndex === progress.stageIndex;
    const climbed =
      prior !== undefined &&
      prior.progress.status === 'comparable' &&
      progress.status === 'comparable' &&
      progress.attempt - prior.progress.attempt >= attemptClimbMin;

    const thrashStreak = positionFlat && climbed ? prior.thrashStreak + 1 : 0;

    next.set(lane.id, {
      progress,
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
export function deriveRunHealth(
  input: DeriveRunHealthInput,
): DeriveRunHealthResult {
  const { thrashDetectedStreak } = { ...DEFAULT_THRESHOLDS, ...input.thresholds };

  const lanes = input.lanes.map((lane) => {
    const session = input.sessionsAvailable
      ? resolveLaneSession(lane, input.sessions)
      : { status: 'unresolved' as const, error: 'run session list unavailable' };
    const sessionResolved = session.status === 'resolved';

    // R2: an unresolved assignee can never be 'known' (must not drive maroon),
    // regardless of the bead-side provenance. Confidence = formula resolved
    // AND the assignee resolves to a live session.
    const phaseConfidence: RunLaneHealth['phaseConfidence'] =
      lane.formulaStageResolved === true && sessionResolved ? 'known' : 'inferred';

    const thrashStreak = input.marks.get(lane.id)?.thrashStreak ?? 0;

    const health: RunLaneHealth = {
      phaseConfidence,
      // Decision-pending from bead state alone — threshold-independent. The
      // stalled-driven attention signal is added client-side from the facts.
      needsOperator: lane.phase === 'approval' || lane.phase === 'blocked',
      stuckNode: stuckNode(lane),
      thrashingDetected: thrashStreak >= thrashDetectedStreak,
      session: session.status === 'resolved'
        ? sessionFacts(session.session)
        : { status: 'unresolved', error: session.error },
    };

    return { ...lane, health: { status: 'available' as const, data: health } };
  });

  return { lanes, census: buildCensus(lanes) };
}

/**
 * First assignee that resolves to a session (active sessions preferred by the
 * shared resolver). The lossy role→session join PRD R2 flags as load-bearing.
 */
function resolveLaneSession(
  lane: RunLane,
  sessions: readonly GcSession[],
): { status: 'resolved'; session: GcSession } | { status: 'unresolved'; error: string } {
  for (const assignee of lane.activeAssignees) {
    const session = resolveSessionForTarget(assignee, sessions);
    if (session !== null) return { status: 'resolved', session };
  }
  return { status: 'unresolved', error: 'run session unresolved' };
}

function comparableProgress(lane: RunLane): LaneProgressComparison {
  if (lane.progress.status !== 'active_step') {
    return { status: 'not_comparable', error: 'run has no active step' };
  }
  if (lane.progress.stage.status !== 'available') {
    return { status: 'not_comparable', error: lane.progress.stage.error };
  }
  if (lane.progress.attempt.status !== 'available') {
    return { status: 'not_comparable', error: lane.progress.attempt.error };
  }
  return {
    status: 'comparable',
    stepId: lane.progress.stepId,
    stageIndex: lane.progress.stage.index,
    attempt: lane.progress.attempt.value,
  };
}

function stuckNode(lane: RunLane): RunLaneHealth['stuckNode'] {
  return lane.progress.status === 'active_step'
    ? { status: 'available', id: lane.progress.stepId }
    : { status: 'unavailable', error: 'active run step unavailable' };
}

function sessionFacts(session: GcSession): RunLaneHealth['session'] {
  return {
    status: 'resolved',
    lastActive:
      session.last_active === undefined
        ? { status: 'unavailable', error: 'session last_active unavailable' }
        : { status: 'available', at: session.last_active },
    running:
      session.running === undefined
        ? { status: 'unavailable', error: 'session running state unavailable' }
        : { status: 'available', value: session.running },
    activity:
      session.activity === undefined
        ? { status: 'unavailable', error: 'session activity unavailable' }
        : { status: 'available', value: session.activity },
  };
}

/**
 * Zero-initialised phase counts. Written as an explicit object literal (not
 * Object.fromEntries + cast) so the compiler enforces exhaustiveness: adding a
 * member to the RunPhase union without a key here is a type error, rather
 * than silently producing an incomplete Record that increments `undefined` →
 * NaN at runtime (typescript-reviewer HIGH-1).
 */
function zeroByPhase(): Record<RunPhase, number> {
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
function buildCensus(lanes: readonly RunLane[]): RunCensus {
  const byPhase = zeroByPhase();

  let totalInFlight = 0;
  let unverifiable = 0;
  let knownDenominator = 0;
  let thrashing = 0;

  for (const lane of lanes) {
    byPhase[lane.phase] += 1;
    if (lane.phase === 'complete') continue;

    totalInFlight += 1;
    if (
      lane.health.status === 'available' &&
      lane.health.data.phaseConfidence === 'known'
    ) {
      knownDenominator += 1;
      if (lane.health.data.thrashingDetected === true) thrashing += 1;
    } else {
      unverifiable += 1;
    }
  }

  return { byPhase, totalInFlight, unverifiable, knownDenominator, thrashing };
}
