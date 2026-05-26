import type {
  GcWorkflowBead,
  WorkflowConstructKind,
  WorkflowControlBadge,
  WorkflowDisplayNode,
  WorkflowExecutionInstance,
} from 'gas-city-dashboard-shared';
import {
  attemptFor,
  iterationFor,
  nonEmpty,
  positiveIntegerMeta,
} from './bead-fields.js';
import { workflowSessionLinkFor } from './session-link.js';
import type { WorkflowSessionLinkContext } from './session-link.js';
import {
  aggregateStatus,
  isRunningStatus,
  presentationStatus,
} from './status.js';

export interface WorkflowNodeGroup {
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: WorkflowConstructKind;
  scopeRef?: string;
  loopControlNodeId?: string;
  beads: GcWorkflowBead[];
}

export function buildWorkflowDisplayNode(
  group: WorkflowNodeGroup,
  controlBadges: WorkflowControlBadge[],
  latestLoopIteration: number | undefined,
  sessionContext: WorkflowSessionLinkContext = {},
): WorkflowDisplayNode {
  const instances = group.beads
    .map((bead, index) =>
      buildExecutionInstance(group.semanticNodeId, bead, index, sessionContext),
    )
    .sort(compareExecutionInstances);
  const visibleInstance = preferredExecutionInstance(instances);
  const iterations = new Set(
    instances
      .map((instance) => instance.iteration)
      .filter((n): n is number => typeof n === 'number'),
  );
  const visibleIteration =
    visibleInstance?.iteration ??
    (iterations.size > 0 ? Math.max(...iterations) : undefined);
  const hasHistoricalIterations =
    visibleIteration !== undefined &&
    instances.some((instance) => instance.iteration !== visibleIteration);
  const historicalOnly =
    group.loopControlNodeId !== undefined &&
    visibleIteration !== undefined &&
    latestLoopIteration !== undefined &&
    visibleIteration < latestLoopIteration;

  for (const instance of instances) {
    const currentIteration =
      !historicalOnly &&
      (visibleIteration === undefined || instance.iteration === visibleIteration);
    instance.currentIteration = currentIteration;
    instance.historical = !currentIteration;
    instance.streamable =
      currentIteration &&
      instance.sessionLink !== null &&
      isRunningStatus(instance.status);
  }

  return {
    id: group.semanticNodeId,
    semanticNodeId: group.semanticNodeId,
    title: group.title,
    kind: group.kind,
    constructKind: group.constructKind,
    status: aggregateStatus(instances, visibleInstance),
    currentBeadId: visibleInstance?.beadId,
    scopeRef: group.scopeRef,
    loopControlNodeId: group.loopControlNodeId,
    visibleInGraph: !historicalOnly,
    historicalOnly,
    visibleIteration,
    iterationCount: iterations.size > 0 ? iterations.size : undefined,
    hasHistoricalIterations,
    attemptBadge: attemptBadgeFor(group.beads),
    attemptCount: attemptCountFor(instances),
    activeAttempt: activeAttemptFor(instances),
    visibleExecutionInstanceId: visibleInstance?.id,
    executionInstances: instances,
    controlBadges: controlBadges.length > 0 ? controlBadges : undefined,
  };
}

export function latestIterationsByLoop(groups: WorkflowNodeGroup[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const group of groups) {
    if (!group.loopControlNodeId) continue;
    for (const bead of group.beads) {
      const iteration = iterationFor(bead);
      if (!isNumber(iteration)) continue;
      const current = latest.get(group.loopControlNodeId);
      if (current === undefined || iteration > current) {
        latest.set(group.loopControlNodeId, iteration);
      }
    }
  }
  return latest;
}

function buildExecutionInstance(
  semanticNodeId: string,
  bead: GcWorkflowBead,
  index: number,
  sessionContext: WorkflowSessionLinkContext,
): WorkflowExecutionInstance {
  const beadId = nonEmpty(bead.id);
  const iteration = iterationFor(bead);
  const attempt = attemptFor(bead);
  const status = presentationStatus(bead);
  return {
    id:
      beadId ??
      `${semanticNodeId}:iteration-${iteration ?? 0}:attempt-${attempt ?? index}`,
    semanticNodeId,
    beadId,
    iteration,
    attempt,
    label: instanceLabel(iteration, attempt),
    status,
    sessionLink: workflowSessionLinkFor(bead, status, sessionContext),
  };
}

function preferredExecutionInstance(
  instances: WorkflowExecutionInstance[],
): WorkflowExecutionInstance | undefined {
  return [...instances].sort(compareExecutionInstances).at(-1);
}

function compareExecutionInstances(
  left: WorkflowExecutionInstance,
  right: WorkflowExecutionInstance,
): number {
  return (
    (left.iteration ?? 0) - (right.iteration ?? 0) ||
    (left.attempt ?? 0) - (right.attempt ?? 0) ||
    (left.beadId ?? left.id).localeCompare(right.beadId ?? right.id)
  );
}

function attemptBadgeFor(beads: GcWorkflowBead[]): string | undefined {
  const max = beads
    .map((bead) => positiveIntegerMeta(bead, 'gc.max_attempts'))
    .find((value) => value !== undefined);
  if (max === undefined) return undefined;
  const attempts = new Set(beads.map(attemptFor).filter(isNumber));
  return `${Math.max(attempts.size, 1)}/${max}`;
}

function attemptCountFor(instances: WorkflowExecutionInstance[]): number | undefined {
  const attempts = new Set(instances.map((instance) => instance.attempt).filter(isNumber));
  return attempts.size > 0 ? attempts.size : undefined;
}

function activeAttemptFor(instances: WorkflowExecutionInstance[]): number | undefined {
  return instances.find((instance) => isRunningStatus(instance.status))?.attempt;
}

function instanceLabel(
  iteration: number | undefined,
  attempt: number | undefined,
): string | undefined {
  if (iteration !== undefined && attempt !== undefined) {
    return `iteration ${iteration}, attempt ${attempt}`;
  }
  if (iteration !== undefined) return `iteration ${iteration}`;
  if (attempt !== undefined) return `attempt ${attempt}`;
  return undefined;
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
