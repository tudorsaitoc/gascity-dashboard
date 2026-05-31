import type {
  GcFormulaDetail,
  GcRunBead,
  GcRunSnapshot,
  GcSession,
  RunControlBadge,
  RunDisplayEdge,
  RunDisplayLane,
  RunDisplayNode,
  RunExecutionPath,
  RunFormula,
  RunFormulaDetailState,
  RunNodeStatus,
  FormulaRunProgress,
  RunScopeKind,
  RunSnapshotSequence,
} from 'gas-city-dashboard-shared';
import { meta } from './bead-fields.js';
import { applyDisplayNodeStates } from './display-state.js';
import { buildRunDisplayEdges } from './edges.js';
import {
  buildRunDisplayNode,
  latestIterationsByLoop,
  type RunNodeGroup,
} from './execution-instances.js';
import { resolveRunExecutionPath } from './execution-path.js';
import { orderRunNodeGroups } from './formula-order.js';
import { groupRunBeads } from './groups.js';
import { buildRunDisplayLanes } from './lanes.js';
import {
  buildRunSessionIndex,
  type RunSessionIndex,
  type RunSessionLinkContext,
} from './session-link.js';

export interface RunningFormulaRunInput {
  raw: GcRunSnapshot;
  runId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: RunScopeKind;
  scopeRef: string;
  root?: GcRunBead;
  beads: GcRunBead[];
  rigRoot?: string;
  sessions?: readonly GcSession[];
  formulaDetail?: GcFormulaDetail;
  formulaDetailState?: RunFormulaDetailState;
}

/**
 * Backend-owned projection of a running graph.v2 formula.
 *
 * The React detail page should render this projection, not infer runtime
 * state from raw run beads or the global sessions list. This is the
 * single aggregation point for supervisor run shape, live bead state,
 * session summaries, loop instances, and display graph state.
 */
export interface RunningFormulaRun {
  raw: GcRunSnapshot;
  runId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: RunScopeKind;
  scopeRef: string;
  title: string;
  formula: RunFormula;
  formulaDetail: RunFormulaDetailState;
  executionPath: RunExecutionPath;
  root?: GcRunBead;
  beads: GcRunBead[];
  nodeGroups: RunNodeGroup[];
  physicalToSemantic: Map<string, string>;
  badgesByTarget: Map<string, RunControlBadge[]>;
  latestIterationByLoop: Map<string, number>;
  sessionIndex: RunSessionIndex;
  sessionContext: RunSessionLinkContext;
  nodes: RunDisplayNode[];
  edges: RunDisplayEdge[];
  lanes: RunDisplayLane[];
  progress: FormulaRunProgress;
}

export function buildRunningFormulaRun(
  input: RunningFormulaRunInput,
): RunningFormulaRun {
  const { groups: unorderedGroups, physicalToSemantic, badgesByTarget } = groupRunBeads(
    input.beads,
    input.rootBeadId,
  );
  const groups = orderRunNodeGroups(
    unorderedGroups,
    input.formulaDetail,
    input.rootBeadId,
  );
  // Prefer supervisor-owned compiled formula order when available. If a run
  // does not expose a formula name yet, preserve snapshot order rather than
  // reading formula files locally.
  const latestIterationByLoop = latestIterationsByLoop(groups);
  const sessionIndex = buildRunSessionIndex(input.sessions ?? []);
  const sessionContext = {
    sessionIndex,
    scopeRef: input.scopeRef,
  };
  const rawNodes = groups.map((group) =>
    buildRunDisplayNode(
      group,
      badgesByTarget.get(group.semanticNodeId) ?? [],
      latestIterationByLoop.get(group.loopControlNodeId ?? ''),
      sessionContext,
    ),
  );
  const edges = buildRunDisplayEdges(input.raw, physicalToSemantic, rawNodes);
  const nodes = applyDisplayNodeStates(rawNodes, edges);
  const progress = buildFormulaRunProgress(input.raw, nodes, edges);
  const formula = runFormulaState(
    input.root,
    input.formulaDetail,
  );
  const formulaDetail = input.formulaDetailState ?? runFormulaDetailState(
    input.root,
    input.formulaDetail,
  );
  const executionPath = resolveRunExecutionPath(
    input.root,
    input.beads,
    input.rigRoot,
  );

  const run: RunningFormulaRun = {
    raw: input.raw,
    runId: input.runId,
    rootBeadId: input.rootBeadId,
    rootStoreRef: input.rootStoreRef,
    resolvedRootStore: input.resolvedRootStore,
    scopeKind: input.scopeKind,
    scopeRef: input.scopeRef,
    title: input.root?.title.trim() || input.runId,
    formula,
    formulaDetail,
    executionPath,
    beads: input.beads,
    nodeGroups: groups,
    physicalToSemantic,
    badgesByTarget,
    latestIterationByLoop,
    sessionIndex,
    sessionContext,
    nodes,
    edges,
    lanes: buildRunDisplayLanes(nodes),
    progress,
  };
  if (input.root !== undefined) run.root = input.root;
  return run;
}

