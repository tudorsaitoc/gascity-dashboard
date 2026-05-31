import type { GcBead } from 'gas-city-dashboard-shared';
import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../api/client';

// Shared fetch + live-clock for a single bead's detail surface
// (gascity-dashboard-6frc). Both the BeadDetailModal (list view) and the
// board's BeadDetailRail render the same bead body, so the "fetch by id
// when the cached row lacks a description, tick a clock for relative
// ages" logic lives here once rather than in each surface.

export interface BeadDetailState {
  bead: GcBead | null;
  loading: boolean;
  error: string | null;
  /** Live clock (ms) for RelatedEntities staleness / "as of". */
  now: number;
}

/**
 * Loads `beadId` while `active`. If `initialBead` already carries a
 * description (the freshness signal — it's the thing the detail surface
 * exists to show), the fetch is skipped. The clock only ticks while active
 * and the tab is visible, so relative ages never silently go stale.
 */
export function useBeadDetail(
  active: boolean,
  beadId: string | null,
  initialBead: GcBead | null = null,
): BeadDetailState {
  const [bead, setBead] = useState<GcBead | null>(initialBead);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    return () => clearInterval(tick);
  }, [active]);

  useEffect(() => {
    if (!active || !beadId) return;
    if (
      initialBead &&
      initialBead.id === beadId &&
      initialBead.description !== undefined
    ) {
      setBead(initialBead);
      setError(null);
      return;
    }
    setBead(initialBead?.id === beadId ? initialBead : null);
    setLoading(true);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getBead(beadId);
        if (!cancelled) setBead(result);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiClientError
            ? err.status === 404
              ? 'Bead not found in the supervisor.'
              : `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'fetch failed';
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, beadId, initialBead]);

  return { bead, loading, error, now };
}
