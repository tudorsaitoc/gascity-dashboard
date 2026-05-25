import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// gascity-dashboard-bqn: regression coverage for the live-updates wiring
// on /workflows. The actual SSE / coalesce / reconnect behavior lives in
// useGcEventRefresh (untested today — separate follow-up bead). These
// tests pin Workflows.tsx's contract with that hook + with the api
// client's bypass-TTL refresh path.
//
// What's pinned here:
//   - useGcEventRefresh is called with ['bead.'] and a function.
//   - <SseIndicator state={...} /> renders inside PageHeader meta.
//   - The manual Refresh button calls api.snapshotRefresh(['workflows']),
//     NOT api.snapshot() — fixes the pre-existing bug where the button
//     served stale data within the backend's 60s WORKFLOWS_CACHE_TTL_MS.
//   - A burst of synthetic SSE matches within the in-component debounce
//     window produces AT MOST one snapshotRefresh call (architect H2
//     upstream-load protection).
//   - The SSE callback no-ops when workflows.status !== 'fresh' so
//     fixture-fallback mode isn't hammered (architect H1).

vi.mock('../api/client', () => ({
  api: {
    snapshot: vi.fn(),
    snapshotRefresh: vi.fn(),
  },
  ApiClientError: class extends Error {},
}));

// Capture the prefixes + onMatch passed to useGcEventRefresh so each
// test can fire synthetic events into Workflows' callback directly.
// Bypasses real EventSource — the hook's own coalesce / reconnect is
// not under test here.
const lastHookCall: { prefixes: ReadonlyArray<string> | null; onMatch: (() => void) | null } = {
  prefixes: null,
  onMatch: null,
};
vi.mock('../hooks/useGcEvents', () => ({
  useGcEventRefresh: vi.fn((prefixes: ReadonlyArray<string>, onMatch: () => void) => {
    lastHookCall.prefixes = prefixes;
    lastHookCall.onMatch = onMatch;
    return 'open' as const;
  }),
}));

import { api } from '../api/client';
import { invalidateKey } from '../api/cache';
import { WorkflowsPage } from './Workflows';
import type { DashboardSnapshot, SourceStatus } from 'gas-city-dashboard-shared';

const mockSnapshot = api.snapshot as Mock;
const mockSnapshotRefresh = api.snapshotRefresh as Mock;

function buildEnvelope(workflowsStatus: SourceStatus = 'fresh'): DashboardSnapshot {
  return {
    generatedAt: '2026-05-25T00:00:00.000Z',
    config: {
      cityName: 'racoon-city',
      cityRoot: '/tmp/example-city',
      githubRepo: 'example-org/example-repo',
      useFixtures: false,
    },
    headline: {
      activeAgents: null,
      maxAgents: null,
      activeSessions: null,
      activeWorkflows: 0,
      githubOpenReviews: null,
    },
    sources: {
      aimux: { source: 'aimux', status: 'fixture', fetchedAt: null, staleAt: null, error: null, data: null },
      city: { source: 'city', status: 'fixture', fetchedAt: null, staleAt: null, error: null, data: null },
      resources: { source: 'resources', status: 'fixture', fetchedAt: null, staleAt: null, error: null, data: null },
      workflows: {
        source: 'workflows',
        status: workflowsStatus,
        fetchedAt: '2026-05-25T00:00:00.000Z',
        staleAt: '2026-05-25T00:01:00.000Z',
        error: null,
        data: { totalActive: 0, runCounts: { total: 0, visible: 0, prReview: 0, designReview: 0, bugfix: 0, blocked: 0, other: 0 }, lanes: [], recentChanges: [], census: null },
      },
      github: { source: 'github', status: 'fixture', fetchedAt: null, staleAt: null, error: null, data: null },
      tokens: { source: 'tokens', status: 'fixture', fetchedAt: null, staleAt: null, error: null, data: null },
    },
  };
}

