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
});
