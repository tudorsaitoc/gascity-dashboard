// Refinery module wire contract (saitoc first-party module).
//
// The refinery is the merge pipeline for fleet-produced work: polecats route
// finished branches to the publish pool as bead metadata, the refinery CLI
// scores each bead against its closeout gate, opens/merges PRs, and closes
// beads on merge. This DTO is the ledger-page read of that pipeline: queue
// in, gate verdicts, merges out, exceptions flagged.
//
// Every section degrades independently — the two host-side sources (a bd
// read of the publish pool, a scan of the nerve river's daily event logs)
// can fail on their own, and the page must state which half is stale or
// missing rather than render a healthy-looking shell.

/** One bead currently routed to the refinery's publish pool. */
export interface RefineryPoolItem {
  beadId: string;
  title: string;
  /** bd status word (open / blocked / in_progress / ...). */
  status: string;
  /** metadata.branch — the branch the refinery will publish. */
  branch: string | null;
  /** metadata.existing_pr — PR URL once one is open. */
  prUrl: string | null;
  /** metadata.blocked_reason when the refinery recorded one. */
  blockedReason: string | null;
  /** Last bd update — the staleness signal for this row. */
  updatedAt: string | null;
  /** True when the row has sat without movement past the stuck threshold. */
  stuck: boolean;
}

/** Aggregated closeout-gate outcomes over the window. */
export interface RefineryGateStats {
  windowDays: number;
  merged: number;
  closedOnMerge: number;
  blockedRequiredChecks: number;
  waitingCi: number;
  ciFailed: number;
  artifactGateBlocked: number;
  llmJudgeBlocked: number;
  mergeFailed: number;
  /** merged / (merged + hard failures), null when no outcomes in window. */
  passRate: number | null;
}

/** One merged unit of work, with its pool-entry→merge lead time. */
export interface RefineryMergeItem {
  beadId: string;
  prNumber: number | null;
  prUrl: string | null;
  title: string | null;
  mergedAt: string;
  /**
   * Milliseconds from the bead's first appearance in refinery river events
   * to merge. Null when the river window no longer contains the entry event.
   */
  leadTimeMs: number | null;
}

export type RefinerySourceStatus =
  | { status: 'ok'; asOf: string }
  | { status: 'unavailable'; reason: string };

export interface RefinerySummary {
  /** Publish-pool read (bd). */
  pool: RefineryPoolItem[];
  poolSource: RefinerySourceStatus;
  /** Gate + merge aggregates (nerve river scan). */
  gate: RefineryGateStats;
  merges: RefineryMergeItem[];
  riverSource: RefinerySourceStatus;
  /** Latest refinery patrol activity seen on the river, staleness first-class. */
  lastPatrolAt: string | null;
  /** Median / p90 lead time over `merges` with known lead times. */
  leadTimeMedianMs: number | null;
  leadTimeP90Ms: number | null;
  stuckThresholdHours: number;
}
