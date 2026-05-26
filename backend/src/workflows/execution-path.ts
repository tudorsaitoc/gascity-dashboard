import type { GcWorkflowBead } from 'gas-city-dashboard-shared';
import { meta, nonEmpty } from './bead-fields.js';

export function resolveWorkflowExecutionPath(
  root: GcWorkflowBead | undefined,
  beads: GcWorkflowBead[],
  rigRoot?: string,
): string | null {
  const candidates = [
    ...executionWorkDirs(root),
    ...beads.flatMap((bead) => executionWorkDirs(bead)),
    ...rigRoots(root),
    ...beads.flatMap((bead) => rigRoots(bead)),
    nonEmpty(rigRoot),
  ];
  return candidates.find((candidate) => candidate !== undefined) ?? null;
}

function executionWorkDirs(bead: GcWorkflowBead | undefined): Array<string | undefined> {
  return [
    meta(bead, 'gc.cwd'),
    meta(bead, 'cwd'),
    meta(bead, 'gc.work_dir'),
    meta(bead, 'work_dir'),
  ];
}

function rigRoots(bead: GcWorkflowBead | undefined): Array<string | undefined> {
  return [
    meta(bead, 'gc.rig_root'),
    meta(bead, 'rig_root'),
  ];
}
