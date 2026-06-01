import { useBeadDetail } from "../hooks/useBeadDetail";
import { useEntityLinks } from "../hooks/useEntityLinks";
import type { SupervisorBead } from "../supervisor/beadReads";
import { BeadBody } from "./BeadBody";
import { Modal } from "./Modal";
import { RelatedEntities } from "./RelatedEntities";

// Click-to-read modal for a single bead. Used from the Beads list
// rows and the AgentDetail assigned-beads list. Pure read view;
// mutations (claim/close/nudge) live on the Beads page row actions
// and are deliberately not duplicated here.
//
// Fetches direct supervisor bead detail on open. If the caller already has
// the full bead in state (Beads, AgentDetail), it can pass it via
// `initialBead` so the modal renders immediately and skips the network round
// trip.

interface BeadDetailModalProps {
  open: boolean;
  onClose: () => void;
  beadId: string | null;
  /** Optional pre-loaded bead. When present and complete, skips the fetch. */
  initialBead?: SupervisorBead | null;
  /**
   * Re-center the modal on a related bead (gascity-dashboard-j4x). When
   * omitted, related bead rows render as plain text (no in-place
   * navigation) so the modal can be used standalone.
   */
  onOpenBead?: (beadId: string) => void;
}

export function BeadDetailModal({
  open,
  onClose,
  beadId,
  initialBead = null,
  onOpenBead,
}: BeadDetailModalProps) {
  const { bead, loading, error, now } = useBeadDetail(open, beadId, initialBead);
  const links = useEntityLinks(open ? beadId : null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bead?.title ?? beadId ?? "Bead"}
      caption={
        bead ? (
          <span>
            <code className="text-fg-muted">{bead.id}</code>
            {" · "}
            {bead.issue_type}
            {" · P"}
            {bead.priority == null ? "—" : bead.priority}
          </span>
        ) : beadId ? (
          <code className="text-fg-muted">{beadId}</code>
        ) : undefined
      }
      widthClass="max-w-3xl"
    >
      {error ? (
        <p className="text-accent" role="alert">
          {error}
        </p>
      ) : loading && bead === null ? (
        <p className="text-fg-muted italic">Fetching bead.</p>
      ) : bead === null ? (
        <p className="text-fg-muted italic">No bead.</p>
      ) : (
        <>
          <BeadBody bead={bead} />
          <RelatedEntities
            view={links.view}
            loading={links.loading}
            error={links.error}
            now={now}
            {...(onOpenBead !== undefined ? { onOpenBead } : {})}
          />
        </>
      )}
    </Modal>
  );
}
