// In-memory store of current per-session PendingInteractions, the core of the
// city-wide pending aggregator (gascity-dashboard-3rm7, PRD R3/R16, Option A).
//
// The home view is not bound to a session, but PendingInteraction is emitted
// only per-session (spike wf4c). A backend aggregator server-side-observes the
// active sessions' streams and records pending here; the dashboard SSE endpoint
// reads alerts() to push pending-decision items to the home (one dashboard
// stream, not N browser EventSources).
//
// Ephemeral by design (PRD R13): no persistence, resets on restart — a process
// restart re-observes live state, it never resurrects a stale decision.
//
// Premortem Theme A (the top tier must never lie):
//  - observe() supersedes the prior entry for a session with a monotonic
//    version, so a re-observation after a resolve cannot be re-ordered behind
//    the stale one (R17 last-write-wins).
//  - retainActive() drops any session no longer active: an agent in a gone
//    session cannot still be blocked on the operator, so its pending must not
//    linger and cry wolf.
//  - clear() removes a resolved pending immediately.

import {
  pendingInteractionToAlert,
  type AlertItem,
  type IsoTimestamp,
  type PendingInteraction,
  type SourceStatus,
} from 'gas-city-dashboard-shared';

interface PendingEntry {
  readonly pending: PendingInteraction;
  readonly observedAt: IsoTimestamp;
  readonly version: number;
}

export class PendingStore {
  private readonly entries = new Map<string, PendingEntry>();
  private seq = 0;

  /** Record (or supersede) the pending interaction observed for a session. */
  observe(sessionId: string, pending: PendingInteraction, observedAt: IsoTimestamp): void {
    this.seq += 1;
    this.entries.set(sessionId, { pending, observedAt, version: this.seq });
  }

  /** Clear a session's pending (resolved, or an empty 'pending' frame). */
  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /**
   * Drop entries for sessions not in the active set — a pending on a session
   * that is no longer active can never still need the operator. Returns the
   * number of stale entries dropped (0 when nothing changed).
   */
  retainActive(activeSessionIds: Iterable<string>): number {
    const active = activeSessionIds instanceof Set ? activeSessionIds : new Set(activeSessionIds);
    let dropped = 0;
    for (const sessionId of [...this.entries.keys()]) {
      if (!active.has(sessionId)) {
        this.entries.delete(sessionId);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Number of sessions currently holding a pending decision. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Current pending-decision AlertItems, ordered deterministically (oldest
   * observation first, then dedupKey). `provenance` is the freshness of the
   * aggregator's view ('fresh' while the subscription is live; the caller
   * passes a degraded status when the stream is dark, so consumers render
   * signal-unavailable rather than a false all-clear — R6/R16).
   */
  alerts(provenance: SourceStatus): readonly AlertItem[] {
    const out: AlertItem[] = [];
    for (const [sessionId, entry] of this.entries) {
      out.push(
        pendingInteractionToAlert(entry.pending, {
          sessionId,
          occurredAt: entry.observedAt,
          version: entry.version,
          provenance,
        }),
      );
    }
    return out.sort((a, b) => {
      if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
      return a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0;
    });
  }
}
