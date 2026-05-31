import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { GcSession, RunLane, RunPhase } from 'gas-city-dashboard-shared';

import {
  advanceProgressMarks,
  deriveRunHealth,
  type LaneProgressMark,
} from '../src/snapshot/health.js';

// Run-health derivation engine coverage (gascity-dashboard-3ax).
//
// R9-strict contract: the engine ships FACTS + the one server-only signal
// (thrashingDetected, cross-cycle). It emits NO staleness-tier enum and NO
// byStalenessTier census — the time threshold crossing is the frontend's
// (kb3) job. These tests pin the structural derivation + the monotonicity
// state machine that the R1 "most likely cause of death" depends on.

function lane(partial: Partial<RunLane> & { id: string }): RunLane {
  return {
    title: partial.id,
    formula: { status: 'unavailable', error: 'run formula unavailable in test' },
    scope: { status: 'unavailable', error: 'not scoped in test' },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'implementation' as RunPhase,
    phaseLabel: 'implementation',
    statusCounts: {},
    activeAssignees: [],
    updatedAt: {
      status: 'available',
      at: '2026-05-25T00:00:00.000Z',
    },
    stages: [],
    progress: {
      status: 'unavailable',
      error: 'run progress unavailable in test',
    },
    formulaStageResolved: false,
    health: { status: 'unavailable', error: 'run health has not been derived' },
    ...partial,
  };
}

function activeProgress(
  stepId: string,
  stageIndex: number,
  attempt: number,
): RunLane['progress'] {
  return {
    status: 'active_step',
    stepId,
    stage: {
      status: 'available',
      index: stageIndex,
      key: `stage-${stageIndex}`,
      label: `Stage ${stageIndex}`,
    },
    attempt: {
      status: 'available',
      value: attempt,
    },
  };
}

function sess(partial: Partial<GcSession> & { id: string }): GcSession {
  return {
    template: 't',
    state: 'active',
    created_at: '2026-05-25T00:00:00.000Z',
    attached: false,
    ...partial,
  } as GcSession;
}

function deriveOne(
  l: RunLane,
  sessions: GcSession[],
  marks: Map<string, LaneProgressMark> = new Map(),
  sessionsAvailable = true,
) {
  const { lanes } = deriveRunHealth({
    lanes: [l],
    sessions,
    sessionsAvailable,
    marks,
  });
  const health = lanes[0]?.health;
  assert.ok(health, 'expected health to be populated');
  assert.equal(health.status, 'available', 'expected health to be available');
  if (health.status !== 'available') assert.fail('health unavailable');
  return health.data;
}

describe('deriveRunHealth — phaseConfidence (R2 + provenance)', () => {
  test("known iff formula stage resolved AND assignee resolves to a session", () => {
    const l = lane({
      id: 'a',
      formulaStageResolved: true,
      activeAssignees: ['chief-of-staff'],
    });
    const h = deriveOne(l, [sess({ id: 's1', pool: 'chief-of-staff' })]);
    assert.equal(h.phaseConfidence, 'known');
    assert.equal(h.session.status, 'resolved');
  });

  test('inferred when formula stage not resolved (generic fallback)', () => {
    const l = lane({ id: 'a', formulaStageResolved: false, activeAssignees: ['x'] });
    const h = deriveOne(l, [sess({ id: 's1', pool: 'x' })]);
    assert.equal(h.phaseConfidence, 'inferred');
  });

  test('R2: inferred when assignee does NOT resolve to a session, even if formula resolved', () => {
    const l = lane({
      id: 'a',
      formulaStageResolved: true,
      activeAssignees: ['ghost-role'],
    });
    const h = deriveOne(l, [sess({ id: 's1', pool: 'someone-else' })]);
    assert.equal(h.phaseConfidence, 'inferred');
    assert.deepEqual(h.session, {
      status: 'unresolved',
      error: 'run session unresolved',
    });
  });

  test('sessions unavailable → every lane inferred + unresolved (fail-safe, no maroon)', () => {
    const l = lane({ id: 'a', formulaStageResolved: true, activeAssignees: ['chief-of-staff'] });
    const h = deriveOne(l, [sess({ id: 's1', pool: 'chief-of-staff' })], new Map(), false);
    assert.equal(h.phaseConfidence, 'inferred');
    assert.deepEqual(h.session, {
      status: 'unresolved',
      error: 'run session list unavailable',
    });
  });
});

