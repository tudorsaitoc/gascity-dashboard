import type { Response } from 'express';
import { Router } from 'express';
import type {
  GcBead,
  GcFormulaDetail,
  GcRunSnapshot,
  GcSession,
  RunFormulaDetailFetchFailure,
  RunFormulaDetailState,
  FormulaRunPartialReason,
  RunScopeKind,
} from 'gas-city-dashboard-shared';
import { SCOPE_REF_RE } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { BEAD_ID_RE } from '../lib/beadId.js';
import { HTTP_STATUS } from '../lib/http-status.js';
import { errorMessage, LOG_COMPONENT, logWarn } from '../logging.js';
import {
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';
import { meta, nonEmpty } from '../runs/bead-fields.js';
import { readRunGitDiff } from '../runs/diff.js';
import {
  enrichFormulaRun,
  formulaRunCompleteness,
  UnsupportedRunError,
} from '../runs/enrich.js';
import { mergeRunRuntimeState } from '../runs/runtime-state.js';

export interface RunsRouterOptions {
  rigRoot?: string;
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
      const diff = await readRunGitDiff(detail.executionPath);
      res.json(diff);
    } catch (err) {
      writeRunError(res, err, 'failed to fetch run diff');
    }
  });

  router.get('/:runId', async (req, res) => {
    const parsed = parseRunRequest(req.params.runId, req.query);
    if (!parsed.ok) {
      writeRouteError(res, routeValidationError(parsed.error));
      return;
    }
    try {
      const { raw, partial: runtimePartial } = await getRunWithRuntimeState(
        gc,
        parsed.runId,
        parsed.scope ?? defaultRunScope(gc.cityName),
      );
      const sessionsLookup = await getRunSessions(gc);
      const formulaDetailLookup = await getRunFormulaDetail(
        gc,
        raw,
        parsed.scope ?? defaultRunScope(gc.cityName),
      );
      const detail = enrichFormulaRun(raw, enrichOptions(
        opts,
        sessionsLookup,
        formulaDetailLookup,
      ));
      const completeness = formulaRunCompleteness([
        ...runPartialReasons(detail.completeness),
        ...(runtimePartial ? ['runtime_bead_read_failed' as const] : []),
        ...(sessionsLookup.kind === 'unavailable' ? ['session_list_failed' as const] : []),
        ...(formulaDetailLookup.kind === 'unavailable'
          ? [formulaDetailPartialReason(formulaDetailLookup.state.reason)]
          : []),
      ]);
      res.json({ ...detail, completeness });
    } catch (err) {
      writeRunError(res, err, 'failed to fetch run');
    }
  });

  return router;
}

async function getRunFormulaDetail(
  gc: GcClient,
  raw: GcRunSnapshot,
  scope: { scopeKind: RunScopeKind; scopeRef: string },
): Promise<RunFormulaDetailLookup> {
  const root = raw.beads?.find((bead) => nonEmpty(bead.id) === raw.root_bead_id);
  const formula = root
    ? meta(root, 'gc.formula') ?? meta(root, 'gc.formula_name')
    : undefined;
  const target = root
    ? meta(root, 'gc.run_target') ?? meta(root, 'gc.routed_to') ?? nonEmpty(root.assignee)
    : undefined;
  if (!formula) {
    return {
      kind: 'unavailable',
      state: { kind: 'unavailable', reason: 'missing_formula_metadata' },
    };
  }
  if (!target) {
    return {
      kind: 'unavailable',
      state: { kind: 'unavailable', reason: 'missing_run_target', name: formula },
    };
  }
  try {
    return {
      kind: 'available',
      detail: await gc.getFormulaDetail(formula, scope, target),
      state: { kind: 'available', name: formula, target },
    };
  } catch (err) {
    logWarn(LOG_COMPONENT.runs, `failed to fetch formula detail for ${formula}: ${errorMessage(err)}`);
    return {
      kind: 'unavailable',
      state: {
        kind: 'unavailable',
        reason: 'fetch_failed',
        name: formula,
        target,
        failure: formulaDetailFetchFailure(err),
      },
    };
  }
}

