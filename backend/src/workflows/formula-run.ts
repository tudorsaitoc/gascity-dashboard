import type {
  GcFormulaDetail,
  GcSession,
  GcWorkflowBead,
  GcWorkflowSnapshot,
  WorkflowControlBadge,
  WorkflowDisplayEdge,
  WorkflowDisplayLane,
  WorkflowDisplayNode,
  WorkflowNodeStatus,
  WorkflowRunProgress,
  WorkflowScopeKind,
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
  formulaDetail?: GcFormulaDetail | null;
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
  formula: string | null;
  executionPath: string | null;
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

  return {
    raw: input.raw,
    workflowId: input.workflowId,
    rootBeadId: input.rootBeadId,
    rootStoreRef: input.rootStoreRef,
    resolvedRootStore: input.resolvedRootStore,
    scopeKind: input.scopeKind,
    scopeRef: input.scopeRef,
    title: input.root?.title.trim() || input.workflowId,
    formula: input.root
      ? workflowFormula(input.root) ?? input.formulaDetail?.name ?? null
      : input.formulaDetail?.name ?? null,
    executionPath: resolveWorkflowExecutionPath(
      input.root,
      input.beads,
      input.rigRoot,
    ),
    root: input.root,
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
}

function workflowFormula(root: GcWorkflowBead): string | null {
  return meta(root, 'gc.formula') ?? null;
}

function buildWorkflowRunProgress(
  raw: GcWorkflowSnapshot,
  nodes: readonly WorkflowDisplayNode[],
  edges: readonly WorkflowDisplayEdge[],
): WorkflowRunProgress {
  const visibleNodes = nodes.filter((node) => node.visibleInGraph !== false);
  const streamableSessionIds = new Set<string>();
  let executionInstanceCount = 0;
  let sessionLinkCount = 0;
  let streamableSessionCount = 0;

  for (const node of nodes) {
    for (const instance of node.executionInstances) {
      executionInstanceCount += 1;
      if (instance.sessionLink !== null && instance.sessionLink !== undefined) {
        sessionLinkCount += 1;
      }
      if (instance.streamable === true && instance.sessionLink) {
        streamableSessionCount += 1;
        streamableSessionIds.add(instance.sessionLink.sessionId);
      }
    }
  }

  return {
    snapshotVersion: raw.snapshot_version,
    snapshotEventSeq:
      typeof raw.snapshot_event_seq === 'number' ? raw.snapshot_event_seq : null,
    partial: raw.partial,
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

function countNodeStatuses(
  nodes: readonly WorkflowDisplayNode[],
): Partial<Record<WorkflowNodeStatus, number>> {
  const counts: Partial<Record<WorkflowNodeStatus, number>> = {};
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
}
