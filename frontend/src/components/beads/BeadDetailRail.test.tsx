import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EntityLinkView,
  GcBead,
  GcSession,
} from 'gas-city-dashboard-shared';
import { BeadDetailRail } from './BeadDetailRail';

// useBeadDetail and useEntityLinks both call the api client; mock it so the
// rail renders without a backend. getBead is never hit when initialBead
// carries a description (the freshness signal), but entityLinks always fires.
vi.mock('../../api/client', () => ({
  api: {
    getBead: vi.fn(),
    entityLinks: vi.fn(
      (ref: string): Promise<EntityLinkView> =>
        Promise.resolve({
          focus: { key: `bead:c:${ref}`, type: 'bead', ref },
          nodes: [],
          edges: [],
          stats: [],
          partial: false,
          generatedAt: '2026-05-31T00:00:00Z',
          asOf: '2026-05-31T00:00:00Z',
        }),
    ),
  },
  ApiClientError: class extends Error {},
}));

afterEach(() => cleanup());

function bead(extra: Partial<GcBead> = {}): GcBead {
  return {
    id: 'b1',
    title: 'judge live smoke',
    status: 'in_progress',
    issue_type: 'task',
    priority: null,
    created_at: '2026-05-01T00:00:00Z',
    description: 'do the thing',
    ...extra,
  };
}

function session(extra: Partial<GcSession> = {}): GcSession {
  return {
    id: 'gc-abc',
    template: 't',
    session_name: 'worker__gasworks',
    title: 'worker',
    state: 'active',
    created_at: '2026-05-01T00:00:00Z',
    attached: false,
    running: true,
    provider: 'claude',
    ...extra,
  };
}

describe('BeadDetailRail', () => {
  it('prompts to select a bead when none is chosen', () => {
    render(
      <BeadDetailRail
        beadId={null}
        initialBead={null}
        sessions={[]}
        onOpenBead={vi.fn()}
      />,
    );
    expect(screen.getByText(/select a bead/i)).toBeTruthy();
  });

  it('offers a live-run click-through when the assignee resolves to a streamable session', async () => {
    const b = bead({ assignee: 'gasworks' });
    render(
      <BeadDetailRail
        beadId="b1"
        initialBead={b}
        sessions={[session({ pool: 'gasworks' })]}
        onOpenBead={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/view live run/i)).toBeTruthy(),
    );
  });

  it('omits the live-run affordance when no session matches the assignee', async () => {
    const b = bead({ assignee: 'nobody' });
    render(
      <BeadDetailRail
        beadId="b1"
        initialBead={b}
        sessions={[session({ pool: 'gasworks' })]}
        onOpenBead={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('judge live smoke')).toBeTruthy());
    expect(screen.queryByText(/view live run/i)).toBeNull();
  });

  it('omits the live-run affordance when the matched session is not streamable', async () => {
    const b = bead({ assignee: 'gasworks' });
    render(
      <BeadDetailRail
        beadId="b1"
        initialBead={b}
        sessions={[session({ pool: 'gasworks', state: 'exited', running: false })]}
        onOpenBead={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('judge live smoke')).toBeTruthy());
    expect(screen.queryByText(/view live run/i)).toBeNull();
  });
});
