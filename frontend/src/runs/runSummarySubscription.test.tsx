import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { type RunSummary, type SourceState, type SourceStatus } from 'gas-city-dashboard-shared';
import { invalidateKey } from '../api/cache';
import { setActiveCity } from '../api/cityBase';
import {
  loadSupervisorRunSummaryPreviewSource,
  loadSupervisorRunSummarySource,
} from '../supervisor/runSummary';
import { RunSummaryProvider, useRunSummary } from './runSummarySubscription';

// gascity-dashboard-2j8e.7: the nav badge and the /runs page used to run two
// separate run-summary fan-outs (separate cache keys) and the badge never
// SSE-refreshed, so it double-fetched on /runs and drifted after mount. This
// pins the unification: ONE provider-owned subscription serves every consumer
// (one fan-out) and an SSE event refreshes the source every consumer reads
// (no post-mount drift).

vi.mock('../supervisor/runSummary', () => ({
  loadSupervisorRunSummaryPreviewSource: vi.fn(),
  loadSupervisorRunSummarySource: vi.fn(),
}));

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

const mockPreview = loadSupervisorRunSummaryPreviewSource as Mock;
const mockFull = loadSupervisorRunSummarySource as Mock;

function buildRunSource(
  status: Exclude<SourceStatus, 'error'>,
  blocked = 0,
): SourceState<RunSummary> {
  return {
    source: 'runs',
    status,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    staleAt: '2026-06-01T00:01:00.000Z',
    error: { kind: 'none' },
    data: {
      totalActive: 0,
      totalHistorical: 0,
      historicalLanes: [],
      blockedLanes: [],
      runCounts: {
        total: 0,
        visible: 0,
        prReview: 0,
        designReview: 0,
        bugfix: 0,
        blocked,
        other: 0,
      },
      lanes: [],
      recentChanges: [],
      census: { status: 'unavailable', error: 'run health has not been derived' },
    },
  };
}

// A stand-in for the two real consumers — the nav badge and the /runs page —
// rendering the status + blocked count of the source it reads.
function Consumer({ label }: { label: string }) {
  const { source } = useRunSummary();
  const blocked = source && source.status !== 'error' ? source.data.runCounts.blocked : -1;
  return <div data-testid={label}>{`${source?.status ?? 'pending'}:${blocked}`}</div>;
}

beforeEach(() => {
  setActiveCity('racoon-city');
  mockPreview.mockReset();
  mockFull.mockReset();
  lastHookCall.prefixes = null;
  lastHookCall.onMatch = null;
  invalidateKey('runs:summary:racoon-city');
  mockPreview.mockResolvedValue(buildRunSource('fresh'));
  mockFull.mockResolvedValue(buildRunSource('fresh'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRunSummarySubscription / RunSummaryProvider (gascity-dashboard-2j8e.7)', () => {
  it('serves many consumers from a single fan-out (no double fetch)', async () => {
    render(
      <RunSummaryProvider>
        <Consumer label="badge" />
        <Consumer label="page" />
      </RunSummaryProvider>,
    );

    // One preview paint + one full upgrade for the whole tree, regardless of
    // how many consumers read it — the badge no longer runs its own fan-out.
    await waitFor(() => expect(mockFull).toHaveBeenCalledTimes(1));
    expect(mockPreview).toHaveBeenCalledTimes(1);

    // Both consumers read the same source object → identical render.
    expect(screen.getByTestId('badge').textContent).toBe(screen.getByTestId('page').textContent);
  });

  it('subscribes to bead events once for the whole tree', async () => {
    render(
      <RunSummaryProvider>
        <Consumer label="badge" />
        <Consumer label="page" />
      </RunSummaryProvider>,
    );
    await waitFor(() => expect(mockFull).toHaveBeenCalledTimes(1));
    expect(lastHookCall.prefixes).toEqual(['bead.']);
    expect(typeof lastHookCall.onMatch).toBe('function');
  });

  it('refreshes every consumer on an SSE event (no post-mount drift)', async () => {
    render(
      <RunSummaryProvider>
        <Consumer label="badge" />
        <Consumer label="page" />
      </RunSummaryProvider>,
    );
    await waitFor(() => expect(mockFull).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('badge').textContent).toBe('fresh:0');

    // A bead event lands and the next load carries a newly-blocked run.
    mockFull.mockResolvedValue(buildRunSource('fresh', 1));
    await act(async () => {
      lastHookCall.onMatch?.();
    });

    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('fresh:1'));
    // The page sees the same update in the same pass — they cannot drift apart.
    expect(screen.getByTestId('page').textContent).toBe('fresh:1');
  });

  it('throws when used outside a RunSummaryProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useRunSummary())).toThrow(/RunSummaryProvider/);
    spy.mockRestore();
  });
});
