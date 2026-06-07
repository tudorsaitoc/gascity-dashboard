import { Link } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { READ_ONLY_CONTROL_TITLE, ReadOnlyBadge } from '../../../contexts/ReadOnlyContext';
import { formatRelative } from '../../../hooks/time';
import { formatDateTime } from '../../../lib/format';
import type { MaintainerSlingIntent, SlingSuccess } from './maintainerSelection';

// Bottom-pinned action bar (gascity-dashboard-0nn). Renders when
// selection > 0 OR a post-sling success line is currently visible
// (gascity-dashboard-5ly). Editorial register, NOT a sticky toolbar
// with chrome: single line of type with a hairline top rule, on the
// page's surface color. No card, no rounded panel, no drop-shadow.
// Per the Flat Page Rule, the separator is space + type + a single
// 1px rule, not a container.
export function SelectionActionBar({
  count,
  skippedCount,
  onSend,
  onSendDraft,
  onClear,
  sending,
  error,
  success,
  readOnly = false,
}: {
  count: number;
  /** Selected keys that vanished from the current envelope before send. */
  skippedCount: number;
  /** Dispatch with intent='triage' (asks an agent to assess prioritisation). */
  onSend: () => void;
  /** Dispatch with intent='draft' (asks an agent to write a PR). */
  onSendDraft: () => void;
  onClear: () => void;
  /** Which intent is mid-flight, or null when idle. */
  sending: MaintainerSlingIntent | null;
  error: string | null;
  success: SlingSuccess | null;
  /** When true the supervisor proxy 405s slings; disable both dispatch buttons. */
  readOnly?: boolean;
}) {
  const isSending = sending !== null;
  const slingTitle = readOnly ? READ_ONLY_CONTROL_TITLE : undefined;
  return (
    <div
      className="fixed inset-x-0 bottom-0 border-t border-rule bg-surface"
      role="region"
      aria-label="bulk triage actions"
    >
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-baseline justify-between gap-6">
        <div className="flex items-baseline gap-3 text-body text-fg-muted">
          {count > 0 && (
            <>
              <span className="tnum text-fg">{count}</span>
              <span>selected</span>
            </>
          )}
          {skippedCount > 0 && (
            <>
              {count > 0 && <span aria-hidden>·</span>}
              <span>
                <span className="tnum text-fg-muted">{skippedCount}</span> skipped; no longer in
                list
              </span>
            </>
          )}
          {error !== null && (
            <>
              {(count > 0 || skippedCount > 0) && <span aria-hidden>·</span>}
              <span className="text-accent" role="alert">
                {error}
              </span>
            </>
          )}
          {success !== null && (
            <>
              {(count > 0 || skippedCount > 0 || error !== null) && <span aria-hidden>·</span>}
              <span className="text-fg" role="status">
                Slung <span className="tnum">{success.count}</span> to {success.target}.{' '}
                <Link
                  to="/agents"
                  className="text-fg hover:text-accent focus-mark underline-offset-2 hover:underline"
                >
                  View in Agents <span aria-hidden>→</span>
                </Link>
              </span>
            </>
          )}
        </div>
        <div className="flex items-baseline gap-3">
          {readOnly && <ReadOnlyBadge />}
          <Button
            size="sm"
            onClick={onSend}
            disabled={readOnly || isSending || count === 0}
            title={slingTitle}
          >
            {sending === 'triage' ? 'Sending' : 'Send to triage agent'}
          </Button>
          <Button
            size="sm"
            tone="quiet"
            onClick={onSendDraft}
            disabled={readOnly || isSending || count === 0}
            title={slingTitle}
          >
            {sending === 'draft' ? 'Sending' : 'Send to draft agent'}
          </Button>
          <Button size="sm" tone="quiet" onClick={onClear} disabled={isSending}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

export function MaintainerFooter({ computedAt, now }: { computedAt: string | null; now: number }) {
  if (computedAt === null) {
    return (
      <p className="mt-16 text-label uppercase tracking-wider text-fg-faint">
        enrichment not yet computed · status data is live
      </p>
    );
  }
  return (
    <p className="mt-16 text-label uppercase tracking-wider text-fg-faint tnum">
      clusters computed {formatDateTime(computedAt)} · {formatRelative(computedAt, now)} ago
    </p>
  );
}
