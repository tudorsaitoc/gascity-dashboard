import { Router } from 'express';
import type { TranscriptResult, TranscriptTurn } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { sanitiseTerminalOutput } from '../exec.js';
import { recordAudit } from '../audit.js';

const SESSION_ID_RE = /^(td|th)-[a-z0-9]{3,12}$/;
const PER_TURN_CAP = 16 * 1024;
const TOTAL_CAP = 256 * 1024;

export function sessionsRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const { items } = await gc.listSessions();
      res.json({ items });
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
        .json({ error: 'failed to list sessions', kind: 'upstream', details: { message: (err as Error).message } });
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
