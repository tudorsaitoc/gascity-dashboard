import type { WorkflowLane, WorkflowStage } from 'gas-city-dashboard-shared';
import { formatRelative } from '../../hooks/time';

// Per-lane typographic row. No card chrome — vertical rhythm carries the
// hierarchy, hairline dividers separate lanes at the WorkflowMap level.
// The phase label up top, the title underneath, then a glyph row for
// stage progress, then secondary metadata. Reads in greyscale: phase
// identity comes from order + label + stage glyphs, not color.

const STAGE_GLYPH: Record<WorkflowStage['status'], string> = {
  pending: '·',
  active: '⬣',
  complete: '◆',
  blocked: '✕',
};

const STAGE_TONE: Record<WorkflowStage['status'], string> = {
  pending: 'text-fg-faint',
  active: 'text-fg',
  complete: 'text-fg-muted',
  // Warm-amber tint reserved for blocked status only (DESIGN.md).
  blocked: 'text-accent',
};

interface LaneCardProps {
  lane: WorkflowLane;
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
          title={lane.updatedAt ?? 'no recent update'}
        >
          {formatRelative(lane.updatedAt, now)}
        </span>
      </div>

      <p className="mt-1 text-body text-fg leading-snug">{lane.title}</p>

      {(lane.externalLabel !== null || lane.formula !== null) && (
        <div className="mt-1 flex items-baseline gap-x-4 gap-y-1 flex-wrap text-label">
          {lane.externalLabel !== null && (
            lane.externalUrl !== null ? (
              <a
                href={lane.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="text-fg-muted uppercase tracking-wider hover:text-fg focus-mark"
              >
                {lane.externalLabel}
              </a>
            ) : (
              <span className="text-fg-muted uppercase tracking-wider">
                {lane.externalLabel}
              </span>
            )
          )}
          {lane.formula !== null && (
            <span className="text-fg-faint tnum">{lane.formula}</span>
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

function statusSortKey(status: string): string {
  const order: Record<string, string> = {
    blocked: '0',
    in_progress: '1',
    open: '2',
    closed: '3',
  };
  return `${order[status] ?? '9'}-${status}`;
}
