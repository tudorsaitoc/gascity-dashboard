import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeadsPage } from './Beads';
import { setActiveCity } from '../api/cityBase';
import { NowProvider } from '../contexts/NowContext';
import { invalidate } from '../api/cache';
import type { SupervisorBead } from '../supervisor/beadReads';

// Beads reads directly from the gc supervisor and defaults to the board view.
// These tests keep that top-level contract pinned without duplicating the
// richer supervisor-read/write coverage in Beads.render.test.tsx.

const PROJECT = 'gascity';

let beadsRequestUrls: string[] = [];

beforeEach(() => {
  setActiveCity('test-city');
  beadsRequestUrls = [];
  invalidate('beads:all:rig:');
  invalidate('beads:open:rig:');
  invalidate('agents');
  invalidate('sessions');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === '/gc-supervisor/v0/city/test-city/beads?limit=1000') {
        beadsRequestUrls.push(url);
        return jsonResponse(beadListPayload([sampleBead()]));
      }
      if (url === '/gc-supervisor/v0/city/test-city/agents') {
        return jsonResponse({ items: [], total: 0 });
      }
      if (url.startsWith('/api/city/test-city/beads')) {
        throw new Error('old dashboard bead read mirror should not be called');
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

  it('renders a board/list view selector with board selected by default', async () => {
    renderPage();

    await screen.findByText('Sample bead');
    const viewToggle = screen.getByRole('radiogroup', { name: /view/i });
    expect(within(viewToggle).getByRole('radio', { name: /board/i }).getAttribute('aria-checked')).toBe('true');
    expect(within(viewToggle).getByRole('radio', { name: /list/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('requests the supervisor beads feed without the old dashboard showAll flag', async () => {
    renderPage();

    await screen.findByText('Sample bead');
    expect(beadsRequestUrls.length).toBeGreaterThan(0);
    for (const url of beadsRequestUrls) {
      expect(url).toBe('/gc-supervisor/v0/city/test-city/beads?limit=1000');
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

function beadListPayload(items: ReadonlyArray<SupervisorBead>): {
  items: ReadonlyArray<SupervisorBead>;
  total: number;
} {
  return { items, total: items.length };
}

function sampleBead(): SupervisorBead {
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

function requestUrl(input: RequestInfo | URL): string {
  const url = input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.toString()
      : String(input);
  return stripSameOrigin(url);
}

function stripSameOrigin(url: string): string {
  const origin = window.location.origin;
  return url.startsWith(origin) ? url.slice(origin.length) : url;
}
