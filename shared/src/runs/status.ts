import type { RunSnapshotBead } from '../run-snapshot.js';
import type { RunExecutionInstance, RunNodeStatus } from '../run-detail.js';
import { meta, nonEmpty } from './bead-fields.js';

// ── Raw bead-status vocabulary ──────────────────────────────────────────────
//
// Phase, lane, and stage derivation read beads from two adapters with DIFFERENT
// raw status vocabularies: the summary lane feeds bd ledger statuses
// (open/in_progress/closed) via fromDashboardBead, while the run-detail page
// feeds supervisor wire statuses (pending/active/completed) via
// fromRunSnapshotBead. Neither is enum-typed on the wire
// (backend/openapi/gc-supervisor.openapi.json types bead status as a plain
// string), so nothing upstream guarantees casing or trimming. These predicates
// are the SINGLE home for that raw vocabulary — presentationStatus below and the
// phaseMapping/summary derivation all reuse them, so the two vocabularies cannot
// drift. They normalize (trim + lowercase) so a cased or padded spelling
// ('Active', ' completed') classifies the same way it renders, never silently
// falling through to 'pending'/non-advanced.

/** Canonicalize a raw bead status (trim + lowercase) so cased or padded wire
 * spellings classify and aggregate the same way they render. */
export function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

/** True when the bead status marks a step currently being worked. */
export function isInFlightStatus(status: string): boolean {
  const s = normalizeStatus(status);
  return s === 'in_progress' || s === 'active' || s === 'running';
}

/** True when the bead status marks a step that completed. */
export function isClosedStatus(status: string): boolean {
  const s = normalizeStatus(status);
  return s === 'closed' || s === 'completed' || s === 'done';
}

/** True when the bead status marks a step that ran but failed. */
export function isFailedStatus(status: string): boolean {
  return normalizeStatus(status) === 'failed';
}

/** True when the bead status marks a step that was skipped and never ran. */
export function isSkippedStatus(status: string): boolean {
  return normalizeStatus(status) === 'skipped';
}

/** True when the bead status is open (ready/unclaimed) — normalized so cased or
 * padded wire spellings ('Open', ' open ') match the same way they render. */
export function isOpenStatus(status: string): boolean {
  return normalizeStatus(status) === 'open';
}

/** True when the bead status is blocked (waiting on a dependency) — normalized
 * so cased or padded wire spellings ('Blocked', ' blocked ') match. */
export function isBlockedStatus(status: string): boolean {
  return normalizeStatus(status) === 'blocked';
}

/**
 * True when the bead status marks a step no work remains for — finished, failed,
 * OR skipped. This is the right test for "the run has no work left" and "this
 * assignee is no longer active", but NOT for "this stage completed successfully":
 * a failed or skipped step is resolved yet did not pass, so stage/ladder
 * advancement must use successful-completion handling, not this predicate.
 */
export function isResolvedStatus(status: string): boolean {
  return isClosedStatus(status) || isFailedStatus(status) || isSkippedStatus(status);
}

/**
 * True when a graph presentation status is terminal — the node has finished,
 * failed, or was skipped and will not advance further. The terminal node
 * statuses (done/completed/failed/skipped) are exactly the resolved raw
 * statuses, so this reuses isResolvedStatus rather than re-declaring the
 * boundary, keeping the run-detail graph and the run-state predicates from
 * drifting.
 */
export function isTerminalNodeStatus(status: RunNodeStatus): boolean {
  return isResolvedStatus(status);
}

export function presentationStatus(bead: RunSnapshotBead): RunNodeStatus {
  const raw = normalizeStatus(nonEmpty(bead.status) ?? '');
  const outcome = meta(bead, 'gc.outcome')?.toLowerCase();
  if (isClosedStatus(raw)) {
    if (outcome === 'fail' || outcome === 'failed') return 'failed';
    if (outcome === 'skipped') return 'skipped';
    return 'completed';
  }
  if (isInFlightStatus(raw)) {
    return 'active';
  }
  if (raw === 'blocked') return 'blocked';
  if (raw === 'ready') return 'ready';
  if (isFailedStatus(raw)) return 'failed';
  if (isSkippedStatus(raw)) return 'skipped';
  return 'pending';
}

export function aggregateStatus(
  instances: RunExecutionInstance[],
  visibleInstance: RunExecutionInstance | undefined,
): RunNodeStatus {
  if (instances.some((instance) => isRunningStatus(instance.status))) {
    return 'active';
  }
  if (visibleInstance?.status) return visibleInstance.status;
  return 'pending';
}

export function isRunningStatus(status: RunNodeStatus | undefined): boolean {
  return status === 'active' || status === 'running';
}
