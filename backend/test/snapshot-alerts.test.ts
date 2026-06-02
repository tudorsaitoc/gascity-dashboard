import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  RunLane,
  RunLaneHealth,
  RunSummary,
  SourceState,
} from 'gas-city-dashboard-shared';

import { deriveRunAlerts } from '../src/snapshot/alerts.js';

// Run-sourced alert derivation (gascity-dashboard-i4ui, PRD R2/R5).
// These pin the structural predicates and the premortem's degrade-to-quiet
// gate: an 'inferred' lane's thrashing fact must never become a failing alert.

const FETCHED_AT = '2026-06-02T12:00:00.000Z';

function health(partial: Partial<RunLaneHealth> = {}): RunLane['health'] {
  return {
    status: 'available',
    data: {
      phaseConfidence: 'known',
      needsOperator: false,
      stuckNode: { status: 'unavailable', error: 'no stuck node in test' },
      thrashingDetected: false,
      session: { status: 'unresolved', error: 'session unresolved in test' },
      ...partial,
    },
  };
}

function lane(partial: Partial<RunLane> & { id: string }): RunLane {
  return {
    title: `run ${partial.id}`,
    formula: { status: 'unavailable', error: 'formula unavailable in test' },
    scope: { status: 'unavailable', error: 'not scoped in test' },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'implementation',
    phaseLabel: 'implementation',
    statusCounts: {},
    activeAssignees: [],
    updatedAt: { status: 'available', at: '2026-06-02T11:00:00.000Z' },
    stages: [],
    progress: { status: 'unavailable', error: 'progress unavailable in test' },
    formulaStageResolved: false,
    health: { status: 'unavailable', error: 'health not derived in test' },
    ...partial,
  };
}

function availableRuns(
  lanes: RunLane[],
  status: 'fresh' | 'stale' | 'fixture' = 'fresh',
): SourceState<RunSummary> {
  return {
    source: 'runs',
    status,
    fetchedAt: FETCHED_AT,
    staleAt: '2026-06-02T12:01:00.000Z',
    error: { kind: 'none' },
    data: {
      totalActive: lanes.length,
      totalHistorical: 0,
      runCounts: { total: lanes.length, visible: lanes.length, prReview: 0, designReview: 0, bugfix: 0, blocked: 0, other: 0 },
      lanes,
      historicalLanes: [],
      recentChanges: [],
      census: { status: 'unavailable', error: 'census not derived in test' },
    },
  };
}

describe('deriveRunAlerts', () => {
  test('emits a run-needs-operator (attention) for a needsOperator lane', () => {
    const alerts = deriveRunAlerts(availableRuns([
      lane({ id: 'r1', phase: 'approval', health: health({ needsOperator: true }) }),
    ]));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'run-needs-operator');
    assert.equal(alerts[0]!.severity, 'attention');
    assert.equal(alerts[0]!.dedupKey, 'run-needs-operator:r1');
    assert.equal(alerts[0]!.reason, 'awaiting your decision');
    assert.equal(alerts[0]!.ref.runId, 'r1');
    assert.equal(alerts[0]!.href, '/runs/r1');
  });

  test('blocked phase reasons as "blocked"', () => {
    const alerts = deriveRunAlerts(availableRuns([
      lane({ id: 'r1', phase: 'blocked', health: health({ needsOperator: true }) }),
    ]));
    assert.equal(alerts[0]!.reason, 'blocked');
  });

  test('emits run-thrashing (failing) for a known-confidence thrashing lane', () => {
    const alerts = deriveRunAlerts(availableRuns([
      lane({ id: 'r1', health: health({ thrashingDetected: true, phaseConfidence: 'known' }) }),
    ]));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'run-thrashing');
    assert.equal(alerts[0]!.severity, 'failing');
  });

  test('SUPPRESSES thrashing on an inferred-confidence lane (premortem: inferred never drives the maroon)', () => {
    const alerts = deriveRunAlerts(availableRuns([
      lane({ id: 'r1', health: health({ thrashingDetected: true, phaseConfidence: 'inferred' }) }),
    ]));
    assert.deepEqual(alerts, []);
  });

  test('a healthy lane produces no alerts (withholding: a calm run is absent)', () => {
    const alerts = deriveRunAlerts(availableRuns([lane({ id: 'r1', health: health() })]));
    assert.deepEqual(alerts, []);
  });

  test('a lane both needing-operator and thrashing yields two alerts, failing ranked first', () => {
    const alerts = deriveRunAlerts(availableRuns([
      lane({ id: 'r1', phase: 'approval', health: health({ needsOperator: true, thrashingDetected: true, phaseConfidence: 'known' }) }),
    ]));
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0]!.kind, 'run-thrashing'); // failing sorts above attention
    assert.equal(alerts[1]!.kind, 'run-needs-operator');
  });

  test('href deep-links to the stuck node when known', () => {
    const alerts = deriveRunAlerts(availableRuns([
      lane({ id: 'r1', health: health({ needsOperator: true, stuckNode: { status: 'available', id: 'node-7' } }) }),
    ]));
    assert.equal(alerts[0]!.href, '/runs/r1?node=node-7');
  });

  test('provenance inherits the source status; version is the generation epoch', () => {
    const alerts = deriveRunAlerts(availableRuns(
      [lane({ id: 'r1', health: health({ needsOperator: true }) })],
      'stale',
    ));
    assert.equal(alerts[0]!.provenance, 'stale');
    assert.equal(alerts[0]!.version, Date.parse(FETCHED_AT));
  });

  test('returns [] for an unavailable source (the SourceState carries the error, not this array)', () => {
    const errored: SourceState<RunSummary> = { source: 'runs', status: 'error', error: 'supervisor unreachable' };
    assert.deepEqual(deriveRunAlerts(errored), []);
  });

  test('ordering is stable across two derivations (R5)', () => {
    const runs = availableRuns([
      lane({ id: 'r2', health: health({ thrashingDetected: true, phaseConfidence: 'known' }) }),
      lane({ id: 'r1', phase: 'approval', health: health({ needsOperator: true }) }),
    ]);
    const a = deriveRunAlerts(runs).map((x) => x.dedupKey);
    const b = deriveRunAlerts(runs).map((x) => x.dedupKey);
    assert.deepEqual(a, b);
  });
});
