import type { Response } from 'express';
import { Router } from 'express';
import type {
  GcBead,
  GcRunSnapshot,
  RunScopeKind,
} from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { BEAD_ID_RE } from '../lib/beadId.js';
import { HTTP_STATUS } from '../lib/http-status.js';
import { fromRequestScope } from '../lib/run-scope.js';
import { LOG_COMPONENT, logWarn } from '../logging.js';
import {
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';
import { nonEmpty } from '../runs/bead-fields.js';
import { readRunGitDiff } from '../runs/diff.js';
import {
  enrichFormulaRun,
  UnsupportedRunError,
} from '../runs/enrich.js';
import { mergeRunRuntimeState } from '../runs/runtime-state.js';

export interface RunsRouterOptions {
  rigRoot?: string;
  /**
   * Opt-in path-prefix allowlist for run-detail git reads
   * (gascity-dashboard-k2b8). Threaded into readRunGitDiff so the cwd fed to
   * `git -C` must live under a sanctioned root. Empty / omitted preserves the
   * prior shape-only validation. Sourced from config.runCwdAllowedRoots.
   */
  runCwdAllowedRoots?: readonly string[];
}

export function runsRouter(
  gc: GcClient,
  opts: RunsRouterOptions = {},
): Router {
  const router = Router();

  router.get('/:runId/diff', async (req, res) => {
    const parsed = parseRunRequest(req.params.runId, req.query);
    if (!parsed.ok) {
      writeRouteError(res, routeValidationError(parsed.error));
      return;
    }
    try {
      const { raw } = await getRunWithRuntimeState(
        gc,
        parsed.runId,
        parsed.scope ?? defaultRunScope(gc.cityName),
      );
      const detail = enrichFormulaRun(raw, baseEnrichOptions(opts));
      const diff = await readRunGitDiff(detail.executionPath, opts.runCwdAllowedRoots ?? []);
      res.json(diff);
    } catch (err) {
      writeRunError(res, err, 'failed to fetch run diff');
    }
  });

  return router;
}

async function getRunWithRuntimeState(
  gc: GcClient,
  runId: string,
  scope: { scopeKind: RunScopeKind; scopeRef: string },
): Promise<{ raw: GcRunSnapshot; partial: boolean }> {
  const raw = await gc.getRun(runId, undefined, scope);
  // The per-bead canonical refresh below only works for runs whose beads
  // live in the city store: the supervisor exposes bead reads solely at
  // /v0/city/{city}/bead/{id}, with no rig-store bead endpoint. For a
  // non-city-store run (e.g. root_store_ref=rig:<rig>) every /bead read
  // 404s structurally, not transiently — refreshing would fire N pointless
  // failing requests AND raise a misleading 'partial' badge (which signals a
  // recoverable flake). Treat the embedded snapshot rows as authoritative
  // instead and skip the refresh entirely. City runs keep the refresh
  // and the allSettled-based partial flagging (see below).
  if (!isCityStore(raw, gc.cityName)) {
    return { raw, partial: false };
  }
  const ids = runBeadIds(raw);
  // Fan out runtime bead reads with allSettled, NOT Promise.all: a single
  // failed /bead/:id read (transient timeout, 404, etc.) must not collapse the
  // whole run-detail request to a 502. Keep every bead we did get and flag
  // the response partial so the UI can show a degraded badge.
  const results = await Promise.allSettled(ids.map((id) => gc.getBead(id)));
  const runtime: GcBead[] = [];
  let failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') runtime.push(result.value);
    else failed += 1;
  }
  if (failed > 0) {
    logWarn(
      LOG_COMPONENT.runs,
      `${failed}/${ids.length} runtime bead reads failed for ${runId}; serving partial runtime state`,
    );
  }
  return { raw: mergeRunRuntimeState(raw, runtime), partial: failed > 0 };
}

/**
 * True when the run's root bead store is the dashboard's city store, i.e.
 * its beads are individually addressable via /v0/city/{city}/bead/{id}. The
 * supervisor identifies the city store as `city:<cityName>` in root_store_ref;
 * anything else (notably `rig:<rig>`) is not addressable through the city bead
 * endpoint.
 */
function isCityStore(raw: GcRunSnapshot, cityName: string): boolean {
  return nonEmpty(raw.root_store_ref) === `city:${cityName}`;
}

function runBeadIds(raw: GcRunSnapshot): string[] {
  const ids = new Set<string>();
  for (const bead of raw.beads ?? []) {
    if (BEAD_ID_RE.test(bead.id)) ids.add(bead.id);
  }
  return [...ids];
}

type ParseResult =
  | {
    ok: true;
    runId: string;
    scope?: { scopeKind: RunScopeKind; scopeRef: string };
  }
  | { ok: false; error: string };

function parseRunRequest(
  runId: string,
  query: Record<string, unknown>,
): ParseResult {
  if (!BEAD_ID_RE.test(runId)) {
    return { ok: false, error: 'invalid run id' };
  }
  if (query.scope_kind !== undefined && typeof query.scope_kind !== 'string') {
    return { ok: false, error: 'invalid scope kind' };
  }
  if (query.scope_ref !== undefined && typeof query.scope_ref !== 'string') {
    return { ok: false, error: 'invalid scope ref' };
  }
  const scope = fromRequestScope(query);
  if (!scope.ok) return scope;
  return scope.scope !== undefined
    ? { ok: true, runId, scope: scope.scope }
    : { ok: true, runId };
}

function defaultRunScope(cityName: string): { scopeKind: RunScopeKind; scopeRef: string } {
  return { scopeKind: 'city', scopeRef: cityName };
}

function baseEnrichOptions(opts: RunsRouterOptions): { rigRoot?: string } {
  return {
    ...(opts.rigRoot !== undefined ? { rigRoot: opts.rigRoot } : {}),
  };
}

function writeRunError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
): void {
  if (err instanceof UnsupportedRunError) {
    res.status(HTTP_STATUS.unprocessableContent).json({ error: err.message, kind: 'unsupported' });
    return;
  }
  writeRouteError(res, routeUpstreamError(err, {
    component: LOG_COMPONENT.runs,
    operation: fallbackMessage,
    responseError: fallbackMessage,
    isTimeout: GcClient.isTimeoutError,
    notFound: { error: 'run not found', kind: 'not_found' },
  }));
}
