import type { GcSession } from 'gas-city-dashboard-shared';
import { SessionPeekContent, formatPeekChars } from './SessionPeek';
import { StatusBadge, type StatusTone } from './StatusBadge';
import {
  useSessionStream,
  type SessionStreamConnState,
} from '../hooks/useSessionStream';
import { formatRelative } from '../hooks/time';

// Composes the session transcript snapshot with a live SSE tail. Owns the
// "fetch snapshot, then stream turns, show a connection badge" pattern so
// every surface that views a session (agent drilldown, agents-list peek
// modal, workflow run node) shares ONE live-peek body instead of each
// re-implementing the hook + badge + render wiring.
//
// Pure composition over useSessionStream — no fetch/cadence decisions of its
// own; the caller decides whether to stream (`stream`) and which chrome to
// show (`showBadge`, `showCaption`).

interface LiveSessionPeekProps {
  /** Session to peek. Null renders nothing (idle). */
  sessionId: string | null;
  /** Open the live SSE tail. False = one-shot snapshot only. */
  stream: boolean;
  /**
   * Show the connection badge (live/connecting/offline/snapshot). Default
   * true. The badge reflects `streamState`, so it reads "snapshot" when
   * `stream` is false — informative, not noise.
   */
  showBadge?: boolean;
  /** Show the turn-count / captured-at caption line. Default false. */
  showCaption?: boolean;
}

export function LiveSessionPeek({
  sessionId,
  stream,
  showBadge = true,
  showCaption = false,
}: LiveSessionPeekProps) {
  const { result, loading, error, streamState } = useSessionStream(sessionId, stream);
  const badge = streamBadge(streamState);

  const captionParts: string[] = [];
  if (showCaption && result) {
    captionParts.push(`${result.turns.length} turn(s)`);
    captionParts.push(formatPeekChars(result.total_chars));
    captionParts.push(`captured ${formatRelative(result.captured_at, Date.now())}`);
  }

  return (
    <div className="space-y-4">
      {showBadge && (
        <div className="flex justify-end">
          <StatusBadge
            tone={badge.tone}
            label={badge.label}
            title={`Session stream: ${streamState}`}
            className="text-label uppercase tracking-wider"
          />
        </div>
      )}
      {captionParts.length > 0 && (
        <p className="text-label uppercase tracking-wider text-fg-faint tnum">
          {captionParts.join(' · ')}
        </p>
      )}
      <SessionPeekContent loading={loading} error={error} result={result} />
    </div>
  );
}

/** Maps the SSE connection state to a status badge tone + label. */
export function streamBadge(state: SessionStreamConnState): {
  tone: StatusTone;
  label: string;
} {
  switch (state) {
    case 'open':
      return { tone: 'ok', label: 'live' };
    case 'connecting':
      return { tone: 'warn', label: 'connecting' };
    case 'closed':
      return { tone: 'stuck', label: 'offline' };
    case 'idle':
      return { tone: 'neutral', label: 'snapshot' };
  }
}

/**
 * Whether a session is worth opening a live stream for. A streamed dead
 * session would hold a connection that never emits a turn and show a
 * perpetual "connecting" badge, so gate on the running signal. Mirrors the
 * "running" filter chip predicate in routes/Agents.tsx (SESSION_CHIPS) so a
 * session the rest of the UI shows as running also streams: process
 * `running`, gc state `active`, OR gc state `running`.
 */
export function isSessionStreamable(session: GcSession | null): boolean {
  if (session === null) return false;
  return (
    session.running === true ||
    session.state === 'active' ||
    session.state === 'running'
  );
}