async function getRunSessions(
  gc: GcClient,
): Promise<RunSessionsLookup> {
  try {
    const list = await gc.listSessions();
    return { kind: 'available', sessions: Array.isArray(list.items) ? list.items : [] };
  } catch (err) {
    logWarn(LOG_COMPONENT.runs, `failed to fetch sessions for run detail: ${errorMessage(err)}`);
    return { kind: 'unavailable', sessions: [] };
  }
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
  const rawScopeKind = query.scope_kind;
  const rawScopeRef = query.scope_ref;
  if (rawScopeKind !== undefined && rawScopeKind !== 'city' && rawScopeKind !== 'rig') {
    return { ok: false, error: 'invalid scope kind' };
  }
  if ((rawScopeKind === undefined) !== (rawScopeRef === undefined)) {
    return { ok: false, error: 'scope kind and scope ref are required together' };
  }
  const scopeKind: RunScopeKind | undefined =
    rawScopeKind === 'city' || rawScopeKind === 'rig' ? rawScopeKind : undefined;
  if (rawScopeRef !== undefined && !SCOPE_REF_RE.test(rawScopeRef)) {
    return { ok: false, error: 'invalid scope ref' };
  }
  if (scopeKind !== undefined && rawScopeRef !== undefined) {
    return { ok: true, runId, scope: { scopeKind, scopeRef: rawScopeRef } };
  }
  return { ok: true, runId };
}

function defaultRunScope(cityName: string): { scopeKind: RunScopeKind; scopeRef: string } {
  return { scopeKind: 'city', scopeRef: cityName };
}

function baseEnrichOptions(opts: RunsRouterOptions): { rigRoot?: string } {
  return {
    ...(opts.rigRoot !== undefined ? { rigRoot: opts.rigRoot } : {}),
  };
}

function enrichOptions(
  opts: RunsRouterOptions,
  sessions: RunSessionsLookup,
  formulaDetail: RunFormulaDetailLookup,
): {
  rigRoot?: string;
  sessions: readonly GcSession[];
  formulaDetail?: GcFormulaDetail;
  formulaDetailState: RunFormulaDetailState;
} {
  return {
    ...(opts.rigRoot !== undefined ? { rigRoot: opts.rigRoot } : {}),
    sessions: sessions.sessions,
    formulaDetailState: formulaDetail.state,
    ...(formulaDetail.kind === 'available'
      ? { formulaDetail: formulaDetail.detail }
      : {}),
  };
}

type RunFormulaDetailLookup =
  | { kind: 'available'; detail: GcFormulaDetail; state: RunFormulaDetailState }
  | {
    kind: 'unavailable';
    state: Extract<RunFormulaDetailState, { kind: 'unavailable' }>;
  };

function formulaDetailPartialReason(
  reason: Extract<RunFormulaDetailState, { kind: 'unavailable' }>['reason'],
): FormulaRunPartialReason {
  switch (reason) {
    case 'missing_formula_metadata':
      return 'formula_detail_missing_formula_metadata';
    case 'missing_run_target':
      return 'formula_detail_missing_run_target';
    case 'fetch_failed':
      return 'formula_detail_fetch_failed';
  }
}

function formulaDetailFetchFailure(err: unknown): RunFormulaDetailFetchFailure {
  if (GcClient.isTimeoutError(err)) return 'timeout';
  const message = errorMessage(err);
  if (/gc supervisor returned 404\b/.test(message)) return 'not_found';
  if (message.includes('invalid gc supervisor getFormulaDetail payload')) return 'invalid_payload';
  if (message.includes('empty response body')) return 'empty_response';
  return 'upstream_error';
}

type RunSessionsLookup =
  | { kind: 'available'; sessions: readonly GcSession[] }
  | { kind: 'unavailable'; sessions: readonly GcSession[] };

function runPartialReasons(
  completeness: ReturnType<typeof formulaRunCompleteness>,
): FormulaRunPartialReason[] {
  return completeness.kind === 'partial' ? completeness.reasons : [];
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
