import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// Double-submit cookie CSRF for state-changing endpoints. Single-user
// localhost tool — no shared-secret store, no rotation needed. Token is
// generated per server boot + handed to the frontend on first GET, then
// validated as a header on POST/PATCH/DELETE.
//
// Why not csurf: the canonical npm package was deprecated; rolling a
// minimal double-submit pattern is reasonable here, and the host-header
// allowlist + Origin check already do the heavy lifting. CSRF here is
// the third belt.

const TOKEN_HEADER = 'x-csrf-token';
const COOKIE_NAME = 'gascity_admin_csrf';
const CSRF_COOKIE_MAX_AGE_S = 86_400;

let bootToken: string | null = null;

function makeToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function getCsrfToken(): string {
  if (bootToken === null) bootToken = makeToken();
  return bootToken;
}

/**
 * Attaches the CSRF token to every GET response as a non-HttpOnly cookie
 * so the browser JS can read it + echo it as a header on writes.
 * (HttpOnly:false is intentional — double-submit requires JS-readable.)
 */
export function csrfIssueCookie(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${getCsrfToken()}; Path=/; SameSite=Strict; Max-Age=${CSRF_COOKIE_MAX_AGE_S}`,
    );
  }
  next();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function csrfValidate(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const headerToken = req.headers[TOKEN_HEADER];
  if (typeof headerToken !== 'string' || headerToken.length === 0) {
    res.status(403).json({ error: 'Missing CSRF token', kind: 'csrf' });
    return;
  }
  const expected = getCsrfToken();
  if (!timingSafeEqualStr(headerToken, expected)) {
    res.status(403).json({ error: 'Invalid CSRF token', kind: 'csrf' });
    return;
  }
  next();
}
