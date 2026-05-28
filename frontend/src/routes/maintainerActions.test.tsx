import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { MaintainerTriage } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { setCached } from '../api/cache';
import { reportClientError } from '../lib/clientErrorReporting';
import {
  MAINTAINER_CACHE_KEY,
  useMaintainerEventRefresh,
  useMaintainerRefreshAction,
} from './maintainerActions';

vi.mock('../api/client', () => ({
  api: {
    maintainerRefresh: vi.fn(),
    maintainerSling: vi.fn(),
  },
}));

vi.mock('../api/cache', () => ({
  setCached: vi.fn(),
}));

vi.mock('../lib/clientErrorReporting', () => ({
  reportClientError: vi.fn(),
}));

const mockMaintainerRefresh = api.maintainerRefresh as Mock;
const mockSetCached = setCached as Mock;
const mockReportClientError = reportClientError as Mock;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readyState = 1;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  fail(): void {
    this.onerror?.();
  }
}

describe('useMaintainerEventRefresh', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    mockReportClientError.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes on maintainer SSE events and reports stream errors', async () => {
    const refresh = vi.fn(async () => {});
    const { unmount } = renderHook(() => useMaintainerEventRefresh(refresh));
    const source = FakeEventSource.instances[0];

    expect(source?.url).toBe('/api/maintainer/events');
    act(() => {
      source?.emit('refreshed');
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    act(() => {
      source?.fail();
    });
    expect(mockReportClientError).toHaveBeenCalledWith({
      component: 'MaintainerPage',
      operation: 'maintainerEvents',
      message: 'event stream error, readyState 1',
    });

    unmount();
    expect(source?.closed).toBe(true);
  });
});

describe('useMaintainerRefreshAction', () => {
  beforeEach(() => {
    mockMaintainerRefresh.mockReset();
    mockSetCached.mockReset();
    mockReportClientError.mockReset();
  });

  it('writes fresh triage data into the cache and then refreshes the page data', async () => {
    const fresh = { repo: 'gastownhall/gascity' } as MaintainerTriage;
    mockMaintainerRefresh.mockResolvedValue(fresh);
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useMaintainerRefreshAction(refresh));

    await act(async () => {
      await result.current.handleRefresh();
    });

    expect(mockSetCached).toHaveBeenCalledWith(MAINTAINER_CACHE_KEY, fresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
  });

  it('surfaces and reports refresh failures', async () => {
    mockMaintainerRefresh.mockRejectedValue(new Error('gh failed'));
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useMaintainerRefreshAction(refresh));

    await act(async () => {
      await result.current.handleRefresh();
    });

    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBe('gh failed');
    expect(refresh).not.toHaveBeenCalled();
    expect(mockReportClientError).toHaveBeenCalledWith({
      component: 'MaintainerPage',
      operation: 'maintainerRefresh',
      message: 'gh failed',
    });
  });
});
