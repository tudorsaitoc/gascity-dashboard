import { Router } from 'express';
import type { Response } from 'express';
import type {
  GcBead,
  GcSession,
  GcFormulaDetail,
  GcWorkflowSnapshot,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { SCOPE_REF_RE } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { BEAD_ID_RE } from '../lib/beadId.js';
import { HTTP_STATUS } from '../lib/http-status.js';
import { meta, nonEmpty } from '../workflows/bead-fields.js';
import { enrichWorkflowRun, UnsupportedWorkflowError } from '../workflows/enrich.js';
import { readWorkflowGitDiff } from '../workflows/diff.js';
import { mergeWorkflowRuntimeState } from '../workflows/runtime-state.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';
import {
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

export interface WorkflowsRouterOptions {
  rigRoot?: string;
}

export function workflowsRouter(
  gc: GcClient,
  opts: WorkflowsRouterOptions = {},
): Router {
  const router = Router();

  router.get('/:workflowId/diff', async (req, res) => {
    const parsed = parseWorkflowRequest(req.params.workflowId, req.query);
    if (!parsed.ok) {
      writeRouteError(res, routeValidationError(parsed.error));
      return;
    }
    try {
      const { raw } = await getWorkflowWithRuntimeState(
        gc,
        parsed.workflowId,
        parsed.scope ?? defaultWorkflowScope(gc.cityName),
      );
      const detail = enrichWorkflowRun(raw, enrichOptions(opts));
      const diff = await readWorkflowGitDiff(detail.executionPath);
      res.json(diff);
    } catch (err) {
      writeWorkflowError(res, err, 'failed to fetch workflow diff');
    }
  });

  router.get('/:workflowId', async (req, res) => {
    const parsed = parseWorkflowRequest(req.params.workflowId, req.query);
    if (!parsed.ok) {
      writeRouteError(res, routeValidationError(parsed.error));
      return;
    }
    try {
      const { raw, partial: runtimePartial } = await getWorkflowWithRuntimeState(
        gc,
        parsed.workflowId,
        parsed.scope ?? defaultWorkflowScope(gc.cityName),
      );
      const { sessions, partial: sessionsPartial } = await getWorkflowSessions(gc);
      const formulaDetail = await getWorkflowFormulaDetail(
        gc,
        raw,
        parsed.scope ?? defaultWorkflowScope(gc.cityName),
      );
      const detail = enrichWorkflowRun(raw, enrichOptions(opts, sessions, formulaDetail));
      // Top-level `partial` is the authoritative "this view is degraded" signal:
      // it unions supervisor-snapshot incompleteness (detail.progress.partial)
      // with dashboard-side enrichment gaps (failed runtime bead reads or a
      // failed sessions fetch). Unioning progress.partial here guarantees the
      // two flags never disagree in the dangerous direction (top=false while
      // progress=true).
      const partial =
        runtimePartial || sessionsPartial || detail.progress.partial;
      res.json(partial ? { ...detail, partial: true } : detail);
    } catch (err) {
      writeWorkflowError(res, err, 'failed to fetch workflow');
    }
  });

  return router;
}

async function getWorkflowFormulaDetail(
  gc: GcClient,
  raw: GcWorkflowSnapshot,
  scope: { scopeKind: WorkflowScopeKind; scopeRef: string },
): Promise<GcFormulaDetail | null> {
  const root = raw.beads?.find((bead) => nonEmpty(bead.id) === raw.root_bead_id);
  const formula = root ? meta(root, 'gc.formula') : undefined;
  const target = root
    ? meta(root, 'gc.run_target') ?? meta(root, 'gc.routed_to') ?? nonEmpty(root.assignee)
    : undefined;
  if (!formula || !target) return null;
  try {
    return await gc.getFormulaDetail(formula, scope, target);
  } catch (err) {
    logWarn(LOG_COMPONENT.workflows, `failed to fetch formula detail for ${formula}: ${errorMessage(err)}`);
    return null;
  }
}

async function getWorkflowSessions(
  gc: GcClient,
): Promise<{ sessions: readonly GcSession[]; partial: boolean }> {
  try {
    const list = await gc.listSessions();
    return { sessions: Array.isArray(list.items) ? list.items : [], partial: false };
  } catch (err) {
    logWarn(LOG_COMPONENT.workflows, `failed to fetch sessions for workflow detail: ${errorMessage(err)}`);
    return { sessions: [], partial: true };
  }
}

async function getWorkflowWithRuntimeState(
  gc: GcClient,
  workflowId: string,
  scope: { scopeKind: WorkflowScopeKind; scopeRef: string },
): Promise<{ raw: GcWorkflowSnapshot; partial: boolean }> {
  const raw = await gc.getWorkflow(workflowId, undefined, scope);
  // The per-bead canonical refresh below only works for workflows whose beads
  // live in the city store: the supervisor exposes bead reads solely at
  // /v0/city/{city}/bead/{id}, with no rig-store bead endpoint. For a
  // non-city-store workflow (e.g. root_store_ref=rig:<rig>) every /bead read
  // 404s structurally, not transiently — refreshing would fire N pointless
  // failing requests AND raise a misleading 'partial' badge (which signals a
  // recoverable flake). Treat the embedded snapshot rows as authoritative
  // instead and skip the refresh entirely. City workflows keep the refresh
  // and the allSettled-based partial flagging (see below).
  if (!isCityStore(raw, gc.cityName)) {
    return { raw, partial: false };
  }
  const ids = workflowBeadIds(raw);
  // Fan out runtime bead reads with allSettled, NOT Promise.all: a single
  // failed /bead/:id read (transient timeout, 404, etc.) must not collapse the
  // whole workflow-detail request to a 502. Keep every bead we did get and flag
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
      LOG_COMPONENT.workflows,
      `${failed}/${ids.length} runtime bead reads failed for ${workflowId}; serving partial runtime state`,
    );
  }
  return { raw: mergeWorkflowRuntimeState(raw, runtime), partial: failed > 0 };
}

