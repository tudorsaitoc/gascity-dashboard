import { useEffect, useState } from 'react';
import { errorMessage } from 'gas-city-dashboard-shared';

export type AbortableVisibleRefreshState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; data: T; refreshing: boolean; error: string };

export interface UseAbortableVisibleRefreshOptions<T> {
  enabled: boolean;
  intervalMs: number;
  load: (signal: AbortSignal) => Promise<T>;
  formatError?: (err: unknown) => string;
}

export function useAbortableVisibleRefresh<T>({
  enabled,
  intervalMs,
  load,
  formatError,
}: UseAbortableVisibleRefreshOptions<T>): AbortableVisibleRefreshState<T> {
  const [state, setState] = useState<AbortableVisibleRefreshState<T>>({ status: 'idle' });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    let controller = new AbortController();

    const tick = async () => {
      controller.abort();
      controller = new AbortController();
      const localController = controller;
      setState((prev) => {
        if (prev.status === 'ready') {
          return { ...prev, refreshing: true, error: '' };
        }
        return { status: 'loading' };
      });

      try {
        const data = await load(localController.signal);
        if (cancelled || localController.signal.aborted) return;
        setState({ status: 'ready', data, refreshing: false, error: '' });
      } catch (err) {
        if (cancelled || localController.signal.aborted) return;
        const error = formatError ? formatError(err) : errorMessage(err);
        setState((prev) => {
          if (prev.status === 'ready') {
            return { ...prev, refreshing: false, error };
          }
          return { status: 'failed', error };
        });
      }
    };

    void tick();
    const interval = window.setInterval(() => {
      if (!document.hidden) void tick();
    }, intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [enabled, intervalMs, load, formatError]);

  return state;
}
