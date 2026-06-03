import { Router } from 'express';
import type {
  ContributorStat,
  MaintainerTriage,
} from 'gas-city-dashboard-shared';
import { decodeMaintainerSlingRecord } from 'gas-city-dashboard-shared';
import { recordAudit } from '../../../audit.js';
import { ExecError } from '../../../exec.js';
import {
  collectItems,
  fetchTriage as defaultFetchTriage,
} from './triage.js';
import { readCache, writeCache, type CacheReadResult } from './storage.js';
import { addSseClient, notifyRefresh, removeSseClient } from './sse.js';
import { writeExecError } from '../../../lib/sanitise-error.js';
import { LOG_COMPONENT } from '../../../logging.js';
import {
  routeInternalError,
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../../../route-errors.js';
import { applySlungOverlay } from './serve-overlay.js';
import { recordMaintainerSling } from './sling-dispatch.js';

const GH_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

// /api/maintainer routes — read the cached triage envelope or refresh it
// from `gh`. The refresh is on-demand for dev; the nightly worker (bead
// ar9) will eventually drive cache writes on its own cadence.

interface MaintainerRouterOptions {
  repo: string;
  cachePath: string;
  /**
   * Path to the active-sling-state JSON map (gascity-dashboard-9qs).
   * Required: the maintainer module's `needs(config)` is the single
   * source of truth for this derivation (PR-B1 / specs/architecture/maintainer-coupling-audit.md C2).
   * Callers must pass it explicitly — there is no longer a sibling-of-cachePath
   * fallback inside the router, so the worker and the route cannot drift.
   */
  slungStatePath: string;
  /**
   * Injected triage fetcher used by POST /refresh. Defaults to the
   * real `fetchTriage` from ../maintainer/triage. Tests pass a stub to
   * exercise failure-redaction contracts without spawning gh.
   */
  fetchTriage?: (repo: string) => Promise<MaintainerTriage>;
}

export function maintainerRouter({
  repo,
  cachePath,
  slungStatePath,
  fetchTriage = defaultFetchTriage,
}: MaintainerRouterOptions): Router {
  const router = Router();

  router.get('/triage', async (_req, res) => {
    let cache: CacheReadResult;
    try {
      cache = await readCache(cachePath);
    } catch (err) {
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.maintainer,
        operation: 'GET /api/maintainer/triage cache read failed',
        responseError: 'maintainer triage cache unavailable',
      }));
      return;
    }

    if (cache.status === 'ready') {
      const cached = cache.envelope;
      // Splice-at-read overlay (gascity-dashboard-9qs): hydrate item.slung
      // from the persisted slung-state file, then re-run isMarkCandidate +
      // selectOneMark over the modified candidate set so the maroon ●
      // reflects the latest slings without waiting for the worker tick
      // (6h default). Vetted items force slung=null (the agent already
      // delivered; slung was the placeholder while waiting).
      await applySlungOverlay(cached, slungStatePath);
      await recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/maintainer/triage',
        parsed_args: {
          repo,
          source: 'cache',
          items: String(countItems(cached)),
        },
        duration_ms: 0,
      });
      res.json(cached);
      return;
    }
    // No cache yet — synthesize an empty envelope so the page renders
    // calmly instead of erroring. The frontend already handles
    // computed_at=null + empty tiers as "enrichment not yet computed".
    const empty: MaintainerTriage = {
      computed_at: null,
      repo,
      tiers: [
        { tier: 'regression_breaking', clusters: [], unclustered: [] },
        { tier: 'regression', clusters: [], unclustered: [] },
        { tier: 'stability', clusters: [], unclustered: [] },
      ],
      totals: { issues_open: 0, prs_open: 0 },
    };
    await recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/maintainer/triage',
      parsed_args: { repo, source: 'empty', items: '0' },
      duration_ms: 0,
    });
    res.json(empty);
  });

  router.post('/refresh', async (_req, res) => {
    const start = Date.now();
    try {
      const envelope = await fetchTriage(repo);
      await writeCache(cachePath, envelope);
      notifyRefresh(envelope);
      await recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'POST /api/maintainer/refresh',
        parsed_args: {
          repo,
          items: String(countItems(envelope)),
        },
        duration_ms: Date.now() - start,
      });
      res.json(envelope);
    } catch (err) {
      if (err instanceof ExecError) {
        writeExecError(res, err, LOG_COMPONENT.maintainer, '/api/maintainer/refresh', {
          fallbackStatus: 502,
        });
        return;
      }
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.maintainer,
        operation: '/api/maintainer/refresh failed',
        responseError: 'failed to refresh maintainer triage',
        isTimeout: () => false,
      }));
    }
  });

  router.get('/events', (req, res) => {
    // SSE stream — fires a 'refreshed' event each time the cache is
    // rewritten (manual button or nightly worker). Frontend refetches
    // /triage on receipt. csrfValidate exempts GET, so this still
    // lives in the same writeRouter as the rest of /api/maintainer.
    addSseClient(res);
    req.on('close', () => removeSseClient(res));
  });

  router.post('/sling-record', async (req, res) => {
    const decoded = decodeMaintainerSlingRecord(req.body);
    if (decoded.status === 'error') {
      writeRouteError(res, routeValidationError(decoded.message));
      return;
    }
    const record = decoded.record;
    try {
      const { beadId } = await recordMaintainerSling(record, { repo, slungStatePath });
      // Wire/disk asymmetry on bead_id: persisted as null on disk
      // (isValidStateMap accepts null), returned to the client as
      // omitted-field via `?? undefined` so the response matches the
      // client's `bead_id?: string` contract (JSON.stringify drops
      // undefined). Disk keeps the explicit null to make field
      // presence machine-checkable.
      res.json({ ok: true, bead_id: beadId ?? undefined });
    } catch (err) {
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.maintainer,
        operation: '/api/maintainer/sling-record failed',
        responseError: 'failed to record maintainer sling',
        isTimeout: () => false,
      }));
    }
  });

  router.get('/contributor/:login', async (req, res) => {
    const login = req.params.login;
    if (!GH_LOGIN_RE.test(login)) {
      writeRouteError(res, routeValidationError('invalid login'));
      return;
    }
    // readCache throws on parse/shape-check failure (PR #31 contract).
    // Express 4 does NOT auto-catch async rejections in route handlers —
    // an uncaught rejection here would hang the request indefinitely
    // (gascity-dashboard-n8q3). Mirror the /triage handler's pattern
    // above: catch -> route through the centralised internal-error
    // helper so the operator gets a clean 500 + a log line.
    let cached: CacheReadResult;
    try {
      cached = await readCache(cachePath);
    } catch (err) {
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.maintainer,
        operation: 'GET /api/maintainer/contributor/:login cache read failed',
        responseError: 'maintainer contributor cache unavailable',
      }));
      return;
    }
    if (cached.status === 'missing') {
      res.status(404).json({ error: 'no triage cache yet', kind: 'not_found' });
      return;
    }
    // The same ContributorStat is sliced onto every item the author owns
    // in the envelope, so any item carrying this login has the answer.
    // Avoids a second source of truth.
    const stat = findContributor(cached.envelope, login);
    if (stat === null) {
      res.status(404).json({ error: 'contributor not in current envelope', kind: 'not_found' });
      return;
    }
    await recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/maintainer/contributor/:login',
      parsed_args: { login },
      duration_ms: 0,
    });
    res.json(stat);
  });

  return router;
}

function findContributor(envelope: MaintainerTriage, login: string): ContributorStat | null {
  for (const item of collectItems(envelope)) {
    if (item.author.login === login) return item.author;
  }
  return null;
}

function countItems(envelope: MaintainerTriage): number {
  const inTiers = collectItems(envelope).length;
  // Include the lifted slung section so the audit count reflects every
  // item served, not just those still in a tier (gascity-dashboard-2yr).
  return inTiers + (envelope.slung_section?.length ?? 0);
}