describe('deriveRunHealth — facts', () => {
  test('needsOperator true on approval + blocked, false on every other phase', () => {
    assert.equal(deriveOne(lane({ id: 'a', phase: 'approval' }), []).needsOperator, true);
    assert.equal(deriveOne(lane({ id: 'a', phase: 'blocked' }), []).needsOperator, true);
    for (const phase of ['intake', 'implementation', 'review', 'finalization', 'complete', 'active'] as const) {
      assert.equal(
        deriveOne(lane({ id: 'a', phase }), []).needsOperator,
        false,
        `phase ${phase} must not flag needsOperator`,
      );
    }
  });

  test('stuckNode equals the raw active step id', () => {
    const h = deriveOne(
      lane({
        id: 'a',
        progress: activeProgress('review-pipeline.review-claude', 2, 1),
      }),
      [],
    );
    assert.deepEqual(h.stuckNode, {
      status: 'available',
      id: 'review-pipeline.review-claude',
    });
  });

  test('session facts come from the resolved session', () => {
    const l = lane({ id: 'a', activeAssignees: ['mayor'] });
    const h = deriveOne(l, [
      sess({
        id: 's1',
        pool: 'mayor',
        last_active: '2026-05-25T01:23:00.000Z',
        running: false,
        activity: 'idle',
      }),
    ]);
    assert.deepEqual(h.session, {
      status: 'resolved',
      lastActive: {
        status: 'available',
        at: '2026-05-25T01:23:00.000Z',
      },
      running: {
        status: 'available',
        value: false,
      },
      activity: {
        status: 'available',
        value: 'idle',
      },
    });
  });
});

describe('progress-monotonicity (R1) + hysteresis (R8)', () => {
  // A thrashing lane: attempt climbs each generation while the active step
  // and stage index stay flat. Hysteresis default = 2 consecutive ticks.
  const gen = (attempt: number) =>
    lane({
      id: 'thrash',
      formulaStageResolved: true,
      activeAssignees: ['w'],
      progress: activeProgress('wait-for-ci', 5, attempt),
    });

  test('cold map → not detected (no prior to compare)', () => {
    const h = deriveOne(gen(3), [sess({ id: 's', pool: 'w' })], new Map());
    assert.equal(h.thrashingDetected, false);
  });

  test('detected only after the predicate holds across enough generations', () => {
    let marks = new Map<string, LaneProgressMark>();
    const sessions = [sess({ id: 's', pool: 'w' })];

    // gen 1: seed, no prior → streak 0
    marks = advanceProgressMarks(marks, [gen(1)]);
    assert.equal(deriveOne(gen(1), sessions, marks).thrashingDetected, false);

    // gen 2: attempt 1→2, stage flat → tick, streak 1, still below threshold 2
    marks = advanceProgressMarks(marks, [gen(2)]);
    assert.equal(deriveOne(gen(2), sessions, marks).thrashingDetected, false);

    // gen 3: attempt 2→3, stage flat → tick, streak 2 → detected
    marks = advanceProgressMarks(marks, [gen(3)]);
    assert.equal(deriveOne(gen(3), sessions, marks).thrashingDetected, true);
  });

  test('an idle lane that never had an active step never thrash-detects', () => {
    // progress is unavailable across generations: position is not comparable,
    // so the predicate
    // must never fire — a genuinely idle lane is not a thrashing lane.
    const idle = () => lane({ id: 'idle', formulaStageResolved: false, activeAssignees: ['w'] });
    let marks = new Map<string, LaneProgressMark>();
    const sessions = [sess({ id: 's', pool: 'w' })];
    for (let i = 0; i < 3; i++) marks = advanceProgressMarks(marks, [idle()]);
    assert.equal(deriveOne(idle(), sessions, marks).thrashingDetected, false);
  });

  test('NOT detected when the stage advances (real progress)', () => {
    let marks = new Map<string, LaneProgressMark>();
    marks = advanceProgressMarks(marks, [gen(1)]);
    marks = advanceProgressMarks(marks, [gen(2)]);
    // stage moves forward even though attempt also climbed → position advanced
    const advanced = lane({
      id: 'thrash',
      formulaStageResolved: true,
      activeAssignees: ['w'],
      progress: activeProgress('merge-and-finalize', 6, 3),
    });
    marks = advanceProgressMarks(marks, [advanced]);
    assert.equal(
      deriveOne(advanced, [sess({ id: 's', pool: 'w' })], marks).thrashingDetected,
      false,
    );
  });

  test('streak resets when attempt stops climbing', () => {
    let marks = new Map<string, LaneProgressMark>();
    marks = advanceProgressMarks(marks, [gen(1)]);
    marks = advanceProgressMarks(marks, [gen(2)]);
    marks = advanceProgressMarks(marks, [gen(3)]); // streak 2 → would detect
    marks = advanceProgressMarks(marks, [gen(3)]); // attempt flat → reset
    assert.equal(deriveOne(gen(3), [sess({ id: 's', pool: 'w' })], marks).thrashingDetected, false);
  });

  test('advanceProgressMarks drops lanes no longer present', () => {
    let marks = advanceProgressMarks(new Map(), [gen(1), lane({ id: 'other' })]);
    assert.ok(marks.has('thrash'));
    marks = advanceProgressMarks(marks, [gen(2)]);
    assert.equal(marks.has('other'), false);
  });

  test('idempotent: deriving twice with the same marks gives the same result', () => {
    const marks = advanceProgressMarks(
      advanceProgressMarks(advanceProgressMarks(new Map(), [gen(1)]), [gen(2)]),
      [gen(3)],
    );
    const sessions = [sess({ id: 's', pool: 'w' })];
    const a = deriveOne(gen(3), sessions, marks);
    const b = deriveOne(gen(3), sessions, marks);
    assert.deepEqual(a, b);
    assert.equal(a.thrashingDetected, true);
  });
});

