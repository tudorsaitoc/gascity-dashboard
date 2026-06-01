import { Router } from 'express';
import os from 'node:os';
import type { SystemHealth } from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';

/** Dashboard-local admin process and host health. GC supervisor health is
 * fetched directly by the browser through the generated supervisor client. */
export function healthRouter(): Router {
  const router = Router();

  router.get('/system', async (_req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
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
    };
    await recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/health/system',
      duration_ms: 0,
    });
    res.json(payload);
  });

  return router;
}
