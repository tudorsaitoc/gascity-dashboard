// Pure phase-classification rules for the workflows collector
// (gascity-dashboard-0t6). Kept in their own module so the rules can be
// tested independently of the lane builder and the transport layer.
//
// All exports here are deterministic functions over WorkflowIssue values;
// no IO, no global state. The companion test file pins the upstream
// classifier behavior so the React translation of WorkflowMap inherits a
// consistent phase grammar.
//
// GcBead has no first-class `parent` field, so `WorkflowIssue.parent` is
// populated by the adapter (in workflows.ts) from metadata['gc.parent_bead_id']
// when present. When that metadata key is absent, parent keyword scans simply
// don't fire and classification falls back to title + description + metadata
// text scans.

import type {
  WorkflowPhase as SharedWorkflowPhase,
} from 'gas-city-dashboard-shared';

export interface WorkflowIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  issue_type: string;
  assignee?: string;
  updated_at: string;
  /** Populated from metadata['gc.parent_bead_id'] by the GcBead adapter. */
  parent?: string;
  metadata?: Record<string, unknown>;
}

export interface PhaseMapping {
  phase: SharedWorkflowPhase;
  label: string;
  reviewRound: number | null;
}

export function mapWorkflowPhase(issues: WorkflowIssue[]): PhaseMapping {
  if (
    issues.some(
      (i) => i.status === 'blocked' || textForIssue(i).includes('blocked'),
    )
  ) {
    return { phase: 'blocked', label: 'blocked', reviewRound: null };
  }

  if (issues.length > 0 && issues.every((i) => i.status === 'closed')) {
    return { phase: 'complete', label: 'complete', reviewRound: null };
  }

  if (
    containsAny(issues, [
      'approval',
      'approved',
      'gate',
      'human',
      'finalize-scope',
    ])
  ) {
    return { phase: 'approval', label: 'approval', reviewRound: null };
  }

  if (
    containsAny(issues, [
      'post-merge',
      'merge',
      'close',
      'report',
      'finalization',
      'finalize',
    ])
  ) {
    return {
      phase: 'finalization',
      label: 'finalization',
      reviewRound: null,
    };
  }

  const round = reviewRoundForIssues(issues);
  if (round !== null || containsAny(issues, ['review', 'reviewer', 'scorecard'])) {
    const resolved = round ?? fallbackReviewRound(issues);
    return {
      phase: 'review',
      label: `review round ${resolved}`,
      reviewRound: resolved,
    };
  }

  if (
    containsAny(issues, ['implementation', 'work', 'patch', 'code', 'fix', 'do-work'])
  ) {
    return {
      phase: 'implementation',
      label: 'implementation',
      reviewRound: null,
    };
  }

  if (containsAny(issues, ['intake', 'load-context', 'router', 'request'])) {
    return { phase: 'intake', label: 'intake', reviewRound: null };
  }

  return { phase: 'active', label: 'active', reviewRound: null };
}

/**
 * Returns the per-issue review round when one is encoded in metadata.
 * Three supported shapes (matching demo-dash):
 *   1. key like `*iteration.N` or `*attempt.N` → N (from key).
 *   2. key like `*iteration` or `*attempt` with numeric value → value.
 *   3. value matching `*iteration.N` or `*attempt.N` → N (from value).
 */
export function reviewRoundForIssue(issue: WorkflowIssue): number | null {
  const metadata = issue.metadata ?? {};

  // Capture group 1 in both ROUND_IN_KEY and ROUND_IN_VALUE is the digit
  // sequence. noUncheckedIndexedAccess makes match[1] type as
  // `string | undefined`, so each branch checks `!== undefined` before
  // numeric coercion.
  for (const [key, value] of Object.entries(metadata)) {
    const keyMatch = key.match(ROUND_IN_KEY);
    if (keyMatch && keyMatch[1] !== undefined) {
      return Number(keyMatch[1]);
    }

    if (ROUND_KEY_NO_DIGITS.test(key)) {
      const attempt = parsePositiveInteger(value);
      if (attempt !== null) {
        return attempt;
      }
    }

    const valueMatch = String(value).match(ROUND_IN_VALUE);
    if (valueMatch && valueMatch[1] !== undefined) {
      return Number(valueMatch[1]);
    }
  }

  return null;
}

const ROUND_IN_KEY = /(?:^|\.)(?:iteration|attempt)\.(\d+)$/;
const ROUND_IN_VALUE = /(?:^|\.)(?:iteration|attempt)\.(\d+)$/;
const ROUND_KEY_NO_DIGITS = /(?:^|\.)(?:iteration|attempt)$/;

export function reviewRoundForIssues(issues: WorkflowIssue[]): number | null {
  const rounds = issues
    .map(reviewRoundForIssue)
    .filter((r): r is number => r !== null);
  if (rounds.length === 0) return null;
  return Math.max(...rounds);
}

export function fallbackReviewRound(issues: WorkflowIssue[]): number {
  const reviewIssueCount = issues.filter((i) =>
    textForIssue(i).includes('review'),
  ).length;
  return Math.max(reviewIssueCount, 1);
}

export function textForIssue(issue: WorkflowIssue): string {
  const metadataText = Object.entries(issue.metadata ?? {})
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(' ');

  return [
    issue.title,
    issue.description,
    issue.status,
    issue.issue_type,
    issue.assignee,
    issue.parent,
    metadataText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function containsAny(issues: WorkflowIssue[], needles: string[]): boolean {
  return issues.some((i) => {
    const text = textForIssue(i);
    return needles.some((n) => text.includes(n));
  });
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
