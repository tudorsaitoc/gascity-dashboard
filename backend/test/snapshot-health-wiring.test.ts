import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  CityStatusSummary,
  GcSessionList,
  ResourceSummary,
  RunLane,
  RunLaneHealth,
  RunPhase,
  RunSummary,
  SourceAvailableState,
  SourceState,
  WorkSummary,
} from 'gas-city-dashboard-shared';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  createSnapshotService,
  type SourceCacheMap,
} from '../src/snapshot/service.js';

// End-to-end wiring of the run-health engine into the snapshot read
// path (gascity-dashboard-3ax). The pure engine is unit-tested in
// snapshot-runHealth.test.ts; these tests prove the SERVICE actually
// runs it against the shared sessions cache and emits the result on the
// snapshot's runs source.

function lane(partial: Partial<RunLane> & { id: string }): RunLane {
  return {
    title: partial.id,
    formula: { status: 'unavailable', error: 'run formula unavailable in test' },
    scope: { status: 'unavailable', error: 'not scoped in test' },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'review' as RunPhase,
    phaseLabel: 'review',
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

const SAMPLE_CITY: CityStatusSummary = {
  activeAgents: 1,
  totalAgents: 1,
  activeSessions: 1,
  suspendedSessions: 0,
  maxSessions: { status: 'unavailable', source: 'city', error: 'not configured in test' },
  sessionsByProvider: [],
  rigs: [],
};

const SAMPLE_RESOURCES: ResourceSummary = {
  vcpuCount: 1,
  loadAverage: [0, 0, 0],
  loadPerVcpu: 0,
  memory: { totalBytes: 1, usedBytes: 0, availableBytes: 1, utilization: 0 },
  uptimeSeconds: 1,
  samples: [],
};

const SAMPLE_WORK: WorkSummary = {
  open: 1,
  ready: 0,
  inProgress: 1,
};

function fresh<T>(source: 'city' | 'resources' | 'runs' | 'work', data: T): SourceCache<T> {
  return new SourceCache<T>({ source, ttlMs: 60_000, sanitizeErrorMessage: null, load: () => data });
}

function buildCaches(runs: RunSummary): SourceCacheMap {
  return {
    city: fresh('city', SAMPLE_CITY),
    resources: fresh('resources', SAMPLE_RESOURCES),
    runs: fresh('runs', runs),
    work: fresh('work', SAMPLE_WORK),
  };
}

function summary(lanes: RunLane[]): RunSummary {
  return {
    totalActive: lanes.length,
    totalHistorical: 0,
    runCounts: { total: lanes.length, visible: lanes.length, prReview: 0, designReview: 0, bugfix: 0, blocked: 0, other: 0 },
    lanes,
    historicalLanes: [],
    recentChanges: [],
    census: { status: 'unavailable', error: 'run health has not been derived' },
  };
}

function requireAvailableHealth(lane: RunLane | undefined): RunLaneHealth {
  assert.ok(lane, 'expected lane to exist');
  assert.equal(lane.health.status, 'available');
  if (lane.health.status !== 'available') assert.fail('expected available lane health');
  return lane.health.data;
}

const CONFIG = {
  cityName: 'test-city',
  cityRoot: '/tmp/x',
  useFixtures: false,
  enabledModules: null,
  defaultView: null,
};

describe('health engine wiring on /api/snapshot', () => {
  test('enriches each lane with health and computes the census from the shared sessions', async () => {
    const lanes = [
      lane({
        id: 'known-lane',
        formulaStageResolved: true,
        activeAssignees: ['mayor'],
        progress: activeProgress('review-loop', 2, 1),
      }),
      lane({ id: 'inferred-lane', formulaStageResolved: false, activeAssignees: ['nobody'] }),
    ];
    const sessions = fresh<GcSessionList>('runs', {
      items: [
        {
          id: 's1',
          template: 'claude',
          session_name: 's1',
          title: 's1',
          provider: 'claude',
          pool: 'mayor',
          state: 'active',
          created_at: '2026-05-25T00:00:00.000Z',
          last_active: '2026-05-25T00:30:00.000Z',
          attached: false,
          running: true,
          activity: 'tool_use',
        },
      ],
      total: 1,
    });

    const service = createSnapshotService({
      caches: buildCaches(summary(lanes)),
      sessions,
      config: CONFIG,
    });

    const snap = await service.getSnapshot();
    assertSourceAvailable(snap.sources.runs);
    const wf = snap.sources.runs.data;

    const known = wf.lanes.find((l) => l.id === 'known-lane');
    const inferred = wf.lanes.find((l) => l.id === 'inferred-lane');

    const knownHealth = requireAvailableHealth(known);
    assert.equal(knownHealth.phaseConfidence, 'known');
    assert.equal(knownHealth.session.status, 'resolved');
    assert.deepEqual(knownHealth.stuckNode, {
      status: 'available',
      id: 'review-loop',
    });
    assert.deepEqual(knownHealth.session, {
      status: 'resolved',
      lastActive: {
        status: 'available',
        at: '2026-05-25T00:30:00.000Z',
      },
      running: {
        status: 'available',
        value: true,
      },
      activity: {
        status: 'available',
        value: 'tool_use',
      },
    });

    const inferredHealth = requireAvailableHealth(inferred);
    assert.equal(inferredHealth.phaseConfidence, 'inferred');
    assert.deepEqual(inferredHealth.session, {
      status: 'unresolved',
      error: 'run session unresolved',
    });

    assert.deepEqual(wf.census, {
      status: 'available',
      data: {
        byPhase: { intake: 0, implementation: 0, review: 2, approval: 0, finalization: 0, blocked: 0, complete: 0, active: 0 },
        totalInFlight: 2,
        unverifiable: 1,
        knownDenominator: 1,
        thrashing: 0,
      },
    });
  });

  test('headline active run count excludes completed runs that remain visible', async () => {
    const completed = lane({
      id: 'completed-run',
      phase: 'complete',
      phaseLabel: 'complete',
      statusCounts: { closed: 1 },
      stages: [
        { key: 'intake', label: 'Intake', status: 'complete' },
        { key: 'implementation', label: 'Implementation', status: 'complete' },
        { key: 'review', label: 'Review', status: 'complete' },
        { key: 'approval', label: 'Approval', status: 'complete' },
        { key: 'finalization', label: 'Finalization', status: 'complete' },
      ],
    });
    const service = createSnapshotService({
      caches: buildCaches(summary([completed])),
      sessions: fresh<GcSessionList>('city', { items: [], total: 0 }),
      config: CONFIG,
    });

    const snap = await service.getSnapshot();

    assertSourceAvailable(snap.sources.runs);
    assert.equal(snap.sources.runs.data.runCounts.total, 1);
    assert.equal(snap.sources.runs.data.census.status, 'available');
    if (snap.sources.runs.data.census.status !== 'available') {
      assert.fail('expected available run census');
    }
    assert.equal(snap.sources.runs.data.census.data.totalInFlight, 0);
    assert.deepEqual(snap.headline.activeRuns, {
      status: 'available',
      value: 0,
    });
  });

  test('R2 fail-safe: a sessions-cache failure degrades every lane to inferred, no throw', async () => {
    const lanes = [
      lane({ id: 'a', formulaStageResolved: true, activeAssignees: ['mayor'] }),
    ];
    const brokenSessions = new SourceCache<GcSessionList>({
      source: 'city',
      ttlMs: 45_000,
      sanitizeErrorMessage: null,
      load: () => {
        throw new Error('gc supervisor returned 503');
      },
    });

    const service = createSnapshotService({
      caches: buildCaches(summary(lanes)),
      sessions: brokenSessions,
      config: CONFIG,
    });

    const snap = await service.getSnapshot();
    assertSourceAvailable(snap.sources.runs);
    const wf = snap.sources.runs.data;
    // Snapshot still served (no 500), lanes intact, but unverifiable.
    assert.equal(snap.sources.runs.status, 'fresh');
    const health = requireAvailableHealth(wf.lanes[0]);
    assert.equal(health.phaseConfidence, 'inferred');
    assert.deepEqual(health.session, {
      status: 'unresolved',
      error: 'run session list unavailable',
    });
    assert.equal(wf.census.status, 'available');
    assert.equal(wf.census.data.unverifiable, 1);
    assert.equal(wf.census.data.knownDenominator, 0);
  });
});

// gascity-dashboard-7u5a — progress-mark monotonicity under concurrent reads
// straddling a generation boundary. The cross-cycle thrashStreak (R8) is the
// ONE "failing"-class signal the client cannot recompute (R1), and it lives in
// closure-scoped service state advanced inside enrichRuns. Two overlapping
// readSnapshot calls (ambient GET poll vs POST /refresh) can capture different
// runs generations; if the newer generation enriches first, a late older read
// must NOT re-advance the marks backward to the stale generation. The pure
// engine tests in snapshot-runHealth.test.ts cannot catch this — the bug is in
// the service-layer guard that decides WHEN to call advanceProgressMarks, so
// the regression guard has to drive createSnapshotService under a real,
// deterministically-ordered straddle.

interface LoadGate {
  promise: Promise<void>;
  release: () => void;
}

function loadGate(): LoadGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

// A thrashing lane: attempt climbs each generation while the active step and
// stage index stay flat. Hysteresis default = 2 consecutive ticks.
function thrashLane(attempt: number): RunLane {
  return lane({
    id: 'thrash',
    formulaStageResolved: true,
    activeAssignees: ['w'],
    progress: activeProgress('wait-for-ci', 5, attempt),
  });
}

function laneThrashing(snap: { sources: { runs: SourceState<RunSummary> } }): boolean {
  assertSourceAvailable(snap.sources.runs);
  const target = snap.sources.runs.data.lanes.find((l) => l.id === 'thrash');
  return requireAvailableHealth(target).thrashingDetected;
}

// A clock-injected cache: every source in these tests shares one controlled
// `now` so each runs generation gets a distinct fetchedAt under test control.
function clocked<T>(source: 'city' | 'resources' | 'runs' | 'work', now: () => Date, load: () => T | Promise<T>): SourceCache<T> {
  return new SourceCache<T>({ source, ttlMs: 600_000, now, sanitizeErrorMessage: null, load });
}

describe('progress-mark monotonicity under concurrent reads (gascity-dashboard-7u5a)', () => {
  test('a late older-generation read must not regress the thrash streak', async () => {
    // A controlled clock stamps each runs generation with a distinct
    // fetchedAt, so the straddle exercises genuinely different generations
    // (not the same-ms coalescing blind spot).
    const clock = { ms: Date.parse('2026-05-25T00:00:00.000Z') };
    const now = () => new Date(clock.ms);

    let currentRuns: RunSummary = summary([thrashLane(1)]);
    let cityGate: LoadGate | null = null;

    // Read B's runs load is never gated — it resolves naturally and enriches
    // while read A is still parked on the city gate, producing the newer-first
    // ordering the bug needs. thrashingDetected derives from the cross-cycle
    // marks alone, independent of session resolution (health.ts), so empty
    // sessions keep the test focused.
    const service = createSnapshotService({
      caches: {
        city: clocked('city', now, async () => {
          if (cityGate) await cityGate.promise;
          return SAMPLE_CITY;
        }),
        resources: clocked('resources', now, () => SAMPLE_RESOURCES),
        runs: clocked('runs', now, () => currentRuns),
        work: clocked('work', now, () => SAMPLE_WORK),
      },
      // The shared sessions cache is labeled with the 'city' SourceName (it IS
      // the city's session list) — mirroring buildSessionsCache in service.ts.
      sessions: clocked<GcSessionList>('city', now, () => ({ items: [], total: 0 })),
      config: CONFIG,
    });

    // Seed the streak sequentially: gen1 (attempt 1 → streak 0), then gen2
    // (attempt 2, position flat → streak 1, still below the 2-tick threshold).
    await service.refresh(); // gen1 @ t0
    clock.ms += 1000;
    currentRuns = summary([thrashLane(2)]);
    const gen2Snap = await service.refresh(['runs']); // gen2 @ t1
    assert.equal(laneThrashing(gen2Snap), false, 'streak 1 must be below the 2-tick threshold');

    // Park read A (POST /refresh of an unrelated source) on the city-load
    // gate. It captures the CURRENT cached runs generation (gen2 @ t1, older)
    // synchronously via snapshot() before read B advances the generation.
    cityGate = loadGate();
    const readA = service.refresh(['city']);

    // Read B forces a new runs generation (gen3 @ t2, attempt 3 → streak 2 →
    // thrash detected) and, with no gate of its own, resolves and enriches
    // FIRST while A is still parked.
    clock.ms += 1000;
    currentRuns = summary([thrashLane(3)]);
    const bSnap = await service.refresh(['runs']);
    assert.equal(laneThrashing(bSnap), true, 'newer generation crosses the 2-tick threshold');

    // Release A so the older (gen2 @ t1) read enriches SECOND. Under the
    // pre-fix identity guard this re-runs advanceProgressMarks with the OLDER
    // lanes, resetting the streak to 0; the monotonic guard makes it a no-op.
    cityGate?.release();
    await readA;

    // gen3 is still the freshest cached runs generation. A follow-up read must
    // still surface the detection B established — the late older read must not
    // have regressed the cross-cycle streak.
    const afterSnap = await service.getSnapshot();
    assert.equal(
      laneThrashing(afterSnap),
      true,
      'late older-generation read must not regress the thrash streak (R1/R8)',
    );
  });

  test('sequential generations still advance the streak normally', async () => {
    const clock = { ms: Date.parse('2026-05-25T00:00:00.000Z') };
    const now = () => new Date(clock.ms);
    let currentRuns: RunSummary = summary([thrashLane(1)]);

    const service = createSnapshotService({
      caches: {
        city: clocked('city', now, () => SAMPLE_CITY),
        resources: clocked('resources', now, () => SAMPLE_RESOURCES),
        runs: clocked('runs', now, () => currentRuns),
        work: clocked('work', now, () => SAMPLE_WORK),
      },
      sessions: clocked<GcSessionList>('city', now, () => ({ items: [], total: 0 })),
      config: CONFIG,
    });

    assert.equal(laneThrashing(await service.refresh()), false); // gen1, streak 0
    clock.ms += 1000;
    currentRuns = summary([thrashLane(2)]);
    assert.equal(laneThrashing(await service.refresh(['runs'])), false); // gen2, streak 1
    clock.ms += 1000;
    currentRuns = summary([thrashLane(3)]);
    assert.equal(laneThrashing(await service.refresh(['runs'])), true); // gen3, streak 2 → detected
  });
});

function assertSourceAvailable<T>(
  state: SourceState<T>,
): asserts state is SourceAvailableState<T> {
  assert.notEqual(state.status, 'error');
}
