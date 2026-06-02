import type { Response } from 'express';
import { Router } from 'express';
import {
  OPERATOR_DISPLAY_ALIAS,
  type BeadUpdateInput,
  type GcBead,
} from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';
import type { ExecResult } from '../exec.js';
import {
  execBeadAction as defaultExecBeadAction,
  ExecError,
} from '../exec.js';
import { GcClient } from '../gc-client.js';
import { HTTP_STATUS } from '../lib/http-status.js';
import { writeExecError } from '../lib/sanitise-error.js';
import { stripNonPrintable } from '../lib/strip-non-printable.js';
import { errorMessage, LOG_COMPONENT, logWarn } from '../logging.js';
import {
  routeInternalError,
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

import { BEAD_ID_RE } from '../lib/beadId.js';

// The dashboard's "real work" issue types — engineering work only. Used both
// to scope the server-side fetch (one supervisor query per type, since its
// `type` filter is single-valued) and by defaultBeadFilter's type gate.
// Exported so the route's fan-out and the filter share one source of truth.
export const ENG_BEAD_TYPES = ['feature', 'bug', 'task', 'docs'] as const;

const ENG_TYPE_SET: ReadonlySet<string> = new Set(ENG_BEAD_TYPES);

// v0 hardcoded spam filter. Comments here are the load-bearing
// documentation — "why isn't bead X showing" has a file/line answer.
//   - issue_type in ENG_BEAD_TYPES              : engineering work only
//   - NOT label starting 'gc:'                  : session/message noise
//   - NOT issue_type 'convoy'                   : auto-convoy trackers
//
// ?showAll=1 disables the filter for diagnostic cases.
//
// This is the dashboard's canonical "real work" predicate — it mirrors the
// supervisor's `gc bd stats → "Ready to Work"` by dropping bookkeeping beads
// (slack/extmsg + nudge carry `gc:` labels; mail is issue_type 'message';
// sessions 'session'; convoy 'convoy'; nudge 'chore'). Exported so the
// exclusion contract is unit-testable (#33).
//
// The list route now fetches by type server-side, so the type gate is
// usually redundant by the time a bead reaches here — but gc:-labelled
// noise (e.g. gc:extmsg-* beads are issue_type 'task') is type-matched and
// can only be excluded client-side, since the supervisor's `label` param is
// a positive match and can't express exclusion. Keep the full predicate.
export function defaultBeadFilter(bead: GcBead): boolean {
  if (!ENG_TYPE_SET.has(bead.issue_type)) return false;
  if (Array.isArray(bead.labels) && bead.labels.some((l) => l.startsWith('gc:'))) {
    return false;
  }
  return true;
}

// Per-type fetch ceiling. The route queries each ENG_BEAD_TYPES value
// independently, so this caps a single type, not the whole store. The
// 'task' type is the largest (it carries gc:extmsg-* noise the spam filter
// then drops); 2000 leaves comfortable headroom over its current ~935 count.
// A limit is a ceiling, not a fetch size — the supervisor returns min(total,
// limit) — so generous headroom costs nothing when actual counts are lower.
const BEADS_FETCH_LIMIT = 2000;

interface BeadsRouterOptions {
  /**
   * Injected `gc bd <close|nudge>` runner. Defaults to the real exec
   * wrapper; tests pass a stub. CLOSE and NUDGE stay on the CLI by design
   * (gascity-dashboard-mq2): the supervisor's HTTP `/bead/{id}/close` has no
   * reason field — which the dashboard's close-reason UI depends on — and no
   * HTTP route exists for agent NUDGE at all. The CLAIM path moved to the
   * `updateBead` HTTP fn below.
   */
  execBeadAction?: (
    beadId: string,
    action: 'close' | 'nudge',
    reason?: string,
    cityPath?: string,
  ) => Promise<ExecResult>;
  /**
   * Injected bead-CLAIM runner (gascity-dashboard-mq2). Production wires
   * `gc.updateBead` (GcClient HTTP `PATCH /bead/{id}`); tests pass a
   * stub. The supervisor exposes the write endpoint, so the dashboard
   * adopts it directly.
   * Mirrors the maintainerRouter.sling DI pattern (gascity-dashboard-mq2).
   */
  updateBead?: (id: string, body: BeadUpdateInput) => Promise<void>;
}

export function beadsRouter(
  gc: GcClient,
  cityPath: string,
  opts: BeadsRouterOptions = {},
): Router {
  const execBeadAction = opts.execBeadAction ?? defaultExecBeadAction;
  const updateBead = opts.updateBead ?? ((id, body) => gc.updateBead(id, body));
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const showAll = req.query.showAll === '1';
      if (showAll) {
        // Diagnostic path: pull the wide unfiltered window (bookkeeping beads
        // included) in a single call. Truncation against the whole-store
        // total is expected and reported via the coverage counters below.
        const { items, total } = await gc.listBeads(undefined, { limit: BEADS_FETCH_LIMIT });
        res.json({
          items,
          total: items.length,
          upstream_total: typeof total === 'number' ? total : undefined,
          upstream_fetched: items.length,
          fetch_limit: BEADS_FETCH_LIMIT,
        });
        return;
      }

      // Real-work path: fetch only engineering types server-side — one query
      // per type, since the supervisor's `type` filter is single-valued —
      // then drop gc:-labelled noise client-side. This scopes the fetch to
      // the ~969-bead eng working set instead of the ~1604-bead store, so the
      // coverage warning only fires on genuine engineering-work truncation.
      const perType = await Promise.all(
        ENG_BEAD_TYPES.map((type) =>
          gc.listBeads(undefined, { limit: BEADS_FETCH_LIMIT, type }),
        ),
      );
      const merged = perType.flatMap((r) => r.items);
      const filtered = merged.filter(defaultBeadFilter);
      // upstream_total: the engineering working set's size (sum of per-type
      // totals). Diff vs upstream_fetched tells the UI when a single type
      // overflowed BEADS_FETCH_LIMIT and engineering work sits past the window.
      const upstreamTotal = perType.reduce(
        (sum, r) => sum + (typeof r.total === 'number' ? r.total : r.items.length),
        0,
      );
      res.json({
        items: filtered,
        total: filtered.length,
        upstream_total: upstreamTotal,
        upstream_fetched: merged.length,
        fetch_limit: BEADS_FETCH_LIMIT,
      });
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.beads,
        operation: '/api/beads failed',
        responseError: 'failed to list beads',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  // Single bead read-through for the click-to-detail modal. Uses the same
  // BEAD_ID_RE as the write side — supervisor's id space is one alphabet.
  router.get('/:id', async (req, res) => {
    const id = req.params.id;
    if (!BEAD_ID_RE.test(id)) {
      writeRouteError(res, routeValidationError('invalid bead id'));
      return;
    }
    try {
      const bead = await gc.getBead(id);
      res.json(bead);
    } catch (err) {
      const msg = (err as Error).message;
      // Supervisor quirk: run/orchestration beads (gc-NNNN ids) are
      // returned by /beads but 404 on /bead/{id}. Fall back to a list scan
      // so the modal works on every bead the user can see in any list.
      // The list call is coalesced by GcClient.getJson, so concurrent
      // fallbacks share one upstream request.
      //
      // Note: timeout-vs-other-upstream-failure routing is handled
      // exclusively by routeUpstreamError via its isTimeout option below.
      if (/\b404\b/.test(msg)) {
        try {
          const list = await gc.listBeads(undefined, { limit: 2000 });
          const hit = list.items.find((b) => b.id === id);
          if (hit) {
            res.json(hit);
            return;
          }
        } catch (fallbackErr) {
          logWarn(LOG_COMPONENT.beads, `/api/beads/:id list fallback failed: ${errorMessage(fallbackErr)}`);
          // fall through to the 404 below
        }
        res.status(HTTP_STATUS.notFound).json({ error: 'bead not found', kind: 'not_found' });
        return;
      }
      // gascity-dashboard-ayr: same redaction rationale as the list-beads
      // handler above. err.name only on the wire; msg already holds the
      // full message from the 404-fallback extraction at the top of the
      // catch block — log it, don't ship it to the browser.
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.beads,
        operation: '/api/beads/:id failed',
        responseError: 'failed to fetch bead',
        isTimeout: GcClient.isTimeoutError,
      }));
    }
  });

  router.post('/:id/claim', async (req, res) => {
    await runBeadClaim(req.params.id, res, updateBead);
  });

  router.post('/:id/close', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await runBeadAction(req.params.id, 'close', reason, res, execBeadAction, cityPath);
  });

  router.post('/:id/nudge', async (req, res) => {
    await runBeadAction(req.params.id, 'nudge', undefined, res, execBeadAction, cityPath);
  });

  return router;
}

