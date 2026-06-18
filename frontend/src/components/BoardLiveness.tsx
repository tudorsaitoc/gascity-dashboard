import { useAttentionModel } from '../attention/context';
import { boardFreshness, type BoardFreshness } from '../attention/compose';
import { useNow } from '../contexts/NowContext';
import { formatRelative } from '../hooks/time';
import { useRunSummary } from '../runs/runSummarySubscription';

// gascity-dashboard-5t0m (Freshness Spine): ONE quiet board-wide liveness line.
// It answers the question no badge does — "is the data CURRENT?" (vs the nav
// badges' "is it alarming?") — so a calm board fed by a dead cache or a dropped
// stream no longer reads as all-clear.
//
// Three things flip it to the single maroon glyph + word (gascity-dashboard-fchh):
//   1. a hard read error on any domain;
//   2. an AGED-stale read — derived from the oldest read's age, not just from a
//      fetch failure, so a frozen-but-not-erroring cache flips, not just ages;
//   3. a dropped/degraded gc event stream (sseState) — the live-update path is
//      down, so the board is freezing whatever the per-read provenance says.
//
// DESIGN.md: at rest it reads in pure greyscale ("as of 12s ago · all live") with
// NO mark (One Mark at rest). When degraded it shows the sanctioned Stuck-Maroon
// status, ALWAYS paired with a word so it survives the Greyscale Test. The Header
// arbitrates the viewport's single mark — when this line owns it, the "reading
// as" indicator and the nav badges drop their accent (see Header.tsx).

export interface BoardLivenessState {
  /** True when any domain is stale/errored or the event stream is down. */
  degraded: boolean;
  /** Age phrase of the oldest read ("just now", "12s ago"), or null if no read
   *  has landed yet (a cold outage shows the degraded copy with no age). */
  ageLabel: string | null;
  /** The single glyph+word phrase to show when degraded; '' otherwise. */
  label: string;
}

export function useBoardLiveness(): BoardLivenessState {
  const model = useAttentionModel();
  const now = useNow();
  const { sseState } = useRunSummary();
  const fresh = boardFreshness(model, now);
  // A closed/degraded gc event stream means updates have stopped arriving — the
  // board is freezing regardless of what each cached read's provenance says.
  const streamDown = sseState === 'closed' || sseState === 'degraded';
  const degraded = streamDown || fresh.degraded.length > 0;
  const ageLabel =
    fresh.fetchedAt === undefined ? null : agePhrase(formatRelative(fresh.fetchedAt, now));
  return { degraded, ageLabel, label: degraded ? livenessLabel(fresh.degraded, streamDown) : '' };
}

export function BoardLiveness() {
  const { degraded, ageLabel, label } = useBoardLiveness();
  // Truly nothing to say — no read has landed and nothing is wrong.
  if (!degraded && ageLabel === null) return null;

  return (
    <span role="status" className="text-label uppercase tracking-wider tnum text-fg-faint">
      {ageLabel !== null && (
        <>
          as of {ageLabel} <span aria-hidden="true">·</span>{' '}
        </>
      )}
      {degraded ? (
        <span className="text-accent">
          <span aria-hidden="true">(!)</span> {label}
        </span>
      ) : (
        'all live'
      )}
    </span>
  );
}

/** "as of N ago", but "just now" for a sub-5s read (formatRelative returns
 *  'now', so "as of now ago" would be ungrammatical). */
function agePhrase(relative: string): string {
  return relative === 'now' ? 'just now' : `${relative} ago`;
}

/** The single degraded phrase. A dropped stream is the board-level root cause and
 *  owns the line; otherwise name a lone degraded domain or count several. "N
 *  degraded" (not "N stale") because the set can mix stale and unreachable. */
function livenessLabel(degraded: BoardFreshness['degraded'], streamDown: boolean): string {
  if (streamDown) return 'live updates paused';
  if (degraded.length === 1) {
    const only = degraded[0]!;
    return `${only.domain} ${only.provenance === 'error' ? 'unreachable' : 'stale'}`;
  }
  return `${degraded.length} degraded`;
}
