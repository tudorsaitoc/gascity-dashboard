import type {
  GcBead,
  GcWorkflowBead,
  GcWorkflowSnapshot,
} from 'gas-city-dashboard-shared';
import { nonEmpty } from './bead-fields.js';

const PRESENTATION_METADATA_KEYS = [
  'gc.outcome',
  'gc.cwd',
  'cwd',
  'gc.work_dir',
  'work_dir',
  'gc.rig_root',
  'rig_root',
  'session_id',
  'session_name',
  'rig_id',
] as const;

/**
 * The supervisor workflow snapshot carries compiled graph shape, but today its
 * embedded bead rows can lag the canonical /beads runtime state. Merge only
 * fields that affect presentation state so graph topology still comes from
 * /workflow while run status comes from exact live supervisor bead reads.
 */
export function mergeWorkflowRuntimeState(
  raw: GcWorkflowSnapshot,
  runtimeBeads: readonly GcBead[],
): GcWorkflowSnapshot {
  if (!Array.isArray(raw.beads) || runtimeBeads.length === 0) return raw;
  const runtimeById = new Map(
    runtimeBeads
      .map((bead) => [nonEmpty(bead.id), bead] as const)
      .filter((entry): entry is readonly [string, GcBead] => entry[0] !== undefined),
  );

  return {
    ...raw,
    beads: raw.beads.map((bead) => mergeWorkflowBead(bead, runtimeById.get(bead.id))),
  };
}

function mergeWorkflowBead(
  bead: GcWorkflowBead,
  runtime: GcBead | undefined,
): GcWorkflowBead {
  if (!runtime) return bead;
  const status = nonEmpty(runtime.status) ?? bead.status;
  const assignee = nonEmpty(runtime.assignee) ?? bead.assignee;
  return {
    ...bead,
    status,
    assignee,
    metadata: {
      ...bead.metadata,
      ...presentationMetadata(runtime.metadata),
    },
  };
}

function presentationMetadata(metadata: GcBead['metadata']): Record<string, string> {
  if (!metadata) return {};
  const out: Record<string, string> = {};
  for (const key of PRESENTATION_METADATA_KEYS) {
    const value = metadata[key];
    const text = nonEmpty(value);
    if (text) out[key] = text;
  }
  return out;
}
