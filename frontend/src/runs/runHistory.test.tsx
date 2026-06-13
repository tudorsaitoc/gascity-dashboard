import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunHistory, SourceState } from 'gas-city-dashboard-shared';
import { invalidateKey } from '../api/cache';
import { setActiveCity } from '../api/cityBase';
import { loadSupervisorRunHistorySource } from '../supervisor/runSummary';
import { useRunHistory } from './runHistory';

// Header-first restructure: the /runs history section loads lazily. The hook
// must fetch the expensive closed-history fan-out ONLY when the section is
// opened — never as a side effect of the page being mounted — and reuse the
// cached payload across toggles so reopening is instant.

vi.mock('../supervisor/runSummary', () => ({
  loadSupervisorRunHistorySource: vi.fn(),
}));

const mockLoadHistory = loadSupervisorRunHistorySource as Mock;

function historySource(total = 1): SourceState<RunHistory> {
  return {
    source: 'runs',
    status: 'fresh',
    fetchedAt: '2026-06-01T12:00:00.000Z',
    staleAt: '2026-06-01T12:01:00.000Z',
    error: { kind: 'none' },
    data: {
      totalHistorical: total,
      lanes: [],
    },
  };
}

beforeEach(() => {
  setActiveCity('racoon-city');
  invalidateKey('runs:history:racoon-city');
  mockLoadHistory.mockReset();
  mockLoadHistory.mockResolvedValue(historySource());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useRunHistory — lazy load on the history toggle (header-first)', () => {
  it('does not fetch while the history section is closed', async () => {
    renderHook(() => useRunHistory(false));

    // Give any stray effect a tick to fire.
    await act(async () => {});
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it('fetches once when the section opens and publishes the payload', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useRunHistory(enabled), {
      initialProps: { enabled: false },
    });
    expect(result.current.source).toBeUndefined();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockLoadHistory).toHaveBeenCalledTimes(1);
    expect(mockLoadHistory).toHaveBeenCalledWith({ forceFresh: false });
    expect(result.current.source?.status).toBe('fresh');
    if (result.current.source?.status !== 'fresh') throw new Error('expected fresh source');
    expect(result.current.source.data.totalHistorical).toBe(1);
  });

  it('reuses the cached payload across close/reopen (no refetch)', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useRunHistory(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.source?.status).toBe('fresh'));

    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {});

    expect(mockLoadHistory).toHaveBeenCalledTimes(1);
    expect(result.current.source?.status).toBe('fresh');
  });

  it('does not start a second fan-out when reopened before the first load resolves', async () => {
    // The first history read is the heaviest fan-out in the view (molecule scan
    // + per-rig all=true reads, the latter not proxy-cached). While it is in
    // flight the cache is still empty, so a closed -> open toggle re-enters the
    // lazy edge; without an in-flight guard it would fire a second copy. The
    // guard holds until the first read resolves and populates the cache.
    let resolveFirst!: (value: SourceState<RunHistory>) => void;
    const pendingFirst = new Promise<SourceState<RunHistory>>((resolve) => {
      resolveFirst = resolve;
    });
    mockLoadHistory.mockReset();
    mockLoadHistory.mockReturnValue(pendingFirst);

    const { rerender } = renderHook(({ enabled }) => useRunHistory(enabled), {
      initialProps: { enabled: true },
    });
    await act(async () => {});
    expect(mockLoadHistory).toHaveBeenCalledTimes(1);

    // Close and reopen while the first read is still pending (cache empty).
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {});
    expect(mockLoadHistory).toHaveBeenCalledTimes(1);

    // Once the first read resolves and caches its payload, a reopen serves the
    // cache — still exactly one fan-out.
    await act(async () => {
      resolveFirst(historySource(2));
      await pendingFirst;
    });
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {});
    expect(mockLoadHistory).toHaveBeenCalledTimes(1);
  });

  it('refresh() refetches and threads forceFresh through to the loader', async () => {
    const { result } = renderHook(() => useRunHistory(true));
    await waitFor(() => expect(result.current.source?.status).toBe('fresh'));

    mockLoadHistory.mockResolvedValue(historySource(7));
    await act(async () => {
      await result.current.refresh({ forceFresh: true });
    });

    expect(mockLoadHistory).toHaveBeenLastCalledWith({ forceFresh: true });
    if (result.current.source?.status !== 'fresh') throw new Error('expected fresh source');
    expect(result.current.source.data.totalHistorical).toBe(7);
  });

  it('keeps the last-good payload as stale when a refresh fails (no blank on transient timeout)', async () => {
    const { result } = renderHook(() => useRunHistory(true));
    await waitFor(() => expect(result.current.source?.status).toBe('fresh'));

    mockLoadHistory.mockResolvedValue({
      source: 'runs',
      status: 'error',
      error: 'gc supervisor request timed out after 30000ms',
    } satisfies SourceState<RunHistory>);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.source?.status).toBe('stale');
    if (result.current.source === undefined || result.current.source.status === 'error') {
      throw new Error('expected retained data');
    }
    expect(result.current.source.data.totalHistorical).toBe(1);
  });

  it('surfaces a first-load error and retries when the section is reopened', async () => {
    mockLoadHistory.mockResolvedValue({
      source: 'runs',
      status: 'error',
      error: 'formula run history unavailable',
    } satisfies SourceState<RunHistory>);

    const { result, rerender } = renderHook(({ enabled }) => useRunHistory(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.source?.status).toBe('error'));

    // An error payload is NOT cached, so closing and reopening retries the load
    // instead of latching the section dead.
    mockLoadHistory.mockResolvedValue(historySource(3));
    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.source?.status).toBe('fresh'));
    expect(mockLoadHistory).toHaveBeenCalledTimes(2);
  });

  it('a rejected loader publishes an error source rather than throwing', async () => {
    mockLoadHistory.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useRunHistory(true));

    await waitFor(() => expect(result.current.source?.status).toBe('error'));
    if (result.current.source?.status !== 'error') throw new Error('expected error source');
    expect(result.current.source.error).toBe('network down');
  });

  it('drops an in-flight response once the active city changed (no cross-city contamination)', async () => {
    // The hook keys its cache off getActiveCity(); a fetch started under city-a
    // must never publish under city-b if the operator switches mid-flight. The
    // stale-response guard keys on the captured cache key, and the city-change
    // reseed re-reads city-b's own (empty) cache.
    let resolveCityA!: (value: SourceState<RunHistory>) => void;
    const pendingCityA = new Promise<SourceState<RunHistory>>((resolve) => {
      resolveCityA = resolve;
    });
    const pendingCityB = new Promise<SourceState<RunHistory>>(() => {
      // city-b's own load stays in flight, isolating the guard under test.
    });

    setActiveCity('city-a');
    invalidateKey('runs:history:city-a');
    invalidateKey('runs:history:city-b');
    mockLoadHistory.mockReset();
    mockLoadHistory.mockReturnValueOnce(pendingCityA).mockReturnValue(pendingCityB);

    const { result, rerender } = renderHook(({ enabled }) => useRunHistory(enabled), {
      initialProps: { enabled: true },
    });
    // city-a's fetch is in flight; nothing published yet.
    await act(async () => {});
    expect(result.current.source).toBeUndefined();

    // Operator switches to city-b before city-a's response lands; the reseed
    // re-reads city-b's empty cache and the lazy edge fires city-b's own fetch.
    setActiveCity('city-b');
    rerender({ enabled: true });
    await act(async () => {});
    expect(mockLoadHistory).toHaveBeenCalledTimes(2);

    // city-a's request finally resolves — it must be dropped, not shown under
    // city-b.
    await act(async () => {
      resolveCityA(historySource(99));
      await pendingCityA;
    });

    expect(result.current.source).toBeUndefined();
  });
});
