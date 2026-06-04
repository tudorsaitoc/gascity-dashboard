import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkInFlight } from './WorkInFlight';
import { NowProvider } from '../contexts/NowContext';
import type { SupervisorBead } from '../supervisor/beadReads';
import type { SupervisorSession } from '../supervisor/sessionReads';

// The Work-in-flight section is driven by the IN-PROGRESS beads joined to their
// live worker session via the session id embedded in the assignee. These tests
// use the real verified examples as fixtures (see shared/work-in-flight.ts).

function bead(partial: Partial<SupervisorBead> & { id: string }): SupervisorBead {
  return {
    title: `title for ${partial.id}`,
    status: 'in_progress',
    issue_type: 'task',
    created_at: '2026-06-03T00:00:00Z',
    ...partial,
  } as SupervisorBead;
}

function session(partial: Partial<SupervisorSession> & { id: string }): SupervisorSession {
  return {
    template: 'worker',
    session_name: partial.id,
    title: partial.id,
    state: 'active',
    created_at: '2026-06-03T00:00:00Z',
    attached: false,
    running: true,
    provider: 'claude',
    ...partial,
  } as SupervisorSession;
}

function renderSection(
  beads: SupervisorBead[],
  sessions: SupervisorSession[],
) {
  return render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <NowProvider intervalMs={1_000_000}>
        <WorkInFlight beads={beads} sessions={sessions} />
      </NowProvider>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('WorkInFlight', () => {
  it('renders a clean "<rig> · <role>" label, bead id + title, and live session state', () => {
    const beads = [bead({ id: 'gc-5rarj', title: 'fix the thing', assignee: 'polecat-gc-335825' })];
    const sessions = [session({ id: 'gc-335825', rig: '/home/ds/gascity', state: 'active' })];
    renderSection(beads, sessions);

    const link = screen.getByRole('link', { name: /gc-5rarj/ });
    // Worker label is cleaned: rig basename + role (no path, no -gc suffix).
    expect(link.textContent).toContain('gascity · polecat');
    expect(link.textContent).toContain('gc-5rarj');
    expect(link.textContent).toContain('fix the thing');
    // Live session state badge present.
    expect(screen.getByText('active')).toBeTruthy();
    // Links to the bead board with the bead pre-selected.
    expect(link.getAttribute('href')).toBe('/beads?bead=gc-5rarj');
  });

  it('strips a -main rig suffix in the worker label (gascity-main → gascity)', () => {
    const beads = [bead({ id: 'gc-1', assignee: 'polecat-gc-2222' })];
    const sessions = [session({ id: 'gc-2222', rig: '/home/ds/gascity-main' })];
    renderSection(beads, sessions);
    expect(screen.getByRole('link', { name: /gc-1/ }).textContent).toContain('gascity · polecat');
  });

  it('orders rows by most-recent session activity first', () => {
    const beads = [
      bead({ id: 'older-1', assignee: 'polecat-gc-100' }),
      bead({ id: 'newer-2', assignee: 'worker-gc-200' }),
    ];
    const sessions = [
      session({ id: 'gc-100', rig: 'gascity', last_active: '2026-06-03T10:00:00Z' }),
      session({ id: 'gc-200', rig: 'scix', last_active: '2026-06-03T11:00:00Z' }),
    ];
    renderSection(beads, sessions);
    const links = screen.getAllByRole('link');
    expect(links[0]?.textContent).toContain('newer-2');
    expect(links[1]?.textContent).toContain('older-1');
  });

  it('degrades gracefully when the embedded session id does not resolve (keeps the row)', () => {
    const beads = [bead({ id: 'EnterpriseBench-mda', assignee: 'enterprisebench-worker-gc-335808' })];
    renderSection(beads, []); // no live session for gc-335808
    const link = screen.getByRole('link', { name: /EnterpriseBench-mda/ });
    // Falls back to the bead-derived rig + parsed role; no live state badge.
    expect(link.textContent).toContain('EnterpriseBench · enterprisebench-worker');
    expect(screen.getByText(/no live session/i)).toBeTruthy();
  });

  it('shows a calm empty state when nothing is in flight', () => {
    const beads = [bead({ id: 'open-1', status: 'open', assignee: 'polecat-gc-1' })];
    renderSection(beads, []);
    expect(screen.getByText('Nothing is in flight right now.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
