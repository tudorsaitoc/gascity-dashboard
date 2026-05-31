import type { GcRunBead, GcSession } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildRunSessionIndex,
  runSessionLinkFor,
} from '../src/runs/session-link.js';

describe('run session link resolution', () => {
  test('returns undefined when no session identity is available', () => {
    assert.equal(runSessionLinkFor(runBead({}), 'active'), undefined);
  });

  test('does not expose transcript links for pending or ready work', () => {
    const bead = runBead({ metadata: { session_id: 'session-1' } });

    assert.equal(runSessionLinkFor(bead, 'pending'), undefined);
    assert.equal(runSessionLinkFor(bead, 'ready'), undefined);
  });

  test('uses explicit supervisor session metadata when available', () => {
    assert.deepEqual(
      runSessionLinkFor(
        runBead({
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
      },
    );
  });

  test('uses gc-prefixed supervisor session metadata when available', () => {
    assert.deepEqual(
      runSessionLinkFor(
        runBead({
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
      {
        sessionId: 'gc-session-1',
        sessionName: 'gc-session-name',
        assignee: 'gc-session-name',
      },
    );
  });

  test('resolves t3bridge gc.sessionName metadata through the session index', () => {
    const index = buildRunSessionIndex([
      session({
        id: 'gc-session-crew',
        alias: 'crew',
        session_name: 't3code--crew',
        title: 'Crew runtime',
      }),
    ]);

    assert.deepEqual(
      runSessionLinkFor(
        runBead({
          assignee: 't3code/crew',
          metadata: {
            'gc.sessionName': 't3code--crew',
          },
        }),
        'active',
        { sessionIndex: index },
      ),
      {
        sessionId: 'gc-session-crew',
        sessionName: 'crew',
        assignee: 't3code/crew',
      },
    );
  });

  test('ignores legacy rig metadata aliases', () => {
    const link = runSessionLinkFor(
      runBead({
        assignee: 'agent-session',
        metadata: {
          session_id: 'session-1',
          mc_rig_id: 'legacy-rig',
        },
      }),
      'active',
    );

    assert.deepEqual(link, {
      sessionId: 'session-1',
      sessionName: 'agent-session',
      assignee: 'agent-session',
    });
  });

  test('falls back to assignee for completed historical transcripts', () => {
    assert.deepEqual(
      runSessionLinkFor(runBead({ assignee: 'agent-session' }), 'completed'),
      {
        sessionId: 'agent-session',
        sessionName: 'agent-session',
        assignee: 'agent-session',
      },
    );
  });

  test('normalizes completed provider-prefixed assignees to supervisor session ids', () => {
    assert.deepEqual(
      runSessionLinkFor(runBead({ assignee: 'claude-fddc-54n' }), 'completed'),
      {
        sessionId: 'fddc-54n',
        sessionName: 'claude-fddc-54n',
        assignee: 'claude-fddc-54n',
      },
    );
  });

  test('resolves an assignee alias to the supervisor session id', () => {
    const index = buildRunSessionIndex([
      session({
        id: 'fddc-g3v',
        alias: 'tic-tac-toe-app/codex-1',
        title: 'tic-tac-toe-app/codex-1',
        template: 'tic-tac-toe-app/codex',
      }),
    ]);

    assert.deepEqual(
      runSessionLinkFor(
        runBead({ assignee: 'tic-tac-toe-app/codex-1' }),
        'active',
        { sessionIndex: index, scopeRef: 'tic-tac-toe-app' },
      ),
      {
        sessionId: 'fddc-g3v',
        sessionName: 'tic-tac-toe-app/codex-1',
        assignee: 'tic-tac-toe-app/codex-1',
      },
    );
  });

  test('keeps failed attempt transcript links non-streaming eligible', () => {
    const link = runSessionLinkFor(
      runBead({ metadata: { session_id: 'failed-session' } }),
      'failed',
    );

    assert.equal(link?.sessionId, 'failed-session');
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
