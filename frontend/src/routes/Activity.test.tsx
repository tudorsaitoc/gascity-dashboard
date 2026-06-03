import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveCity } from '../api/cityBase';
import { invalidate } from '../api/cache';
import { AttentionProvider } from '../attention/context';
import { createAttentionContributors } from '../attention/registry';
import type { TypedEventStreamEnvelope } from '../generated/gc-supervisor-client/types.gen';
import { ActivityPage } from './Activity';

interface FetchCall {
  path: string;
  query: URLSearchParams;
}

const fetchCalls: FetchCall[] = [];

beforeEach(() => {
  setActiveCity('test-city');
  fetchCalls.length = 0;
  invalidate('activity:bundle:test-city:events:session.crashed');
  invalidate('activity:bundle:test-city:events:all');
  invalidate('activity:bundle:test-city:commits:all');
  invalidate('activity:bundle:test-city:deploys:all');
  invalidate('activity:bundle:test-city:all:all');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://dashboard.local');
    fetchCalls.push({ path: url.pathname, query: url.searchParams });

    if (url.pathname === '/gc-supervisor/v0/city/test-city/events') {
      return jsonResponse({
        items: [
          supervisorEvent({
            message: 'session crashed while applying patch',
            seq: 42,
            subject: 'gc-session-1',
            type: 'session.crashed',
          }),
          supervisorEvent({
            message: 'event archive rotated',
            seq: 41,
            subject: 'events',
            type: 'events.rotated',
          }),
        ],
        total: 2,
      });
    }
    if (url.pathname === '/api/builds') {
      return jsonResponse({
        failed_marker: true,
        source: '/tmp/.dev-deploy.log',
        items: [
          {
            at: '2026-06-01T10:00:00.000Z',
            detail: 'stage: frontend',
            status: 'failed',
          },
        ],
      });
    }
    if (url.pathname === '/api/git/commits') {
      return jsonResponse({
        view: url.searchParams.get('view') ?? 'recent-main',
        items: [
          {
            author: 'Chris',
            date: '2026-06-01T09:30:00.000Z',
            sha: 'abcdef123456',
            short_sha: 'abcdef1',
            subject: 'wire activity route',
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url.pathname}${url.search}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ActivityPage', () => {
  it('loads supervisor events through the generated-client proxy and honors type deep links', async () => {
    renderPage('/activity?mode=events&type=session.crashed');

    const table = await screen.findByRole('table', { name: /supervisor events/i });

    expect(await within(table).findByText('session.crashed')).toBeTruthy();
    expect(await within(table).findByText('session crashed while applying patch')).toBeTruthy();
    expect(within(table).queryByText('events.rotated')).toBeNull();

    const eventFetch = fetchCalls.find((call) =>
      call.path === '/gc-supervisor/v0/city/test-city/events'
    );
    expect(eventFetch).toBeDefined();
    expect(eventFetch?.query.get('type')).toBe('session.crashed');
    expect(eventFetch?.query.get('since')).toBe('24h');
    expect(fetchCalls.some((call) => call.path === '/api/city/test-city/events')).toBe(false);
  });

  it('renders deploy and commit activity without using supervisor mirrors', async () => {
    renderPage('/activity');

    expect(await screen.findByText('stage: frontend')).toBeTruthy();
    expect(screen.getByText('wire activity route')).toBeTruthy();
    expect(fetchCalls.some((call) => call.path === '/api/builds')).toBe(true);
    expect(fetchCalls.some((call) => call.path === '/api/git/commits')).toBe(true);
    expect(fetchCalls.some((call) => call.path === '/api/city/test-city/snapshot')).toBe(false);
  });

  it('marks event rows that match composed Activity attention', async () => {
    renderPage('/activity?mode=events', {
      eventId: 'activity:event:42:session.crashed',
    });

    const eventText = await screen.findByText('session.crashed');
    const row = eventText.closest('tr');
    expect(row?.getAttribute('data-attention-severity')).toBe('attention');
  });
});

function renderPage(
  path: string,
  attention: { eventId?: string } = {},
) {
  const facts = attention.eventId === undefined
    ? {}
    : {
        activity: {
          events: [
            supervisorEvent({
              seq: 42,
              type: 'session.crashed',
            }),
          ],
        },
      };
  return render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <AttentionProvider
        contributors={createAttentionContributors(facts)}
      >
        <ActivityPage />
      </AttentionProvider>
    </MemoryRouter>,
  );
}

function supervisorEvent(overrides: {
  message?: string;
  seq?: number;
  subject?: string;
  type?: string;
}): TypedEventStreamEnvelope {
  const type = overrides.type ?? 'session.crashed';
  return {
    actor: 'supervisor',
    message: overrides.message ?? 'event message',
    payload: type === 'events.rotated'
      ? {
          prior_archive: '/tmp/events-1.jsonl',
          prior_first_seq: 1,
          prior_last_seq: 40,
        }
      : {
          reason: 'panic',
          session_id: 'gc-session-1',
          template: 'mayor',
        },
    seq: overrides.seq ?? 1,
    subject: overrides.subject ?? 'subject',
    ts: '2026-06-01T10:10:00.000Z',
    type,
  } as TypedEventStreamEnvelope;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
