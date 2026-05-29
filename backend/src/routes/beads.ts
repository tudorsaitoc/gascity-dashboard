import { Router } from 'express';
import type { Response } from 'express';
import type { GcBead, BeadUpdateInput } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import {
  execBeadAction as defaultExecBeadAction,
  ExecError,
} from '../exec.js';
import type { ExecResult } from '../exec.js';
import { recordAudit } from '../audit.js';
import { toWireExecError } from '../lib/sanitise-error.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';
import {
  routeInternalError,
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

import { BEAD_ID_RE } from '../lib/beadId.js';

// v0 hardcoded spam filter. Comments here are the load-bearing
// documentation — "why isn't bead X showing" has a file/line answer.
//   - issue_type in {feature, bug, task, docs}  : engineering work only
//   - NOT label starting 'gc:'                  : session/message noise
//   - NOT issue_type 'convoy'                   : auto-convoy trackers
//
// ?showAll=1 disables the filter for diagnostic cases.
function defaultBeadFilter(bead: GcBead): boolean {
  const allowedTypes = new Set(['feature', 'bug', 'task', 'docs']);
  if (!allowedTypes.has(bead.issue_type)) return false;
  if (Array.isArray(bead.labels) && bead.labels.some((l) => l.startsWith('gc:'))) {
    return false;
  }
  return true;
}

// td-7t24i6 fix: gc default /beads limit is 50, far below the city's working
// set (~2139 total, ~183 eng-only). Pull a wide window so the spam filter
// operates on the full set, not a 50-item slice. 1000 is well over the
// current ~183-item eng-only count and leaves headroom; safety cap in case
// the supervisor returns more.
const BEADS_FETCH_LIMIT = 1000;

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
   * stub. Replaces the former `execBeadAction(id, 'claim')` subprocess —
   * the supervisor exposes the write endpoint, so the dashboard adopts it.
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
      const { items, total } = await gc.listBeads(undefined, { limit: BEADS_FETCH_LIMIT });
      const showAll = req.query.showAll === '1';
      const filtered = showAll ? items : items.filter(defaultBeadFilter);
      res.json({
        items: filtered,
        total: filtered.length,
        // upstream_total: the store's total bead count (per gc's `total`
        // field). Diff between upstream_total and items.length tells the UI
        // how much was truncated by our fetch limit so the operator can see
        // when the window isn't covering everything.
        upstream_total: typeof total === 'number' ? total : undefined,
        upstream_fetched: items.length,
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
      // Supervisor quirk: workflow/orchestration beads (gc-NNNN ids) are
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
        res.status(404).json({ error: 'bead not found', kind: 'not_found' });
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
// {status:'in_progress', assignee:'stephanie'}, replacing the former
// `gc bd update` subprocess. Error mapping mirrors the maintainer sling
// handler: a true client-side timeout → 504, any other upstream failure
// (non-2xx from the supervisor, network error) → 502, with the same
// toWireInternal500 redaction (only details.name on the wire — the raw
// message can embed the supervisor URL / host).
async function runBeadClaim(
  beadId: string,
  res: Response,
  updateBead: NonNullable<BeadsRouterOptions['updateBead']>,
): Promise<void> {
  if (!BEAD_ID_RE.test(beadId)) {
    res.status(400).json({ error: 'invalid bead id', kind: 'validation' });
    return;
  }
  const startedAt = Date.now();
  try {
    await updateBead(beadId, { status: 'in_progress', assignee: 'stephanie' });
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
  try {
    const result = await execBeadAction(beadId, action, reason, cityPath);
    await recordAudit({
      type: 'dashboard.exec',
      endpoint: `POST /api/beads/:id/${action}`,
      parsed_args: { bead_id: beadId, ...(reason ? { reason } : {}) },
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
      res.status(502).json({
        error: `gc command failed with exit ${result.exitCode}`,
        kind: 'upstream',
        details: { name: 'NonZeroExit' },
      });
      return;
    }
    res.json({ ok: true, stdout: result.stdout.slice(0, 4096) });
  } catch (err) {
    if (err instanceof ExecError) {
      const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
      // gascity-dashboard-473: the 'spawn' kind wraps node's child_process
      // "spawn <abs-path> ENOENT" which exposes the operator's binary
      // layout. validation/timeout carry pre-authored safe strings by
      // ExecError construction (see backend/src/exec.ts), so they pass
      // through. journalctl retains the full message via the source-side
      // ExecError instantiation.
      if (err.kind === 'spawn') {
        logWarn(LOG_COMPONENT.beads, `runBeadAction spawn failed: ${err.message}`);
      }
      const wire = toWireExecError(err, status);
      res.status(wire.status).json(wire.body);
      return;
    }
    writeRouteError(res, routeInternalError(err, {
      component: LOG_COMPONENT.beads,
      operation: 'runBeadAction failed',
      responseError: 'internal error',
    }));
  }
}
