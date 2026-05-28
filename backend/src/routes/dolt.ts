import { Router } from 'express';
import type { DoltNomsTrend, GcStatus } from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';

// In-memory ring buffer of dolt-noms size samples — 24 h at 10-minute
// cadence = 144 slots. The metric source is the supervisor's already-exposed
// store_health.size_bytes (GET /v0/city/{name}/status), read via the injected
// status fetch (gascity-dashboard-x82). The ring buffer + /api/dolt-noms/trend
// response shape are independent of the source.

const SLOT_COUNT = 144;
const SAMPLE_INTERVAL_MS = 10 * 60 * 1_000;

// Stable label surfaced on the trend response so the UI can attribute the
// metric. Set once the sampler is wired to a status fetch.
const STORE_HEALTH_SOURCE = 'status.store_health.size_bytes';

/** Fetches the supervisor city status (source of store_health.size_bytes). */
export type FetchStatus = () => Promise<GcStatus>;

interface RingSlot {
  ts: string;
  bytes: number;
}

const ring: (RingSlot | null)[] = new Array(SLOT_COUNT).fill(null);
let head = 0;
let metricSource: string | null = null;
let metricAvailable = false;

export function startDoltNomsSampler(fetchStatus: FetchStatus): void {
  metricSource = STORE_HEALTH_SOURCE;
  // Run once at boot, then on the cadence.
  void runSample(fetchStatus);
  setInterval(() => {
    void runSample(fetchStatus);
  }, SAMPLE_INTERVAL_MS).unref();
}

async function runSample(fetchStatus: FetchStatus): Promise<void> {
  try {
    const sample = await sampleDoltNomsSize(fetchStatus);
    if (sample !== null) {
      ring[head] = { ts: new Date().toISOString(), bytes: sample };
      head = (head + 1) % SLOT_COUNT;
      metricAvailable = true;
    }
  } catch {
    /* sampling errors are non-fatal — a transient supervisor failure just
       skips this slot; metricAvailable reflects the last good sample */
  }
}

/**
 * Read the dolt-noms on-disk size from the supervisor's
 * store_health.size_bytes. Returns null when the supervisor omits
 * store_health (degraded status) so the endpoint can signal available=false
 * rather than reporting a fake zero. A failed status fetch is NOT caught here
 * — it propagates to runSample's non-fatal handler.
 */
export async function sampleDoltNomsSize(
  fetchStatus: FetchStatus,
): Promise<number | null> {
  const status = await fetchStatus();
  const sizeBytes = status.store_health?.size_bytes;
  return typeof sizeBytes === 'number' ? sizeBytes : null;
}

export function doltRouter(): Router {
  const router = Router();
  router.get('/trend', (_req, res) => {
    const samples = ring
      .filter((s): s is RingSlot => s !== null)
      .map((s) => ({ ts: s.ts, bytes: s.bytes }));
    const payload: DoltNomsTrend = {
      samples,
      source: metricSource,
      available: metricAvailable,
    };
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/dolt-noms/trend',
      parsed_args: { samples: String(samples.length) },
      duration_ms: 0,
    });
    res.json(payload);
  });
  return router;
}
