import path from 'node:path';
import { Router } from 'express';
import type {
  ContributorStat,
  MaintainerTriage,
} from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';
import {
  AGENT_ALIAS_RE,
  ExecError,
  execGcSling as defaultExecGcSling,
} from '../exec.js';
import type { ExecResult } from '../exec.js';
import { collectItems, fetchTriage, selectOneMark } from '../maintainer/triage.js';
import { readCache, writeCache } from '../maintainer/storage.js';
import { isMarkCandidate } from '../maintainer/classifier.js';
import {
  readSlungState,
  slungKey,
  writeSlungEntry,
} from '../maintainer/slung-state.js';
import { addSseClient, notifyRefresh, removeSseClient } from '../maintainer/sse.js';

const GH_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+$/;
const MAX_URL_LEN = 2_048;
// gascity-dashboard-wds: gc sling emits a multi-line envelope; only the
// trailing "Slung <id> ..." line uniquely identifies the routed bead.
// Earlier lines ("Created <id>", "Auto-convoy <id>", "Attached wisp <id>")
// each carry an id but refer to the create/wisp/convoy steps, and
// "Created" recurs 3+ times in multi-bead workflows. The wave-8nj regex
// anchored on "created bead <id>", a shape gc sling no longer emits, so
// the silent-omission bead-id failure was back. Anchoring on ^Slung with
// the multiline flag picks the routing summary deterministically.
//
// Delimiter: `(?!\S)` (next char is whitespace or EOL), not `\b`. The id
// alphabet [A-Za-z0-9_.-] permits trailing `.` or `-` (both non-word),
// which would silently truncate the captured id by one char if `\b` were
// used: between two non-word chars `\b` doesn't assert, so the engine
// backtracks one position. `(?!\S)` is delimiter-agnostic.
const BEAD_ID_RE = /^Slung ([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?!\S)/m;

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
   * Absolute path to the Gas City root. Threaded as `--city=<path>` to
   * `gc sling` so the subprocess finds city.toml without walking up from
   * the dashboard's own cwd. Optional: when unset, gc falls back to its
   * cwd-walk discovery, which fails in this dashboard's deployment.
   * From config.cityPath.
   */
  cityPath?: string;
  /**
   * Injected `gc sling` runner. Defaults to the real exec wrapper; tests
   * pass a stub. This DI is the new pattern for write-exec routers
   * (mailSendRouter is a candidate for the same retrofit later).
   */
  execGcSling?: (
    target: string,
    beadText: string,
    cityPath?: string,
  ) => Promise<ExecResult>;
}

