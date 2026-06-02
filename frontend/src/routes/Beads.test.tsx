import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeadsPage } from './Beads';
import { NowProvider } from '../contexts/NowContext';
import { invalidate } from '../api/cache';
import type { GcBead } from 'gas-city-dashboard-shared';

// gascity-dashboard-lcnb: the Beads tab is board-only — the list view and
// the board/list selector are gone. These tests assert (a) the kanban board
// renders by default with no toggle, and (b) there is no "View" radiogroup
// (the SortToggle that used to switch views).

const PROJECT = 'gascity';

let beadsRequestUrls: string[] = [];

beforeEach(() => {
  // #33: the board reads the real-work-filtered beads feed
  // (no showAll), so the count/list mirrors the supervisor's "Ready to Work"
  // and excludes bookkeeping beads (slack/nudge/mail/session/convoy).
  beadsRequestUrls = [];
  invalidate('beads:all');
  invalidate('sessions');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/city/test-city/beads')) {
        beadsRequestUrls.push(url);
        return jsonResponse(beadListPayload([sampleBead()]));
      }
      if (url === '/api/city/test-city/sessions') {
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BeadsPage', () => {
  it('renders the kanban board by default', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /^beads$/i });
    // The board renders one <section aria-label={project}> per project
    // group; the list view rendered a <table> instead.
    const board = await screen.findByRole('region', { name: PROJECT });
    expect(board).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('does not render a board/list view selector', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /^beads$/i });
    // The removed selector was a SortToggle rendered as a radiogroup
    // labelled "View".
    expect(screen.queryByRole('radiogroup', { name: /view/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /list/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /board/i })).toBeNull();
  });

  it('requests the real-work-filtered beads feed, not showAll', async () => {
    // #33: showAll=1 disables the backend spam filter and
    // floods the board (and its ready count) with bookkeeping beads
    // (slack/nudge/mail/session/convoy), inflating ~78 real ready-to-work
    // to ~979. The board must consume the filtered feed so its count/list
    // mirrors `gc bd stats → Ready to Work`.
    renderPage();

    await screen.findByRole('heading', { name: /^beads$/i });
    expect(beadsRequestUrls.length).toBeGreaterThan(0);
    for (const url of beadsRequestUrls) {
      expect(url).not.toContain('showAll');
    }
  });
});

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/beads']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <NowProvider intervalMs={1_000_000}>
        <BeadsPage />
      </NowProvider>
    </MemoryRouter>,
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function beadListPayload(items: ReadonlyArray<GcBead>): {
  items: ReadonlyArray<GcBead>;
  total: number;
} {
  return { items, total: items.length };
}

function sampleBead(): GcBead {
  return {
    id: `${PROJECT}-0001`,
    title: 'Sample bead',
    status: 'open',
    priority: 0,
    issue_type: 'task',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
  };
}
