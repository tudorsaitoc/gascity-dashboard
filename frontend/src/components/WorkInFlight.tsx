import { Link } from 'react-router-dom';
import {
  deriveWorkInFlight,
  type WorkInFlightRow,
} from 'gas-city-dashboard-shared';
import type { SupervisorBead } from '../supervisor/beadReads';
import type { SupervisorSession } from '../supervisor/sessionReads';
import { useNow } from '../contexts/NowContext';
import { formatRelative } from '../hooks/time';
import {
  beadProject,
  canonicalRigLabel,
  cleanWorkerName,
  sessionProject,
} from '../hooks/projectOf';
import { stateTone } from '../routes/Agents';
import { StatusBadge } from './StatusBadge';

// Concrete row type for this surface — the shared generic specialized to the
// generated supervisor wire types the dashboard actually holds.
type Row = WorkInFlightRow<SupervisorBead, SupervisorSession>;

// "Work in flight" — the operator's at-a-glance answer to "what is actually
// working right now". Driven by the IN-PROGRESS BEADS (the real units of work),
// each joined to its live worker session via the session id embedded in the
// bead's assignee (see shared/work-in-flight.ts). One row per unit of work:
//
//     <rig> · <role>  →  <bead-id>: <title>          [session state · 12m]
//
// The roster (configured agent slots) is deliberately NOT the source: it
// reports nearly every worker as stopped with no active bead because the live
// work happens in dynamically-spawned sessions, not the slots.

interface WorkInFlightProps {
  beads: readonly SupervisorBead[];
  sessions: readonly SupervisorSession[];
}

/**
 * The rig label for a row. Prefer the live session's rig (the authoritative
 * source once joined); fall back to the bead's project prefix when the session
 * didn't resolve. Both are run through canonicalRigLabel to strip a `-main`
 * build-tree/worktree suffix so the operator sees `gascity`, not `gascity-main`.
 */
function rigLabelFor(row: Row): string {
  if (row.session) {
    return canonicalRigLabel(sessionProject(row.session).label);
  }
  return canonicalRigLabel(beadProject(row.bead));
}

/**
 * Clean worker label `<rig> · <role>` (e.g. `gascity · polecat`). The role is
 * the parsed assignee prefix, run through cleanWorkerName so any leaked path or
 * `-gc-XXXXX` session suffix is stripped. Falls back to just the rig when the
 * bead has no assignee/role.
 */
function workerLabelFor(row: Row): string {
  const rig = rigLabelFor(row);
  if (!row.role) return rig;
  const role = cleanWorkerName(row.role);
  return role.length > 0 ? `${rig} · ${role}` : rig;
}

function WorkInFlightItem({ row }: { row: Row }) {
  const now = useNow();
  const worker = workerLabelFor(row);
  const lastActivity = row.session?.last_active;
  return (
    <li className="px-2 py-2 -mx-2 rounded-sm transition-colors duration-150 ease-out-quart hover:bg-surface-tint/60">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <Link
            to={`/beads?bead=${encodeURIComponent(row.bead.id)}`}
            className="block text-body text-fg hover:text-accent focus-mark truncate"
            title={`Open ${row.bead.id}`}
          >
            <span className="font-medium">{worker}</span>
            <span className="text-fg-faint" aria-hidden="true"> → </span>
            <span className="tnum text-fg-muted">{row.bead.id}</span>
            <span className="text-fg-muted">: {row.bead.title}</span>
          </Link>
        </div>
        <div className="flex items-baseline gap-3 shrink-0">
          {row.session ? (
            <StatusBadge tone={stateTone(row.session.state)} label={row.session.state} />
          ) : (
            // The embedded session id didn't resolve to a live session: show the
            // raw assignee so the work stays visible (degrade, never drop).
            <span
              className="text-label uppercase tracking-wider text-fg-faint truncate max-w-[16rem]"
              title={row.assignee ? `assignee ${row.assignee}` : 'no live session'}
            >
              {row.assignee ? 'no live session' : 'unassigned'}
            </span>
          )}
          <span className="tnum text-fg-muted w-10 text-right">
            {formatRelative(lastActivity, now)}
          </span>
        </div>
      </div>
    </li>
  );
}

export function WorkInFlight({ beads, sessions }: WorkInFlightProps) {
  const rows = deriveWorkInFlight(beads, sessions);

  return (
    <section className="mb-10" aria-label="Work in flight">
      <header className="flex items-baseline justify-between border-b border-rule pb-2 mb-4">
        <h2 className="text-headline text-fg">Work in flight</h2>
        <span className="text-label tnum text-fg-muted">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="text-body text-fg-muted">Nothing is in flight right now.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <WorkInFlightItem key={row.bead.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}
