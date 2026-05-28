import { Router } from 'express';
import type { GcBead, GcSession } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { parseRef } from '../links/node-ref.js';
import { buildRelationIndex } from '../links/relation-index.js';
import { buildLinkView } from '../links/build-link-view.js';
import { ResolutionRollup } from '../links/instrumentation.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';
import { routeUpstreamError, writeRouteError } from '../route-errors.js';

// GET /api/links/:ref — bead-ID cross-entity linked view (gascity-dashboard-j4x).
//
// Resolves any input ref (bead-id, pr/<n>, issue/<n>, session-id,
// workflow-id) to its bead-id(s), builds the per-snapshot relation index
// over the city bead set + session list, and returns a one-hop
// EntityLinkView. Read-only; no gh fan-out (the bead→PR/issue edges are
// authoritative numbers, but the PR/issue entities are rendered as honest
// unresolved rows — PG2 safety valve).
//
// GET /api/links/_stats — the R11 rollup endpoint (RK4): per-edge-type
// resolution rates. Out-of-band / future-use (curl-able); no frontend
// surface consumes it in this PR.

// The supervisor's working set is ~2139 beads (see GcClient.listBeads), so
// a 2000 limit silently truncates relations. Fetch comfortably above the
// known working set; if the supervisor's reported `total` ever exceeds even
// this, the view is marked `partial` (truncation is never silent).
const LINKS_FETCH_LIMIT = 5000;

export interface LinksRouterOptions {
  /** Process-scoped resolution rollup (R11). Defaults to a fresh instance. */
  rollup?: ResolutionRollup;
  now?: () => Date;
}

export function linksRouter(gc: GcClient, opts: LinksRouterOptions = {}): Router {
  const router = Router();
  const rollup = opts.rollup ?? new ResolutionRollup();

  // _stats must be registered before /:ref so it isn't captured as a ref.
  router.get('/_stats', (_req, res) => {
    res.json({ stats: rollup.snapshot() });
  });

  router.get('/:ref', async (req, res) => {
    const parsed = parseRef(req.params.ref);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, kind: 'validation' });
      return;
    }

    try {
      const { beads, sessions, partial, supervisorFetchedAt } =
        await fetchSources(gc);
      const index = buildRelationIndex(beads, sessions, gc.cityName);
      const view = buildLinkView(index, parsed, {
        partial,
        supervisorFetchedAt,
        // No GitHub source contributes yet (open-only gh fan-out avoided).
        // The bead→PR/issue numbers resolve to unresolved rows; their
        // fetchedAt stays null until a real GitHub join lands (R8/OQ#2).
        githubFetchedAt: null,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        recorder: rollup.recorder(),
      });
      res.json(view);
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.links,
        operation: '/api/links/:ref failed',
        responseError: 'failed to build linked view',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  return router;
}

interface Sources {
  beads: GcBead[];
  sessions: GcSession[];
  partial: boolean;
  supervisorFetchedAt: string;
}

/**
 * Fetch the bead set + session list so a single failed source degrades the
 * view to `partial` rather than collapsing to a 5xx (mirrors
 * routes/workflows.ts). The bead list is the load-bearing source: if it
 * fails the request errors (no index is possible).
 *
 * Truncation is never silent: if the supervisor reports a `total` larger
 * than the fetched window, the view is marked `partial` so the operator
 * knows relations may be incomplete (rather than the index quietly missing
 * edges to beads beyond the limit).
 */
async function fetchSources(gc: GcClient): Promise<Sources> {
  const supervisorFetchedAt = new Date().toISOString();
  const beadList = await gc.listBeads(undefined, { limit: LINKS_FETCH_LIMIT });
  // izgc F3: decoder guarantees items is an array (collapses null → []),
  // and a separate gc-client test asserts non-array shapes still reject —
  // the prior Array.isArray defensive guard was already dead and the only
  // safe escape was the cast escape hatch the decoder now closes.
  const beads = beadList.items;
  let partial = false;
  if (typeof beadList.total === 'number' && beadList.total > beads.length) {
    logWarn(
      LOG_COMPONENT.links,
      `bead set truncated: supervisor total ${beadList.total} > fetched ${beads.length}; serving partial`,
    );
    partial = true;
  }
  // izgc F3: supervisor-reported wire-partial on a 200 response (degraded
  // bead store) — propagate the degradation signal so the operator sees
  // it even when the local truncation/session-fetch checks above wouldn't
  // have triggered. Per CLAUDE.md "Don't Swallow Errors".
  if (beadList.partial === true || (beadList.partial_errors?.length ?? 0) > 0) {
    logWarn(
      LOG_COMPONENT.links,
      `supervisor reported partial bead list (${beadList.partial_errors?.join(', ') ?? 'no detail'}); serving partial`,
    );
    partial = true;
  }
  let sessions: GcSession[] = [];
  try {
    const sessionList = await gc.listSessions();
    sessions = sessionList.items;
    if (sessionList.partial === true || (sessionList.partial_errors?.length ?? 0) > 0) {
      logWarn(
        LOG_COMPONENT.links,
        `supervisor reported partial session list (${sessionList.partial_errors?.join(', ') ?? 'no detail'}); serving partial`,
      );
      partial = true;
    }
  } catch (err) {
    logWarn(LOG_COMPONENT.links, `session fetch failed; serving partial: ${errorMessage(err)}`);
    partial = true;
  }
  return { beads, sessions, partial, supervisorFetchedAt };
}
