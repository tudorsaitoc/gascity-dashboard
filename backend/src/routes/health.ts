import { Router } from 'express';
import os from 'node:os';
import type { SupervisorHealth, SystemHealth } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';

// Health uses a tighter window than the global GcClient timeout (5s default)
// because /v0/city/{name}/health is a cheap localhost ping. 2.5s is plenty
// to distinguish "supervisor hung" from "supervisor slow under real load".
// Operators can override via GC_HEALTH_TIMEOUT_MS (mirrors the
// GC_CLIENT_TIMEOUT_MS knob on GcClient — same shape, narrower scope).
const SUPERVISOR_HEALTH_TIMEOUT_MS = 2_500;
// Upper bound: any GC_HEALTH_TIMEOUT_MS above this is a typo, not a tuning
// choice. A 30s ceiling keeps a fat-fingered value from holding the health
// route open for hours and effectively breaking the dashboard.
const MAX_HEALTH_TIMEOUT_MS = 30_000;

/**
 * Resolves the supervisor health timeout from the GC_HEALTH_TIMEOUT_MS env
 * var, falling back to SUPERVISOR_HEALTH_TIMEOUT_MS. Invalid or non-positive
 * values fall back too — silent fallback matches the gc-client pattern and
 * keeps a typo from accidentally setting a 0ms timeout. Values above
 * MAX_HEALTH_TIMEOUT_MS are clamped to that ceiling.
 */
export function resolveHealthTimeoutMs(): number {
  const raw = process.env.GC_HEALTH_TIMEOUT_MS;
  if (typeof raw !== 'string') return SUPERVISOR_HEALTH_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return SUPERVISOR_HEALTH_TIMEOUT_MS;
  return Math.min(n, MAX_HEALTH_TIMEOUT_MS);
}

export interface HealthRouterOptions {
  /** Per-request timeout for the supervisor /health probe. Defaults to GC_HEALTH_TIMEOUT_MS env, then 2500ms. */
  supervisorTimeoutMs?: number;
}

export function healthRouter(gc: GcClient, opts: HealthRouterOptions = {}): Router {
  const router = Router();
  const supervisorTimeoutMs = opts.supervisorTimeoutMs ?? resolveHealthTimeoutMs();

  router.get('/system', async (_req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    let supervisor: SupervisorHealth | null;
    try {
      supervisor = await fetchSupervisor(gc, supervisorTimeoutMs);
    } catch (err) {
      // gascity-dashboard-mek: distinguish hung supervisor (504) from
      // broken supervisor (200 + supervisor:null). Generic fetch failures
      // (connection refused, 5xx, JSON parse error) still return null so
      // the admin + host slices stay visible. Only the per-request timeout
      // propagates as 504, matching the contract in sessions.ts/beads.ts.
      if (GcClient.isTimeoutError(err)) {
        res.status(504).json({
          error: 'gc supervisor did not respond in time',
          kind: 'upstream-timeout',
        });
        return;
      }
      supervisor = null;
    }
    const payload: SystemHealth = {
      admin: {
        pid: process.pid,
        uptime_sec: Math.round(process.uptime()),
        rss_bytes: mem.rss,
        heap_used_bytes: mem.heapUsed,
        node_version: process.version,
      },
      host: {
        load_avg_1: load[0] ?? 0,
        load_avg_5: load[1] ?? 0,
        load_avg_15: load[2] ?? 0,
        total_mem_bytes: os.totalmem(),
        free_mem_bytes: os.freemem(),
        cpu_count: os.cpus().length,
        uptime_sec: Math.round(os.uptime()),
      },
      supervisor,
    };
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/system/health',
      duration_ms: 0,
    });
    res.json(payload);
  });

  return router;
}

async function fetchSupervisor(
  gc: GcClient,
  timeoutMs: number,
): Promise<SupervisorHealth | null> {
  // gc supervisor's /v0/city/{name}/health endpoint — verified to return
  // {status, version, city, uptime_sec}. Path is under the city scope,
  // not the supervisor root.
  const url = new URL(
    `${gc.baseUrl}/v0/city/${encodeURIComponent(gc.cityName)}/health`,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    // Re-throw TimeoutError so the route can map it to 504. Wrap other
    // errors in a non-timeout Error so isTimeoutError doesn't false-positive
    // on a fetch-level abort caused by something else, and let the caller
    // fall through to the supervisor:null branch.
    if (err instanceof Error && err.name === 'TimeoutError') throw err;
    return null;
  }
  if (!res.ok) return null;
  try {
    return (await res.json()) as SupervisorHealth;
  } catch {
    return null;
  }
}
