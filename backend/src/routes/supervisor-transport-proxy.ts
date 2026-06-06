import { Router, type Request, type Response as ExpressResponse } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { HTTP_STATUS } from '../lib/http-status.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';
import { isAllowedReadPath } from './supervisor-read-allowlist.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'cookie',
  'host',
  'origin',
  'referer',
]);

// In read-only mode every forwarded request is a GET/HEAD read, so the
// supervisor's write-authorizing `x-gc-request` header is removed unconditionally
// (never depend on its absence) along with a body `content-type` that can no
// longer apply.
const READONLY_STRIPPED_REQUEST_HEADERS = new Set([
  ...STRIPPED_REQUEST_HEADERS,
  'x-gc-request',
  'content-type',
]);

export function supervisorTransportProxy(supervisorBaseUrl: string, readOnly = false): Router {
  const router = Router();
  const baseUrl = new URL(supervisorBaseUrl);

  router.use(async (req, res) => {
    if (readOnly && req.method !== 'GET' && req.method !== 'HEAD') {
      // RFC 9110 §15.5.6: a 405 MUST carry an Allow header advertising the
      // methods the resource does support.
      res.setHeader('Allow', 'GET, HEAD');
      res.status(HTTP_STATUS.methodNotAllowed).type('text/plain').send('read-only');
      return;
    }
    if (!isAllowedPath(req.path, readOnly)) {
      res.status(HTTP_STATUS.notFound).type('text/plain').send('not found');
      return;
    }

    const target = new URL(req.url, baseUrl);
    try {
      const upstream = await fetch(target, requestInit(req, readOnly));
      await writeUpstreamResponse(upstream, res);
    } catch (err) {
      logWarn(LOG_COMPONENT.admin, `gc supervisor transport proxy failed: ${errorMessage(err)}`);
      if (!res.headersSent) {
        res.status(HTTP_STATUS.badGateway).json({
          error: 'gc supervisor transport failed',
          kind: 'upstream',
        });
      } else {
        res.destroy(err instanceof Error ? err : undefined);
      }
    }
  });

  return router;
}

function isAllowedPath(path: string, readOnly: boolean): boolean {
  if (readOnly) return isAllowedReadPath(path);
  return path === '/health' || path.startsWith('/v0/');
}

function requestInit(req: Request, readOnly: boolean): RequestInit & { duplex?: 'half' } {
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: requestHeaders(req, readOnly),
    redirect: 'manual',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req as unknown as BodyInit;
    init.duplex = 'half';
  }
  return init;
}

function requestHeaders(req: Request, readOnly: boolean): Headers {
  const stripped = readOnly ? READONLY_STRIPPED_REQUEST_HEADERS : STRIPPED_REQUEST_HEADERS;
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (stripped.has(lower)) continue;
    if (rawValue === undefined) continue;
    headers.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue);
  }
  return headers;
}

async function writeUpstreamResponse(upstream: Response, res: ExpressResponse): Promise<void> {
  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });
  if (upstream.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>), res);
}
