// Operator-mail alert derivation for the home-view attention queue
// (gascity-dashboard-mpfx, PRD R4). Turns mayor/orchestration-sender mail into
// 'operator-mail' AlertItems and reports how much worker-firehose chatter was
// folded away.
//
// The sender-role filter (which mail needs the human, which agent kinds count
// as orchestration) lives in shared/operator-mail.ts so this backend derivation
// and the TUI ledger share ONE owner — a drift between the two product surfaces
// is a compile error, not a silent divergence.
//
// Provenance travels with every item (R6/R15): an item's `provenance` is the
// mail source's SourceStatus, so a stale/fixture-derived alert can never render
// as live truth. An errored mail source yields NO items — its signal-unavailable
// state is carried out-of-band on DashboardSnapshot.mail.status (035r's
// tri-state reads that, not an absent alert). `version` is the source generation
// (fetchedAt epoch), matching the run-alert convention, so a newer fetch
// supersedes a stale snapshot-envelope row under R17 — `created_at` would freeze
// the version for immutable mail and defeat last-write-wins.

import {
  basename,
  foldedMailCount,
  makeAlertDedupKey,
  operatorMail,
  type AlertItem,
  type GcSession,
  type SourceState,
  type SourceStatus,
} from 'gas-city-dashboard-shared';
import type {
  MailListBody,
  Message,
} from '../generated/gc-supervisor-client/types.gen.js';

export interface OperatorMailAlerts {
  /** One 'operator-mail' AlertItem per kept (orchestration-sender) mail, newest first. */
  readonly alerts: readonly AlertItem[];
  /** Unread worker-firehose mail suppressed by the sender-role filter. Reported
   *  even when zero alerts are kept (the steady state) so a fold is never silent. */
  readonly folded: number;
}

/** Authoritative mail surface deep link. There is one mail page (no per-id
 *  route today), so every operator-mail row navigates there; the dedupKey keeps
 *  the rows distinct by mail id. */
const MAIL_HREF = '/mail';

function operatorMailAlert(
  mail: Message,
  version: number,
  provenance: Exclude<SourceStatus, 'error'>,
  foldedCount: number | undefined,
): AlertItem {
  const ref = { mailId: mail.id };
  const item: AlertItem = {
    kind: 'operator-mail',
    source: 'mail',
    ref,
    href: MAIL_HREF,
    title: mail.subject.length > 0 ? mail.subject : '(no subject)',
    // Machine-derived "why it's here": the sender role, never a score. It is
    // kept because the sender is the mayor / an orchestration-kind agent.
    reason: `escalation from ${basename(mail.from) || mail.from}`,
    severity: 'attention',
    occurredAt: mail.created_at,
    dedupKey: makeAlertDedupKey('operator-mail', ref),
    version,
    provenance,
  };
  // A fold must never be silent (R8): the top kept item carries the count of
  // worker chatter suppressed beneath it. Absent (not 0) when nothing folded.
  return foldedCount !== undefined && foldedCount > 0 ? { ...item, foldedCount } : item;
}

/**
 * Derive the operator-mail AlertItems from the mail source and the live session
 * list (needed to resolve which senders are orchestration-kind). Returns no
 * items when the source is unavailable — the SourceState carries the error for
 * the signal-unavailable render (R6/R15), so this is never where a failure is
 * signalled.
 */
export function deriveOperatorMailAlerts(
  mailState: SourceState<MailListBody>,
  sessions: readonly GcSession[],
): OperatorMailAlerts {
  if (mailState.status === 'error') return { alerts: [], folded: 0 };
  const provenance = mailState.status;
  const version = Date.parse(mailState.fetchedAt);
  const items = mailState.data.items ?? [];
  const kept = operatorMail(items, sessions);
  const folded = foldedMailCount(items, kept);
  // operatorMail already orders newest-first; the top item (index 0) carries
  // the fold count. R5+R17 cross-source ranking/dedup is bqey's job, not here.
  const alerts = kept.map((mail, i) =>
    operatorMailAlert(mail, version, provenance, i === 0 ? folded : undefined),
  );
  return { alerts, folded };
}
