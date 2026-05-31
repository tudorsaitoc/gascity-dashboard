import type { GcBead, GcSession } from 'gas-city-dashboard-shared';
import { resolveSessionForTarget } from 'gas-city-dashboard-shared';
import { useState } from 'react';
import { useBeadDetail } from '../../hooks/useBeadDetail';
import { useEntityLinks } from '../../hooks/useEntityLinks';
import { BeadBody } from '../BeadBody';
import { Button } from '../Button';
import { RelatedEntities } from '../RelatedEntities';
import { isSessionStreamable } from '../LiveSessionPeek';
import { BeadLiveRunModal } from './BeadLiveRunModal';

// The board's selected-bead detail panel (gascity-dashboard-6frc). Inline
// counterpart to BeadDetailModal: same BeadBody + RelatedEntities, but set
// beside the board rather than over it. When the bead's assignee resolves
// to a streamable session, it offers a click-through to the live agent run
// — the same pop-out the Agents tab uses, not a re-implementation.

interface BeadDetailRailProps {
  /** Selected bead id, or null when nothing is selected. */
  beadId: string | null;
  /** Cached row for `beadId`, when it is inside the board's window. A
   *  re-centred related bead may be outside it, in which case this is null
   *  and the detail is fetched by id. */
  initialBead: GcBead | null;
  /** Session list, for assignee → live-run resolution. */
  sessions: readonly GcSession[];
  /** Re-centre the board on a related bead. */
  onOpenBead: (beadId: string) => void;
}

export function BeadDetailRail({
  beadId,
  initialBead,
  sessions,
  onOpenBead,
}: BeadDetailRailProps) {
  const detail = useBeadDetail(beadId !== null, beadId, initialBead);
  const links = useEntityLinks(beadId);
  const [runOpen, setRunOpen] = useState(false);

  if (beadId === null) {
    return (
      <aside className="text-body text-fg-faint italic">
        Select a bead to read its detail.
      </aside>
    );
  }

  const shown = detail.bead;
  if (shown === null) {
    return (
      <aside className="text-body text-fg-muted italic">
        {detail.error ?? 'Fetching bead.'}
      </aside>
    );
  }
  const session =
    shown.assignee !== undefined && shown.assignee.length > 0
      ? resolveSessionForTarget(shown.assignee, sessions)
      : null;
  const liveRunnable = isSessionStreamable(session);

  return (
    <aside className="space-y-6">
      <header className="border-b border-rule pb-3">
        <h2 className="text-title text-fg font-medium">{shown.title}</h2>
        <p className="text-label uppercase tracking-wider text-fg-faint mt-1">
          <span className="tnum">{shown.id}</span>
          {' · '}
          {shown.issue_type}
          {' · P'}
          {shown.priority === null ? '—' : shown.priority}
        </p>
        {liveRunnable && (
          <div className="mt-3">
            <Button size="sm" tone="quiet" onClick={() => setRunOpen(true)}>
              View live run ↗
            </Button>
          </div>
        )}
      </header>

      {detail.error ? (
        <p className="text-accent" role="alert">
          {detail.error}
        </p>
      ) : (
        <>
          <BeadBody bead={shown} />
          <RelatedEntities
            view={links.view}
            loading={links.loading}
            error={links.error}
            now={detail.now}
            onOpenBead={onOpenBead}
          />
        </>
      )}

      <BeadLiveRunModal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        session={session}
        beadTitle={shown.title}
      />
    </aside>
  );
}
