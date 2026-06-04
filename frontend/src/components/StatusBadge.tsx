import type { ReactNode } from 'react';

// Status is always carried by glyph + word + color, in that order of
// importance. Strip color (the greyscale test) and the badge still
// reads. Per DESIGN.md §Status, never the primary signal — always
// paired.

export type StatusTone = 'ok' | 'warn' | 'stuck' | 'neutral';

interface StatusBadgeProps {
  tone: StatusTone;
  label: ReactNode;
  /** Override the default glyph for this tone. */
  glyph?: ReactNode;
  /** Extra trailing meta (e.g. " · att" for attached sessions). */
  trailing?: ReactNode;
  className?: string;
  title?: string;
}

const TONE_COLOR: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  stuck: 'text-accent',
  neutral: 'text-fg-muted',
};

const TONE_GLYPH: Record<StatusTone, string> = {
  ok: '●', // ●
  warn: '▲', // ▲
  stuck: '■', // ■
  neutral: '·', // ·
};

export function StatusBadge({
  tone,
  label,
  glyph,
  trailing,
  className = '',
  title,
}: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 text-body ${TONE_COLOR[tone]} ${className}`}
      title={title}
    >
      <span aria-hidden className="text-[0.85em] leading-none translate-y-[1px]">
        {glyph ?? TONE_GLYPH[tone]}
      </span>
      <span>{label}</span>
      {trailing && (
        <span className="text-fg-faint text-label uppercase tracking-wider">{trailing}</span>
      )}
    </span>
  );
}

export function beadStatusTone(status: string): StatusTone {
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