// Bead CLAIM over HTTP (gascity-dashboard-mq2): PATCH /bead/{id} with
// {status:'in_progress', assignee: OPERATOR_DISPLAY_ALIAS}. Error mapping mirrors the
// maintainer sling handler: a true client-side timeout → 504, any other
// upstream failure (non-2xx from the supervisor, network error) → 502,
// with the same toWireInternal500 redaction (only details.name on the wire —
// the raw message can embed the supervisor URL / host).
async function runBeadClaim(
  beadId: string,
  res: Response,
  updateBead: NonNullable<BeadsRouterOptions['updateBead']>,
): Promise<void> {
  if (!BEAD_ID_RE.test(beadId)) {
    res.status(HTTP_STATUS.badRequest).json({ error: 'invalid bead id', kind: 'validation' });
    return;
  }
  const startedAt = Date.now();
  try {
    await updateBead(beadId, { status: 'in_progress', assignee: OPERATOR_DISPLAY_ALIAS });
    await recordAudit({
      type: 'dashboard.exec',
      endpoint: 'POST /api/beads/:id/claim',
      parsed_args: { bead_id: beadId },
      duration_ms: Date.now() - startedAt,
    });
    res.json({ ok: true });
  } catch (err) {
    const isTimeout = GcClient.isTimeoutError(err);
    await recordAudit({
      type: 'dashboard.exec',
      endpoint: 'POST /api/beads/:id/claim',
      parsed_args: {
        bead_id: beadId,
        error_kind: isTimeout ? 'timeout' : 'upstream',
      },
      duration_ms: Date.now() - startedAt,
    });
    writeRouteError(res, routeUpstreamError(err, {
      component: LOG_COMPONENT.beads,
      operation: '/api/beads/:id/claim failed',
      responseError: 'failed to claim bead',
      timeoutError: 'gc supervisor timed out',
      isTimeout: GcClient.isTimeoutError,
    }));
  }
}

