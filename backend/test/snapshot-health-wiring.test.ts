import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CityStatusSummary,
  GcSessionList,
  ResourceSummary,
  SourceAvailableState,
  SourceState,
  WorkflowLane,
  WorkflowLaneHealth,
  WorkflowPhase,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';

import { SourceCache } from '../src/snapshot/cache.js';
import {
  createSnapshotService,
  type SourceCacheMap,
} from '../src/snapshot/service.js';

// End-to-end wiring of the workflow-health engine into the snapshot read
// path (gascity-dashboard-3ax). The pure engine is unit-tested in
// snapshot-workflowHealth.test.ts; these tests prove the SERVICE actually
// runs it against the shared sessions cache and emits the result on the
// snapshot's workflows source.

function lane(partial: Partial<WorkflowLane> & { id: string }): WorkflowLane {
  return {
    title: partial.id,
    formula: { status: 'unavailable', error: 'workflow formula unavailable in test' },
    scope: { status: 'unavailable', error: 'not scoped in test' },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'review' as WorkflowPhase,
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
      error: 'workflow progress unavailable in test',
    },
    formulaStageResolved: false,
    health: { status: 'unavailable', error: 'workflow health has not been derived' },
    ...partial,
  };
}

function activeProgress(
  stepId: string,
  stageIndex: number,
  attempt: number,
): WorkflowLane['progress'] {
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

function fresh<T>(source: 'city' | 'resources' | 'workflows', data: T): SourceCache<T> {
  return new SourceCache<T>({ source, ttlMs: 60_000, sanitizeErrorMessage: null, load: () => data });
}

function buildCaches(workflows: WorkflowSummary): SourceCacheMap {
  return {
    city: fresh('city', SAMPLE_CITY),
    resources: fresh('resources', SAMPLE_RESOURCES),
    workflows: fresh('workflows', workflows),
  };
}

function summary(lanes: WorkflowLane[]): WorkflowSummary {
  return {
    totalActive: lanes.length,
    totalHistorical: 0,
    runCounts: { total: lanes.length, visible: lanes.length, prReview: 0, designReview: 0, bugfix: 0, blocked: 0, other: 0 },
    lanes,
    historicalLanes: [],
    recentChanges: [],
    census: { status: 'unavailable', error: 'workflow health has not been derived' },
  };
}

function requireAvailableHealth(lane: WorkflowLane | undefined): WorkflowLaneHealth {
  assert.ok(lane, 'expected lane to exist');
  assert.equal(lane.health.status, 'available');
  if (lane.health.status !== 'available') assert.fail('expected available lane health');
  return lane.health.data;
}

const CONFIG = {
  cityName: 'test-city',
  cityRoot: '/tmp/x',
  useFixtures: false,
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
    const sessions = fresh<GcSessionList>('workflows', {
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
    assertSourceAvailable(snap.sources.workflows);
    const wf = snap.sources.workflows.data;

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
      error: 'workflow session unresolved',
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

  test('headline active workflow count excludes completed runs that remain visible', async () => {
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

    assertSourceAvailable(snap.sources.workflows);
    assert.equal(snap.sources.workflows.data.runCounts.total, 1);
    assert.equal(snap.sources.workflows.data.census.status, 'available');
    if (snap.sources.workflows.data.census.status !== 'available') {
      assert.fail('expected available workflow census');
    }
    assert.equal(snap.sources.workflows.data.census.data.totalInFlight, 0);
    assert.deepEqual(snap.headline.activeWorkflows, {
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
    assertSourceAvailable(snap.sources.workflows);
    const wf = snap.sources.workflows.data;
    // Snapshot still served (no 500), lanes intact, but unverifiable.
    assert.equal(snap.sources.workflows.status, 'fresh');
    const health = requireAvailableHealth(wf.lanes[0]);
    assert.equal(health.phaseConfidence, 'inferred');
    assert.deepEqual(health.session, {
      status: 'unresolved',
      error: 'workflow session list unavailable',
    });
    assert.equal(wf.census.status, 'available');
    assert.equal(wf.census.data.unverifiable, 1);
    assert.equal(wf.census.data.knownDenominator, 0);
  });
});

function assertSourceAvailable<T>(
  state: SourceState<T>,
): asserts state is SourceAvailableState<T> {
  assert.notEqual(state.status, 'error');
}
