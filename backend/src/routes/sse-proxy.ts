import type { Request, Response } from 'express';

// Shared backend-side SSE proxy. The browser opens an EventSource against
// this server (same origin as /api/*); this helper opens an upstream fetch
// to the gc supervisor and pipes the raw byte stream verbatim. SSE framing
// is line-delimited so chunk boundaries don't matter.
//
// Extracted from the original inline events.ts proxy so multiple routes
// (city event stream, per-session stream) share one correct implementation,
// including the drain-vs-close race handling that prevents leaking the
// upstream connection + heartbeat timer when a client disconnects mid-write.

export interface SupervisorSseProxyOptions {
  upstream: URL;
  heartbeatMs: number;
  unreachableMessage: string;
  noBodyMessage: string;
  openImmediately?: boolean;
}

/**
 * Resolve the resume position for an SSE reconnect. EventSource sends
 * `Last-Event-ID` automatically; the FE hook also passes `?after=`
 * explicitly. Prefer the header (set by the browser without FE bookkeeping).
 */
export function lastEventIdFor(req: Request): string | null {
  const headerVal = req.headers['last-event-id'];
  if (typeof headerVal === 'string' && headerVal.length > 0) return headerVal;
  const after = req.query.after;
  if (typeof after === 'string' && after.length > 0) return after;
  return null;
}

export async function proxySupervisorSse(
  req: Request,
  res: Response,
  opts: SupervisorSseProxyOptions,
): Promise<void> {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  let heartbeat: NodeJS.Timeout | undefined;
  if (opts.openImmediately) {
    openSseResponse(res);
    res.write(':\n\n');
    heartbeat = startHeartbeat(res, opts.heartbeatMs);
  }

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(opts.upstream, {
      signal: ctrl.signal,
      headers: { accept: 'text/event-stream' },
    });
  } catch {
    if (heartbeat) clearInterval(heartbeat);
    if (res.headersSent) {
      writeUpstreamFailure(res, opts.unreachableMessage);
      return;
    }
    if (!res.headersSent && !res.writableEnded) {
      res.status(502).json({ error: opts.unreachableMessage, kind: 'upstream' });
    }
    return;
  }

  if (!upstreamRes.ok) {
    upstreamRes.body?.cancel().catch(() => undefined);
    if (heartbeat) clearInterval(heartbeat);
    writeUpstreamFailure(res, `gc supervisor returned ${upstreamRes.status}`);
    return;
  }
  if (!upstreamRes.body) {
    if (heartbeat) clearInterval(heartbeat);
    writeUpstreamFailure(res, opts.noBodyMessage);
    return;
  }

  if (!res.headersSent) openSseResponse(res);
  heartbeat ??= startHeartbeat(res, opts.heartbeatMs);

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || res.writableEnded) break;
      if (!res.write(value)) {
        // Race drain against close — otherwise a client disconnecting while a
        // write is backpressured would orphan the await forever, leaking the
        // upstream connection and heartbeat timer.
        await new Promise<void>((resolve) => {
          const doneDrain = (): void => {
            res.off('drain', doneDrain);
            res.off('close', doneDrain);
            resolve();
          };
          res.once('drain', doneDrain);
          res.once('close', doneDrain);
        });
        if (res.writableEnded || res.destroyed) break;
      }
    }
  } catch {
    // Upstream errored or client disconnected. Cleanup below owns closure.
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    ctrl.abort();
    if (!res.writableEnded) res.end();
  }
}

function openSseResponse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function startHeartbeat(res: Response, heartbeatMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (!res.writableEnded) res.write(':\n\n');
  }, heartbeatMs);
}

function writeUpstreamFailure(res: Response, error: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error, kind: 'upstream' })}\n\n`);
      res.end();
    }
    return;
  }
  res.status(502).json({ error, kind: 'upstream' });
}
