import { Router } from 'express';
import {
  execMailSend as defaultExecMailSend,
  ExecError,
} from '../exec.js';
import type { ExecResult } from '../exec.js';
import { recordAudit } from '../audit.js';

// WRITE-only mail router. Physically separated from ./mail.ts per the
// architect's design (security_researcher td-wisp-eb0pn): the handler in
// this file does NOT read `viewing-as` from anywhere. The exec wrapper it
// calls has no as-identity parameter in its signature. There is no code
// path through this file that can send-as-someone-else — the structural
// guarantee is the file, not discipline.

const TO_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;
const MAX_SUBJECT = 200;
const MAX_BODY = 16 * 1024;

interface MailSendRouterOptions {
  /**
   * Injected `gc mail send` runner. Defaults to the real exec wrapper;
   * tests pass a stub. Mirrors the DI pattern established by
   * maintainerRouter.execGcSling (gascity-dashboard-ib5) and applied to
   * audit (gascity-dashboard-gxf). The structural-separation guarantee
   * of this file (no `from`/`viewing_as` slot) is preserved: the stub
   * type has no identity parameter either.
   */
  execMailSend?: (
    to: string,
    subject: string,
    body: string,
  ) => Promise<ExecResult>;
}

export function mailSendRouter(opts: MailSendRouterOptions = {}): Router {
  const execMailSend = opts.execMailSend ?? defaultExecMailSend;
  const router = Router();

  router.post('/', async (req, res) => {
    const body = req.body as { to?: unknown; subject?: unknown; body?: unknown };
    const to = typeof body?.to === 'string' ? body.to : '';
    const subject = typeof body?.subject === 'string' ? body.subject : '';
    const text = typeof body?.body === 'string' ? body.body : '';

    if (!TO_RE.test(to)) {
      res.status(400).json({ error: 'invalid `to` alias', kind: 'validation' });
      return;
    }
    if (subject.length === 0 || subject.length > MAX_SUBJECT) {
      res.status(400).json({ error: 'subject must be 1–200 chars', kind: 'validation' });
      return;
    }
    if (text.length === 0 || text.length > MAX_BODY) {
      res.status(400).json({ error: `body must be 1–${MAX_BODY} chars`, kind: 'validation' });
      return;
    }

    try {
      const result = await execMailSend(to, subject, text);
      void recordAudit({
        type: 'dashboard.send_mail',
        endpoint: 'POST /api/mail-send',
        // viewing_as deliberately NOT recorded here — sender is always the
        // operator. The signature has no slot for it. Record only what was sent.
        parsed_args: { to, subject_len: String(subject.length), body_len: String(text.length) },
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      });
      if (result.exitCode !== 0) {
        res.status(502).json({
          error: `gc mail send failed (${result.exitCode})`,
          kind: 'upstream',
          details: { stderr: result.stderr.slice(0, 1024) },
        });
        return;
      }
      // gc mail send prints the message id; pull it best-effort from stdout.
      const idMatch = /\b(td-wisp-[a-z0-9]{3,12})\b/.exec(result.stdout);
      res.json({ ok: true, message_id: idMatch?.[1] });
    } catch (err) {
      if (err instanceof ExecError) {
        const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      res.status(500).json({ error: (err as Error).message, kind: 'internal' });
    }
  });

  return router;
}
