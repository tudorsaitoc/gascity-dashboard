import type { RunLane, RunStage } from 'gas-city-dashboard-shared';
import { Link } from 'react-router-dom';
import { formatRelative } from '../../hooks/time';

// Per-lane typographic row. No card chrome — vertical rhythm carries the
// hierarchy, hairline dividers separate lanes at the RunMap level.
// The phase label up top, the title underneath, then a glyph row for
// stage progress, then secondary metadata. Reads in greyscale: phase
// identity comes from order + label + stage glyphs, not color.

const STAGE_GLYPH: Record<RunStage['status'], string> = {
  pending: '·',
  active: '⬣',
  complete: '◆',
  blocked: '✕',
};

const STAGE_TONE: Record<RunStage['status'], string> = {
  pending: 'text-fg-faint',
  active: 'text-fg',
  complete: 'text-fg-muted',
  // Warm-amber tint reserved for blocked status only (DESIGN.md).
  blocked: 'text-accent',
};

interface LaneCardProps {
  lane: RunLane;
  now: number;
}

export function LaneCard({ lane, now }: LaneCardProps) {
  const statusEntries = Object.entries(lane.statusCounts).sort((a, b) =>
    statusSortKey(a[0]).localeCompare(statusSortKey(b[0])),
  );

  return (
    <li className="py-4">
      <div className="flex items-baseline justify-between gap-4">
        <span
          className={`text-label uppercase tracking-wider ${
            lane.phase === 'blocked' ? 'text-accent' : 'text-fg'
          }`}
        >
          {lane.phaseLabel}
        </span>
        <span
          className="text-label uppercase tracking-wider text-fg-faint tnum tabular-nums"
          title={
            lane.updatedAt.status === 'available'
              ? lane.updatedAt.at
              : lane.updatedAt.error
          }
        >
          {lane.updatedAt.status === 'available'
            ? formatRelative(lane.updatedAt.at, now)
            : '·'}
        </span>
      </div>

      <Link
        to={runDetailHref(lane)}
        className="focus-mark mt-1 block text-body text-fg leading-snug hover:text-accent"
      >
        {lane.title}
      </Link>

      {(lane.external.status !== 'unavailable' || lane.formula.status === 'known') && (
        <div className="mt-1 flex items-baseline gap-x-4 gap-y-1 flex-wrap text-label">
          {lane.external.status !== 'unavailable' && (
            lane.external.status === 'available' ? (
              <a
                href={lane.external.url}
                target="_blank"
                rel="noreferrer"
                className="text-fg-muted uppercase tracking-wider hover:text-fg focus-mark"
              >
                {lane.external.label}
              </a>
            ) : (
              <span className="text-fg-muted uppercase tracking-wider">
                {lane.external.label}
              </span>
            )
          )}
          {lane.formula.status === 'known' && (
            <span className="text-fg-faint tnum">{lane.formula.name}</span>
          )}
        </div>
      )}

      {lane.stages.length > 0 && (
        <ol
          className="mt-2 flex items-baseline gap-x-2 flex-wrap"
          aria-label={`${lane.title} stages`}
        >
          {lane.stages.map((stage) => (
            <li
              key={stage.key}
              className={`text-label uppercase tracking-wider ${STAGE_TONE[stage.status]}`}
              title={`${stage.label}: ${stage.status}`}
            >
              <span aria-hidden="true">{STAGE_GLYPH[stage.status]}</span>{' '}
              <span
                className={
                  stage.status === 'active'
                    ? 'text-fg'
                    : stage.status === 'blocked'
                      ? 'text-accent'
                      : 'text-fg-muted'
                }
              >
                {stage.label}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-2 flex items-baseline gap-x-4 gap-y-1 flex-wrap text-label">
        {lane.activeAssignees.length > 0 && (
          <span className="text-fg-muted lowercase tracking-normal">
            <span className="uppercase tracking-wider text-fg-faint">on </span>
            {lane.activeAssignees.join(', ')}
          </span>
        )}
        {statusEntries.length > 0 && (
          <span className="text-fg-faint uppercase tracking-wider tnum tabular-nums">
            {statusEntries
              .map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`)
              .join(' · ')}
          </span>
        )}
      </div>
    </li>
  );
}

function runDetailHref(lane: RunLane): string {
  const search = new URLSearchParams();
  if (lane.scope.status === 'available') {
    search.set('scope_kind', lane.scope.kind);
    search.set('scope_ref', lane.scope.ref);
  }
  const qs = search.toString();
  return `/runs/${encodeURIComponent(lane.id)}${qs ? `?${qs}` : ''}`;
}

function statusSortKey(status: string): string {
  const order: Record<string, string> = {
    blocked: '0',
    in_progress: '1',
    open: '2',
    closed: '3',
  };
  return `${order[status] ?? '9'}-${status}`;
}
