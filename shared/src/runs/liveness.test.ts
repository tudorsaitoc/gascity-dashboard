import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDanglingRootGroup,
  isStaleSessionlessLatch,
  isStrandedRun,
  STALE_LATCH_AFTER_MS,
  STRANDED_DISPATCH_GRACE_MS,
  type RunRegistryObservation,
} from './liveness.js';
import type { RunIssue } from './phaseMapping.js';
import type { RunLane, RunLaneHealth } from '../snapshot/types.js';

// gascity-dashboard-s4rp: the sharp session-less demotion predicate. Operator
// repro gc-1920 — an ancient approval-gate latch with no live session, no
// in_progress step, ~4d stale — inflated Active:1 and flickered in/out. It must
// be demoted, while a freshly-queued run and an approval gate genuinely waiting
// on a human (both legitimately session-less) must NOT be.

const NOW_MS = Date.parse('2026-06-07T00:00:00.000Z');

function health(sessionStatus: 'resolved' | 'unresolved'): RunLane['health'] {
  const session: RunLaneHealth['session'] =
    sessionStatus === 'resolved'
      ? {
          status: 'resolved',
          lastActive: { status: 'available', at: new Date(NOW_MS).toISOString() },
          running: { status: 'available', value: true },
          activity: { status: 'available', value: 'working' },
        }
      : { status: 'unresolved', error: 'run session unresolved' };

  return {
    status: 'available',
    data: {
      phaseConfidence: 'inferred',
      needsOperator: false,
      stuckNode: { status: 'unavailable', error: 'active run step unavailable' },
      thrashingDetected: false,
      session,
    },
  };
}

function lane(overrides: Partial<RunLane> = {}): RunLane {
  return {
    id: 'gc-1920',
    title: 'mol-focus-review',
    formula: { status: 'known', name: 'mol-focus-review' },
    scope: { status: 'unavailable', error: 'run scope metadata unavailable' },
    external: { status: 'unavailable', error: 'external reference unavailable' },
    phase: 'approval',
    phaseLabel: 'approval',
    statusCounts: { open: 1 },
    activeAssignees: [],
    updatedAt: {
      status: 'available',
      at: new Date(NOW_MS - 4 * 24 * 60 * 60 * 1000).toISOString(),
    },
    stages: [],
    progress: { status: 'unavailable', error: 'run progress unavailable' },
    formulaStageResolved: false,
    registration: { status: 'unknown', error: 'supervisor formula feed not observed' },
    health: health('unresolved'),
    ...overrides,
  };
}

describe('isStaleSessionlessLatch — gascity-dashboard-s4rp', () => {
  test('demotes a session-less, step-less, stale approval latch (gc-1920)', () => {
    assert.equal(isStaleSessionlessLatch(lane(), NOW_MS, true), true);
  });

  test('keeps a freshly-queued session-less run (recent updatedAt)', () => {
    const queued = lane({
      phase: 'intake',
      updatedAt: { status: 'available', at: new Date(NOW_MS - 60_000).toISOString() },
    });
    assert.equal(isStaleSessionlessLatch(queued, NOW_MS, true), false);
  });

  test('keeps an approval gate waiting on a human while still recent', () => {
    const waiting = lane({
      updatedAt: { status: 'available', at: new Date(NOW_MS - 30 * 60_000).toISOString() },
    });
    assert.equal(isStaleSessionlessLatch(waiting, NOW_MS, true), false);
  });

  test('keeps a stale run that still has a resolved live session', () => {
    assert.equal(
      isStaleSessionlessLatch(lane({ health: health('resolved') }), NOW_MS, true),
      false,
    );
  });

  test('keeps a stale run that still has an in_progress primary step', () => {
    const active = lane({
      progress: {
        status: 'active_step',
        stepId: 'implementation.patch',
        stage: { status: 'unavailable', error: 'active run stage unavailable' },
        attempt: { status: 'unavailable', error: 'run step attempt unavailable' },
      },
    });
    assert.equal(isStaleSessionlessLatch(active, NOW_MS, true), false);
  });

  test('does not demote when the session list is unavailable', () => {
    assert.equal(isStaleSessionlessLatch(lane(), NOW_MS, false), false);
  });

  test('never demotes complete or blocked lanes (already partitioned upstream)', () => {
    assert.equal(isStaleSessionlessLatch(lane({ phase: 'complete' }), NOW_MS, true), false);
    assert.equal(isStaleSessionlessLatch(lane({ phase: 'blocked' }), NOW_MS, true), false);
  });

  test('does not demote without a known age', () => {
    const noAge = lane({
      updatedAt: { status: 'unavailable', error: 'run update time unavailable' },
    });
    assert.equal(isStaleSessionlessLatch(noAge, NOW_MS, true), false);
  });

  test('the staleness boundary is exclusive below the floor', () => {
    const justUnder = lane({
      updatedAt: {
        status: 'available',
        at: new Date(NOW_MS - (STALE_LATCH_AFTER_MS - 1_000)).toISOString(),
      },
    });
    assert.equal(isStaleSessionlessLatch(justUnder, NOW_MS, true), false);
    const atFloor = lane({
      updatedAt: { status: 'available', at: new Date(NOW_MS - STALE_LATCH_AFTER_MS).toISOString() },
    });
    assert.equal(isStaleSessionlessLatch(atFloor, NOW_MS, true), true);
  });
});