beforeEach(() => {
  mockSnapshot.mockReset();
  mockSnapshotRefresh.mockReset();
  lastHookCall.prefixes = null;
  lastHookCall.onMatch = null;
  invalidateKey('snapshot');
  mockSnapshot.mockResolvedValue(buildEnvelope('fresh'));
  mockSnapshotRefresh.mockResolvedValue(buildEnvelope('fresh'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount() {
  return render(
    <MemoryRouter
      initialEntries={['/workflows']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <WorkflowsPage />
    </MemoryRouter>,
  );
}

async function waitForMount() {
  // Wait until the Refresh button mounts AND becomes enabled (loading
  // flips back to false after the initial fetcher resolves). Using the
  // disabled-to-enabled transition rather than text presence keeps the
  // wait stable across copy changes and avoids substring collisions
  // (the page renders both "Active" in CountsHeader and "active
  // workflows" in the synopsis line).
  const btn = (await screen.findByRole('button', { name: /refresh/i })) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
}

describe('WorkflowsPage — SSE wiring (gascity-dashboard-bqn)', () => {
  it('subscribes to useGcEventRefresh with [bead.] prefix', async () => {
    mount();
    await waitForMount();
    expect(lastHookCall.prefixes).toEqual(['bead.']);
    expect(typeof lastHookCall.onMatch).toBe('function');
  });

  it('renders the SseIndicator in PageHeader meta', async () => {
    mount();
    await waitForMount();
    // SseIndicator with state='open' renders a StatusBadge with label 'live'.
    expect(screen.getByText(/^live$/i)).toBeTruthy();
  });

  it('manual Refresh button calls api.snapshotRefresh([workflows]), not api.snapshot()', async () => {
    mount();
    await waitForMount();
    // Reset to ignore the mount-effect call.
    mockSnapshot.mockClear();
    mockSnapshotRefresh.mockClear();

    const btn = screen.getByRole('button', { name: /refresh/i }) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });

    expect(mockSnapshotRefresh).toHaveBeenCalledTimes(1);
    expect(mockSnapshotRefresh).toHaveBeenCalledWith(['workflows']);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('coalesces a burst of SSE matches to AT MOST one snapshotRefresh within the debounce window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await waitForMount();
    mockSnapshotRefresh.mockClear();

    // Simulate a busy slung pipeline: 5 onMatch calls within 1s. The
    // 10s in-component debounce floor must collapse this to a single
    // upstream POST. (useGcEventRefresh's own 2.5s coalesce sits in
    // front of onMatch in production; this test exercises ONLY the
    // Workflows-side debounce we added per architect H2.)
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        lastHookCall.onMatch?.();
        await vi.advanceTimersByTimeAsync(50);
      }
    });

    // Within the 10s window, exactly one (the leading edge) fires.
    // `toBe(1)` rather than `toBeLessThanOrEqual(1)` so a regression
    // that suppresses the leading edge entirely (count would be 0) is
    // caught loudly.
    expect(mockSnapshotRefresh.mock.calls.length).toBe(1);
  });

  it('fires a second snapshotRefresh once the debounce window elapses', async () => {
    // Pins the trailing edge of the in-component debounce. The burst
    // test above proves we collapse a flurry to one POST; this test
    // proves we DON'T accidentally latch the gate shut forever. If a
    // future refactor drops the `lastRefreshAtRef.current = Date.now()`
    // reset (or fails to clear it on error), the second event would be
    // silently swallowed and the page would stop receiving live updates
    // until full reload. Catch that loudly here.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await waitForMount();
    mockSnapshotRefresh.mockClear();

    // Leading edge: one event, one POST.
    await act(async () => {
      lastHookCall.onMatch?.();
    });
    expect(mockSnapshotRefresh.mock.calls.length).toBe(1);

    // Advance past the 10s debounce floor (REFRESH_DEBOUNCE_MS = 10_000
    // in Workflows.tsx; +100ms cushion so we're unambiguously past it).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });

    // Second event after the window must fire a second POST.
    await act(async () => {
      lastHookCall.onMatch?.();
    });
    expect(mockSnapshotRefresh.mock.calls.length).toBe(2);
  });

  it('SSE callback no-ops when workflows source status is not fresh', async () => {
    // First load returns a fixture-status envelope (gc supervisor is
    // down, snapshot is serving committed fixtures). SSE-driven force
    // refresh must NOT fire in this state — otherwise we hammer
    // loadFixture every coalesce-tick during a gc outage.
    mockSnapshot.mockResolvedValue(buildEnvelope('fixture'));
    mount();
    await waitForMount();
    mockSnapshotRefresh.mockClear();

    await act(async () => {
      lastHookCall.onMatch?.();
    });

    expect(mockSnapshotRefresh).not.toHaveBeenCalled();
  });
});
