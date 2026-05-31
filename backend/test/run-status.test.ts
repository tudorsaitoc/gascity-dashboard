import type {
  GcRunBead,
  RunExecutionInstance,
  RunNodeStatus,
} from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  aggregateStatus,
  isRunningStatus,
  presentationStatus,
} from '../src/runs/status.js';

describe('run status presentation', () => {
  test('normalizes closed outcomes into completed, failed, or skipped', () => {
    assert.equal(presentationStatus(runBead({ status: 'closed' })), 'completed');
    assert.equal(
      presentationStatus(runBead({
        status: 'completed',
        metadata: { 'gc.outcome': 'fail' },
      })),
      'failed',
    );
    assert.equal(
      presentationStatus(runBead({
        status: 'done',
        metadata: { 'gc.outcome': 'SKIPPED' },
      })),
      'skipped',
    );
  });

  test('maps active supervisor statuses to active dashboard state', () => {
    assert.equal(
      presentationStatus(runBead({ status: 'in_progress', assignee: 'agent-session' })),
      'active',
    );
    assert.equal(
      presentationStatus(runBead({ status: 'active', assignee: 'agent-session' })),
      'active',
    );
    assert.equal(
      presentationStatus(runBead({ status: 'running', assignee: 'agent-session' })),
      'active',
    );
    assert.equal(presentationStatus(runBead({ status: 'in_progress' })), 'active');
    assert.equal(presentationStatus(runBead({ status: 'active' })), 'active');
    assert.equal(presentationStatus(runBead({ status: 'running' })), 'active');
  });

  test('passes through terminal and waiting statuses, otherwise pending', () => {
    assert.equal(presentationStatus(runBead({ status: 'blocked' })), 'blocked');
    assert.equal(presentationStatus(runBead({ status: 'ready' })), 'ready');
    assert.equal(presentationStatus(runBead({ status: 'failed' })), 'failed');
    assert.equal(presentationStatus(runBead({ status: 'skipped' })), 'skipped');
    assert.equal(presentationStatus(runBead({ status: 'unknown' })), 'pending');
    assert.equal(presentationStatus(runBead({ status: '   ' })), 'pending');
  });

  test('aggregate status keeps active visible even when latest instance is terminal', () => {
    assert.equal(
      aggregateStatus(
        [
          executionInstance('failed'),
          executionInstance('active'),
          executionInstance('completed'),
        ],
        executionInstance('completed'),
      ),
      'active',
    );
  });

  test('aggregate status falls back to selected visible instance or pending', () => {
    assert.equal(
      aggregateStatus([executionInstance('failed')], executionInstance('failed')),
      'failed',
    );
    assert.equal(aggregateStatus([], undefined), 'pending');
  });

  test('running status predicate matches active streamable states', () => {
    assert.equal(isRunningStatus('active'), true);
    assert.equal(isRunningStatus('running'), true);
    assert.equal(isRunningStatus('completed'), false);
    assert.equal(isRunningStatus(undefined), false);
  });
});

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

function executionInstance(
  status: RunNodeStatus,
): RunExecutionInstance {
  return {
    id: `${status}-instance`,
    semanticNodeId: 'node',
    beadId: `${status}-bead`,
    iteration: { kind: 'base' },
    attempt: { kind: 'untracked' },
    label: 'base',
    status,
    session: { kind: 'none', reason: 'session_unresolved' },
    currentIteration: true,
    historical: false,
  };
}
