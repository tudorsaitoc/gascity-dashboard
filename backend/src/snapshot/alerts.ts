// Run-sourced alert derivation for the home-view attention queue
// (gascity-dashboard-i4ui, PRD R2/R5). Maps the health-enriched runs source
// into AlertItems.
//
// Scope: this module owns the RUN signals (run-needs-operator, run-thrashing)
// — they need only `sources.runs`, which the snapshot read path has already
// enriched with health facts. The `operator-mail` signal (R4) is derived
// elsewhere: it needs a mail fetch the snapshot read path does not perform
// today, and the role filter needs the private session list. The
// `pending-decision` tier (R3) is layered client-side from the live SSE.
//
// ZFC: every clause is a named pure predicate over structural lane-health
// facts (needsOperator, thrashingDetected, phaseConfidence) — no scoring, no
// keyword matching. phaseConfidence gates the failing tier: an 'inferred' lane
// must never drive a 'failing' alert (the maroon One Mark), per the engine's
// own R2 footgun warning and the premortem's degrade-to-quiet rule.

import {
  ALERT_SEVERITY_RANK,
  makeAlertDedupKey,
  type AlertItem,
  type RunLane,
  type RunSummary,
  type SourceState,
} from 'gas-city-dashboard-shared';

/** Deep link into the authoritative run-detail surface, pre-selecting the stuck node when known. */
function runLaneHref(lane: RunLane): string {
  const base = `/runs/${encodeURIComponent(lane.id)}`;
  const stuck = lane.health.status === 'available' ? lane.health.data.stuckNode : undefined;
  if (stuck !== undefined && stuck.status === 'available') {
    return `${base}?node=${encodeURIComponent(stuck.id)}`;
  }
  return base;
}

/** When the lane last changed, falling back to the source generation when unknown. */
function laneOccurredAt(lane: RunLane, fallbackIso: string): string {
  return lane.updatedAt.status === 'available' ? lane.updatedAt.at : fallbackIso;
}

/**
 * A lane parked at a human-approval gate or blocked (needsOperator). Severity
 * 'attention' — it needs a decision but is not itself a failure.
 */
function needsOperatorAlert(
  lane: RunLane,
  version: number,
  provenance: AlertItem['provenance'],
  fallbackIso: string,
): AlertItem | null {
  if (lane.health.status !== 'available' || !lane.health.data.needsOperator) return null;
  return {
    kind: 'run-needs-operator',
    source: 'runs',
    ref: { runId: lane.id },
    href: runLaneHref(lane),
    title: lane.title,
    reason: lane.phase === 'blocked' ? 'blocked' : 'awaiting your decision',
    severity: 'attention',
    occurredAt: laneOccurredAt(lane, fallbackIso),
    dedupKey: makeAlertDedupKey('run-needs-operator', { runId: lane.id }),
    version,
    provenance,
  };
}

/**
 * A lane whose progress-monotonicity tripped (thrashingDetected). Severity
 * 'failing'. Gated on phaseConfidence === 'known': an 'inferred' lane's raw
 * thrashing fact must never drive the maroon (it is suppressed, not promoted).
 */
function thrashingAlert(
  lane: RunLane,
  version: number,
  provenance: AlertItem['provenance'],
  fallbackIso: string,
): AlertItem | null {
  if (lane.health.status !== 'available') return null;
  const { thrashingDetected, phaseConfidence } = lane.health.data;
  if (!thrashingDetected || phaseConfidence !== 'known') return null;
  return {
    kind: 'run-thrashing',
    source: 'runs',
    ref: { runId: lane.id },
    href: runLaneHref(lane),
    title: lane.title,
    reason: 'no progress across cycles',
    severity: 'failing',
    occurredAt: laneOccurredAt(lane, fallbackIso),
    dedupKey: makeAlertDedupKey('run-thrashing', { runId: lane.id }),
    version,
    provenance,
  };
}

/** Stable, deterministic order (R5): severity desc, then oldest first, then dedupKey. */
function compareAlerts(a: AlertItem, b: AlertItem): number {
  const sev = ALERT_SEVERITY_RANK[b.severity] - ALERT_SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0;
}

/**
 * Derive the run-sourced AlertItems from the health-enriched runs source.
 * Returns [] when the source is unavailable — the source's own SourceState
 * carries the error for the signal-unavailable render (R6/R15); this array is
 * never the place a failure is signalled. `version` is the source generation
 * (fetchedAt epoch) so a newer snapshot supersedes an older one under R17.
 */
export function deriveRunAlerts(runsState: SourceState<RunSummary>): readonly AlertItem[] {
  if (runsState.status === 'error') return [];
  const provenance = runsState.status;
  const version = Date.parse(runsState.fetchedAt);
  const fallbackIso = runsState.fetchedAt;
  const out: AlertItem[] = [];
  for (const lane of runsState.data.lanes) {
    const needs = needsOperatorAlert(lane, version, provenance, fallbackIso);
    if (needs !== null) out.push(needs);
    const thrash = thrashingAlert(lane, version, provenance, fallbackIso);
    if (thrash !== null) out.push(thrash);
  }
  return out.sort(compareAlerts);
}
