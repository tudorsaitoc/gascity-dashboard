import type {
  GcWorkflowBead,
  WorkflowExecutionInstance,
  WorkflowNodeStatus,
} from 'gas-city-dashboard-shared';
import { meta, nonEmpty } from './bead-fields.js';

export function presentationStatus(bead: GcWorkflowBead): WorkflowNodeStatus {
  const raw = (nonEmpty(bead.status) ?? '').toLowerCase();
  const outcome = meta(bead, 'gc.outcome')?.toLowerCase();
  if (raw === 'closed' || raw === 'completed' || raw === 'done') {
    if (outcome === 'fail' || outcome === 'failed') return 'failed';
    if (outcome === 'skipped') return 'skipped';
    return 'completed';
  }
  if (raw === 'in_progress' || raw === 'active' || raw === 'running') {
    return nonEmpty(bead.assignee) ? 'active' : 'pending';
  }
  if (raw === 'blocked') return 'blocked';
  if (raw === 'ready') return 'ready';
  if (raw === 'failed') return 'failed';
  if (raw === 'skipped') return 'skipped';
  return 'pending';
}

export function aggregateStatus(
  instances: WorkflowExecutionInstance[],
  visibleInstance: WorkflowExecutionInstance | undefined,
): WorkflowNodeStatus {
  if (instances.some((instance) => isRunningStatus(instance.status))) {
    return 'active';
  }
  if (visibleInstance?.status) return visibleInstance.status;
  return 'pending';
}

export function isRunningStatus(status: WorkflowNodeStatus | undefined): boolean {
  return status === 'active' || status === 'running';
}
