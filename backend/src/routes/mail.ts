import { Router } from 'express';
import type { GcMailItem } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';
import { LOG_COMPONENT, logWarn, sanitizeForLog } from '../logging.js';
import {
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

// READ-only mail router. The architect (security_researcher td-wisp-eb0pn)
// requires PHYSICAL SEPARATION from the send path — see ./mail-send.ts.
// Anything in this file may read `viewing-as`; nothing in this file sends.

const ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;
const BOX_VALUES = new Set(['inbox', 'sent', 'all']);
// The operator's dashboard-internal display identity vs. gc's wire identity.
// gc addresses the human operator as `human` (see server.ts's mailSendRouter
// `from:'human'` pin on gc.sendMail); the dashboard accounts for her as
// `stephanie`. Mail
// is never addressed to `stephanie` on the wire, so a naive
// `to === 'stephanie'` inbox filter returns nothing. Resolve the display
// alias to the wire alias before matching so the operator's own inbox/sent
// boxes actually populate.
const OPERATOR_DISPLAY_ALIAS = 'stephanie';
const OPERATOR_WIRE_ALIAS = 'human';
// td-7t24i6 scope expansion: gc supervisor's mail endpoint defaults to
// limit=50 and caps at 1000 (verified — limit=2000 returns 1000). 1000 is
// the practical max. For the current corpus (~1167 mails) this covers
// ~86% which is enough for the common alias-filtered case; pagination
// would need a separate v1 design if the corpus grows past 2-3× this.
const FETCH_LIMIT = 1000;

export function mailRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const rawAlias = typeof req.query.alias === 'string' ? req.query.alias : 'stephanie';
    const rawBox = typeof req.query.box === 'string' ? req.query.box : 'inbox';
    const alias = ALIAS_RE.test(rawAlias) ? rawAlias : 'stephanie';
    const box: 'inbox' | 'sent' | 'all' = BOX_VALUES.has(rawBox)
      ? (rawBox as 'inbox' | 'sent' | 'all')
      : 'inbox';
    try {
      // td-h3n2ar fix: gc supervisor's `box` + `alias` query params are
      // silently ignored upstream (verified: box=sent&alias=mayor and
      // box=sent&alias=human both return the same first items with
      // to=mayor). So we can't lean on the supervisor to filter by sender.
      //
      // Pull a wide window and filter server-side: inbox = to===alias,
      // sent = from===alias. Filtering here keeps each box's results
      // independent under as-identity switching, which is what the
      // operator actually wants from the UI.
      const mailList = await gc.listMail(undefined, { limit: FETCH_LIMIT });
      const rawItems = mailList.items;
      // izgc F3: surface supervisor-reported partial-list degradation
      // (one or more rig providers failed during aggregation) — without
      // this OR-in the operator only sees the count, not the fact that
      // the underlying source was degraded. Per CLAUDE.md
      // "Don't Swallow Errors".
      if (mailList.partial === true || (mailList.partial_errors?.length ?? 0) > 0) {
        const detail = mailList.partial_errors && mailList.partial_errors.length > 0
          ? mailList.partial_errors.map(sanitizeForLog).join(', ')
          : 'no detail';
        logWarn(
          LOG_COMPONENT.mail,
          `supervisor reported partial mail list (${detail}); some rig providers degraded`,
        );
      }
      const filtered = filterByBox(rawItems, box, alias);
      // Newest first — td-liky3d default sort, applied at the source so
      // the API contract is stable independent of any table sort UI.
      filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        items: filtered,
        total: filtered.length,
        upstream_total: rawItems.length,
      });
      await recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/mail',
        viewing_as: alias,
        parsed_args: { box, alias, returned: String(filtered.length) },
        duration_ms: 0,
      });
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.mail,
        operation: '/api/mail failed',
        responseError: 'failed to list mail',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  // Thread view: gc supervisor doesn't expose a /threads/:id endpoint
  // (verified: returns 404). We fetch the alias's inbox+sent and filter
  // by thread_id server-side. Cheap at our scale + keeps clients dumb.
  router.get('/threads/:id', async (req, res) => {
    const threadId = req.params.id;
    if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 128) {
      writeRouteError(res, routeValidationError('invalid thread id'));
      return;
    }
    const rawAlias = typeof req.query.alias === 'string' ? req.query.alias : 'stephanie';
    const alias = ALIAS_RE.test(rawAlias) ? rawAlias : 'stephanie';
    try {
      const [inbox, sent] = await Promise.all([
        gc.listMail(undefined, { box: 'inbox', alias }),
        gc.listMail(undefined, { box: 'sent', alias }),
      ]);
      const all: GcMailItem[] = [...inbox.items, ...sent.items];
      const items = all
        .filter((m) => m.thread_id === threadId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      // De-dup by id (a message may appear in both inbox + sent views).
      const seen = new Set<string>();
      const deduped = items.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: deduped });
      await recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/mail/threads/:id',
        viewing_as: alias,
        parsed_args: { thread_id: threadId, alias },
        duration_ms: 0,
      });
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.mail,
        operation: '/api/mail/threads/:id failed',
        responseError: 'failed to load thread',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  return router;
}

function filterByBox(
  items: GcMailItem[],
  box: 'inbox' | 'sent' | 'all',
  alias: string,
): GcMailItem[] {
  // Aliases are case-insensitive at our scale — gc emits a mix of styles
  // (e.g. 'mayor or scix-worker/orchestrator' vs 'human'). Lowercase both sides.
  // Resolve the operator's display alias to her wire alias so her own boxes
  // match the mail gc actually addresses to/from `human`.
  const lower = alias.toLowerCase();
  const a = lower === OPERATOR_DISPLAY_ALIAS ? OPERATOR_WIRE_ALIAS : lower;
  if (box === 'all') return items.slice();
  if (box === 'inbox') {
    return items.filter((m) => typeof m.to === 'string' && m.to.toLowerCase() === a);
  }
  // sent
  return items.filter((m) => typeof m.from === 'string' && m.from.toLowerCase() === a);
}
