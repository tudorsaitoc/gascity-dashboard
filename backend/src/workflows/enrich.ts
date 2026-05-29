import type {
  GcSession,
  GcFormulaDetail,
  GcWorkflowBead,
  GcWorkflowSnapshot,
  WorkflowRunCompleteness,
  WorkflowRunPartialReason,
  WorkflowRunDetail,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { meta, nonEmpty } from './bead-fields.js';
import { buildRunningFormulaRun } from './formula-run.js';
import type { RunningFormulaRunInput } from './formula-run.js';

interface EnrichOptions {
  rigRoot?: string;
  sessions?: readonly GcSession[];
  formulaDetail?: GcFormulaDetail;
  formulaDetailUnavailable?: boolean;
}

export class UnsupportedWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWorkflowError';
  }
}

export function enrichWorkflowRun(
  raw: GcWorkflowSnapshot,
  opts: EnrichOptions,
): WorkflowRunDetail {
  if (!isGraphV2(raw)) {
    throw new UnsupportedWorkflowError('workflow is not a graph.v2 run');
  }

  const rootBeadId = nonEmpty(raw.root_bead_id) ?? '';
  const workflowId = nonEmpty(raw.workflow_id);
  const rootStoreRef = nonEmpty(raw.root_store_ref);
  const resolvedRootStore = nonEmpty(raw.resolved_root_store);
  const beads = dedupeBeads(Array.isArray(raw.beads) ? raw.beads : []);
  const root = rootBead(beads, rootBeadId);
  const scopeKind = parseScopeKind(raw.scope_kind);
  const scopeRef = nonEmpty(raw.scope_ref);
  if (!workflowId || !rootStoreRef || !resolvedRootStore) {
    throw new UnsupportedWorkflowError('workflow snapshot identity is missing or invalid');
  }
  if (!scopeKind || !scopeRef) {
    throw new UnsupportedWorkflowError('workflow scope is missing or invalid');
  }
  if (!Number.isFinite(raw.snapshot_version)) {
    throw new UnsupportedWorkflowError('workflow snapshot version is missing or invalid');
  }
  if (typeof raw.partial !== 'boolean') {
    throw new UnsupportedWorkflowError('workflow partial flag is missing or invalid');
  }

  const runInput: RunningFormulaRunInput = {
    raw,
    workflowId,
    rootBeadId,
    rootStoreRef,
    resolvedRootStore,
    scopeKind,
    scopeRef,
    beads,
  };
  if (root !== undefined) runInput.root = root;
  if (opts.rigRoot !== undefined) runInput.rigRoot = opts.rigRoot;
  if (opts.sessions !== undefined) runInput.sessions = opts.sessions;
  if (opts.formulaDetail !== undefined) runInput.formulaDetail = opts.formulaDetail;
  if (opts.formulaDetailUnavailable !== undefined) {
    runInput.formulaDetailUnavailable = opts.formulaDetailUnavailable;
  }

  const formulaRun = buildRunningFormulaRun(runInput);
  const partialReasons: WorkflowRunPartialReason[] = raw.partial
    ? ['supervisor_snapshot_partial']
    : [];

  return {
    workflowId,
    rootBeadId,
    rootStoreRef,
    resolvedRootStore,
    scopeKind,
    scopeRef,
    title: formulaRun.title,
    formula: formulaRun.formula,
    executionPath: formulaRun.executionPath,
    snapshotVersion: raw.snapshot_version,
    snapshotEventSeq: formulaRun.progress.snapshotEventSeq,
    completeness: workflowRunCompleteness(partialReasons),
    progress: formulaRun.progress,
    nodes: formulaRun.nodes,
    edges: formulaRun.edges,
    lanes: formulaRun.lanes,
  };
}

export function workflowRunCompleteness(
  reasons: readonly WorkflowRunPartialReason[],
): WorkflowRunCompleteness {
  const uniqueReasons = [...new Set(reasons)];
  return uniqueReasons.length === 0
    ? { kind: 'complete' }
    : { kind: 'partial', reasons: uniqueReasons };
}

function isGraphV2(raw: GcWorkflowSnapshot): boolean {
  const root = rootBead(Array.isArray(raw.beads) ? raw.beads : [], raw.root_bead_id);
  return meta(root, 'gc.formula_contract') === 'graph.v2';
}

function rootBead(
  beads: GcWorkflowBead[],
  rootBeadId: string | undefined,
): GcWorkflowBead | undefined {
  const rootId = nonEmpty(rootBeadId);
  if (!rootId) return undefined;
  return beads.find((bead) => nonEmpty(bead.id) === rootId);
}

function parseScopeKind(raw: string | undefined): WorkflowScopeKind | undefined {
  return raw === 'city' || raw === 'rig' ? raw : undefined;
}

function dedupeBeads(beads: GcWorkflowBead[]): GcWorkflowBead[] {
  const seen = new Set<string>();
  const out: GcWorkflowBead[] = [];
  for (const bead of beads) {
    const id = nonEmpty(bead.id);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(bead);
  }
  return out;
}
