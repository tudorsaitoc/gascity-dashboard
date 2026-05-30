import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPage } from './Agents';
import { invalidate } from '../api/cache';

// Regression tests for two bugs that shipped with the ay6 Agents-view rewrite
// (PR #45, surfaced post-deploy):
//
// 1. Peek button errored with "invalid session id" because the modal passed
//    `agent.session.name` (a friendly alias like "mayor") to a route that
//    validates against SESSION_ID_RE (`gc-XXX` format). The fix maps
//    agent.session.name -> session.id through the sessions cache.
//
// 2. The agent name column rendered `display_name ?? name`, so the
//    Orchestration group showed "Claude (Account 5)" instead of "mayor".
//    The fix uses `name` (alias) as primary and pushes `display_name` to a
//    secondary line.

const fetchUrls: string[] = [];

// Minimal fetch stub that mimics the surface the AgentsPage hits via the
// shared api client (api.listAgents + api.listSessions).
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchUrls.push(url);
    if (url === '/api/agents') {
      return jsonResponse({
        items: [
          {
            name: 'mayor',
            available: true,
            running: true,
            suspended: false,
            state: 'idle',
            display_name: 'Claude (Account 5)',
            provider: 'claude-5',
            session: {
              name: 'mayor',
              attached: true,
              last_activity: '2026-05-29T20:56:31-04:00',
            },
          },
        ],
      });
    }
    if (url === '/api/sessions') {
      return jsonResponse({
        items: [
          {
            id: 'gc-2568',
            session_name: 'mayor',
            state: 'active',
            template: 'mayor',
            alias: 'mayor',
            provider: 'claude-5',
            running: true,
            title: 'mayor',
          },
        ],
      });
    }
    if (url === '/api/sessions/gc-2568/peek') {
      return jsonResponse({
        session_id: 'gc-2568',
        turns: [{ role: 'assistant', text: 'mayor transcript snapshot' }],
        total_chars: 25,
        captured_at: '2026-05-30T00:00:00Z',
        truncated: false,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchUrls.length = 0;
  invalidate('agents');
  invalidate('sessions');
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentsPage (post-ay6 regressions)', () => {
  it('renders the alias as primary label and display_name as secondary (Orchestration shows "mayor", not "Claude (Account 5)")', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AgentsPage />
      </MemoryRouter>,
    );

    // Alias is the primary label — must be rendered as a Link.
    const mayorLink = await screen.findByRole('link', { name: /mayor/i });
    expect(mayorLink).toBeDefined();
    expect(mayorLink.textContent).toBe('mayor');
    // display_name appears as secondary muted text — present but not the link.
    expect(screen.getByText('Claude (Account 5)')).toBeDefined();
  });

  it('Peek resolves agent.session.name -> session.id via the sessions cache and POSTs the right gc-XXX id', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AgentsPage />
      </MemoryRouter>,
    );

    // Wait for the row to load.
    await screen.findByRole('link', { name: /mayor/i });

    const peekButton = await screen.findByRole('button', { name: /peek/i });
    fireEvent.click(peekButton);

    // The peek modal must hit /api/sessions/gc-2568/peek — NOT
    // /api/sessions/mayor/peek (the pre-fix bug). We wait for the POST to
    // land in fetchUrls because the resolution is async (sessions cache).
    await waitFor(() => {
      expect(fetchUrls).toContain('/api/sessions/gc-2568/peek');
    });
    // Belt-and-suspenders: assert the buggy URL was NEVER attempted.
    expect(fetchUrls).not.toContain('/api/sessions/mayor/peek');
  });
});
