import { Router } from 'express';
import type { TranscriptResult, TranscriptTurn } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { sanitiseTerminalOutput } from '../exec.js';
import { recordAudit } from '../audit.js';

// gc supervisor session IDs are gc-<digits> (gc-229461 etc.). The
// td-/th- prefixes are legacy session shapes kept for backward
// compatibility. This anchored, bounded-length regex remains the SSRF
// gate before any upstream call (security_researcher td-wisp-eb0pn).
const SESSION_ID_RE = /^(gc|td|th)-[a-z0-9]{1,16}$/;
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

/**
 * Races a promise against a TimeoutError-named rejection so the route can
 * surface a 504 (via GcClient.isTimeoutError) when the underlying GcClient
 * call would otherwise sit on a generous default timeout. The underlying
 * fetch is NOT cancelled (gc-client's awaitWithSignal would convert a
 * caller-supplied AbortSignal into AbortError, which the 504 path doesn't
 * recognise); it's left to settle on its own timer. Node releases the
 * socket on completion, and single-flight coalescing means concurrent
 * callers (e.g. the snapshot collector) still benefit from the same fetch.
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`sessions route timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    // Match the rest of the backend (worker.ts, dolt.ts, server.ts): an
    // unref'd timer doesn't block graceful shutdown on SIGTERM.
    timer.unref();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
      if (GcClient.isTimeoutError(err)) {
        res.status(504).json({
          error: 'gc supervisor did not respond in time',
          kind: 'upstream-timeout',
        });
        return;
      }
      // gascity-dashboard-sr6: do NOT forward err.message to the browser.
      // Fetch-level failures (ECONNREFUSED, DNS errors) embed OS detail
      // (interface names, ports, file paths) that leaks topology even on a
      // 127.0.0.1-only deployment. Surface the error's class name only;
      // server-side log retains full fidelity for ops debugging.
      console.warn(`[sessions] /api/sessions failed: ${(err as Error).message}`);
      res
        .status(502)
        .json({ error: 'failed to list sessions', kind: 'upstream', details: { name: (err as Error).name ?? 'Error' } });
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
      res.status(400).json({ error: 'invalid session id', kind: 'validation' });
      return;
    }
    const start = Date.now();
    try {
      const raw = await gc.fetchTranscript(id);
      const result = buildTranscriptResult(id, raw.turns ?? [], raw);
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'POST /api/sessions/:id/peek',
        parsed_args: { session_id: id },
        duration_ms: Date.now() - start,
      });
      res.json(result);
    } catch (err) {
      if (GcClient.isTimeoutError(err)) {
        res.status(504).json({
          error: 'gc supervisor did not respond in time',
          kind: 'upstream-timeout',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'failed to fetch transcript', kind: 'upstream', details: { message: (err as Error).message } });
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
  return {
    session_id: sessionId,
    template: raw.template,
    provider: raw.provider,
    format: raw.format,
    turns,
    total_chars: totalChars,
    captured_at: new Date().toISOString(),
    truncated,
  };
}
