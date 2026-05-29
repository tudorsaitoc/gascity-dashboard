import type {
  GcFormulaDetail,
  GcSession,
  GcWorkflowBead,
  GcWorkflowSnapshot,
  WorkflowControlBadge,
  WorkflowDisplayEdge,
  WorkflowDisplayLane,
  WorkflowDisplayNode,
  WorkflowExecutionPath,
  WorkflowFormula,
  WorkflowNodeStatus,
  WorkflowRunProgress,
  WorkflowScopeKind,
  WorkflowSnapshotSequence,
} from 'gas-city-dashboard-shared';
import { meta } from './bead-fields.js';
import { applyDisplayNodeStates } from './display-state.js';
import { buildWorkflowDisplayEdges } from './edges.js';
import { orderWorkflowNodeGroups } from './formula-order.js';
import {
  buildWorkflowDisplayNode,
  latestIterationsByLoop,
  type WorkflowNodeGroup,
} from './execution-instances.js';
import { resolveWorkflowExecutionPath } from './execution-path.js';
import { groupWorkflowBeads } from './groups.js';
import { buildWorkflowDisplayLanes } from './lanes.js';
import {
  buildWorkflowSessionIndex,
  type WorkflowSessionIndex,
  type WorkflowSessionLinkContext,
} from './session-link.js';

export interface RunningFormulaRunInput {
  raw: GcWorkflowSnapshot;
  workflowId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: WorkflowScopeKind;
  scopeRef: string;
  root?: GcWorkflowBead;
  beads: GcWorkflowBead[];
  rigRoot?: string;
  sessions?: readonly GcSession[];
  formulaDetail?: GcFormulaDetail;
  formulaDetailUnavailable?: boolean;
}

/**
 * Backend-owned projection of a running graph.v2 formula.
 *
 * The React detail page should render this projection, not infer runtime
 * state from raw workflow beads or the global sessions list. This is the
 * single aggregation point for supervisor workflow shape, live bead state,
 * session summaries, loop instances, and display graph state.
 */
export interface RunningFormulaRun {
  raw: GcWorkflowSnapshot;
  workflowId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: WorkflowScopeKind;
  scopeRef: string;
  title: string;
  formula: WorkflowFormula;
  executionPath: WorkflowExecutionPath;
  root?: GcWorkflowBead;
  beads: GcWorkflowBead[];
  nodeGroups: WorkflowNodeGroup[];
  physicalToSemantic: Map<string, string>;
  badgesByTarget: Map<string, WorkflowControlBadge[]>;
  latestIterationByLoop: Map<string, number>;
  sessionIndex: WorkflowSessionIndex;
  sessionContext: WorkflowSessionLinkContext;
  nodes: WorkflowDisplayNode[];
  edges: WorkflowDisplayEdge[];
  lanes: WorkflowDisplayLane[];
  progress: WorkflowRunProgress;
}

export function buildRunningFormulaRun(
  input: RunningFormulaRunInput,
): RunningFormulaRun {
  const { groups: unorderedGroups, physicalToSemantic, badgesByTarget } = groupWorkflowBeads(
    input.beads,
    input.rootBeadId,
  );
  const groups = orderWorkflowNodeGroups(
    unorderedGroups,
    input.formulaDetail,
    input.rootBeadId,
  );
  // Prefer supervisor-owned compiled formula order when available. If a run
  // does not expose a formula name yet, preserve snapshot order rather than
  // reading formula files locally.
  const latestIterationByLoop = latestIterationsByLoop(groups);
  const sessionIndex = buildWorkflowSessionIndex(input.sessions ?? []);
  const sessionContext = {
    sessionIndex,
    scopeRef: input.scopeRef,
  };
  const rawNodes = groups.map((group) =>
    buildWorkflowDisplayNode(
      group,
      badgesByTarget.get(group.semanticNodeId) ?? [],
      latestIterationByLoop.get(group.loopControlNodeId ?? ''),
      sessionContext,
    ),
  );
  const edges = buildWorkflowDisplayEdges(input.raw, physicalToSemantic, rawNodes);
  const nodes = applyDisplayNodeStates(rawNodes, edges);
  const progress = buildWorkflowRunProgress(input.raw, nodes, edges);
  const formula = workflowFormulaState(
    input.root,
    input.formulaDetail,
    input.formulaDetailUnavailable === true,
  );
  const executionPath = resolveWorkflowExecutionPath(
    input.root,
    input.beads,
    input.rigRoot,
  );

  const run: RunningFormulaRun = {
    raw: input.raw,
    workflowId: input.workflowId,
    rootBeadId: input.rootBeadId,
    rootStoreRef: input.rootStoreRef,
    resolvedRootStore: input.resolvedRootStore,
    scopeKind: input.scopeKind,
    scopeRef: input.scopeRef,
    title: input.root?.title.trim() || input.workflowId,
    formula,
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
    lanes: buildWorkflowDisplayLanes(nodes),
    progress,
  };
  if (input.root !== undefined) run.root = input.root;
  return run;
}

function workflowFormula(root: GcWorkflowBead): string | null {
  return meta(root, 'gc.formula') ?? null;
}

function workflowFormulaState(
  root: GcWorkflowBead | undefined,
  formulaDetail: GcFormulaDetail | undefined,
  formulaDetailUnavailable: boolean,
): WorkflowFormula {
  const name = root ? workflowFormula(root) ?? formulaDetail?.name : formulaDetail?.name;
  if (name) return { kind: 'known', name };
  return {
    kind: 'unavailable',
    reason: formulaDetailUnavailable ? 'formula_detail_unavailable' : 'missing_formula_metadata',
  };
}

function buildWorkflowRunProgress(
  raw: GcWorkflowSnapshot,
  nodes: readonly WorkflowDisplayNode[],
  edges: readonly WorkflowDisplayEdge[],
): WorkflowRunProgress {
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
    snapshotEventSeq: workflowSnapshotSequence(raw.snapshot_event_seq),
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

function workflowSnapshotSequence(raw: number | null | undefined): WorkflowSnapshotSequence {
  return typeof raw === 'number'
    ? { kind: 'known', seq: raw }
    : { kind: 'unavailable', reason: 'supervisor_omitted' };
}

function countNodeStatuses(
  nodes: readonly WorkflowDisplayNode[],
): Partial<Record<WorkflowNodeStatus, number>> {
  const counts: Partial<Record<WorkflowNodeStatus, number>> = {};
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
}
