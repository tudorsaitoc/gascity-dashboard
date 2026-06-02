import { useMemo } from 'react';
import type {
  DashboardSnapshot,
  RunLane,
  RunSummary,
} from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { ConcernRegion, type ConcernRow } from '../components/ambient/ConcernRegion';
import { PhaseCensus } from '../components/ambient/PhaseCensus';
import { StatusSentence } from '../components/ambient/StatusSentence';
import { useCachedData } from '../hooks/useCachedData';
import { useFaviconSignal } from '../hooks/useFaviconSignal';
import { useStaleness, type StalenessResult } from '../hooks/useStaleness';

// gascity-dashboard-kb3 — the L0 ambient home at `/`. PRD §4 + §5.
//
// Composes:
//   • PhaseCensus           — Line 1, the trust anchor pattern-match target.
//   • StatusSentence        — Line 2 with the single .text-accent run-id token.
//   • ConcernRegion         — opacity-materialized rows for items needing a decision.
//   • useFaviconSignal      — R8 hysteresis on the failing count.
//
// R10 (PRD §4 withholding contract): / NEVER lists a healthy in-flight
// run. The concern predicate is the gate; the sentence and the region
// both consume it.

function pickTopConcern(
  lanes: readonly RunLane[],
  staleness: StalenessResult,
): { lane: RunLane; ageMs: number } | undefined {
  // Rank-broken by oldest stall (PRD §4). Server's thrashing-detected
  // lanes outrank time-stalled because thrashing is the freshness-
  // independent server signal — but both already gated to known per R2.
  const candidates: { lane: RunLane; ageMs: number; priority: number }[] = [];
  for (const lane of lanes) {
    if (lane.health.status !== 'available') continue;
    const known = lane.health.data.phaseConfidence === 'known';
    if (!known) continue;
    const ageMs = staleness.byLane.get(lane.id)?.ageMs ?? 0;
    if (lane.health.data.thrashingDetected) {
      candidates.push({ lane, ageMs, priority: 2 });
    } else if (staleness.byLane.get(lane.id)?.isStalled) {
      candidates.push({ lane, ageMs, priority: 1 });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.priority - a.priority || b.ageMs - a.ageMs);
  const top = candidates[0]!;
  return { lane: top.lane, ageMs: top.ageMs };
}

function buildConcernRows(
  lanes: readonly RunLane[],
  staleness: StalenessResult,
  topConcernId: string | undefined,
): ConcernRow[] {
  // R10 predicate: needsOperator OR (known AND (thrashing OR client-stalled)).
  // The top-concern lane is already represented by the StatusSentence
  // maroon token, so it is omitted from the rows below to avoid
  // double-surfacing.
  //
  // Note (Phase 4 code-review M5): needsOperator INTENTIONALLY bypasses
  // the phaseConfidence gate. The backend at health.ts:175 derives
  // needsOperator from lane.phase ∈ {'approval','blocked'} — a structural
  // bead-state fact, not a phase-resolution conclusion. A human-gate
  // decision must surface even when the engine can't confidently classify
  // the lane's stage, because the decision is exactly what the operator
  // is being asked to make. The R2 maroon-on-inferred constraint applies
  // only to the One Mark Rule (which ConcernRegion does not paint), not
  // to surfacing the row.
  const rows: ConcernRow[] = [];
  for (const lane of lanes) {
    if (lane.id === topConcernId) continue;
    if (lane.health.status !== 'available') continue;
    const health = lane.health.data;
    if (health.needsOperator) {
      rows.push({ lane, reason: 'needsOperator' });
      continue;
    }
    if (health.phaseConfidence !== 'known') continue;
    if (health.thrashingDetected || staleness.byLane.get(lane.id)?.isStalled) {
      rows.push({ lane, reason: 'stalled' });
    }
  }
  return rows;
}

function countWaiting(lanes: readonly RunLane[]): number {
  // "waiting" census-vocab (Phase 1 architect M4) — operator-decision-pending.
  let count = 0;
  for (const lane of lanes) {
    if (lane.health.status === 'available' && lane.health.data.needsOperator) count += 1;
  }
  return count;
}

interface FreshSnapshot {
  snapshot: DashboardSnapshot;
  summary: RunSummary;
}

function readFresh(data: DashboardSnapshot | undefined): FreshSnapshot | null {
  if (data === undefined) return null;
  const wf = data.sources.runs;
  if (wf.status === 'error') return null;
  return { snapshot: data, summary: wf.data };
}

interface BodyProps {
  fresh: FreshSnapshot;
  cycleKey: string;
}

function AmbientBody({ fresh, cycleKey }: BodyProps) {
  const { summary, snapshot } = fresh;
  const staleness = useStaleness(summary.lanes);
  const top = useMemo(() => pickTopConcern(summary.lanes, staleness), [summary.lanes, staleness]);
  const rows = useMemo(
    () => buildConcernRows(summary.lanes, staleness, top?.lane.id),
    [summary.lanes, staleness, top],
  );

  // The server's `thrashing` count already excludes inferred lanes;
  // clientStalledLaneIds.length is gated to known via useStaleness.
  // Both contribute to the headline failing count.
  const failing = (() => {
    if (summary.census.status !== 'available') return 0;
    return summary.census.data.thrashing + staleness.clientStalledLaneIds.length;
  })();

  useFaviconSignal({ failing, cycleKey });

  // gascity-dashboard-aw75: surface the city-wide in-progress work count
  // (claimed beads the run-lane census never covers) alongside the active
  // run count. Shown whenever the work source RESOLVED — including a value of
  // 0. Zero is deliberately NOT suppressed: this bug was "in_progress never
  // surfaces", and hiding the clause at 0 reproduces that exact ambiguity
  // (the operator could not tell "nothing claimed" from "dimension missing").
  // A 0 reads as "tracked, currently none", mirroring the adjacent "0 active".
  // Only a source ERROR omits the clause, to avoid a broken token. Neutral
  // type — the One Mark maroon stays reserved for the StatusSentence run-id.
  const workInProgress = snapshot.headline.workInProgress;
  const inProgressClause =
    workInProgress.status === 'available' ? `, ${workInProgress.value} in progress` : '';
  const synopsis =
    snapshot.config !== undefined
      ? `${snapshot.config.cityName}, ${summary.totalActive} active${inProgressClause}`
      : null;

  if (summary.census.status !== 'available') {
    return (
      <section>
        <PageHeader title="Home" synopsis={synopsis} />
        <p
          className="mt-6 text-body text-fg-muted max-w-[70ch]"
          role="alert"
          data-testid="census-unavailable"
        >
          Census unavailable: {summary.census.error}.
        </p>
      </section>
    );
  }

  return (
    <section>
      <PageHeader title="Home" synopsis={synopsis} />
      <div className="mt-6 space-y-4">
        <PhaseCensus
          census={summary.census.data}
          waitingCount={countWaiting(summary.lanes)}
          failingCount={failing}
        />
        {top !== undefined && <StatusSentence topConcern={top} />}
        <ConcernRegion rows={rows} />
      </div>
    </section>
  );
}

export function AmbientHomePage() {
  const { data, loading, error } = useCachedData('snapshot', () => api.snapshot());

  const fresh = readFresh(data);
  // cycleKey advances per snapshot (drives R8 hysteresis); now-ticks
  // re-render the body but share the same generatedAt and so do not
  // advance the favicon hysteresis. The 'pre-snapshot' sentinel is a
  // non-ISO string a well-formed generatedAt cannot collide with,
  // closing the gap Phase 4 L4 flagged where '' could match a
  // pathological empty-string response.
  const cycleKey = fresh?.snapshot.generatedAt ?? 'pre-snapshot';

  if (data === undefined && loading) {
    return (
      <section>
        <PageHeader title="Home" synopsis={null} />
        <p className="mt-6 text-body text-fg-muted">Loading…</p>
      </section>
    );
  }
  if (data === undefined && error !== null) {
    return (
      <section>
        <PageHeader title="Home" synopsis={null} />
        <p className="mt-6 text-body text-accent" role="alert" data-testid="snapshot-error">
          {error}
        </p>
      </section>
    );
  }
  if (fresh === null) {
    // runs source itself is in error state — the rest of the
    // snapshot may be fine but we have no facts to assemble the home.
    return (
      <section>
        <PageHeader title="Home" synopsis={null} />
        <p
          className="mt-6 text-body text-accent"
          role="alert"
          data-testid="runs-source-error"
        >
          Run data is unavailable.
        </p>
      </section>
    );
  }
  return <AmbientBody fresh={fresh} cycleKey={cycleKey} />;
}
