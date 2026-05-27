import { Router } from 'express';
import type { MailSendResponse } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';
import { toWireInternal500 } from '../lib/sanitise-error.js';

// WRITE-only mail router. Physically separated from ./mail.ts per the
// architect's design (security_researcher td-wisp-eb0pn): the handler in
// this file does NOT read `viewing-as` from anywhere. The injected sendMail
// fn has no as-identity parameter in its signature — `from` is pinned to
// 'human' by the caller in server.ts, never sourced from the request. There
// is no code path through this file that can send-as-someone-else — the
// structural guarantee is the file, not discipline.

const TO_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;
const MAX_SUBJECT = 200;
const MAX_BODY = 16 * 1024;

interface MailSendRouterOptions {
  /**
   * Injected mail-send runner (gascity-dashboard-mq2). Production wires a
   * closure over `gc.sendMail` that pins `from:'human'` (see server.ts);
   * tests pass a stub. Replaces the former `execMailSend` subprocess DI —
   * the supervisor exposes `POST /mail`. The structural-separation
   * guarantee of this file is preserved: the fn's only inputs are
   * to/subject/body, so this handler has no `from`/`viewing_as` slot.
   * Returns the supervisor's Message; the route surfaces only `id`.
   */
  sendMail: (
    to: string,
    subject: string,
    body: string,
  ) => Promise<MailSendResponse>;
}

export function mailSendRouter(opts: MailSendRouterOptions): Router {
  const { sendMail } = opts;
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

    const startedAt = Date.now();
    try {
      const result = await sendMail(to, subject, text);
      void recordAudit({
        type: 'dashboard.send_mail',
        endpoint: 'POST /api/mail-send',
        // viewing_as deliberately NOT recorded here — sender is always the
        // operator. The signature has no slot for it. Record only what was sent.
        parsed_args: { to, subject_len: String(subject.length), body_len: String(text.length) },
        duration_ms: Date.now() - startedAt,
      });
      // The supervisor returns the created Message; `id` replaces the old
      // `Sent <id>` stdout parse. Typed string, but guard against an empty
      // value so the client's `message_id?: string` stays meaningful.
      res.json({ ok: true, message_id: result.id.length > 0 ? result.id : undefined });
    } catch (err) {
      // gascity-dashboard-mq2: mail send is now an HTTP POST to the
      // supervisor. A true client-side timeout maps to 504; any other
      // failure (non-2xx from the supervisor, network error) maps to 502
      // upstream. The raw message can embed the supervisor URL / host
      // (GcClient throws `gc supervisor returned NNN`; fetch errors embed
      // host:port), so it stays server-side in console.warn — only
      // details.name reaches the wire, mirroring the maintainer sling +
      // sr6 redaction (gascity-dashboard-473/ayr).
      const isTimeout = GcClient.isTimeoutError(err);
      void recordAudit({
        type: 'dashboard.send_mail',
        endpoint: 'POST /api/mail-send',
        parsed_args: {
          to,
          subject_len: String(subject.length),
          body_len: String(text.length),
          error_kind: isTimeout ? 'timeout' : 'upstream',
        },
        duration_ms: Date.now() - startedAt,
      });
      console.warn(`[mail-send] failed: ${(err as Error).message}`);
      const wire = toWireInternal500(err, {
        status: isTimeout ? 504 : 502,
        error: isTimeout ? 'gc supervisor timed out' : 'gc mail send failed',
        kind: isTimeout ? 'timeout' : 'upstream',
      });
      res.status(wire.status).json(wire.body);
    }
  });

  return router;
}
