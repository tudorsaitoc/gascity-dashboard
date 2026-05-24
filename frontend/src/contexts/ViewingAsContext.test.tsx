import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useEffect } from 'react';
import { ViewingAsProvider, useViewingAs } from './ViewingAsContext';

// gascity-dashboard-5gg: bounded retry for /api/sessions in the alias
// prefetch. Tests cover:
//
//   1. Initial fetch failure flips sessionsUnavailable=true.
//   2. Three retries are scheduled at 30s, 90s, 270s after each prior
//      failure; no retry fires earlier.
//   3. A successful retry flips sessionsUnavailable back to false.
//   4. After the third failed retry, no further attempts are made
//      (sticky failure matches current behaviour).
//   5. Unmounting between retries cancels the pending timer (no late
//      state updates, no leaked timeouts).
//
// We mock `../api/client` so listSessions/listMail return shaped
// promises under our control. listMail is not retried — only sessions
// has the bounded retry.

vi.mock('../api/client', () => ({
  api: {
    listSessions: vi.fn(),
    listMail: vi.fn(),
  },
  ApiClientError: class extends Error {},
}));

// Import the mocked module after the mock so we get the vi.fn() references.
// eslint-disable-next-line import/first
import { api } from '../api/client';

const mockListSessions = api.listSessions as Mock;
const mockListMail = api.listMail as Mock;

interface Probe {
  sessionsUnavailable: boolean;
  aliasesLoading: boolean;
}

function Harness({ onState }: { onState: (p: Probe) => void }) {
  const { sessionsUnavailable, aliasesLoading, loadAliases } = useViewingAs();
  useEffect(() => {
    loadAliases();
  }, [loadAliases]);
  useEffect(() => {
    onState({ sessionsUnavailable, aliasesLoading });
  }, [sessionsUnavailable, aliasesLoading, onState]);
  return null;
}

async function flushPromises() {
  // Vitest fake timers don't drain microtasks; wrap a real-clock yield
  // so awaited `.then()` callbacks on resolved promises run.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockListSessions.mockReset();
  mockListMail.mockReset();
  // Mail fetch is uninteresting for these tests; resolve to empty.
  mockListMail.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ViewingAsProvider — bounded sessions retry', () => {
  it('flips sessionsUnavailable=true on initial /api/sessions failure', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    const states: Probe[] = [];
    render(
      <ViewingAsProvider>
        <Harness onState={(p) => states.push(p)} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(states.at(-1)?.sessionsUnavailable).toBe(true);
  });

  it('does not retry before the 30s mark', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);
    // Advance just under the first retry window.
    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('retries at 30s, 90s, and 270s after successive failures', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    // First retry at 30s.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(2);

    // Second retry at 30s + 90s.
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(3);

    // Third retry at 30s + 90s + 270s.
    await act(async () => {
      vi.advanceTimersByTime(270_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(4);
  });

  it('flips sessionsUnavailable=false when a retry succeeds', async () => {
    mockListSessions
      .mockRejectedValueOnce(new Error('upstream 504'))
      .mockResolvedValueOnce({ items: [{ alias: 'mechanic' }] });

    const states: Probe[] = [];
    render(
      <ViewingAsProvider>
        <Harness onState={(p) => states.push(p)} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(states.at(-1)?.sessionsUnavailable).toBe(true);

    // First retry at 30s — succeeds this time.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(states.at(-1)?.sessionsUnavailable).toBe(false);
  });

  it('stops retrying after the third failed attempt (sticky failure)', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    // Exhaust all three retries.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(270_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(4); // initial + 3 retries

    // No further calls even after a long quiet period.
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(4);
  });

  it('cancels pending retry on unmount (no late /api/sessions call)', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    const { unmount } = render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    // Unmount before the 30s retry window elapses.
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });
});