describe('isDanglingRootGroup — gascity-dashboard-s4rp', () => {
  function issue(id: string): RunIssue {
    return {
      id,
      title: id,
      status: 'open',
      issue_type: 'task',
      updated_at: '2026-06-01T00:00:00Z',
    };
  }

  test('flags a group whose root bead is absent from its issues', () => {
    assert.equal(isDanglingRootGroup('gc-1920', [issue('gc-1920-step-1')]), true);
  });

  test('does not flag a group whose root bead is present', () => {
    assert.equal(
      isDanglingRootGroup('gc-1920', [issue('gc-1920'), issue('gc-1920-step-1')]),
      false,
    );
  });
});

// gascity-dashboard-uxvk: an orphaned molecule — its bead graph persisted in
// the rig store but the supervisor's workflow registry has NO entry (the
// gc-odssky repro: dispatched during a supervisor orphan-PID crash-loop, every
// step child still open, absent from a COMPLETE formula feed). Such a run never
// executed and never will; it must read as stranded, not live. The predicate
// must NOT strand: a run the feed knows, a run with any step progress (it
// executed; feed absence just means it aged out of the feed window), a freshly
// dispatched run racing the feed read, or a group with no step graph to judge.
describe('isStrandedRun — gascity-dashboard-uxvk', () => {
  const OBSERVED_AT_MS = Date.parse('2026-06-12T08:20:00.000Z');
  // The repro dispatch time: ~7h before the feed observation.
  const DISPATCHED_AT = '2026-06-12T01:20:05.000Z';

  function orphanRoot(id: string, overrides: Partial<RunIssue> = {}): RunIssue {
    return {
      id,
      title: 'mol-pr-start: gascity issue #3192',
      status: 'open',
      issue_type: 'molecule',
      updated_at: DISPATCHED_AT,
      metadata: { 'gc.formula_contract': 'graph.v2', 'gc.kind': 'run' },
      ...overrides,
    };
  }

  function orphanStep(
    rootId: string,
    stepId: string,
    status = 'open',
    overrides: Partial<RunIssue> = {},
  ): RunIssue {
    return {
      id: `${rootId}-${stepId}`,
      title: stepId,
      status,
      issue_type: 'task',
      updated_at: DISPATCHED_AT,
      metadata: { 'gc.kind': 'step', 'gc.root_bead_id': rootId, 'gc.step_id': stepId },
      ...overrides,
    };
  }

  function observation(rootIds: string[]): RunRegistryObservation {
    return { rootIds: new Set(rootIds), observedAtMs: OBSERVED_AT_MS };
  }

  function orphanGroup(id: string): RunIssue[] {
    return [
      orphanRoot(id),
      orphanStep(id, 'read-issue'),
      orphanStep(id, 'plan-implementation'),
      orphanStep(id, 'conventions-audit'),
    ];
  }

  test('zero step progress + absent from a complete feed + past the grace → stranded', () => {
    assert.equal(isStrandedRun('gc-odssky', orphanGroup('gc-odssky'), observation([])), true);
  });

  test('a run present in the feed observation is never stranded', () => {
    assert.equal(
      isStrandedRun('gc-odssky', orphanGroup('gc-odssky'), observation(['gc-odssky'])),
      false,
    );
  });

  test('a freshly dispatched run inside the grace window is not stranded', () => {
    const recent = new Date(OBSERVED_AT_MS - 60_000).toISOString();
    const group = [
      orphanRoot('gc-fresh', { updated_at: recent }),
      orphanStep('gc-fresh', 'read-issue', 'open', { updated_at: recent }),
    ];
    assert.equal(isStrandedRun('gc-fresh', group, observation([])), false);
  });

  test('a run with a closed step executed; feed absence is not stranding', () => {
    const group = [
      orphanRoot('gc-old'),
      orphanStep('gc-old', 'read-issue', 'closed'),
      orphanStep('gc-old', 'plan-implementation', 'open'),
    ];
    assert.equal(isStrandedRun('gc-old', group, observation([])), false);
  });

  test('a run with an in_progress step is live, not stranded', () => {
    const group = [
      orphanRoot('gc-live'),
      orphanStep('gc-live', 'read-issue', 'in_progress'),
      orphanStep('gc-live', 'plan-implementation', 'open'),
    ];
    assert.equal(isStrandedRun('gc-live', group, observation([])), false);
  });

  test('a group with no step beads cannot be judged → not stranded', () => {
    assert.equal(isStrandedRun('gc-bare', [orphanRoot('gc-bare')], observation([])), false);
  });

  test('the grace boundary is inclusive at the floor', () => {
    const atFloor = new Date(OBSERVED_AT_MS - STRANDED_DISPATCH_GRACE_MS).toISOString();
    const justInside = new Date(OBSERVED_AT_MS - STRANDED_DISPATCH_GRACE_MS + 1_000).toISOString();
    const groupAt = [
      orphanRoot('gc-floor', { updated_at: atFloor }),
      orphanStep('gc-floor', 'read-issue', 'open', { updated_at: atFloor }),
    ];
    const groupInside = [
      orphanRoot('gc-floor', { updated_at: justInside }),
      orphanStep('gc-floor', 'read-issue', 'open', { updated_at: justInside }),
    ];
    assert.equal(isStrandedRun('gc-floor', groupAt, observation([])), true);
    assert.equal(isStrandedRun('gc-floor', groupInside, observation([])), false);
  });

  test('age is judged off the most recent bead write in the group', () => {
    // Root is old, but a step bead was written recently (e.g. a metadata
    // refresh): the group is not conclusively abandoned yet.
    const group = [
      orphanRoot('gc-mixed'),
      orphanStep('gc-mixed', 'read-issue', 'open', {
        updated_at: new Date(OBSERVED_AT_MS - 60_000).toISOString(),
      }),
    ];
    assert.equal(isStrandedRun('gc-mixed', group, observation([])), false);
  });
});
