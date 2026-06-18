import { useAttentionModel } from '../attention/context';
import { boardFreshness, type BoardFreshness } from '../attention/compose';
import { useNow } from '../contexts/NowContext';
import { formatRelative } from '../hooks/time';

// gascity-dashboard-5t0m (Freshness Spine): ONE quiet board-wide liveness line.
// It answers the question no badge does — "is the data CURRENT?" (vs the nav
// badges' "is it alarming?") — so a calm board fed by a dead cache or a dropped
// stream no longer reads as all-clear. `fetchedAt` is the oldest read on the
// board; the line ages off it, so a frozen source surfaces as a growing "as of N
// ago" even before its provenance flips.
//
// DESIGN.md: at rest it reads in pure greyscale ("as of 12s ago · all live") and
// carries NO mark (One Mark at rest). It turns a single maroon glyph + word ONLY
// when a domain read is stale or errored — the sanctioned Stuck-Maroon status,
// always paired with a word so it survives the Greyscale Test (the "(!)" glyph +
// the word carry the state, not the color).
export function BoardLiveness() {
  const model = useAttentionModel();
  const now = useNow();
  const fresh = boardFreshness(model);
  // Nothing has loaded yet — no honest age to show, so stay silent.
  if (fresh.fetchedAt === undefined) return null;

  const age = formatRelative(fresh.fetchedAt, now);
  return (
    <span role="status" className="text-label uppercase tracking-wider tnum text-fg-faint">
      as of {age} ago <span aria-hidden="true">·</span>{' '}
      {fresh.degraded.length === 0 ? (
        'all live'
      ) : (
        <span className="text-accent">
          <span aria-hidden="true">(!)</span> {degradedLabel(fresh.degraded)}
        </span>
      )}
    </span>
  );
}

/** A compact phrase for the degraded domains — named when there is one, counted
 *  when there are several, so the single mark stays one word-group. */
function degradedLabel(degraded: BoardFreshness['degraded']): string {
  if (degraded.length === 1) {
    const only = degraded[0]!;
    return `${only.domain} ${only.provenance === 'error' ? 'unreachable' : 'stale'}`;
  }
  return `${degraded.length} stale`;
}
