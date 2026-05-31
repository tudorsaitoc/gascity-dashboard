import type {
  GcFormulaDetail,
  GcRunBead,
  GcRunSnapshot,
  GcSession,
  RunFormulaDetailState,
  FormulaRunCompleteness,
  FormulaRunDetail,
  FormulaRunPartialReason,
  RunScopeKind,
} from 'gas-city-dashboard-shared';
import { meta, nonEmpty } from './bead-fields.js';
import type { RunningFormulaRunInput } from './formula-run.js';
import { buildRunningFormulaRun } from './formula-run.js';

interface EnrichOptions {
  rigRoot?: string;
  sessions?: readonly GcSession[];
  formulaDetail?: GcFormulaDetail;
  formulaDetailState?: RunFormulaDetailState;
}

export class UnsupportedRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRunError';
  }
}

export function enrichFormulaRun(
  raw: GcRunSnapshot,
  opts: EnrichOptions,
): FormulaRunDetail {
  if (!isGraphV2(raw)) {
    throw new UnsupportedRunError('run is not a graph.v2 run');
  }

  const rootBeadId = nonEmpty(raw.root_bead_id) ?? '';
  const runId = nonEmpty(raw.run_id);
  const rootStoreRef = nonEmpty(raw.root_store_ref);
  const resolvedRootStore = nonEmpty(raw.resolved_root_store);
  const beads = dedupeBeads(Array.isArray(raw.beads) ? raw.beads : []);
  const root = rootBead(beads, rootBeadId);
  const scopeKind = parseScopeKind(raw.scope_kind);
  const scopeRef = nonEmpty(raw.scope_ref);
  if (!runId || !rootStoreRef || !resolvedRootStore) {
    throw new UnsupportedRunError('run snapshot identity is missing or invalid');
  }
  if (!scopeKind || !scopeRef) {
    throw new UnsupportedRunError('run scope is missing or invalid');
  }
  if (!Number.isFinite(raw.snapshot_version)) {
    throw new UnsupportedRunError('run snapshot version is missing or invalid');
  }
  if (typeof raw.partial !== 'boolean') {
    throw new UnsupportedRunError('run partial flag is missing or invalid');
  }

  const runInput: RunningFormulaRunInput = {
    raw,
    runId,
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
  if (opts.formulaDetailState !== undefined) runInput.formulaDetailState = opts.formulaDetailState;

  const formulaRun = buildRunningFormulaRun(runInput);
  const partialReasons: FormulaRunPartialReason[] = raw.partial
    ? ['supervisor_snapshot_partial']
    : [];

  return {
    runId,
    rootBeadId,
    rootStoreRef,
    resolvedRootStore,
    scopeKind,
    scopeRef,
    title: formulaRun.title,
    formula: formulaRun.formula,
    formulaDetail: formulaRun.formulaDetail,
    executionPath: formulaRun.executionPath,
    snapshotVersion: raw.snapshot_version,
    snapshotEventSeq: formulaRun.progress.snapshotEventSeq,
    completeness: formulaRunCompleteness(partialReasons),
    progress: formulaRun.progress,
    nodes: formulaRun.nodes,
    edges: formulaRun.edges,
    lanes: formulaRun.lanes,
  };
}

export function formulaRunCompleteness(
  reasons: readonly FormulaRunPartialReason[],
): FormulaRunCompleteness {
  const uniqueReasons = [...new Set(reasons)];
  return uniqueReasons.length === 0
    ? { kind: 'complete' }
    : { kind: 'partial', reasons: uniqueReasons };
}

function isGraphV2(raw: GcRunSnapshot): boolean {
  const root = rootBead(Array.isArray(raw.beads) ? raw.beads : [], raw.root_bead_id);
  return meta(root, 'gc.formula_contract') === 'graph.v2';
}

function rootBead(
  beads: GcRunBead[],
  rootBeadId: string | undefined,
): GcRunBead | undefined {
  const rootId = nonEmpty(rootBeadId);
  if (!rootId) return undefined;
  return beads.find((bead) => nonEmpty(bead.id) === rootId);
}

function parseScopeKind(raw: string | undefined): RunScopeKind | undefined {
  return raw === 'city' || raw === 'rig' ? raw : undefined;
}

function dedupeBeads(beads: GcRunBead[]): GcRunBead[] {
  const seen = new Set<string>();
  const out: GcRunBead[] = [];
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
