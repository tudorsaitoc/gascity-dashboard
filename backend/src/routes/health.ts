import { Router } from 'express';
import os from 'node:os';
import type { SupervisorHealthState, SystemHealth } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';

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
 *
 * Read once at startup: healthRouter() calls this when the router is
 * constructed and captures the result in a closure. Mutating
 * GC_HEALTH_TIMEOUT_MS at runtime has no effect — operators must restart
 * the dashboard process for a new value to take effect.
 */
export function resolveHealthTimeoutMs(): number {
  const raw = process.env.GC_HEALTH_TIMEOUT_MS;
  if (typeof raw !== 'string') return SUPERVISOR_HEALTH_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return SUPERVISOR_HEALTH_TIMEOUT_MS;
  return Math.min(n, MAX_HEALTH_TIMEOUT_MS);
}

export interface HealthRouterOptions {
  /**
   * Per-request timeout for the supervisor /health probe. Defaults to
   * GC_HEALTH_TIMEOUT_MS env, then 2500ms. Captured at router construction
   * time, not re-read per request.
   */
  supervisorTimeoutMs?: number;
}

/**
 * Builds the /system health router. The supervisor timeout is resolved
 * exactly once here (from opts.supervisorTimeoutMs, then GC_HEALTH_TIMEOUT_MS,
 * then the 2500ms default) and captured in the route handler's closure.
 * Runtime env changes do not propagate — restart the process to pick up a
 * new GC_HEALTH_TIMEOUT_MS.
 */
export function healthRouter(gc: GcClient, opts: HealthRouterOptions = {}): Router {
  const router = Router();
  const supervisorTimeoutMs = opts.supervisorTimeoutMs ?? resolveHealthTimeoutMs();

  router.get('/system', async (_req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    let supervisor: SupervisorHealthState;
    try {
      supervisor = {
        status: 'available',
        data: await gc.health({ timeoutMs: supervisorTimeoutMs }),
      };
    } catch (err) {
      // gascity-dashboard-mek: distinguish hung supervisor (504) from
      // broken supervisor (200 + explicit unavailable state). Generic fetch
      // failures (connection refused, 5xx, JSON parse error) still keep the
      // admin + host slices visible. Only the per-request timeout propagates
      // as 504, matching the contract in sessions.ts/beads.ts.
      if (GcClient.isTimeoutError(err)) {
        res.status(504).json({
          error: 'gc supervisor did not respond in time',
          kind: 'upstream-timeout',
        });
        return;
      }
      logWarn(LOG_COMPONENT.health, `supervisor health probe failed: ${errorMessage(err)}`);
      supervisor = {
        status: 'unavailable',
        error: 'supervisor health unavailable',
      };
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
    await recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/system/system',
      duration_ms: 0,
    });
    res.json(payload);
  });

  return router;
}