function runFormula(root: GcRunBead): string | null {
  return meta(root, 'gc.formula') ?? meta(root, 'gc.formula_name') ?? null;
}

function runFormulaTarget(root: GcRunBead): string | null {
  return meta(root, 'gc.run_target') ?? meta(root, 'gc.routed_to') ?? root.assignee ?? null;
}

function runFormulaState(
  root: GcRunBead | undefined,
  formulaDetail: GcFormulaDetail | undefined,
): RunFormula {
  const name = root ? runFormula(root) ?? formulaDetail?.name : formulaDetail?.name;
  if (name) return { kind: 'known', name };
  return {
    kind: 'unavailable',
    reason: 'missing_formula_metadata',
  };
}

function runFormulaDetailState(
  root: GcRunBead | undefined,
  formulaDetail: GcFormulaDetail | undefined,
): RunFormulaDetailState {
  const name = root ? runFormula(root) ?? formulaDetail?.name : formulaDetail?.name;
  if (!name) return { kind: 'unavailable', reason: 'missing_formula_metadata' };
  const target = root ? runFormulaTarget(root) : null;
  if (!target) return { kind: 'unavailable', reason: 'missing_run_target', name };
  if (formulaDetail !== undefined) return { kind: 'available', name, target };
  return {
    kind: 'unavailable',
    reason: 'fetch_failed',
    name,
    target,
    failure: 'upstream_error',
  };
}

function buildFormulaRunProgress(
  raw: GcRunSnapshot,
  nodes: readonly RunDisplayNode[],
  edges: readonly RunDisplayEdge[],
): FormulaRunProgress {
  const visibleNodes = nodes.filter((node) => node.visibleInGraph);
  const streamableSessionIds = new Set<string>();
  let executionInstanceCount = 0;
  let sessionLinkCount = 0;
  let streamableSessionCount = 0;

  for (const node of nodes) {
    for (const instance of node.executionInstances) {
      executionInstanceCount += 1;
      if (instance.session.kind === 'attached') {
        sessionLinkCount += 1;
      }
      if (instance.session.kind === 'attached' && instance.session.streamable) {
        streamableSessionCount += 1;
        streamableSessionIds.add(instance.session.link.sessionId);
      }
    }
  }

  return {
    snapshotVersion: raw.snapshot_version,
    snapshotEventSeq: runSnapshotSequence(raw.snapshot_event_seq),
    snapshotPartial: raw.partial,
    totalNodeCount: nodes.length,
    visibleNodeCount: visibleNodes.length,
    edgeCount: edges.length,
    executionInstanceCount,
    sessionLinkCount,
    streamableSessionCount,
    streamableSessionIds: [...streamableSessionIds],
    statusCounts: countNodeStatuses(visibleNodes),
    allStatusCounts: countNodeStatuses(nodes),
  };
}

function runSnapshotSequence(raw: number | null | undefined): RunSnapshotSequence {
  return typeof raw === 'number'
    ? { kind: 'known', seq: raw }
    : { kind: 'unavailable', reason: 'supervisor_omitted' };
}

function countNodeStatuses(
  nodes: readonly RunDisplayNode[],
): Partial<Record<RunNodeStatus, number>> {
  const counts: Partial<Record<RunNodeStatus, number>> = {};
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
}
