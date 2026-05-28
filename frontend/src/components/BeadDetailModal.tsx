import { useEffect, useState } from 'react';
import type { GcBead } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { Modal } from './Modal';
import { StatusBadge, type StatusTone } from './StatusBadge';
import { Field } from './Field';
import { RelatedEntities } from './RelatedEntities';
import { useEntityLinks } from '../hooks/useEntityLinks';
import { formatDateTime } from '../lib/format';

// Click-to-read modal for a single bead. Used from the Beads list
// rows and the AgentDetail assigned-beads list. Pure read view;
// mutations (claim/close/nudge) live on the Beads page row actions
// and are deliberately not duplicated here.
//
// Fetches /api/beads/:id on open. If the caller already has the full
// bead in state (Beads, AgentDetail), it can pass it via `initialBead`
// so the modal renders immediately and skips the network round trip.

interface BeadDetailModalProps {
  open: boolean;
  onClose: () => void;
  beadId: string | null;
  /** Optional pre-loaded bead. When present and complete, skips the fetch. */
  initialBead?: GcBead | null;
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
  const [bead, setBead] = useState<GcBead | null>(initialBead);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const links = useEntityLinks(open ? beadId : null);

  // Live clock for RelatedEntities staleness / "as of" (matches the
  // setNow+interval pattern in AgentDetail / WorkflowRunDetail). A frozen
  // Date.now() captured once would never re-tick while the modal stays
  // open, so the relative ages would silently go stale. Only tick while
  // the modal is open and the tab is visible.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    return () => clearInterval(tick);
  }, [open]);

  useEffect(() => {
    if (!open || !beadId) return;
    // If we already have the bead and it includes a description, skip the
    // refetch. Description is the primary thing this modal exists to
    // show, so its presence is the freshness signal.
    if (initialBead && initialBead.id === beadId && initialBead.description !== undefined) {
      setBead(initialBead);
      setError(null);
      return;
    }
    setBead(initialBead?.id === beadId ? initialBead : null);
    setLoading(true);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getBead(beadId);
        if (!cancelled) setBead(result);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiClientError
            ? err.status === 404
              ? 'Bead not found in the supervisor.'
              : `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'fetch failed';
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, beadId, initialBead]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bead?.title ?? beadId ?? 'Bead'}
      caption={
        bead ? (
          <span>
            <code className="text-fg-muted">{bead.id}</code>
            {' · '}
            {bead.issue_type}
            {' · P'}
            {bead.priority}
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

// Gc has three bead shapes the modal needs to distinguish, all clarified
// by the mayor (and not by the wire shape, which calls every one "task"):
//
//   1. Formula template: metadata['gc.kind'] === 'workflow'. NOT
//      actionable work — it's the recipe every wisp is instantiated
//      from. `status=in_progress` is the gc-system convention for "this
//      template is live and available". `gc.source_bead_id` is the
//      historical authoring origin, NOT the work this bead tracks.
//      `gc.run_target` may be stale (the originally-targeted epic may
//      have closed years ago). Leave it alone. It's plumbing.
//
//   2. Wisp / molecule instance: issue_type === 'molecule'. A single
//      run of a formula. Description usually empty.
//
//   3. Regular work bead: everything else.
//
// The modal labels each honestly so the operator doesn't mistake
// plumbing for actionable work.
interface WorkflowMeta {
  kind?: string;
  originBeadId?: string;
  formulaContract?: string;
  runTarget?: string;
}

function readWorkflowMeta(bead: GcBead): WorkflowMeta {
  const md = bead.metadata;
  if (!md || typeof md !== 'object') return {};
  const r = md as Record<string, unknown>;
  const workflowMeta: WorkflowMeta = {};
  if (typeof r['gc.kind'] === 'string') workflowMeta.kind = r['gc.kind'];
  if (typeof r['gc.source_bead_id'] === 'string') {
    workflowMeta.originBeadId = r['gc.source_bead_id'];
  }
  if (typeof r['gc.formula_contract'] === 'string') {
    workflowMeta.formulaContract = r['gc.formula_contract'];
  }
  if (typeof r['gc.run_target'] === 'string') {
    workflowMeta.runTarget = r['gc.run_target'];
  } else if (typeof r['gc.routed_to'] === 'string') {
    workflowMeta.runTarget = r['gc.routed_to'];
  }
  return workflowMeta;
}

type BeadKind = 'template' | 'wisp' | 'work';

function classifyBead(bead: GcBead, wf: WorkflowMeta): BeadKind {
  if (wf.kind === 'workflow') return 'template';
  if (bead.issue_type === 'molecule') return 'wisp';
  return 'work';
}

function BeadBody({ bead }: { bead: GcBead }) {
  const wf = readWorkflowMeta(bead);
  const kind = classifyBead(bead, wf);

  return (
    <div className="space-y-8">
      {kind === 'template' && (
        <section>
          <h3 className="text-label uppercase tracking-wider text-fg-faint mb-3">
            Formula template
          </h3>
          <p className="text-body text-fg-muted max-w-prose">
            This bead is a recipe, not actionable work. Every{' '}
            {bead.ref ? <code className="text-fg-muted">{bead.ref}</code> : 'wisp'}{' '}
            instance is instantiated from this template. The{' '}
            <span className="text-fg-muted">in_progress</span> status is the
            gc-system convention for {'"'}available for instantiation{'"'} —
            do not act on it, nudge it, or close it.
          </p>
        </section>
      )}

      {kind === 'wisp' && (
        <section>
          <h3 className="text-label uppercase tracking-wider text-fg-faint mb-3">
            Formula instance
          </h3>
          <p className="text-body text-fg-muted max-w-prose">
            One run of the{' '}
            {bead.title ? <code className="text-fg-muted">{bead.title}</code> : 'formula'}{' '}
            recipe.
          </p>
        </section>
      )}

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5">
        <Field label="Status">
          <StatusBadge tone={statusTone(bead.status)} label={bead.status} />
        </Field>
        <Field label="Type">{bead.issue_type}</Field>
        <Field label="Assignee">{bead.assignee || '·'}</Field>
        <Field label="Owner">{bead.owner || '·'}</Field>
        <Field label="Created">
          <span className="tnum">{formatDateTime(bead.created_at)}</span>
        </Field>
        {bead.updated_at && (
          <Field label="Updated">
            <span className="tnum">{formatDateTime(bead.updated_at)}</span>
          </Field>
        )}
        {bead.closed_at && (
          <Field label="Closed">
            <span className="tnum">{formatDateTime(bead.closed_at)}</span>
          </Field>
        )}
        {typeof bead.dependency_count === 'number' && bead.dependency_count > 0 && (
          <Field label="Blocked by">
            <span className="tnum">{bead.dependency_count}</span>
          </Field>
        )}
        {typeof bead.dependent_count === 'number' && bead.dependent_count > 0 && (
          <Field label="Blocks">
            <span className="tnum">{bead.dependent_count}</span>
          </Field>
        )}
      </dl>

      {kind === 'template' && (wf.formulaContract || wf.originBeadId || wf.runTarget) && (
        <section>
          <h3 className="text-label uppercase tracking-wider text-fg-faint mb-3">
            Template origin
          </h3>
          <p className="text-body text-fg-muted max-w-prose mb-4">
            Where this formula came from, kept for traceability. The origin
            bead and target may be stale; the formula itself is now used
            wherever the pool dispatches it.
          </p>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-3">
            {wf.formulaContract && (
              <Field label="Contract">
                <code className="text-fg-muted">{wf.formulaContract}</code>
              </Field>
            )}
            {bead.ref && (
              <Field label="Ref">
                <code className="text-fg-muted">{bead.ref}</code>
              </Field>
            )}
            {wf.originBeadId && (
              <Field label="Origin bead">
                <code className="text-fg-muted">{wf.originBeadId}</code>
              </Field>
            )}
            {wf.runTarget && (
              <Field label="Origin target">
                <span className="text-fg-muted truncate" title={wf.runTarget}>
                  {wf.runTarget}
                </span>
              </Field>
            )}
          </dl>
        </section>
      )}

      {Array.isArray(bead.labels) && bead.labels.length > 0 && (
        <section>
          <h3 className="text-label uppercase tracking-wider text-fg-faint mb-3">
            Labels
          </h3>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {bead.labels.map((l) => (
              <span
                key={l}
                className="text-label uppercase tracking-wider text-fg-muted"
              >
                {l}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="text-label uppercase tracking-wider text-fg-faint mb-3">
          {kind === 'template' ? 'Recipe' : 'Description'}
        </h3>
        {bead.description && bead.description.length > 0 ? (
          <pre className="text-body whitespace-pre-wrap leading-relaxed text-fg font-sans">
            {bead.description}
          </pre>
        ) : (
          <p className="text-body text-fg-muted italic">No description.</p>
        )}
      </section>
    </div>
  );
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'closed':
      return 'neutral';
    case 'in_progress':
      return 'ok';
    case 'blocked':
      return 'stuck';
    case 'open':
    case 'deferred':
    default:
      return 'warn';
  }
}