async function runBeadAction(
  beadId: string,
  action: 'close' | 'nudge',
  reason: string | undefined,
  res: Response,
  execBeadAction: NonNullable<BeadsRouterOptions['execBeadAction']>,
  cityPath: string,
): Promise<void> {
  if (!BEAD_ID_RE.test(beadId)) {
    writeRouteError(res, routeValidationError('invalid bead id'));
    return;
  }
  // gascity-dashboard-htrz: the close-reason is the only operator-controlled
  // free-text that reaches a subprocess arg (`bd close --reason`) and the
  // audit log. Strip control/escape/bidi bytes here, BEFORE both sinks, so a
  // browser-supplied reason cannot forge a terminal-escape sequence into the
  // `gc bd` output or inject a fake line/row into .gc/events.jsonl.
  const safeReason =
    reason !== undefined ? stripNonPrintable(reason) : undefined;
  try {
    const result = await execBeadAction(beadId, action, safeReason, cityPath);
    await recordAudit({
      type: 'dashboard.exec',
      endpoint: `POST /api/beads/:id/${action}`,
      parsed_args: { bead_id: beadId, ...(safeReason ? { reason: safeReason } : {}) },
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });
    if (result.exitCode !== 0) {
      // gascity-dashboard-i0b: do NOT echo raw stderr on the wire. gc's
      // stderr is implementation-defined and can embed host paths / socket
      // paths / ENOENT. Mirror the i53 (agents.ts) + 473 catch-arm pattern:
      // stderr stays server-side in the operational log; the wire
      // carries kind + a fixed message plus details:{name} for shape parity
      // with the catch-all 500.
      logWarn(
        LOG_COMPONENT.beads,
        `runBeadAction ${action} non-zero exit ${result.exitCode}: ${result.stderr}`,
      );
      res.status(HTTP_STATUS.badGateway).json({
        error: `gc command failed with exit ${result.exitCode}`,
        kind: 'upstream',
        details: { name: 'NonZeroExit' },
      });
      return;
    }
    res.json({ ok: true, stdout: result.stdout.slice(0, 4096) });
  } catch (err) {
    if (err instanceof ExecError) {
      writeExecError(res, err, LOG_COMPONENT.beads, 'runBeadAction');
      return;
    }
    writeRouteError(res, routeInternalError(err, {
      component: LOG_COMPONENT.beads,
      operation: 'runBeadAction failed',
      responseError: 'internal error',
    }));
  }
}
