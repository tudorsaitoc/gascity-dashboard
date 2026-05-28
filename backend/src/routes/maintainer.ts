import path from 'node:path';
import { Router } from 'express';
import type {
  ContributorStat,
  GcSession,
  MaintainerTriage,
  SlingInput,
  SlingResponse,
  TriageItem,
} from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';
import { AGENT_ALIAS_RE, ExecError } from '../exec.js';
import { GcClient } from '../gc-client.js';
import {
  collectItems,
  fetchTriage as defaultFetchTriage,
  selectOneMark,
} from '../maintainer/triage.js';
import { readCache, writeCache, type CacheReadResult } from '../maintainer/storage.js';
import { isMarkCandidate } from '../maintainer/classifier.js';
import { resolveTargetToSession } from '../maintainer/resolve-target.js';
import {
  readSlungState,
  slungKey,
  writeSlungEntry,
} from '../maintainer/slung-state.js';
import { addSseClient, notifyRefresh, removeSseClient } from '../maintainer/sse.js';
import { toWireExecError } from '../lib/sanitise-error.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';
import {
  routeInternalError,
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

const GH_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+$/;
const MAX_URL_LEN = 2_048;

type SlingIntent = 'review' | 'draft' | 'triage';
type SlingKind = 'pr' | 'issue';

// /api/maintainer routes — read the cached triage envelope or refresh it
// from `gh`. The refresh is on-demand for dev; the nightly worker (bead
// ar9) will eventually drive cache writes on its own cadence.

interface MaintainerRouterOptions {
  repo: string;
  cachePath: string;
  /**
   * Path to the active-sling-state JSON map (gascity-dashboard-9qs).
   * Defaults to a sibling of cachePath when omitted so callers that
   * predate this option don't need to thread a separate config.
   */
  slungStatePath?: string;
  /** Default `gc sling` target when the request omits one. From config. */
  slingTarget: string;
  /**
   * Override `gc sling` target when intent='triage' and the request
   * omits an explicit target. Defaults to slingTarget when unset so a
   * caller that doesn't pass this option keeps the original
   * single-target behaviour. From config.maintainerTriageTarget.
   */
  triageTarget?: string;
  /**
   * Injected sling runner (gascity-dashboard-mq2). Production wires
   * `gc.sling` (GcClient HTTP POST /sling); tests pass a stub. Replaces the
   * former `execGcSling` subprocess DI — the supervisor exposes the write
   * endpoint directly, so the route no longer shells the gc CLI, parses
   * stdout, or threads `--city` (the city is in the request URL path).
   */
  sling: (input: SlingInput) => Promise<SlingResponse>;
  /**
   * Injected triage fetcher used by POST /refresh. Defaults to the
   * real `fetchTriage` from ../maintainer/triage. Tests pass a stub to
   * exercise failure-redaction contracts without spawning gh. Mirrors
   * the execGcSling DI pattern already established here.
   */
  fetchTriage?: (repo: string) => Promise<MaintainerTriage>;
  /**
   * Injected supervisor sessions fetcher (gascity-dashboard-55b). Used
   * to resolve the configured sling target role (e.g. 'chief-of-staff')
   * to a concrete session_name at write time so the frontend's inline
   * 'slung →' link lands on a real AgentDetail route instead of 404ing
   * on the role label. Production wires gc.listSessions; tests pass a
   * stub. When unset OR when the call fails, the route persists
   * `resolved_session_name: null` and the slung itself still succeeds —
   * the frontend then surfaces an inline 'no session for role X' error
   * instead of a clickable link.
   */
  listSessions?: () => Promise<readonly GcSession[]>;
}

export function maintainerRouter({
  repo,
  cachePath,
  slungStatePath = defaultSlungStatePath(cachePath),
  slingTarget,
  triageTarget,
  sling,
  fetchTriage = defaultFetchTriage,
  listSessions,
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
    void recordAudit({
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
        const status =
          err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 502;
        // gascity-dashboard-473: the 'spawn' kind wraps node's
        // child_process "spawn <abs-path> ENOENT" which exposes the
        // operator's PATH layout. validation/timeout carry pre-authored
        // safe strings by ExecError construction (see backend/src/exec.ts),
        // so they pass through.
        if (err.kind === 'spawn') {
          logWarn(LOG_COMPONENT.maintainer, `/api/maintainer/refresh spawn failed: ${err.message}`);
        }
        const wire = toWireExecError(err, status);
        res.status(wire.status).json(wire.body);
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

  router.post('/sling', async (req, res) => {
    const body = req.body as {
      kind?: unknown;
      number?: unknown;
      html_url?: unknown;
      intent?: unknown;
      target?: unknown;
    };

    if (!isSlingKind(body.kind)) {
      writeRouteError(res, routeValidationError('invalid kind (pr|issue)'));
      return;
    }
    if (!isSlingIntent(body.intent)) {
      writeRouteError(res, routeValidationError('invalid intent (review|draft|triage)'));
      return;
    }
    if (
      typeof body.number !== 'number' ||
      !Number.isInteger(body.number) ||
      body.number < 1 ||
      // GitHub's effective ceiling for issue / PR numbers. Above this is
      // either a crafted request or a typo; either way it can't reference
      // a real upstream item, so reject before it lands in slung-state.
      body.number > 2_147_483_647
    ) {
      writeRouteError(res, routeValidationError('invalid number'));
      return;
    }
    if (
      typeof body.html_url !== 'string' ||
      body.html_url.length > MAX_URL_LEN
    ) {
      writeRouteError(res, routeValidationError('invalid html_url'));
      return;
    }
    const urlMatch = GH_URL_RE.exec(body.html_url);
    if (urlMatch === null) {
      writeRouteError(res, routeValidationError('invalid html_url'));
      return;
    }
    // Cross-check: kind='pr' must point at /pull/, kind='issue' at /issues/.
    // Closes the "review PR <issues/47>" semantic footgun.
    const urlPath = urlMatch[1];
    const expected = body.kind === 'pr' ? 'pull' : 'issues';
    if (urlPath !== expected) {
      writeRouteError(res, routeValidationError('kind/html_url mismatch'));
      return;
    }
    // Intent-aware default target: 'triage' routes to chief-of-staff
    // (config.maintainerTriageTarget) by default so the bulk-sling action
    // bar can fan out without each request needing to know the operator's
    // routing preference. review/draft keep the generic sling target.
    let target =
      body.intent === 'triage' && triageTarget !== undefined ? triageTarget : slingTarget;
    if (body.target !== undefined) {
      if (typeof body.target !== 'string' || !AGENT_ALIAS_RE.test(body.target)) {
        writeRouteError(res, routeValidationError('invalid target alias'));
        return;
      }
      target = body.target;
    }

    const beadText = composeBeadText(body.intent, body.html_url);
    const startedAt = Date.now();
    try {
      const result = await sling({ target, bead: beadText });
      // root_bead_id is the routed bead the supervisor created — the JSON
      // replacement for the old `^Slung <id>` stdout parse. `bead` is a
      // fallback if a future supervisor omits root_bead_id; null when
      // neither is present (slung-state tolerates a null bead_id).
      const beadId = result.root_bead_id ?? result.bead ?? null;
      void recordAudit({
        type: 'dashboard.sling',
        endpoint: 'POST /api/maintainer/sling',
        parsed_args: {
          kind: body.kind,
          number: String(body.number),
          intent: body.intent,
          target,
          text_len: String(beadText.length),
        },
        duration_ms: Date.now() - startedAt,
      });
      // Persist active slung state so subsequent GET /triage requests
      // exclude this item from the One Mark and surface the inline
      // workflow link (gascity-dashboard-9qs). Failed slings (above
      // non-zero-exit branch) deliberately don't write — slung state
      // means "agent has the work."
      //
      // gascity-dashboard-55b: resolve the target role (e.g.
      // 'chief-of-staff') to a concrete session_name BEFORE persisting
      // so the frontend renders a real /agents/<session_name> link
      // instead of /agents/<role-label> (which 404s in AgentDetail's
      // strict resolver). listSessions failure is non-fatal: we persist
      // resolved_session_name=null and the renderer surfaces an inline
      // 'no session for role X' error. The sling already routed; the
      // link is a navigational courtesy, not a correctness invariant.
      const resolvedSessionName = await resolveTargetSafely(target, listSessions);
      try {
        await writeSlungEntry(slungStatePath, slungKey(body.kind, body.number), {
          slung_at: new Date().toISOString(),
          target,
          bead_id: beadId,
          resolved_session_name: resolvedSessionName,
        });
      } catch (slungErr) {
        // Slung-state write failure is non-fatal: the sling itself
        // succeeded, the audit row is in place, the operator just
        // won't see the One Mark move until the next refresh. Log
        // and continue rather than 500ing on a downstream-of-success
        // disk hiccup.
        logWarn(
          LOG_COMPONENT.maintainer,
          `slung-state write failed (sling succeeded): ${errorMessage(slungErr)}`,
        );
      }
      // Push connected clients to refetch so the One Mark moves
      // visibly within ~1s of the click rather than waiting for the
      // 6h worker tick. The frontend SSE handler ignores the payload
      // (it just triggers a refetch), so we stamp a minimal meta —
      // computed_at: null signals "this is a serve-time refresh, not
      // a re-compose" without lying about the cache's freshness.
      notifyRefresh({ computed_at: null, repo });
      // Wire/disk asymmetry on bead_id: persisted as null on disk
      // (isValidStateMap accepts null), returned to the client as
      // omitted-field via `?? undefined` so the response matches the
      // client's `bead_id?: string` contract (JSON.stringify drops
      // undefined). Disk keeps the explicit null to make field
      // presence machine-checkable.
      res.json({ ok: true, bead_id: beadId ?? undefined });
    } catch (err) {
      // gascity-dashboard-ur0: thrown errors must also leave an audit row.
      // Timeouts in particular are operationally significant — the
      // success path already audits, so failing to audit throws would
      // create an asymmetric forensic record where the most-interesting
      // failure mode (the supervisor hung) leaves no trace in events.jsonl.
      const isTimeout = GcClient.isTimeoutError(err);
      void recordAudit({
        type: 'dashboard.sling',
        endpoint: 'POST /api/maintainer/sling',
        parsed_args: {
          kind: body.kind,
          number: String(body.number),
          intent: body.intent,
          target,
          text_len: String(beadText.length),
          error_kind: isTimeout ? 'timeout' : 'upstream',
        },
      });
      // gascity-dashboard-mq2: the sling is now an HTTP POST to the
      // supervisor. A true client-side timeout maps to 504; any other
      // failure (non-2xx from the supervisor, network error) maps to 502
      // upstream. The raw message can embed the supervisor URL / host
      // (GcClient throws `gc supervisor returned NNN`; fetch errors embed
      // host:port), so it stays server-side in the centralized route log.
      writeRouteError(res, routeUpstreamError(err, {
        component: LOG_COMPONENT.maintainer,
        operation: '/api/maintainer/sling failed',
        responseError: 'gc sling failed',
        timeoutError: 'gc supervisor timed out',
        isTimeout: GcClient.isTimeoutError,
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
    void recordAudit({
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
  for (const tier of envelope.tiers) {
    for (const item of [...tier.unclustered, ...tier.clusters.flatMap((c) => c.items)]) {
      if (item.author.login === login) return item.author;
    }
  }
  return null;
}

// ── Sling dispatch (gascity-dashboard-ib5) ───────────────────────────
//
// Composes a per-intent bead text from the request body, dispatches via
// `gc sling`, and audit-logs. The exec fn is DI'd through router options
// so tests can stub. Audit row records only metadata + lengths — never
// the rendered text body (events.jsonl noise control).

function isSlingIntent(v: unknown): v is SlingIntent {
  return v === 'review' || v === 'draft' || v === 'triage';
}

function isSlingKind(v: unknown): v is SlingKind {
  return v === 'pr' || v === 'issue';
}

function composeBeadText(intent: SlingIntent, htmlUrl: string): string {
  switch (intent) {
    case 'review':
      return `Please review PR ${htmlUrl}`;
    case 'draft':
      return `Please draft a PR addressing ${htmlUrl}`;
    case 'triage':
      return `Please triage ${htmlUrl}`;
  }
}

function countItems(envelope: MaintainerTriage): number {
  const inTiers = envelope.tiers.reduce(
    (n, tier) =>
      n +
      tier.unclustered.length +
      tier.clusters.reduce((m, c) => m + c.items.length, 0),
    0,
  );
  // Include the lifted slung section so the audit count reflects every
  // item served, not just those still in a tier (gascity-dashboard-2yr).
  return inTiers + (envelope.slung_section?.length ?? 0);
}

// ── Slung-state overlay (gascity-dashboard-9qs) ──────────────────────

function defaultSlungStatePath(cachePath: string): string {
  // Sibling of the envelope cache so a single state-dir holds the
  // maintainer's persisted bookkeeping.
  return path.join(path.dirname(cachePath), 'slung-state.json');
}

/**
 * Resolves the configured `gc sling` target role to a concrete session
 * name (gascity-dashboard-55b). Wraps both the absence of the
 * listSessions injection AND any error it might throw — both cases
 * return null so the slung-state entry persists with
 * resolved_session_name=null. The frontend then renders an inline
 * 'no session for role X' error instead of producing a 404-bound link
 * built from the raw role label.
 *
 * This is deliberately separate from resolveTargetToSession itself:
 * the pure resolver shouldn't know about DI or supervisor failure
 * modes; the route handler owns the safety wrapping.
 */
async function resolveTargetSafely(
  target: string,
  listSessions: (() => Promise<readonly GcSession[]>) | undefined,
): Promise<string | null> {
  if (listSessions === undefined) return null;
  try {
    const sessions = await listSessions();
    return resolveTargetToSession(target, sessions);
  } catch (err) {
    // Supervisor unreachable / 5xx / timeout — log and degrade. The
    // sling itself still routed (gc sling is a separate subprocess
    // path; we got here because exitCode === 0). The operator just
    // won't get a clickable link on this entry until the next
    // successful sling refreshes the resolution.
    logWarn(
      LOG_COMPONENT.maintainer,
      `sling target resolution failed (sling succeeded, link will surface 'no session for role' error): ${errorMessage(err)}`,
    );
    return null;
  }
}

/**
 * Mutates the cached envelope in place to reflect the latest slung
 * state. Order matters:
 *   1. Hydrate item.slung from the file (vetted-overrides-slung: a
 *      vetted item is not in flight even if the file says otherwise;
 *      the worker sweep eventually purges those entries from disk,
 *      this is the serve-side guarantee).
 *   2. Re-evaluate isMarkCandidate per item so item.is_marked
 *      reflects the slung filter. Tier was set at compose time and
 *      doesn't change here.
 *   3. Re-run selectOneMark across all items so the maroon ● lands
 *      on the next non-slung candidate.
 *
 * readSlungState swallows its own IO + parse errors and returns {},
 * so a corrupt slung-state file can't 502 the route.
 */
async function applySlungOverlay(
  envelope: MaintainerTriage,
  slungStatePath: string,
): Promise<void> {
  const state = await readSlungState(slungStatePath);
  const allItems = collectItems(envelope);
  const slung: TriageItem[] = [];
  for (const item of allItems) {
    const persisted = state[slungKey(item.kind, item.number)];
    // Active slung: a persisted entry AND not yet vetted. Vetted items
    // force slung=null (the agent already delivered; slung was the
    // placeholder while waiting) and stay in their tier.
    const active = persisted !== undefined && item.triage_assessment == null;
    item.slung = active ? persisted : null;
    item.is_marked = item.tier !== null && isMarkCandidate(item, item.tier);
    if (active) slung.push(item);
  }
  // Winnow the One Mark BEFORE lifting slung items out of the tiers.
  // selectOneMark reads the flat list (not tier membership), and slung
  // items already have is_marked=false (isMarkCandidate excludes them),
  // so the mark lands on the top surviving in-tier candidate.
  selectOneMark(allItems);
  // Lift active-slung items out of their tier rows into a dedicated
  // section (gascity-dashboard-2yr) so the operator sees the in-flight
  // batch as a group instead of inline markers. Most-recent sling on top.
  if (slung.length > 0) {
    removeItemsFromTiers(envelope, slung);
    slung.sort((a, b) =>
      (b.slung?.slung_at ?? '').localeCompare(a.slung?.slung_at ?? ''),
    );
  }
  envelope.slung_section = slung;
}

/**
 * Remove the given items (by kind:number identity) from every tier's
 * clusters and unclustered lists, dropping any cluster left empty so the
 * UI never renders a zero-row cluster block. Rebuilds each tier's arrays
 * (and each cluster object) rather than splicing in place — but does
 * reassign `tier.clusters` / `tier.unclustered`, so the envelope itself
 * is mutated, consistent with applySlungOverlay's serve-time overlay
 * pattern (collectItems hands back live references it edits in place).
 * Used by applySlungOverlay to lift slung items into their own section.
 */
function removeItemsFromTiers(
  envelope: MaintainerTriage,
  toRemove: readonly TriageItem[],
): void {
  const keys = new Set(toRemove.map((it) => slungKey(it.kind, it.number)));
  const keep = (it: TriageItem): boolean => !keys.has(slungKey(it.kind, it.number));
  for (const tier of envelope.tiers) {
    tier.clusters = tier.clusters
      .map((cluster) => ({ ...cluster, items: cluster.items.filter(keep) }))
      .filter((cluster) => cluster.items.length > 0);
    tier.unclustered = tier.unclustered.filter(keep);
  }
}