describe('city census (R5, threshold-independent)', () => {
  test('byPhase, in-flight denominators, and known-gated thrashing', () => {
    let marks = new Map<string, LaneProgressMark>();
    const thrash = (a: number) =>
      lane({
        id: 'thr',
        phase: 'review',
        formulaStageResolved: true,
        activeAssignees: ['w'],
        progress: activeProgress('review-loop', 2, a),
      });
    marks = advanceProgressMarks(marks, [thrash(1)]);
    marks = advanceProgressMarks(marks, [thrash(2)]);
    marks = advanceProgressMarks(marks, [thrash(3)]); // streak 2 → thrash detected

    const lanes: RunLane[] = [
      thrash(3), // review, known (resolves), thrashing
      lane({ id: 'inf', phase: 'implementation', formulaStageResolved: false, activeAssignees: ['w'] }), // inferred
      lane({ id: 'done', phase: 'complete', formulaStageResolved: true, activeAssignees: ['w'] }), // not in-flight
    ];
    const sessions = [sess({ id: 's', pool: 'w' })];
    const { census } = deriveRunHealth({ lanes, sessions, sessionsAvailable: true, marks });
    assert.ok(census);
    assert.equal(census.totalInFlight, 2); // complete excluded
    assert.equal(census.knownDenominator, 1); // only the review lane resolves known
    assert.equal(census.unverifiable, 1); // the inferred lane
    assert.equal(census.thrashing, 1);
    assert.equal(census.byPhase.review, 1);
    assert.equal(census.byPhase.implementation, 1);
    assert.equal(census.byPhase.complete, 1);
  });

  test('thrashing count is gated to known confidence (inferred lane cannot inflate failing)', () => {
    let marks = new Map<string, LaneProgressMark>();
    const thr = (a: number) =>
      lane({
        id: 'thr',
        phase: 'review',
        formulaStageResolved: true,
        activeAssignees: ['ghost'], // does NOT resolve → inferred
        progress: activeProgress('review-loop', 2, a),
      });
    marks = advanceProgressMarks(marks, [thr(1)]);
    marks = advanceProgressMarks(marks, [thr(2)]);
    marks = advanceProgressMarks(marks, [thr(3)]);
    const { census, lanes } = deriveRunHealth({
      lanes: [thr(3)],
      sessions: [sess({ id: 's', pool: 'someone' })],
      sessionsAvailable: true,
      marks,
    });
    // structural thrash is still a fact on the lane…
    const health = lanes[0]?.health;
    assert.equal(health?.status, 'available');
    if (health?.status !== 'available') assert.fail('expected available health');
    assert.equal(health.data.thrashingDetected, true);
    assert.equal(health.data.phaseConfidence, 'inferred');
    // …but the census "failing"-class count excludes it (R2: inferred never drives maroon)
    assert.equal(census?.thrashing, 0);
    assert.equal(census?.unverifiable, 1);
  });
});
