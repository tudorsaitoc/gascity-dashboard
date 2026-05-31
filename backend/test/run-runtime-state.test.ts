import type {
  GcBead,
  GcRunBead,
  GcRunSnapshot,
} from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeRunRuntimeState } from '../src/runs/runtime-state.js';

describe('run runtime state overlay', () => {
  test('preserves gc-prefixed session metadata from live bead reads', () => {
    const merged = mergeRunRuntimeState(
      runSnapshot([
        runBead({
          id: 'node',
          metadata: {
            session_id: 'stale-session',
            session_name: 'stale-session-name',
            'gc.sessionName': 'stale-camel-session-name',
          },
        }),
      ]),
      [
        runtimeBead({
          id: 'node',
          metadata: {
            'gc.session_id': 'gc-live-session',
            'gc.session_name': 'gc-live-session-name',
            'gc.sessionName': 'live-camel-session-name',
          },
        }),
      ],
    );

    assert.equal(merged.beads?.[0]?.metadata['gc.session_id'], 'gc-live-session');
    assert.equal(merged.beads?.[0]?.metadata['gc.session_name'], 'gc-live-session-name');
    assert.equal(merged.beads?.[0]?.metadata['gc.sessionName'], 'live-camel-session-name');
  });
});

function runSnapshot(beads: GcRunBead[]): GcRunSnapshot {
  return {
    run_id: 'run-1',
    root_bead_id: 'root',
    root_store_ref: 'city:test',
    resolved_root_store: 'city:test',
    scope_kind: 'city',
    scope_ref: 'test',
    snapshot_version: 1,
    snapshot_event_seq: 1,
    partial: false,
    stores_scanned: ['city:test'],
    beads,
    deps: [],
    logical_nodes: [],
    logical_edges: [],
    scope_groups: [],
  };
}

function runBead(overrides: Partial<GcRunBead>): GcRunBead {
  return {
    id: 'node',
    title: 'Node',
    status: 'ready',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}

function runtimeBead(overrides: Partial<GcBead>): GcBead {
  return {
    id: 'node',
    title: 'Node',
    status: 'in_progress',
    issue_type: 'task',
    priority: null,
    created_at: '2026-01-01T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}
