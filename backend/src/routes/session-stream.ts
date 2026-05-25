import { Router, type Request, type Response } from 'express';
import { lastEventIdFor, proxySupervisorSse } from './sse-proxy.js';

const SESSION_ID_RE = /^(gc|td|th)-[a-z0-9-]{1,32}$/i;
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface SessionStreamRouterOptions {
  supervisorUrl: string;
  cityName: string;
  heartbeatMs?: number;
}

export function sessionStreamRouter(opts: SessionStreamRouterOptions): Router {
  const router = Router();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  router.get('/:id/stream', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (typeof id !== 'string') {
      res.status(400).json({ error: 'invalid session id', kind: 'validation' });
      return;
    }
    if (!SESSION_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid session id', kind: 'validation' });
      return;
    }

    const upstream = new URL(
      `${opts.supervisorUrl}/v0/city/${encodeURIComponent(opts.cityName)}/session/${encodeURIComponent(id)}/stream`,
    );
    const lastEventId = lastEventIdFor(req);
    if (lastEventId) upstream.searchParams.set('after', lastEventId);

    await proxySupervisorSse(req, res, {
      upstream,
      heartbeatMs,
      unreachableMessage: 'gc supervisor session stream unreachable',
      noBodyMessage: 'gc supervisor session stream response had no body',
    });
  });

  return router;
}
