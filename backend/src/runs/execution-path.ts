import type {
  GcRunBead,
  RunExecutionPath,
} from 'gas-city-dashboard-shared';
import { meta, nonEmpty } from './bead-fields.js';

export function resolveRunExecutionPath(
  root: GcRunBead | undefined,
  beads: GcRunBead[],
  rigRoot?: string,
): RunExecutionPath {
  const candidates = [
    ...executionWorkDirs(root),
    ...beads.flatMap((bead) => executionWorkDirs(bead)),
    // gascity-dashboard-tqus: gc.routed_to is the supervisor's canonical
    // routing dir for rig-store roots. It ranks BELOW every explicit
    // cwd/work_dir (a child session's real work_dir must win over the
    // root's canonical-but-maybe-uninstantiated routed_to) but ABOVE the
    // generic rig roots, since it is more specific than a rig checkout.
    routedToWorkDir(root),
    ...beads.map((bead) => routedToWorkDir(bead)),
    ...rigRoots(root),
    ...beads.flatMap((bead) => rigRoots(bead)),
    nonEmpty(rigRoot),
  ];
  const path = candidates.find((candidate) => candidate !== undefined);
  return path === undefined
    ? { kind: 'unavailable', reason: 'missing_cwd_and_rig_root' }
    : { kind: 'known', path };
}

function executionWorkDirs(bead: GcRunBead | undefined): Array<string | undefined> {
  return [
    meta(bead, 'gc.cwd'),
    meta(bead, 'cwd'),
    meta(bead, 'gc.work_dir'),
    meta(bead, 'work_dir'),
  ];
}

// gascity-dashboard-tqus: the supervisor marks routed rig-store workflow
// roots with gc.routed_to (the agent's working directory) when no explicit
// work_dir is recorded. Only an absolute path is a usable git cwd —
// gc.routed_to can also hold an agent alias, which must never become a path.
function routedToWorkDir(bead: GcRunBead | undefined): string | undefined {
  const routedTo = meta(bead, 'gc.routed_to');
  return routedTo !== undefined && routedTo.startsWith('/') ? routedTo : undefined;
}

function rigRoots(bead: GcRunBead | undefined): Array<string | undefined> {
  return [
    meta(bead, 'gc.rig_root'),
    meta(bead, 'rig_root'),
  ];
}
