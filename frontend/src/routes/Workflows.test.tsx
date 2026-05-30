import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  DashboardSnapshot,
  SourceStatus,
  WorkflowLane,
} from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { invalidateKey } from '../api/cache';
import { WorkflowsPage } from './Workflows';
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

const mockSnapshot = api.snapshot as Mock;
const mockSnapshotRefresh = api.snapshotRefresh as Mock;

function buildEnvelope(
  workflowsStatus: Exclude<SourceStatus, 'error'> = 'fresh',
): DashboardSnapshot {
  return {
    generatedAt: '2026-05-25T00:00:00.000Z',
    config: {
      cityName: 'racoon-city',
      cityRoot: '/tmp/example-city',
      useFixtures: false,
      enabledModules: null,
      defaultView: null,
    },
    headline: {
      activeAgents: { status: 'unavailable', source: 'city', error: 'city unavailable in test' },
      maxAgents: { status: 'unavailable', source: 'city', error: 'city unavailable in test' },
      activeSessions: { status: 'unavailable', source: 'city', error: 'city unavailable in test' },
      activeWorkflows: { status: 'available', value: 0 },
    },
    sources: {
      city: { source: 'city', status: 'error', error: 'city unavailable in test' },
      resources: { source: 'resources', status: 'error', error: 'resources unavailable in test' },
      workflows: {
        source: 'workflows',
        status: workflowsStatus,
        fetchedAt: '2026-05-25T00:00:00.000Z',
        staleAt: '2026-05-25T00:01:00.000Z',
        error: { kind: 'none' },
        data: {
          totalActive: 0,
          totalHistorical: 0,
          historicalLanes: [],
          runCounts: {
            total: 0,
            visible: 0,
            prReview: 0,
            designReview: 0,
            bugfix: 0,
            blocked: 0,
            other: 0,
          },
          lanes: [],
          recentChanges: [],
          census: { status: 'unavailable', error: 'workflow health has not been derived' },
        },
      },
    },
  };
}

function completedLane(): WorkflowLane {
  return {
    id: 'done-root',
    title: 'Completed formula run',
    formula: { status: 'known', name: 'mol-adopt-pr-v2' },
    scope: {
      status: 'available',
      kind: 'city',
      ref: 'racoon-city',
      rootStoreRef: 'city:racoon-city',
    },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'complete',
    phaseLabel: 'complete',
    statusCounts: { closed: 2 },
    activeAssignees: [],
    updatedAt: { status: 'available', at: '2026-05-27T22:01:00Z' },
    stages: [
      { key: 'intake', label: 'Intake', status: 'complete' },
      { key: 'implementation', label: 'Implementation', status: 'complete' },
      { key: 'review', label: 'Review', status: 'complete' },
      { key: 'approval', label: 'Approval', status: 'complete' },
      { key: 'finalization', label: 'Finalization', status: 'complete' },
    ],
    progress: {
      status: 'stage_only',
      stage: {
        status: 'available',
        index: 4,
        key: 'finalization',
        label: 'Finalization',
      },
      error: 'active workflow step unavailable',
    },
    formulaStageResolved: false,
    health: {
      status: 'available',
      data: {
        phaseConfidence: 'known',
        needsOperator: false,
        stuckNode: { status: 'unavailable', error: 'workflow stuck node unavailable' },
        thrashingDetected: false,
        session: { status: 'unresolved', error: 'workflow session unresolved' },
      },
    },
  };
}

function requireWorkflowData(envelope: DashboardSnapshot) {
  const workflows = envelope.sources.workflows;
  if (workflows.status === 'error') {
    throw new Error(workflows.error);
  }
  return workflows.data;
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

function mount(initialPath = '/workflows') {
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
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

  it('does not flatten an unavailable workflow count into zero', async () => {
    const envelope = buildEnvelope('fresh');
    envelope.headline.activeWorkflows = {
      status: 'unavailable',
      source: 'workflows',
      error: 'workflow collector unavailable in test',
    };
    mockSnapshot.mockResolvedValue(envelope);

    mount();
    await waitForMount();

    expect(
      screen.getByText(/Workflow counts unavailable: workflow collector unavailable in test/i),
    ).toBeTruthy();
    expect(screen.queryByText(/^0 active workflows/i)).toBeNull();
  });

  // yh5i: completed lanes now land in historicalLanes (toggle-visible),
  // not the default-visible `lanes`. The test below pins the new contract;
  // see the toggle tests further down for the ?history=1 reveal path.
  it('yh5i: hides completed workflow runs from default view, shows them under ?history=1', async () => {
    const envelope = buildEnvelope('fresh');
    const lane = completedLane();
    const workflows = requireWorkflowData(envelope);
    envelope.headline.activeWorkflows = { status: 'available', value: 0 };
    workflows.totalActive = 0;
    workflows.totalHistorical = 1;
    workflows.lanes = [];
    workflows.historicalLanes = [lane];
    workflows.census = {
      status: 'available',
      data: {
        byPhase: {
          intake: 0,
          implementation: 0,
          review: 0,
          approval: 0,
          finalization: 0,
          blocked: 0,
          complete: 1,
          active: 0,
        },
        totalInFlight: 0,
        unverifiable: 0,
        knownDenominator: 0,
        thrashing: 0,
      },
    };
    mockSnapshot.mockResolvedValue(envelope);

    // Default view (/workflows): historical lane is hidden, empty-state
    // trailer hints at the count.
    mount();
    await waitForMount();
    expect(screen.queryByText('Completed formula run')).toBeNull();
    expect(
      screen.getByText(/No active workflow runs\. \(1 completed\.\)/i),
    ).toBeTruthy();
    // The toggle button is enabled (totalHistorical > 0) and labeled
    // with the count.
    const toggleDefault = screen.getByRole('button', { name: /show 1 completed/i }) as HTMLButtonElement;
    expect(toggleDefault.disabled).toBe(false);
    expect(toggleDefault.getAttribute('aria-expanded')).toBe('false');
    cleanup();

    // History view (?history=1): the historical section renders the lane.
    mount('/workflows?history=1');
    await waitForMount();
    expect(screen.getByText('Completed formula run')).toBeTruthy();
    const toggleHistory = screen.getByRole('button', { name: /hide historical/i }) as HTMLButtonElement;
    expect(toggleHistory.getAttribute('aria-expanded')).toBe('true');
    expect(toggleHistory.getAttribute('aria-controls')).toBeTruthy();
  });

  it('yh5i: toggle button is disabled when totalHistorical is 0', async () => {
    // Default envelope has totalHistorical = 0.
    mount();
    await waitForMount();
    const toggle = screen.getByRole('button', {
      name: /no completed workflow runs in the current window/i,
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // aria-controls must NOT reference a non-existent DOM id when the
    // historical section is not rendered (WAI-ARIA spec).
    expect(toggle.getAttribute('aria-controls')).toBeNull();
  });

  it('yh5i: toggle stays enabled when showHistory=true even if totalHistorical drops to 0', async () => {
    // Reachable via back-button + SSE refresh: URL has ?history=1 but the
    // last historical lane has since rolled out. The user must still be
    // able to dismiss the historical section.
    mount('/workflows?history=1');
    await waitForMount();
    const toggle = screen.getByRole('button', { name: /hide historical/i }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(screen.getByText(/No completed runs in the current window/i)).toBeTruthy();
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
