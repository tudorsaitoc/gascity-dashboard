import { Router } from 'express';
import type { GcMailItem } from 'gas-city-dashboard-shared';
import type { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';

// READ-only mail router. The architect (security_researcher td-wisp-eb0pn)
// requires PHYSICAL SEPARATION from the send path — see ./mail-send.ts.
// Anything in this file may read `viewing-as`; nothing in this file sends.

const ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;
const BOX_VALUES = new Set(['inbox', 'sent', 'all']);
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
      const { items: rawItems } = await gc.listMail(undefined, { limit: FETCH_LIMIT });
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
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/mail',
        viewing_as: alias,
        parsed_args: { box, alias, returned: String(filtered.length) },
        duration_ms: 0,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to list mail', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  // Thread view: gc supervisor doesn't expose a /threads/:id endpoint
  // (verified: returns 404). We fetch the alias's inbox+sent and filter
  // by thread_id server-side. Cheap at our scale + keeps clients dumb.
  router.get('/threads/:id', async (req, res) => {
    const threadId = req.params.id;
    if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 128) {
      res.status(400).json({ error: 'invalid thread id', kind: 'validation' });
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
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/mail/threads/:id',
        viewing_as: alias,
        parsed_args: { thread_id: threadId, alias },
        duration_ms: 0,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to load thread', kind: 'upstream', details: { message: (err as Error).message } });
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
  const a = alias.toLowerCase();
  if (box === 'all') return items.slice();
  if (box === 'inbox') {
    return items.filter((m) => typeof m.to === 'string' && m.to.toLowerCase() === a);
  }
  // sent
  return items.filter((m) => typeof m.from === 'string' && m.from.toLowerCase() === a);
}
