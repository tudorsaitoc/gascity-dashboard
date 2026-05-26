import { Router } from 'express';
import type { GcBead } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import {
  execBeadAction as defaultExecBeadAction,
  ExecError,
} from '../exec.js';
import type { ExecResult } from '../exec.js';
import { recordAudit } from '../audit.js';
import { toWireExecError, toWireInternal500 } from '../lib/sanitise-error.js';

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

import { BEAD_ID_RE } from '../lib/beadId.js';

// td-7t24i6 fix: gc default /beads limit is 50, far below the city's working
// set (~2139 total, ~183 eng-only). Pull a wide window so the spam filter
// operates on the full set, not a 50-item slice. 1000 is well over the
// current ~183-item eng-only count and leaves headroom; safety cap in case
// the supervisor returns more.
const BEADS_FETCH_LIMIT = 1000;

interface BeadsRouterOptions {
  /**
   * Injected `gc bd <claim|close|nudge>` runner. Defaults to the real
   * exec wrapper; tests pass a stub. Mirrors the DI pattern established
   * by maintainerRouter.execGcSling (gascity-dashboard-ib5). This is the
   * live "agent-nudge" path: POST /api/beads/:id/nudge → execBeadAction(id,
   * 'nudge') → `gc bd nudge <id>`.
   */
  execBeadAction?: (
    beadId: string,
    action: 'claim' | 'close' | 'nudge',
    reason?: string,
    cityPath?: string,
  ) => Promise<ExecResult>;
}

export function beadsRouter(
  gc: GcClient,
  cityPath: string,
  opts: BeadsRouterOptions = {},
): Router {
  const execBeadAction = opts.execBeadAction ?? defaultExecBeadAction;
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
      if (GcClient.isTimeoutError(err)) {
        res.status(504).json({
          error: 'gc supervisor did not respond in time',
          kind: 'upstream-timeout',
        });
        return;
      }
      // gascity-dashboard-ayr: mirror the sr6 redaction. err.message from
      // fetch-level failures embeds OS detail (ECONNREFUSED, host:port);
      // details.name (Error class) is the only safe channel for the browser.
      console.warn(`[beads] /api/beads failed: ${(err as Error).message}`);
      const wire = toWireInternal500(err, {
        status: 502,
        error: 'failed to list beads',
        kind: 'upstream',
      });
      res.status(wire.status).json(wire.body);
    }
  });

  // Single bead read-through for the click-to-detail modal. Uses the same
  // BEAD_ID_RE as the write side — supervisor's id space is one alphabet.
  router.get('/:id', async (req, res) => {
    const id = req.params.id;
    if (!BEAD_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid bead id', kind: 'validation' });
      return;
    }
    try {
      const bead = await gc.getBead(id);
      res.json(bead);
    } catch (err) {
      if (GcClient.isTimeoutError(err)) {
        res.status(504).json({ error: 'gc supervisor did not respond in time', kind: 'upstream-timeout' });
        return;
      }
      const msg = (err as Error).message;
      // Supervisor quirk: workflow/orchestration beads (gc-NNNN ids) are
      // returned by /beads but 404 on /bead/{id}. Fall back to a list scan
      // so the modal works on every bead the user can see in any list.
      // The list call is coalesced by GcClient.getJson, so concurrent
      // fallbacks share one upstream request.
      if (/\b404\b/.test(msg)) {
        try {
          const list = await gc.listBeads(undefined, { limit: 2000 });
          const hit = list.items.find((b) => b.id === id);
          if (hit) {
            res.json(hit);
            return;
          }
        } catch {
          // fall through to the 404 below
        }
        res.status(404).json({ error: 'bead not found', kind: 'not_found' });
        return;
      }
      // gascity-dashboard-ayr: same redaction rationale as the list-beads
      // handler above. err.name only on the wire; msg already holds the
      // full message from the 404-fallback extraction at the top of the
      // catch block — log it for journalctl, don't ship it to the browser.
      console.warn(`[beads] /api/beads/:id failed: ${msg}`);
      const wire = toWireInternal500(err, {
        status: 502,
        error: 'failed to fetch bead',
        kind: 'upstream',
      });
      res.status(wire.status).json(wire.body);
    }
  });

  router.post('/:id/claim', async (req, res) => {
    await runBeadAction(req.params.id, 'claim', undefined, res, execBeadAction, cityPath);
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

async function runBeadAction(
  beadId: string,
  action: 'claim' | 'close' | 'nudge',
  reason: string | undefined,
  res: import('express').Response,
  execBeadAction: NonNullable<BeadsRouterOptions['execBeadAction']>,
  cityPath: string,
): Promise<void> {
  if (!BEAD_ID_RE.test(beadId)) {
    res.status(400).json({ error: 'invalid bead id', kind: 'validation' });
    return;
  }
  try {
    const result = await execBeadAction(beadId, action, reason, cityPath);
    void recordAudit({
      type: 'dashboard.exec',
      endpoint: `POST /api/beads/:id/${action}`,
      parsed_args: { bead_id: beadId, ...(reason ? { reason } : {}) },
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });
    if (result.exitCode !== 0) {
      res.status(502).json({
        error: `gc command failed with exit ${result.exitCode}`,
        kind: 'upstream',
        details: { stderr: result.stderr.slice(0, 1024) },
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
        console.warn(`[beads] runBeadAction spawn failed: ${err.message}`);
      }
      const wire = toWireExecError(err, status);
      res.status(wire.status).json(wire.body);
      return;
    }
    // gascity-dashboard-473: mirror the ayr sr6 redaction. Raw err.message
    // from unexpected throws can embed OS detail; details.name (Error
    // class) is the only safe channel for the browser.
    console.warn(`[beads] runBeadAction failed: ${(err as Error).message}`);
    const wire = toWireInternal500(err, {
      status: 500,
      error: 'internal error',
      kind: 'internal',
    });
    res.status(wire.status).json(wire.body);
  }
}
