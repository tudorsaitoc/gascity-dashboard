import { stepIdCarriers, type RunIssue } from './phaseMapping.js';
import { isOpenStatus } from './status.js';
import type { RunLane } from '../snapshot/types.js';

// gascity-dashboard-s4rp: a run can be echoed by the supervisor long after it
// has stopped progressing. The operator repro is gc-1920 — an ancient
// (id ~1920 vs a current store at ~346k) mol-focus-review approval-gate latch
// with NO live session, ~4 days since its last bead write, and no in_progress
// step. It was counted as Active:1 and flickered in and out of the lane set on
// every refresh. Half (b) of gascity-dashboard-4xcv asked for these
// session-less latches to be demoted out of Active; the blocked half (a) was
// already handled by the blockedLanes split.
//
// The sharp predicate has to demote the dead latch WITHOUT demoting a run that
// is legitimately session-less for a benign reason — a freshly queued run that
// has not yet been picked up, or an approval gate genuinely waiting on a human.
// Those are RECENT; the dead latch is days old. Staleness is therefore the
// distinguishing axis, with a floor well clear of any human-in-the-loop
// turnaround so a real approval gate is never demoted while it is still being
// waited on.

/**
 * A run is treated as a stale session-less latch once its most-recent bead
 * write is older than this. Deliberately far above the live-attention staleness
 * tiers (frontend `STALENESS_TIER_MS.stalled` = 30m) — that tier flags a run
 * the operator should look at NOW; this floor decides a run is abandoned and
 * should leave the Active set entirely, so it must clear normal queue and
 * approval-gate dwell times (hours) with room to spare.
 */
export const STALE_LATCH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * True when `lane` is an open run that is no longer progressing and should be
 * demoted out of the Active set: the session list resolved, no session maps to
 * the lane, no primary step is in_progress, and the lane's last write is older
 * than {@link STALE_LATCH_AFTER_MS}. complete/blocked lanes are already
 * partitioned out upstream and are never considered here.
 *
 * `nowMs` is the snapshot generation time (the caller's fetch timestamp), not a
 * live clock read — staleness is judged against the data's own generation so
 * the result is deterministic for a given snapshot (no wall-clock test flake).
 */
export function isStaleSessionlessLatch(
  lane: RunLane,
  nowMs: number,
  sessionsAvailable: boolean,
): boolean {
  // Without a session list we cannot trust the "no session" signal — a failed
  // session read must not demote every lane.
  if (!sessionsAvailable) return false;
  if (lane.phase === 'complete' || lane.phase === 'blocked') return false;
  // A live in_progress primary step means the run IS progressing.
  if (lane.progress.status === 'active_step') return false;
  // A resolved session means a worker is on it (even if parked at a gate).
  if (laneSessionResolved(lane)) return false;
  // Needs a known age to judge staleness; absent that we do not demote.
  if (lane.updatedAt.status !== 'available') return false;
  const ageMs = nowMs - Date.parse(lane.updatedAt.at);
  return Number.isFinite(ageMs) && ageMs >= STALE_LATCH_AFTER_MS;
}

function laneSessionResolved(lane: RunLane): boolean {
  return lane.health.status === 'available' && lane.health.data.session.status === 'resolved';
}

/**
 * True when a run group's root bead is absent from the group's issues — the run
 * is rooted at a bead that no longer exists in the store (gascity-dashboard-s4rp
 * dangling root). Such a group has no authoritative root metadata; its title is
 * inferred from a child and its scope is unresolvable, so it must not be
 * surfaced as a live run.
 */
export function isDanglingRootGroup(rootId: string, issues: readonly RunIssue[]): boolean {
  return !issues.some((issue) => issue.id === rootId);
}

// gascity-dashboard-uxvk: an orphaned molecule. The operator repro is
// gc-odssky — dispatched during a supervisor orphan-PID crash-loop, so the
// molecule bead graph persisted in the rig store but the supervisor's workflow
// registry has NO entry (workflow detail 404, absent from a complete formula
// feed) and every step child is still open: the run NEVER EXECUTED and never
// will. Built from beads alone it rendered as a live lane with a stage and a
// relative time — a false-alive signal the operator cannot distinguish from a
// working run.

/**
 * The supervisor-registry side of the stranded judgment: the set of run root
 * ids present in a COMPLETE formula-feed read, and when that read was taken.
 * `observedAtMs` is the age reference for {@link STRANDED_DISPATCH_GRACE_MS} —
 * judging a run's age against the observation that failed to list it (rather
 * than a live clock) means a cached observation can never strand a run that
 * was dispatched after it was taken.
 */
export interface RunRegistryObservation {
  rootIds: ReadonlySet<string>;
  observedAtMs: number;
}

/**
 * Dispatch grace: a run is only judged stranded once its last bead write is at
 * least this much older than the feed observation that lacks it. Registration
 * normally follows bead creation within seconds; the race a grace must absorb
 * is one refresh cycle (the bead read and the feed read run concurrently,
 * ≤60s apart). Ten minutes is an order of magnitude above that race and far
 * below the hours-old scale at which an operator meets a stranded run.
 */
export const STRANDED_DISPATCH_GRACE_MS = 10 * 60 * 1000;

/**
 * True when a run group is conclusively stranded: it has a structured step
 * graph with ZERO progress (every primary gc.step_id carrier still open), the
 * supervisor's formula feed — read completely — does not know its root, and
 * its last bead write predates that observation by the dispatch grace. Any
 * weaker evidence returns false: a run with step progress executed (feed
 * absence just means it aged out of the feed window), and a group without a
 * step graph offers no never-executed signal to judge. A group whose
 * timestamps are all unparsable (e.g. the run-detail snapshot adapter blanks
 * every updated_at) has no age to hold against the grace and is likewise
 * unjudgeable — never stranded.
 *
 * Precedence vs {@link isStaleSessionlessLatch}: a stranded lane is sessionless
 * with no in_progress step, so once its last write ages past
 * {@link STALE_LATCH_AFTER_MS} the latch demotes it out of the Active set like
 * any other abandoned lane. Deliberate — the stranded card is an operator
 * prompt while the orphan is recent; a day-old orphan leaves the board with
 * the rest of the stale latches rather than accumulating forever.
 */
export function isStrandedRun(
  rootId: string,
  issues: readonly RunIssue[],
  observation: RunRegistryObservation,
): boolean {
  if (observation.rootIds.has(rootId)) return false;

  const stepCarriers = stepIdCarriers(issues);
  if (stepCarriers.length === 0) return false;
  // isOpenStatus (not a raw !== 'open'): the supervisor wire is not
  // case/trim-guaranteed (status.ts), so any advanced step — including a
  // cased/padded non-open spelling — must disable stranding; a raw compare
  // would wrongly read a ' Closed ' step as "still open" and strand a
  // progressed run (gascity-dashboard-uxvk).
  if (stepCarriers.some((issue) => !isOpenStatus(issue.status))) return false;

  const lastWriteMs = issues
    .map((issue) => Date.parse(issue.updated_at))
    .filter((ms) => Number.isFinite(ms))
    .reduce((latest, ms) => Math.max(latest, ms), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(lastWriteMs)) return false;

  return observation.observedAtMs - lastWriteMs >= STRANDED_DISPATCH_GRACE_MS;
}
