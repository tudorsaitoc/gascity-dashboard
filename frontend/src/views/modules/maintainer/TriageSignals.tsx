import { Link } from 'react-router-dom';
import type { TriageItem } from 'gas-city-dashboard-shared';

export function TriageScore({
  item,
}: {
  item: Pick<TriageItem, 'triage_score' | 'triage_assessment'>;
}) {
  if (item.triage_assessment !== null) {
    const vettedLabel = `vetted by ${item.triage_assessment.source}: score ${item.triage_assessment.vetted_score}`;
    return (
      <>
        <span aria-hidden>·</span>
        <span className="text-fg" title={vettedLabel} aria-label={vettedLabel}>
          <span aria-hidden className="mr-1">
            {'✓'}
          </span>
          {item.triage_assessment.vetted_score}
        </span>
      </>
    );
  }
  if (item.triage_score !== null) {
    return (
      <>
        <span aria-hidden>·</span>
        <span
          className="text-fg-faint italic"
          title="heuristic triage score = severity_base + simplicity_bonus; awaiting agent assessment"
        >
          t{item.triage_score}
        </span>
      </>
    );
  }
  return null;
}

export function SlungLink({ item }: { item: Pick<TriageItem, 'slung'> }) {
  if (item.slung === null) return null;
  const { target, resolved_session_name } = item.slung;
  if (resolved_session_name === null || resolved_session_name.includes('/')) {
    return (
      <>
        <span aria-hidden>·</span>
        <span
          className="text-fg-faint italic"
          title={`slung to ${target}, but no running session carries that role; sling routed successfully, this link can drill in once the agent spawns`}
          aria-label={`no session for role ${target}; sling itself succeeded`}
        >
          no session for {target}
        </span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden>·</span>
      <Link
        to={`/agents/${encodeURIComponent(resolved_session_name)}`}
        className="text-fg-faint hover:text-fg focus-mark"
        title={`slung to ${target}; click to verify the agent is working`}
        aria-label={`slung to ${target}, open agent detail`}
      >
        slung →
      </Link>
    </>
  );
}
