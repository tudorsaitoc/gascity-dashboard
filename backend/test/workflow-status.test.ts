import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  GcWorkflowBead,
  WorkflowExecutionInstance,
} from 'gas-city-dashboard-shared';
import {
  aggregateStatus,
  isRunningStatus,
  presentationStatus,
} from '../src/workflows/status.js';

describe('workflow status presentation', () => {
  test('normalizes closed outcomes into completed, failed, or skipped', () => {
    assert.equal(presentationStatus(workflowBead({ status: 'closed' })), 'completed');
    assert.equal(
      presentationStatus(workflowBead({
        status: 'completed',
        metadata: { 'gc.outcome': 'fail' },
      })),
      'failed',
    );
    assert.equal(
      presentationStatus(workflowBead({
        status: 'done',
        metadata: { 'gc.outcome': 'SKIPPED' },
      })),
      'skipped',
    );
  });

  test('maps assigned active supervisor statuses to active dashboard state', () => {
    assert.equal(
      presentationStatus(workflowBead({ status: 'in_progress', assignee: 'agent-session' })),
      'active',
    );
    assert.equal(
      presentationStatus(workflowBead({ status: 'active', assignee: 'agent-session' })),
      'active',
    );
    assert.equal(
      presentationStatus(workflowBead({ status: 'running', assignee: 'agent-session' })),
      'active',
    );
  });

  test('does not mark unassigned active supervisor statuses as running', () => {
    assert.equal(presentationStatus(workflowBead({ status: 'in_progress' })), 'pending');
    assert.equal(presentationStatus(workflowBead({ status: 'active' })), 'pending');
    assert.equal(presentationStatus(workflowBead({ status: 'running' })), 'pending');
  });

  test('passes through terminal and waiting statuses, otherwise pending', () => {
    assert.equal(presentationStatus(workflowBead({ status: 'blocked' })), 'blocked');
    assert.equal(presentationStatus(workflowBead({ status: 'ready' })), 'ready');
    assert.equal(presentationStatus(workflowBead({ status: 'failed' })), 'failed');
    assert.equal(presentationStatus(workflowBead({ status: 'skipped' })), 'skipped');
    assert.equal(presentationStatus(workflowBead({ status: 'unknown' })), 'pending');
    assert.equal(presentationStatus(workflowBead({ status: '   ' })), 'pending');
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

function workflowBead(overrides: Partial<GcWorkflowBead>): GcWorkflowBead {
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
  status: WorkflowExecutionInstance['status'],
): WorkflowExecutionInstance {
  return {
    id: `${status ?? 'unknown'}-instance`,
    semanticNodeId: 'node',
    status,
  };
}
