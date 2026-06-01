import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GcAgent } from 'gas-city-dashboard-shared';
import { AgentsPage, isActivelyRunning } from './Agents';
import { NowProvider } from '../contexts/NowContext';

// The SSE refresh hook opens an EventSource; stub it so tests run in jsdom
// without a live supervisor. We only assert on rendered roster, not on the
// live-update plumbing (covered by useGcEvents' own tests).
vi.mock('../hooks/useGcEvents', () => ({
  useGcEventRefresh: () => 'open',
}));

const listAgents = vi.fn();
const listSessions = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    listAgents: () => listAgents(),
    listSessions: () => listSessions(),
  },
}));

function agent(partial: Partial<GcAgent> & Pick<GcAgent, 'name'>): GcAgent {
  return {
    available: true,
    running: false,
    suspended: false,
    state: 'asleep',
    ...partial,
  };
}

const ROSTER: GcAgent[] = [
  agent({
    name: 'alpha/worker',
    rig: 'alpha',
    state: 'active',
    running: true,
    session: { name: 'gc-1', attached: false, last_activity: '2026-06-01T10:00:00Z' },
  }),
  agent({
    name: 'beta/worker',
    rig: 'beta',
    state: 'running',
    running: true,
    session: { name: 'gc-2', attached: false, last_activity: '2026-06-01T12:00:00Z' },
  }),
  agent({
    name: 'alpha/sleeper',
    rig: 'alpha',
    state: 'asleep',
    running: false,
  }),
  agent({
    name: 'beta/stopped',
    rig: 'beta',
    state: 'failed',
    running: false,
  }),
];

function renderAgents() {
  return render(
    <NowProvider intervalMs={1_000_000}>
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AgentsPage />
      </MemoryRouter>
    </NowProvider>,
  );
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table');
  const body = table.querySelector('tbody');
  if (!body) throw new Error('table has no tbody');
  // Rows that carry an agent (have a link cell). Skip the empty-state row.
  return Array.from(body.querySelectorAll('tr')).filter(
    (tr) => tr.querySelector('a') !== null,
  );
}

beforeEach(() => {
  listAgents.mockResolvedValue({ items: ROSTER });
  listSessions.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('isActivelyRunning', () => {
  it('treats active/running state or running flag as actively running', () => {
    expect(isActivelyRunning(agent({ name: 'a', state: 'active' }))).toBe(true);
    expect(isActivelyRunning(agent({ name: 'a', state: 'running' }))).toBe(true);
    expect(isActivelyRunning(agent({ name: 'a', state: 'asleep', running: true }))).toBe(true);
  });

  it('excludes suspended agents even when otherwise running', () => {
    expect(
      isActivelyRunning(agent({ name: 'a', state: 'active', suspended: true })),
    ).toBe(false);
  });

  it('treats idle/asleep/failed agents as not actively running', () => {
    expect(isActivelyRunning(agent({ name: 'a', state: 'asleep' }))).toBe(false);
    expect(isActivelyRunning(agent({ name: 'a', state: 'failed' }))).toBe(false);
  });
});

describe('AgentsPage', () => {
  it('renders a single flat table with no expandable/group rows', async () => {
    renderAgents();
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(1));
    // No collapsible group headers (those carry a chevron / group toggle).
    expect(screen.queryByRole('button', { name: /toggle|collapse|expand/i })).toBeNull();
  });

  it('has a Rig column with the agent rig value', async () => {
    renderAgents();
    await waitFor(() => screen.getByRole('table'));
    expect(screen.getByRole('columnheader', { name: /rig/i })).toBeTruthy();
    // Active-only default: alpha/worker + beta/worker are visible; their rigs render.
    const table = screen.getByRole('table');
    expect(within(table).getByText('alpha')).toBeTruthy();
    expect(within(table).getByText('beta')).toBeTruthy();
  });

  it('defaults to showing only actively-running agents', async () => {
    renderAgents();
    await waitFor(() => screen.getByRole('table'));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(screen.getByText('alpha/worker')).toBeTruthy();
    expect(screen.getByText('beta/worker')).toBeTruthy();
    expect(screen.queryByText('alpha/sleeper')).toBeNull();
    expect(screen.queryByText('beta/stopped')).toBeNull();
  });

  it('filters the table by rig via the rig dropdown', async () => {
    renderAgents();
    await waitFor(() => screen.getByRole('table'));
    const rigSelect = screen.getByRole('combobox', { name: /rig/i });
    fireEvent.change(rigSelect, { target: { value: 'alpha' } });
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText('alpha/worker')).toBeTruthy();
    expect(screen.queryByText('beta/worker')).toBeNull();
  });

  it('can show all agents (not just running) and sort by rig', async () => {
    renderAgents();
    await waitFor(() => screen.getByRole('table'));
    // Turn off the active-only default so all four rows show.
    const runningToggle = screen.getByRole('checkbox', { name: /running/i });
    fireEvent.click(runningToggle);
    await waitFor(() => expect(bodyRows()).toHaveLength(4));

    // Sort by rig ascending: alpha rows precede beta rows.
    const rigHeader = screen.getByRole('button', { name: /rig/i });
    fireEvent.click(rigHeader);
    const namesAsc = bodyRows().map((r) => r.querySelector('a')?.textContent ?? '');
    const firstBetaIdx = namesAsc.findIndex((n) => n.startsWith('beta'));
    const lastAlphaIdx = namesAsc.map((n) => n.startsWith('alpha')).lastIndexOf(true);
    expect(lastAlphaIdx).toBeLessThan(firstBetaIdx);
  });

  it('sorts by activity', async () => {
    renderAgents();
    await waitFor(() => screen.getByRole('table'));
    // beta/worker has the later last_activity than alpha/worker.
    const activityHeader = screen.getByRole('button', { name: /^last active/i });
    fireEvent.click(activityHeader); // asc
    const namesAsc = bodyRows().map((r) => r.querySelector('a')?.textContent ?? '');
    fireEvent.click(activityHeader); // desc
    const namesDesc = bodyRows().map((r) => r.querySelector('a')?.textContent ?? '');
    expect(namesDesc).toEqual([...namesAsc].reverse());
  });
});
