import { Router } from 'express';
import type { TranscriptResult, TranscriptTurn } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { sanitiseTerminalOutput } from '../exec.js';
import { recordAudit } from '../audit.js';
import { SESSION_ID_RE } from '../lib/sessionId.js';
import { raceWithTimeout } from '../lib/race-with-timeout.js';
import { LOG_COMPONENT } from '../logging.js';
import {
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

const PER_TURN_CAP = 16 * 1024;
const TOTAL_CAP = 256 * 1024;

// gascity-dashboard-xba: bound /api/sessions wait time independently of the
// global GcClient default. The Mail agent panel renders progressively from a
// fast mail-derived list and footnotes "loading more agents" while sessions
// is in flight; session-only aliases shouldn't keep that footnote up for 15s
// when the supervisor stalls. 3s is tight enough that the panel turns over
// quickly, long enough that a real-but-slow supervisor still answers.
//
// Operators override via GC_SESSIONS_TIMEOUT_MS (same shape as
// GC_HEALTH_TIMEOUT_MS / GC_CLIENT_TIMEOUT_MS — narrower scope). Clamped at
// MAX_SESSIONS_TIMEOUT_MS so a typo can't hold the route open for hours.
const SESSIONS_TIMEOUT_MS = 3_000;
const MAX_SESSIONS_TIMEOUT_MS = 30_000;

/**
 * Resolves the /api/sessions route timeout from GC_SESSIONS_TIMEOUT_MS,
 * falling back to SESSIONS_TIMEOUT_MS. Invalid, zero, or negative values
 * fall back too (matches resolveHealthTimeoutMs). Values above
 * MAX_SESSIONS_TIMEOUT_MS are clamped.
 *
 * Read once at startup: sessionsRouter() calls this when the router is
 * constructed and captures the result in a closure. Mutating
 * GC_SESSIONS_TIMEOUT_MS at runtime has no effect — restart the dashboard.
 */
export function resolveSessionsTimeoutMs(): number {
  const raw = process.env.GC_SESSIONS_TIMEOUT_MS;
  if (typeof raw !== 'string') return SESSIONS_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return SESSIONS_TIMEOUT_MS;
  return Math.min(n, MAX_SESSIONS_TIMEOUT_MS);
}

export interface SessionsRouterOptions {
  /**
   * Per-request timeout for GET /api/sessions. Defaults to
   * GC_SESSIONS_TIMEOUT_MS env, then 3000ms. Captured at router
   * construction; runtime env mutation has no effect.
   */
  sessionsTimeoutMs?: number;
}

export function sessionsRouter(
  gc: GcClient,
  opts: SessionsRouterOptions = {},
): Router {
  const router = Router();
  const sessionsTimeoutMs = opts.sessionsTimeoutMs ?? resolveSessionsTimeoutMs();

  router.get('/', async (_req, res) => {
    try {
      const { items } = await raceWithTimeout(gc.listSessions(), sessionsTimeoutMs);
      res.json({ items });
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.sessions,
        operation: '/api/sessions failed',
        responseError: 'failed to list sessions',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  // POST /api/sessions/:id/peek — returns the session's transcript.
  //
  // Architect addendum td-wisp-ijk7g (mechanic td-wisp-e1v14): peek is an
  // HTTP endpoint, not a shell-exec. We still POST here (frontend issues
  // a CSRF-protected write to bound the audit log + keep the action
  // explicit) but the backend's work collapses to: fetch from gc, strip
  // dangerous characters, cap size, return.
  router.post('/:id/peek', async (req, res) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) {
      writeRouteError(res, routeValidationError('invalid session id'));
      return;
    }
    const start = Date.now();
    try {
      const raw = await gc.fetchTranscript(id);
      const result = buildTranscriptResult(id, raw.turns, raw);
      await recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'POST /api/sessions/:id/peek',
        parsed_args: { session_id: id },
        duration_ms: Date.now() - start,
      });
      res.json(result);
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.sessions,
        operation: '/api/sessions/:id/peek failed',
        responseError: 'failed to fetch transcript',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  return router;
}

function buildTranscriptResult(
  sessionId: string,
  rawTurns: TranscriptTurn[],
  raw: { template?: string; provider?: string; format?: string },
): TranscriptResult {
  const turns: TranscriptTurn[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const turn of rawTurns) {
    if (typeof turn?.text !== 'string') continue;
    let cleaned = sanitiseTerminalOutput(turn.text);
    if (cleaned.length > PER_TURN_CAP) {
      cleaned = cleaned.slice(0, PER_TURN_CAP);
      truncated = true;
    }
    if (totalChars + cleaned.length > TOTAL_CAP) {
      const remaining = TOTAL_CAP - totalChars;
      if (remaining > 0) {
        turns.push({ role: turn.role, text: cleaned.slice(0, remaining) });
        totalChars += remaining;
      }
      truncated = true;
      break;
    }
    turns.push({ role: typeof turn.role === 'string' ? turn.role : 'unknown', text: cleaned });
    totalChars += cleaned.length;
  }
  const result: TranscriptResult = {
    session_id: sessionId,
    turns,
    total_chars: totalChars,
    captured_at: new Date().toISOString(),
    truncated,
  };
  if (raw.template !== undefined) result.template = raw.template;
  if (raw.provider !== undefined) result.provider = raw.provider;
  if (raw.format !== undefined) result.format = raw.format;
  return result;
}
