import type { AttentionDomainSummary, BadgeSeverity } from './compose';

export function NavAttentionIndicator({
  label,
  summary,
  suppressAccent = false,
}: {
  label: string;
  summary: AttentionDomainSummary;
  /**
   * gascity-dashboard-fchh major 4 (DESIGN.md One Mark): when the board liveness
   * line owns the viewport's single maroon mark, the count still renders (the
   * number is the signal) but drops to neutral tone so the header never shows two
   * maroons at once. The badge count is unchanged — only its colour defers.
   */
  suppressAccent?: boolean;
}) {
  const total = summary.attention + summary.watch;
  if (total === 0 || summary.severity === null) return null;
  const itemWord = total === 1 ? 'item' : 'items';

  return (
    <span
      aria-label={`${label}: ${total} ${summary.severity} ${itemWord}`}
      className={`ml-1 align-super text-[0.65rem] leading-none tnum ${
        suppressAccent ? 'text-fg-muted' : severityClass(summary.severity)
      }`}
    >
      {total}
    </span>
  );
}

function severityClass(severity: BadgeSeverity): string {
  return severity === 'attention' ? 'text-accent' : 'text-warn';
}
