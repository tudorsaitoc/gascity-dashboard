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
      logRejection(req, 'method not allowed');
      return;
    }

    // Resolve the upstream target *first*, then gate on the resolved path. This
    // is the normalize-and-compare invariant: the allowlist check and the
    // forwarded request operate on the SAME string (`target.pathname`), so an
    // encoded `..` (e.g. `%2e%2e`) cannot pass the gate as a `[^/]+` city
    // segment yet resolve upstream to a different, global path — `new URL`
    // decodes and collapses it before either the check or the forward sees it.
    const target = resolveUpstreamTarget(req.url, baseUrl);
    if (target === null || !isAllowedPath(target.pathname, readOnly)) {
      res.status(HTTP_STATUS.notFound).type('text/plain').send('not found');
      logRejection(req, 'not allowed');
      return;
    }

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

// Build the upstream URL the request will be forwarded to, failing closed
// (`null`) on anything we will not proxy. `new URL` resolves `..`/encoded-dot
// segments and decodes percent-escapes, so this is the canonical normalized
// form to gate on. A malformed target throws, and an authority in `reqUrl`
// (e.g. `//evil.example/v0/x`) retargets the proxy at a foreign host — both are
// rejected so the proxy can only ever reach the configured supervisor origin.
function resolveUpstreamTarget(reqUrl: string, baseUrl: URL): URL | null {
  let target: URL;
  try {
    target = new URL(reqUrl, baseUrl);
  } catch {
    return null;
  }
  if (target.origin !== baseUrl.origin) return null;
  return target;
}

function isAllowedPath(path: string, readOnly: boolean): boolean {
  if (readOnly) return isAllowedReadPath(path);
  return path === '/health' || path.startsWith('/v0/');
}

function logRejection(req: Request, reason: string): void {
  // Surfaces method/path probes (traversal attempts, write attempts) so an
  // externally-fronted instance leaves an audit trail of what it refused.
  logWarn(LOG_COMPONENT.admin, `gc supervisor proxy rejected ${req.method} ${req.path}: ${reason}`);
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
