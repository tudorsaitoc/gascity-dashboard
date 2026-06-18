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
   * line owns the viewport's single maroon mark, a maroon (attention) badge still
   * renders its count but drops to neutral tone so the header never shows two
   * maroons at once. The One Mark Rule is MAROON-only — Caution Ochre (text-warn,
   * a 'watch' badge) is a separate signal that coexists with one maroon, so it is
   * left untouched (gascity-dashboard-4q60). The badge count is never changed —
   * only an attention badge's colour defers.
   */
  suppressAccent?: boolean;
}) {
  const total = summary.attention + summary.watch;
  if (total === 0 || summary.severity === null) return null;
  const itemWord = total === 1 ? 'item' : 'items';
  const suppressMaroon = suppressAccent && summary.severity === 'attention';

  return (
    <span
      aria-label={`${label}: ${total} ${summary.severity} ${itemWord}`}
      className={`ml-1 align-super text-[0.65rem] leading-none tnum ${
        suppressMaroon ? 'text-fg-muted' : severityClass(summary.severity)
      }`}
    >
      {total}
    </span>
  );
}

function severityClass(severity: BadgeSeverity): string {
  return severity === 'attention' ? 'text-accent' : 'text-warn';
}
