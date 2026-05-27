import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcSession, GcWorkflowBead } from 'gas-city-dashboard-shared';
import {
  buildWorkflowSessionIndex,
  workflowSessionLinkFor,
} from '../src/workflows/session-link.js';

describe('workflow session link resolution', () => {
  test('returns null when no session identity is available', () => {
    assert.equal(workflowSessionLinkFor(workflowBead({}), 'active'), null);
  });

  test('does not expose transcript links for pending or ready work', () => {
    const bead = workflowBead({ metadata: { session_id: 'session-1' } });

    assert.equal(workflowSessionLinkFor(bead, 'pending'), null);
    assert.equal(workflowSessionLinkFor(bead, 'ready'), null);
  });

  test('uses explicit supervisor session metadata when available', () => {
    assert.deepEqual(
      workflowSessionLinkFor(
        workflowBead({
          assignee: 'agent',
          metadata: {
            session_id: 'session-1',
            session_name: 'rig__agent',
            rig_id: 'rig-a',
          },
        }),
        'active',
      ),
      {
        sessionId: 'session-1',
        sessionName: 'rig__agent',
        assignee: 'agent',
        rigId: 'rig-a',
      },
    );
  });

  test('ignores non-supervisor session metadata aliases', () => {
    assert.equal(
      workflowSessionLinkFor(
        workflowBead({
          metadata: {
            'gc.session_id': 'gc-session-1',
            'gc.session_name': 'gc-session-name',
            'gc.sessionId': 'camel-session-1',
            'gc.sessionName': 'camel-session-name',
            assignee: 'metadata-assignee',
          },
        }),
        'active',
      ),
      null,
    );
  });

  test('does not expose legacy rig metadata aliases', () => {
    const link = workflowSessionLinkFor(
      workflowBead({
        assignee: 'agent-session',
        metadata: {
          session_id: 'session-1',
          mc_rig_id: 'legacy-rig',
        },
      }),
      'active',
    );

    assert.equal(link?.rigId, undefined);
  });

  test('falls back to assignee for completed historical transcripts', () => {
    assert.deepEqual(
      workflowSessionLinkFor(workflowBead({ assignee: 'agent-session' }), 'completed'),
      {
        sessionId: 'agent-session',
        sessionName: 'agent-session',
        assignee: 'agent-session',
        rigId: undefined,
      },
    );
  });

  test('normalizes completed provider-prefixed assignees to supervisor session ids', () => {
    assert.deepEqual(
      workflowSessionLinkFor(workflowBead({ assignee: 'claude-fddc-54n' }), 'completed'),
      {
        sessionId: 'fddc-54n',
        sessionName: 'claude-fddc-54n',
        assignee: 'claude-fddc-54n',
        rigId: undefined,
      },
    );
  });

  test('resolves an assignee alias to the supervisor session id', () => {
    const index = buildWorkflowSessionIndex([
      session({
        id: 'fddc-g3v',
        alias: 'tic-tac-toe-app/codex-1',
        title: 'tic-tac-toe-app/codex-1',
        template: 'tic-tac-toe-app/codex',
      }),
    ]);

    assert.deepEqual(
      workflowSessionLinkFor(
        workflowBead({ assignee: 'tic-tac-toe-app/codex-1' }),
        'active',
        { sessionIndex: index, scopeRef: 'tic-tac-toe-app' },
      ),
      {
        sessionId: 'fddc-g3v',
        sessionName: 'tic-tac-toe-app/codex-1',
        assignee: 'tic-tac-toe-app/codex-1',
        rigId: undefined,
      },
    );
  });

  test('keeps failed attempt transcript links non-streaming eligible', () => {
    const link = workflowSessionLinkFor(
      workflowBead({ metadata: { session_id: 'failed-session' } }),
      'failed',
    );

    assert.equal(link?.sessionId, 'failed-session');
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

function session({ id, ...overrides }: Partial<GcSession> & { id: string }): GcSession {
  return {
    id,
    title: overrides.title ?? id,
    alias: overrides.alias ?? overrides.title ?? id,
    template: overrides.template ?? 'codex',
    state: overrides.state ?? 'active',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    attached: overrides.attached ?? false,
    running: overrides.running ?? true,
    ...overrides,
  };
}
