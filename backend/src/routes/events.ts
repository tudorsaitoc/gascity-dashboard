import { Router, type Request, type Response } from 'express';
import { lastEventIdFor, proxySupervisorSse } from './sse-proxy.js';

// gascity-dashboard-iew: backend-side SSE proxy. The browser opens
// EventSource('/api/events/stream') against this server (same origin as
// the rest of /api/*). This route opens an upstream fetch to the gc
// supervisor's /v0/city/{name}/events/stream and pipes the raw byte
// stream verbatim (see ./sse-proxy.ts for the shared streaming impl).
//
// Why not direct browser-to-supervisor? Because the supervisor binds
// 127.0.0.1 only. Any deployment where the browser isn't on the same
// host (SSH tunnel, reverse proxy, separate machine) requires either
// forwarding the supervisor port too or this proxy. The proxy keeps
// the deployment story to a single port.

export interface EventsRouterOptions {
  /** Base URL of the gc supervisor — no trailing slash. */
  supervisorUrl: string;
  cityName: string;
  /** Heartbeat comment frequency (defaults to 15s). */
  heartbeatMs?: number;
}

// Nginx default proxy_read_timeout is 60s; 15s keeps the stream alive
// through most intermediaries without spamming the client.
const DEFAULT_HEARTBEAT_MS = 15_000;

export function eventsRouter(opts: EventsRouterOptions): Router {
  const router = Router();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  router.get('/stream', async (req: Request, res: Response) => {
    // EventSource sends Last-Event-ID automatically on reconnect. The
    // existing FE hook also passes ?after= explicitly; accept both, prefer
    // the header (set by the browser without the FE having to manage it).
    const upstream = new URL(
      `${opts.supervisorUrl}/v0/city/${encodeURIComponent(opts.cityName)}/events/stream`,
    );
    const lastEventId = lastEventIdFor(req);
    if (lastEventId) upstream.searchParams.set('after', lastEventId);

    await proxySupervisorSse(req, res, {
      upstream,
      heartbeatMs,
      unreachableMessage: 'gc supervisor SSE upstream unreachable',
      noBodyMessage: 'gc supervisor SSE response had no body',
    });
  });

  return router;
}
