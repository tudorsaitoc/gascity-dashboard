import { useCallback, useEffect, useRef, useState } from 'react';
import { formatApiError } from '../api/client';
import { loadActiveConvoyRoots, type ConvoyRootsLoad } from '../supervisor/convoyReads';

// Fetch the active-convoy roots for the /convoy index (gascity-dashboard-0chv3).
//
// Mirrors useConvoyView: the convoy set changes slowly relative to a session, so
// this is static-with-explicit-refresh — it loads once on mount and exposes a
// `refresh` for the page's Refresh control rather than wiring an SSE
// auto-refresh. There is no `not_found` state: an empty city is the legitimate
// `ready` state with zero roots, which the page renders as the calm empty
// notice, not an error.

export type ConvoyRootsState =
  | { kind: 'loading' }
  | { kind: 'ready'; load: ConvoyRootsLoad; refreshing: boolean }
  | { kind: 'failed'; error: string };

export interface UseConvoyRoots {
  state: ConvoyRootsState;
  refresh: () => Promise<void>;
}

export function useConvoyRoots(): UseConvoyRoots {
  const [state, setState] = useState<ConvoyRootsState>({ kind: 'loading' });
  // A refresh that resolves after the page unmounted must not setState on a
  // dead component, so each load checks it is still the live one.
  const mountedRef = useRef(true);

  const load = useCallback(async (mode: 'initial' | 'refresh'): Promise<void> => {
    setState((prev) =>
      mode === 'refresh' && prev.kind === 'ready'
        ? { ...prev, refreshing: true }
        : { kind: 'loading' },
    );
    try {
      const result = await loadActiveConvoyRoots();
      if (mountedRef.current) setState({ kind: 'ready', load: result, refreshing: false });
    } catch (err) {
      if (mountedRef.current) {
        setState({ kind: 'failed', error: formatApiError(err, 'convoy list load failed') });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load('initial');
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => load('refresh'), [load]);

  return { state, refresh };
}
