import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CityStatusSummary,
  GcSessionList,
  ResourceSummary,
  WorkflowLane,
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
    formula: null,
    externalUrl: null,
    externalLabel: null,
    phase: 'review' as WorkflowPhase,
    phaseLabel: 'review',
    statusCounts: {},
    activeAssignees: [],
    updatedAt: '2026-05-25T00:00:00.000Z',
    stages: [],
    activeStepId: null,
    activeStepAttempt: null,
    activeStageIndex: null,
    formulaStageResolved: false,
    ...partial,
  };
}

const SAMPLE_CITY: CityStatusSummary = {
  activeAgents: 1,
  totalAgents: 1,
  activeSessions: 1,
  suspendedSessions: 0,
  maxSessions: null,
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

function throwing<T>(source: 'aimux' | 'github' | 'tokens'): SourceCache<T> {
  return new SourceCache<T>({
    source,
    ttlMs: 30_000,
    sanitizeErrorMessage: null,
    load: () => {
      throw new Error(`${source} not wired`);
    },
  });
}

function buildCaches(workflows: WorkflowSummary): SourceCacheMap {
  return {
    aimux: throwing('aimux'),
    city: fresh('city', SAMPLE_CITY),
    resources: fresh('resources', SAMPLE_RESOURCES),
    workflows: fresh('workflows', workflows),
    github: throwing('github'),
    tokens: throwing('tokens'),
  };
}

function summary(lanes: WorkflowLane[]): WorkflowSummary {
  return {
    totalActive: lanes.length,
    runCounts: { total: lanes.length, visible: lanes.length, prReview: 0, designReview: 0, bugfix: 0, blocked: 0, other: 0 },
    lanes,
    recentChanges: [],
    census: null,
  };
}

const CONFIG = { cityRoot: '/tmp/x', githubRepo: 'o/r', useFixtures: false };

describe('health engine wiring on /api/snapshot', () => {
  test('enriches each lane with health and computes the census from the shared sessions', async () => {
    const lanes = [
      lane({
        id: 'known-lane',
        formulaStageResolved: true,
        activeAssignees: ['mayor'],
        activeStepId: 'review-loop',
        activeStageIndex: 2,
      }),
      lane({ id: 'inferred-lane', formulaStageResolved: false, activeAssignees: ['nobody'] }),
    ];
    const sessions = fresh<GcSessionList>('workflows', {
      items: [
        {
          id: 's1',
          template: 'claude',
          pool: 'mayor',
          state: 'active',
          created_at: '2026-05-25T00:00:00.000Z',
          last_active: '2026-05-25T00:30:00.000Z',
          attached: false,
          running: true,
          activity: 'tool_use',
        },
      ],
    });

    const service = createSnapshotService({
      caches: buildCaches(summary(lanes)),
      sessions,
      config: CONFIG,
    });

    const snap = await service.getSnapshot();
    const wf = snap.sources.workflows.data;
    assert.ok(wf);

    const known = wf.lanes.find((l) => l.id === 'known-lane');
    const inferred = wf.lanes.find((l) => l.id === 'inferred-lane');

    assert.equal(known?.health?.phaseConfidence, 'known');
    assert.equal(known?.health?.sessionResolved, true);
    assert.equal(known?.health?.sessionActivity, 'tool_use');
    assert.equal(known?.health?.stuckNodeId, 'review-loop');

    assert.equal(inferred?.health?.phaseConfidence, 'inferred');
    assert.equal(inferred?.health?.sessionResolved, false);

    assert.deepEqual(wf.census, {
      byPhase: { intake: 0, implementation: 0, review: 2, approval: 0, finalization: 0, blocked: 0, complete: 0, active: 0 },
      totalInFlight: 2,
      unverifiable: 1,
      knownDenominator: 1,
      thrashing: 0,
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
    const wf = snap.sources.workflows.data;
    assert.ok(wf);
    // Snapshot still served (no 500), lanes intact, but unverifiable.
    assert.equal(snap.sources.workflows.status, 'fresh');
    assert.equal(wf.lanes[0]?.health?.phaseConfidence, 'inferred');
    assert.equal(wf.lanes[0]?.health?.sessionResolved, false);
    assert.equal(wf.census?.unverifiable, 1);
    assert.equal(wf.census?.knownDenominator, 0);
  });
});
