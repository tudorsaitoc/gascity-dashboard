import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidate } from '../api/cache';
import { AttentionProvider } from '../attention/context';
import type { AttentionContributor } from '../attention/compose';
import { NowProvider } from '../contexts/NowContext';
import { BeadsPage } from './Beads';

interface FetchCall {
  method: string;
  url: string;
  body: unknown;
  gcRequest: string | null;
}

const fetchCalls: FetchCall[] = [];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    fetchCalls.push({
      method,
      url,
      body: await requestBody(input, init),
      gcRequest: requestHeader(input, init, 'X-GC-Request'),
    });
    if (url.startsWith('/api/city/test-city/beads') && method === 'GET') {
      throw new Error('old dashboard bead read mirror should not be called');
    }
    if (url === '/gc-supervisor/v0/city/test-city/beads?limit=1000') {
      return jsonResponse({
        items: [
          {
            id: 'td-bead-abc123',
            title: 'direct supervisor bead',
            status: 'open',
            issue_type: 'task',
            created_at: '2026-06-01T00:00:00Z',
            assignee: 'mayor',
            labels: ['needs-review'],
          },
          {
            id: 'gc-noise-abc123',
            title: 'supervisor noise bead',
            status: 'open',
            issue_type: 'molecule',
            created_at: '2026-06-01T00:00:00Z',
            labels: ['gc:session'],
          },
        ],
        total: 2,
      });
    }
    if (url === '/gc-supervisor/v0/city/test-city/beads?limit=1000&rig=east') {
      return jsonResponse({
        items: [
          {
            id: 'td-east-1',
            title: 'east rig bead',
            status: 'open',
            issue_type: 'task',
            created_at: '2026-06-01T00:00:00Z',
            labels: ['needs-review'],
          },
        ],
        total: 2,
      });
    }
    if (url === '/gc-supervisor/v0/city/test-city/sessions') {
      return jsonResponse({ items: [], total: 0 });
    }
    if (url === '/gc-supervisor/v0/city/test-city/agents') {
      return jsonResponse({
        items: [
          {
            name: 'mayor',
            available: true,
            running: true,
            suspended: false,
            state: 'active',
            rig: 'east',
          },
          {
            name: 'mechanic',
            available: true,
            running: true,
            suspended: false,
            state: 'active',
            rig: 'west',
          },
        ],
        total: 1,
      });
    }
    if (url === '/gc-supervisor/v0/city/test-city/beads' && method === 'POST') {
      return jsonResponse({
        id: 'td-new-1',
        title: 'Route failing work',
        status: 'open',
        issue_type: 'task',
        created_at: '2026-06-01T00:00:00Z',
        labels: [],
      }, { status: 201 });
    }
    if (url === '/gc-supervisor/v0/city/test-city/sling' && method === 'POST') {
      return jsonResponse({
        status: 'ok',
        bead: 'td-new-1',
        target: 'mayor',
      });
    }
    if (url === '/gc-supervisor/v0/city/test-city/bead/td-bead-abc123' && method === 'PATCH') {
      return jsonResponse({ status: 'ok' });
    }
    if (url === '/gc-supervisor/v0/city/test-city/agent/mayor/nudge' && method === 'POST') {
      return jsonResponse({ status: 'ok' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
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

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method !== undefined) return init.method;
  if (input instanceof Request) return input.method;
  return 'GET';
}

async function requestBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return JSON.parse(raw) as unknown;
}

function requestHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string | null {
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  return headers.get(name);
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchCalls.length = 0;
  invalidate('beads');
  invalidate('sessions');
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BeadsPage supervisor reads', () => {
  it('loads bead rows from the supervisor API instead of the dashboard GET mirror', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <BeadsPage />
        </NowProvider>
      </MemoryRouter>,
    );

    await screen.findByText('direct supervisor bead');

    expect(fetchCalls.map((call) => call.url)).toContain('/gc-supervisor/v0/city/test-city/beads?limit=1000');
    expect(fetchCalls.map((call) => call.url)).not.toContain('/api/city/test-city/beads');
    expect(fetchCalls.map((call) => call.url)).not.toContain('/api/city/test-city/beads?showAll=1');
  });

  it('keeps the local engineering-work filter when the list view is open-only', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <BeadsPage />
        </NowProvider>
      </MemoryRouter>,
    );

    await screen.findByText('direct supervisor bead');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));

    await waitFor(() => {
      expect(screen.queryByText('supervisor noise bead')).toBeNull();
    });
    expect(screen.getByText('direct supervisor bead')).toBeTruthy();
  });

  it('filters bead reads by rig through the supervisor query when a rig is selected', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <BeadsPage />
        </NowProvider>
      </MemoryRouter>,
    );

    await screen.findByText('direct supervisor bead');

    fireEvent.change(screen.getByLabelText('Rig filter'), {
      target: { value: 'east' },
    });

    await screen.findByText('east rig bead');

    expect(fetchCalls.map((call) => call.url)).toContain(
      '/gc-supervisor/v0/city/test-city/beads?limit=1000&rig=east',
    );
    expect(fetchCalls.map((call) => call.url)).not.toContain('/api/city/test-city/beads?rig=east');
  });

  it('claims through the supervisor API instead of the dashboard write mirror', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <BeadsPage />
        </NowProvider>
      </MemoryRouter>,
    );

    await screen.findByText('direct supervisor bead');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    fireEvent.click(screen.getByLabelText('Show all'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search beads' }), {
      target: { value: 'direct supervisor' },
    });
    await screen.findByText('direct supervisor bead');
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        method: 'PATCH',
        url: '/gc-supervisor/v0/city/test-city/bead/td-bead-abc123',
        body: { status: 'in_progress', assignee: 'stephanie' },
        gcRequest: 'dashboard',
      });
    });
    expect(fetchCalls.some((call) => call.url.endsWith('/claim'))).toBe(false);
  });

  it('nudges the bead assignee instead of overloading the bead id as an alias', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <BeadsPage />
        </NowProvider>
      </MemoryRouter>,
    );

    await screen.findByText('direct supervisor bead');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    fireEvent.click(screen.getByLabelText('Show all'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search beads' }), {
      target: { value: 'direct supervisor' },
    });
    await screen.findByText('direct supervisor bead');
    fireEvent.click(screen.getByRole('button', { name: 'Nudge' }));

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        method: 'POST',
        url: '/gc-supervisor/v0/city/test-city/agent/mayor/nudge',
        body: undefined,
        gcRequest: 'dashboard',
      });
    });
    expect(fetchCalls.some((call) => call.url.endsWith('/beads/td-bead-abc123/nudge'))).toBe(false);
  });

  it('creates a bead and slings it to a selected rig and agent through supervisor writes', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <BeadsPage />
        </NowProvider>
      </MemoryRouter>,
    );

    await screen.findByText('direct supervisor bead');
    fireEvent.click(screen.getByRole('button', { name: 'New bead' }));
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Route failing work' },
    });
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Please investigate the failed deployment.' },
    });
    fireEvent.change(screen.getByLabelText('Rig'), {
      target: { value: 'east' },
    });
    fireEvent.change(screen.getByLabelText('Agent'), {
      target: { value: 'mayor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create and sling' }));

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        method: 'POST',
        url: '/gc-supervisor/v0/city/test-city/beads',
        body: {
          title: 'Route failing work',
          description: 'Please investigate the failed deployment.',
        },
        gcRequest: 'dashboard',
      });
      expect(fetchCalls).toContainEqual({
        method: 'POST',
        url: '/gc-supervisor/v0/city/test-city/sling',
        body: {
          bead: 'td-new-1',
          rig: 'east',
          target: 'mayor',
        },
        gcRequest: 'dashboard',
      });
    });
    expect(screen.getByText('created and slung td-new-1 to mayor')).toBeTruthy();
  });

  it('marks attention beads in both board and list views while preserving non-attention rows', async () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NowProvider intervalMs={1_000_000}>
          <AttentionProvider contributors={[
            contributor('beads', [{
              id: 'beads:td-bead-abc123:high-priority',
              domain: 'beads',
              severity: 'attention',
              title: 'td-bead-abc123 high priority',
            }]),
          ]}>
            <BeadsPage />
          </AttentionProvider>
        </NowProvider>
      </MemoryRouter>,
    );

    const boardRow = (await screen.findByText('direct supervisor bead')).closest('li');
    expect(boardRow?.getAttribute('data-attention-severity')).toBe('attention');

    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    const listRow = (await screen.findByText('direct supervisor bead')).closest('tr');
    expect(listRow?.getAttribute('data-attention-severity')).toBe('attention');
  });
});

function contributor(
  domain: 'beads',
  items: ReturnType<AttentionContributor['getItems']>,
): AttentionContributor {
  return {
    id: `${domain}:test`,
    domain,
    getItems: () => items,
  };
}