/**
 * True when the workflow's root bead store is the dashboard's city store, i.e.
 * its beads are individually addressable via /v0/city/{city}/bead/{id}. The
 * supervisor identifies the city store as `city:<cityName>` in root_store_ref;
 * anything else (notably `rig:<rig>`) is not addressable through the city bead
 * endpoint.
 */
function isCityStore(raw: GcWorkflowSnapshot, cityName: string): boolean {
  return nonEmpty(raw.root_store_ref) === `city:${cityName}`;
}

function workflowBeadIds(raw: GcWorkflowSnapshot): string[] {
  const ids = new Set<string>();
  for (const bead of raw.beads ?? []) {
    if (BEAD_ID_RE.test(bead.id)) ids.add(bead.id);
  }
  return [...ids];
}

type ParseResult =
  | {
      ok: true;
      workflowId: string;
      scope?: { scopeKind: WorkflowScopeKind; scopeRef: string };
    }
  | { ok: false; error: string };

function parseWorkflowRequest(
  workflowId: string,
  query: Record<string, unknown>,
): ParseResult {
  if (!BEAD_ID_RE.test(workflowId)) {
    return { ok: false, error: 'invalid workflow id' };
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
  const scopeKind: WorkflowScopeKind | undefined =
    rawScopeKind === 'city' || rawScopeKind === 'rig' ? rawScopeKind : undefined;
  if (rawScopeRef !== undefined && !SCOPE_REF_RE.test(rawScopeRef)) {
    return { ok: false, error: 'invalid scope ref' };
  }
  if (scopeKind !== undefined && rawScopeRef !== undefined) {
    return { ok: true, workflowId, scope: { scopeKind, scopeRef: rawScopeRef } };
  }
  return { ok: true, workflowId };
}

function defaultWorkflowScope(cityName: string): { scopeKind: WorkflowScopeKind; scopeRef: string } {
  return { scopeKind: 'city', scopeRef: cityName };
}

function enrichOptions(
  opts: WorkflowsRouterOptions,
  sessions?: readonly GcSession[],
  formulaDetail?: GcFormulaDetail | null,
): {
  rigRoot?: string;
  sessions?: readonly GcSession[];
  formulaDetail?: GcFormulaDetail | null;
} {
  return {
    ...(opts.rigRoot !== undefined ? { rigRoot: opts.rigRoot } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(formulaDetail !== undefined ? { formulaDetail } : {}),
  };
}

function writeWorkflowError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
): void {
  if (err instanceof UnsupportedWorkflowError) {
    res.status(HTTP_STATUS.unprocessableContent).json({ error: err.message, kind: 'unsupported' });
    return;
  }
  writeRouteError(res, routeUpstreamError(err, {
    component: LOG_COMPONENT.workflows,
    operation: fallbackMessage,
    responseError: fallbackMessage,
    isTimeout: GcClient.isTimeoutError,
    notFound: { error: 'workflow not found', kind: 'not_found' },
  }));
}
