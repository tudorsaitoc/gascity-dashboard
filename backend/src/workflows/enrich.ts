import type {
  GcSession,
  GcFormulaDetail,
  GcWorkflowBead,
  GcWorkflowSnapshot,
  WorkflowRunDetail,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import { meta, nonEmpty } from './bead-fields.js';
import { buildRunningFormulaRun } from './formula-run.js';

interface EnrichOptions {
  rigRoot?: string;
  sessions?: readonly GcSession[];
  formulaDetail?: GcFormulaDetail | null;
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

  const formulaRun = buildRunningFormulaRun({
    raw,
    workflowId,
    rootBeadId,
    rootStoreRef,
    resolvedRootStore,
    scopeKind,
    scopeRef,
    root,
    beads,
    rigRoot: opts.rigRoot,
    sessions: opts.sessions,
    formulaDetail: opts.formulaDetail,
  });

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
    snapshotEventSeq:
      typeof raw.snapshot_event_seq === 'number'
        ? raw.snapshot_event_seq
        : null,
    partial: raw.partial,
    progress: formulaRun.progress,
    nodes: formulaRun.nodes,
    edges: formulaRun.edges,
    lanes: formulaRun.lanes,
  };
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
