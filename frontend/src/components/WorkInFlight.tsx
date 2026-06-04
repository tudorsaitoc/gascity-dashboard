import { Link } from 'react-router-dom';
import type { SupervisorBead } from '../supervisor/beadReads';
import type { SupervisorSession } from '../supervisor/sessionReads';
import { useNow } from '../contexts/NowContext';
import { formatRelative } from '../hooks/time';
import {
  deriveActiveWorkers,
  summarizeActiveWorkers,
  type ActiveWorker,
} from '../hooks/activeWorkers';
import { StatusBadge, stateTone } from './StatusBadge';

// "Workers active" — the operator's calm at-a-glance answer to "what is
// actually working right now".
//
// SESSION-DRIVEN, not bead-driven. The work-beads churn to zero within seconds
// (focus-reviews finish fast) and live in rig stores the dashboard's bead fetch
// doesn't reliably aggregate, while the worker SESSIONS stay active across that
// churn. So the primary signal is the live worker sessions, grouped by rig:
//
//     7 workers active across gascity (3), scix-experiments (3), gascity-packs (2).
//
// Per-worker rows below the summary, most-recently-active first:
//
//     gascity · polecat · 2m              [→ gc-5rarj: fix the thing]
//
// The bead is best-effort secondary context — attached only when an in-progress
// bead's assignee embeds this session's id. The common case is no bead; the
// worker being active IS the signal, so there is never an "unassigned" row.

interface WorkInFlightProps {
  beads: readonly SupervisorBead[];
  sessions: readonly SupervisorSession[];
}

function WorkerRow({ worker, accent }: { worker: ActiveWorker; accent: boolean }) {
  const now = useNow();
  const { session, rig, bead } = worker;
  // Workers being "active" is normal, not an alert. Per the One Mark Rule, only
  // the FIRST stuck/failed worker (accent === true) renders its state badge in
  // tone; every other worker reads as neutral state text so at most one maroon
  // mark appears per viewport.
  const tone = accent ? stateTone(session.state) : 'neutral';
  return (
    <li className="px-2 py-2 -mx-2 rounded-sm transition-colors duration-150 ease-out-quart hover:bg-surface-tint/60">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0 text-body text-fg">
          <span className="font-medium">{rig}</span>
          <span className="text-fg-faint" aria-hidden="true"> · </span>
          <span className="text-fg-muted">{worker.worker}</span>
          {bead && (
            <Link
              to={`/beads?bead=${encodeURIComponent(bead.id)}`}
              className="hover:text-accent focus-mark"
              title={`Open ${bead.id}`}
            >
              <span className="text-fg-faint" aria-hidden="true"> → </span>
              <span className="tnum text-fg-muted">{bead.id}</span>
              <span className="text-fg-muted">: {bead.title}</span>
            </Link>
          )}
        </div>
        <div className="flex items-baseline gap-3 shrink-0">
          <StatusBadge tone={tone} label={session.state} />
          <span className="tnum text-fg-muted w-10 text-right">
            {formatRelative(session.last_active, now)}
          </span>
        </div>
      </div>
    </li>
  );
}

export function WorkInFlight({ beads, sessions }: WorkInFlightProps) {
  const active = deriveActiveWorkers(sessions, beads);
  const summary = summarizeActiveWorkers(active);

  // One Mark Rule: render at most one accent state badge — the first worker
  // whose state is stuck/failed (an actual anomaly). Every other worker's state
  // is neutral, since an active worker is the expected, calm case.
  const accentIndex = active.workers.findIndex(
    (w) => stateTone(w.session.state) === 'stuck',
  );

  return (
    <section className="mb-10" aria-label="Workers active">
      <header className="flex items-baseline justify-between border-b border-rule pb-2 mb-4">
        <h2 className="text-headline text-fg">Workers active</h2>
        <span className="text-label tnum text-fg-muted">{active.total}</span>
      </header>
      {active.total === 0 ? (
        <p className="text-body text-fg-muted">No workers active right now.</p>
      ) : (
        <>
          <p className="text-body text-fg-muted mb-4">{summary}</p>
          <ul className="space-y-1">
            {active.workers.map((worker, i) => (
              <WorkerRow
                key={worker.session.id}
                worker={worker}
                accent={i === accentIndex}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
