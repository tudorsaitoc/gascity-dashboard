import type { SourceState, WorkflowSummary } from 'gas-city-dashboard-shared';
import { LaneCard } from './LaneCard';

// Workflow phase-lane map (gascity-dashboard-0t6). Renders the snapshot's
// workflows source as a typographic block list — count summary up top,
// hairline-separated lanes below. No card chrome anywhere; hierarchy is
// carried by space, weight, and tracked-uppercase column heads, matching
// the Flat Page Rule and Greyscale Test in DESIGN.md.

interface WorkflowMapProps {
  source: SourceState<WorkflowSummary>;
  now: number;
}

const COUNT_LABELS: Array<[keyof WorkflowSummary['runCounts'], string]> = [
  ['prReview', 'PR'],
  ['designReview', 'Design'],
  ['bugfix', 'Bugfix'],
  ['other', 'Other'],
];

export function WorkflowMap({ source, now }: WorkflowMapProps) {
  const summary = source.data;

  if (summary === null) {
    return (
      <section>
        <CountsHeader summary={null} />
        <p className="mt-8 text-body text-fg-muted italic">
          {source.status === 'error'
            ? `Workflow data unavailable: ${source.error ?? 'unknown error'}.`
            : 'Waiting for workflow data.'}
        </p>
      </section>
    );
  }

  return (
    <section>
      <CountsHeader summary={summary} />
      {summary.lanes.length === 0 ? (
        <p className="mt-8 text-body text-fg-muted italic">
          No active workflows.
        </p>
      ) : (
        <ol className="mt-6 divide-y divide-rule">
          {summary.lanes.map((lane) => (
            <LaneCard key={lane.id} lane={lane} now={now} />
          ))}
        </ol>
      )}
      {summary.totalActive > summary.lanes.length && (
        <p className="mt-3 text-label uppercase tracking-wider text-fg-faint tnum">
          {summary.totalActive - summary.lanes.length} more not shown
        </p>
      )}
    </section>
  );
}

function CountsHeader({ summary }: { summary: WorkflowSummary | null }) {
  const total = summary?.runCounts.total ?? 0;
  const blocked = summary?.runCounts.blocked ?? 0;
  return (
    <header className="space-y-2">
      <div className="flex items-baseline gap-x-6 gap-y-2 flex-wrap">
        <CountTile label="Active" value={total} tone="strong" />
        {COUNT_LABELS.map(([key, label]) => (
          <CountTile
            key={key}
            label={label}
            value={summary?.runCounts[key] ?? 0}
            tone="muted"
          />
        ))}
        {blocked > 0 && (
          <CountTile label="Blocked" value={blocked} tone="accent" />
        )}
      </div>
    </header>
  );
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'strong' | 'muted' | 'accent';
}) {
  // tnum + tracked-uppercase label per the column-head register elsewhere on
  // the page; value sits below in body weight. No box around either.
  const valueTone =
    tone === 'strong'
      ? 'text-fg'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-fg-muted';
  return (
    <div className="flex flex-col">
      <span className="text-label uppercase tracking-wider text-fg-faint">
        {label}
      </span>
      <span className={`text-title tnum ${valueTone}`}>
        {value}
      </span>
    </div>
  );
}
