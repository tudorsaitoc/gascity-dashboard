import { useEffect, useRef } from 'react';

export interface VisibleIntervalOptions {
  enabled?: boolean;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onError?: (err: unknown) => void;
}

export function useVisibleInterval(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: boolean | VisibleIntervalOptions = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const optionsRef = useRef(resolveOptions(options));
  optionsRef.current = resolveOptions(options);
  const failureCountRef = useRef(0);
  const nextAllowedAtRef = useRef(0);

  const { enabled, initialBackoffMs, maxBackoffMs } = optionsRef.current;

  useEffect(() => {
    if (!enabled) return;
    const resetBackoff = () => {
      failureCountRef.current = 0;
      nextAllowedAtRef.current = 0;
    };
    const recordFailure = (err: unknown) => {
      const currentOptions = optionsRef.current;
      currentOptions.onError?.(err);
      const delay = Math.min(
        currentOptions.initialBackoffMs * 2 ** failureCountRef.current,
        currentOptions.maxBackoffMs,
      );
      failureCountRef.current += 1;
      nextAllowedAtRef.current = Date.now() + delay;
    };
    const tick = () => {
      if (document.hidden) return;
      if (Date.now() < nextAllowedAtRef.current) return;
      try {
        const result = callbackRef.current();
        if (isPromiseLike(result)) {
          void result.then(resetBackoff, recordFailure);
        } else {
          resetBackoff();
        }
      } catch (err) {
        recordFailure(err);
      }
    };
    const interval = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(interval);
  }, [enabled, intervalMs, initialBackoffMs, maxBackoffMs]);
}

function resolveOptions(options: boolean | VisibleIntervalOptions): Required<VisibleIntervalOptions> {
  if (typeof options === 'boolean') {
    return {
      enabled: options,
      initialBackoffMs: 2_000,
      maxBackoffMs: 60_000,
      onError: noopOnError,
    };
  }
  return {
    enabled: options.enabled ?? true,
    initialBackoffMs: options.initialBackoffMs ?? 2_000,
    maxBackoffMs: options.maxBackoffMs ?? 60_000,
    onError: options.onError ?? noopOnError,
  };
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function';
}

function noopOnError(): void {}