export function maintainerRouter({
  repo,
  cachePath,
  slungStatePath = defaultSlungStatePath(cachePath),
  slingTarget,
  triageTarget,
  cityPath,
  execGcSling = defaultExecGcSling,
}: MaintainerRouterOptions): Router {
  const router = Router();

  router.get('/triage', async (_req, res) => {
    const cached = await readCache(cachePath);
    if (cached !== null) {
      // Splice-at-read overlay (gascity-dashboard-9qs): hydrate item.slung
      // from the persisted slung-state file, then re-run isMarkCandidate +
      // selectOneMark over the modified candidate set so the maroon ●
      // reflects the latest slings without waiting for the worker tick
      // (6h default). Vetted items force slung=null (the agent already
      // delivered; slung was the placeholder while waiting).
      await applySlungOverlay(cached, slungStatePath);
      void recordAudit({
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
      void recordAudit({
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
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      const msg = (err as Error).message;
      res
        .status(502)
        .json({ error: 'failed to refresh maintainer triage', kind: 'upstream', details: { message: msg } });
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
      res.status(400).json({ error: 'invalid kind (pr|issue)', kind: 'validation' });
      return;
    }
    if (!isSlingIntent(body.intent)) {
      res
        .status(400)
        .json({ error: 'invalid intent (review|draft|triage)', kind: 'validation' });
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
      res.status(400).json({ error: 'invalid number', kind: 'validation' });
      return;
    }
    if (
      typeof body.html_url !== 'string' ||
      body.html_url.length > MAX_URL_LEN
    ) {
      res.status(400).json({ error: 'invalid html_url', kind: 'validation' });
      return;
    }
    const urlMatch = GH_URL_RE.exec(body.html_url);
    if (urlMatch === null) {
      res.status(400).json({ error: 'invalid html_url', kind: 'validation' });
      return;
    }
    // Cross-check: kind='pr' must point at /pull/, kind='issue' at /issues/.
    // Closes the "review PR <issues/47>" semantic footgun.
    const urlPath = urlMatch[1];
    const expected = body.kind === 'pr' ? 'pull' : 'issues';
    if (urlPath !== expected) {
      res.status(400).json({ error: 'kind/html_url mismatch', kind: 'validation' });
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
        res.status(400).json({ error: 'invalid target alias', kind: 'validation' });
        return;
      }
      target = body.target;
    }

    const beadText = composeBeadText(body.intent, body.html_url);
    try {
      const result = await execGcSling(target, beadText, cityPath);
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
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      });
      if (result.exitCode !== 0) {
        res.status(502).json({
          error: `gc sling failed (${result.exitCode})`,
          kind: 'upstream',
          details: { stderr: result.stderr.slice(0, 1024) },
        });
        return;
      }
      const idMatch = BEAD_ID_RE.exec(result.stdout);
      const beadId = idMatch?.[1] ?? null;
      // Persist active slung state so subsequent GET /triage requests
      // exclude this item from the One Mark and surface the inline
      // workflow link (gascity-dashboard-9qs). Failed slings (above
      // non-zero-exit branch) deliberately don't write — slung state
      // means "agent has the work."
      try {
        await writeSlungEntry(slungStatePath, slungKey(body.kind, body.number), {
          slung_at: new Date().toISOString(),
          target,
          bead_id: beadId,
        });
      } catch (slungErr) {
        // Slung-state write failure is non-fatal: the sling itself
        // succeeded, the audit row is in place, the operator just
        // won't see the One Mark move until the next refresh. Log
        // and continue rather than 500ing on a downstream-of-success
        // disk hiccup.
        console.warn(
          `[maintainer] slung-state write failed (sling succeeded): ${(slungErr as Error).message}`,
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
      // success-path + non-zero-exit branches already audit, so failing
      // to audit throws would create an asymmetric forensic record where
      // the most-interesting failure mode (the supervisor hung) is the
      // one that leaves no trace in events.jsonl. Mirrors the pattern in
      // routes/agents.ts (GET /api/agents/:alias/prime).
      const errorKind = err instanceof ExecError ? err.kind : 'unknown';
      void recordAudit({
        type: 'dashboard.sling',
        endpoint: 'POST /api/maintainer/sling',
        parsed_args: {
          kind: body.kind,
          number: String(body.number),
          intent: body.intent,
          target,
          text_len: String(beadText.length),
          error_kind: errorKind,
        },
      });
      if (err instanceof ExecError) {
        const status =
          err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 502;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      res.status(500).json({ error: (err as Error).message, kind: 'internal' });
    }
  });

  router.get('/contributor/:login', async (req, res) => {
    const login = req.params.login;
    if (!GH_LOGIN_RE.test(login)) {
      res.status(400).json({ error: 'invalid login', kind: 'validation' });
      return;
    }
    const cached = await readCache(cachePath);
    if (cached === null) {
      res.status(404).json({ error: 'no triage cache yet', kind: 'not_found' });
      return;
    }
    // The same ContributorStat is sliced onto every item the author owns
    // in the envelope, so any item carrying this login has the answer.
    // Avoids a second source of truth.
    const stat = findContributor(cached, login);
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
  return envelope.tiers.reduce(
    (n, tier) =>
      n +
      tier.unclustered.length +
      tier.clusters.reduce((m, c) => m + c.items.length, 0),
    0,
  );
}

// ── Slung-state overlay (gascity-dashboard-9qs) ──────────────────────

function defaultSlungStatePath(cachePath: string): string {
  // Sibling of the envelope cache so a single state-dir holds the
  // maintainer's persisted bookkeeping.
  return path.join(path.dirname(cachePath), 'slung-state.json');
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
  for (const item of allItems) {
    const persisted = state[slungKey(item.kind, item.number)];
    item.slung =
      persisted !== undefined && item.triage_assessment == null ? persisted : null;
    item.is_marked = item.tier !== null && isMarkCandidate(item, item.tier);
  }
  selectOneMark(allItems);
}

