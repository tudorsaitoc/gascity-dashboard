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
import { meta, nonEmpty } from '../workflows/bead-fields.js';
import { enrichWorkflowRun, UnsupportedWorkflowError } from '../workflows/enrich.js';
import { readWorkflowGitDiff } from '../workflows/diff.js';
import { mergeWorkflowRuntimeState } from '../workflows/runtime-state.js';

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
      res.status(400).json({ error: parsed.error, kind: 'validation' });
      return;
    }
    try {
      const { raw } = await getWorkflowWithRuntimeState(
        gc,
        parsed.workflowId,
        parsed.scope ?? defaultWorkflowScope(gc.cityName),
      );
      const detail = enrichWorkflowRun(raw, {
        rigRoot: opts.rigRoot,
      });
      const diff = await readWorkflowGitDiff(detail.executionPath);
      res.json(diff);
    } catch (err) {
      writeWorkflowError(res, err, 'failed to fetch workflow diff');
    }
  });

  router.get('/:workflowId', async (req, res) => {
    const parsed = parseWorkflowRequest(req.params.workflowId, req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, kind: 'validation' });
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
      const detail = enrichWorkflowRun(raw, {
        rigRoot: opts.rigRoot,
        sessions,
        formulaDetail,
      });
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
    console.warn(`[workflows] failed to fetch formula detail for ${formula}: ${(err as Error).message}`);
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
    console.warn(`[workflows] failed to fetch sessions for workflow detail: ${(err as Error).message}`);
    return { sessions: [], partial: true };
  }
}

async function getWorkflowWithRuntimeState(
  gc: GcClient,
  workflowId: string,
  scope: { scopeKind: WorkflowScopeKind; scopeRef: string },
): Promise<{ raw: GcWorkflowSnapshot; partial: boolean }> {
  const raw = await gc.getWorkflow(workflowId, undefined, scope);
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
    console.warn(
      `[workflows] ${failed}/${ids.length} runtime bead reads failed for ${workflowId}; serving partial runtime state`,
    );
  }
  return { raw: mergeWorkflowRuntimeState(raw, runtime), partial: failed > 0 };
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
  const scope =
    scopeKind !== undefined && rawScopeRef !== undefined
      ? {
          scopeKind,
          scopeRef: rawScopeRef,
        }
      : undefined;
  return { ok: true, workflowId, scope };
}

function defaultWorkflowScope(cityName: string): { scopeKind: WorkflowScopeKind; scopeRef: string } {
  return { scopeKind: 'city', scopeRef: cityName };
}

function writeWorkflowError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
): void {
  if (err instanceof UnsupportedWorkflowError) {
    res.status(422).json({ error: err.message, kind: 'unsupported' });
    return;
  }
  if (GcClient.isTimeoutError(err)) {
    res.status(504).json({
      error: 'gc supervisor did not respond in time',
      kind: 'upstream-timeout',
    });
    return;
  }
  const message = err instanceof Error ? err.message : '';
  if (/\b404\b/.test(message)) {
    res.status(404).json({ error: 'workflow not found', kind: 'not_found' });
    return;
  }
  console.warn(`[workflows] ${fallbackMessage}: ${message}`);
  res.status(502).json({
    error: fallbackMessage,
    kind: 'upstream',
    details: { name: err instanceof Error ? err.name : 'Error' },
  });
}
