import { Router } from 'express';
import type { Response } from 'express';
import type { WorkflowScopeKind } from 'gas-city-dashboard-shared';
import { GcClient } from '../gc-client.js';
import { BEAD_ID_RE } from '../lib/beadId.js';
import { enrichWorkflowRun, UnsupportedWorkflowError } from '../workflows/enrich.js';
import { readWorkflowGitDiff } from '../workflows/diff.js';

const SCOPE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

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
      const raw = await gc.getWorkflow(parsed.workflowId, undefined, parsed.scope);
      const detail = enrichWorkflowRun(raw, {
        fallbackScopeRef: gc.cityName,
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
      const raw = await gc.getWorkflow(parsed.workflowId, undefined, parsed.scope);
      const detail = enrichWorkflowRun(raw, {
        fallbackScopeRef: gc.cityName,
        rigRoot: opts.rigRoot,
      });
      res.json(detail);
    } catch (err) {
      writeWorkflowError(res, err, 'failed to fetch workflow');
    }
  });

  return router;
}

type ParseResult =
  | {
      ok: true;
      workflowId: string;
      scope?: { scopeKind?: WorkflowScopeKind; scopeRef?: string };
    }
  | { ok: false; error: string };

function parseWorkflowRequest(
  workflowId: string,
  query: Record<string, unknown>,
): ParseResult {
  if (!BEAD_ID_RE.test(workflowId)) {
    return { ok: false, error: 'invalid workflow id' };
  }
  const rawScopeKind = typeof query.scope_kind === 'string'
    ? query.scope_kind
    : undefined;
  const rawScopeRef = typeof query.scope_ref === 'string'
    ? query.scope_ref
    : undefined;
  if (rawScopeKind !== undefined && rawScopeKind !== 'city' && rawScopeKind !== 'rig') {
    return { ok: false, error: 'invalid scope kind' };
  }
  const scopeKind: WorkflowScopeKind | undefined =
    rawScopeKind === 'city' || rawScopeKind === 'rig' ? rawScopeKind : undefined;
  if (rawScopeRef !== undefined && !SCOPE_REF_RE.test(rawScopeRef)) {
    return { ok: false, error: 'invalid scope ref' };
  }
  const scope =
    rawScopeKind !== undefined || rawScopeRef !== undefined
      ? {
          scopeKind,
          scopeRef: rawScopeRef,
        }
      : undefined;
  return { ok: true, workflowId, scope };
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
