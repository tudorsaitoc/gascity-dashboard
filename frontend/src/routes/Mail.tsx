import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GcMailItem } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { useCachedData } from '../hooks/useCachedData';
import { Button } from '../components/Button';
import { FilterChips } from '../components/FilterChips';
import { GroupedTable } from '../components/GroupedTable';
import { ListSearchBar } from '../components/ListSearchBar';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { type TableColumn } from '../components/Table';
import { AgentPanel } from '../components/AgentPanel';
import { useViewingAs, OPERATOR_ALIAS } from '../contexts/ViewingAsContext';
import { displayLabel } from '../hooks/aliasPriority';
import { useListFilters, type FilterChip } from '../hooks/useListFilters';
import { mailProject } from '../hooks/projectOf';
import { formatRelative } from '../hooks/time';

// Mail chips operate on read-state. "Sent" box has no unread concept;
// the chips still render but their match predicates are box-aware.
const MAIL_CHIPS: ReadonlyArray<FilterChip<GcMailItem>> = [
  { id: 'unread', label: 'unread', match: (m) => !m.read },
  { id: 'read', label: 'read', match: (m) => m.read },
];

const MAIL_SEARCH_FIELDS = (m: GcMailItem): ReadonlyArray<string | undefined> => [
  m.from,
  m.to,
  m.subject,
  m.rig,
  // First body line only — out-of-scope per bead description to search
  // full bodies; matching the preview keeps parity with what the table
  // already renders.
  m.body.split('\n')[0],
];

const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

type MailBox = 'inbox' | 'sent';

export function MailPage() {
  const {
    viewingAs,
    setAlias,
    resetToOperator,
    aliasBuckets,
    aliasesLoading,
    sessionsUnavailable,
    loadAliases,
  } = useViewingAs();
  const [box, setBox] = useState<MailBox>('inbox');

  // Lazy alias prefetch — Mail is the only consumer of the dropdown, so
  // non-Mail routes don't pay the cost (code-reviewer HIGH-1). Idempotent
  // on the context side, so re-entries are no-ops.
  useEffect(() => {
    loadAliases();
  }, [loadAliases]);
  // Tick state so relative timestamps refresh between data fetches. Mirrors
  // the Agents.tsx pattern: 15s interval, visibility-aware so background
  // tabs don't churn.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 15_000);
    return () => clearInterval(tick);
  }, []);

  const { data: mailData, loading, error: mailError, refresh } = useCachedData(
    `mail:${box}:${viewingAs.alias}`,
    () => api.listMail(box, viewingAs.alias),
  );
  const items = mailData?.items ?? [];
  const [error, setError] = useState<string | null>(null);
  // Surface fetch errors from the cached hook through the same state
  // local handlers use, so the existing error banner keeps working.
  useEffect(() => {
    if (mailError) setError(mailError);
  }, [mailError]);

  const [threadFor, setThreadFor] = useState<GcMailItem | null>(null);
  const [threadItems, setThreadItems] = useState<GcMailItem[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [composing, setComposing] = useState(false);

  const openThread = useCallback(
    async (mail: GcMailItem) => {
      setThreadFor(mail);
      setThreadItems([]);
      if (!mail.thread_id) return;
      setThreadLoading(true);
      try {
        const data = await api.getThread(mail.thread_id, viewingAs.alias);
        setThreadItems(data.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'thread failed');
      } finally {
        setThreadLoading(false);
      }
    },
    [viewingAs.alias],
  );

  const columns = useMemo<ReadonlyArray<TableColumn<GcMailItem>>>(() => [
    {
      key: 'from',
      label: 'From',
      sortable: true,
      sortValue: (r) => r.from,
      render: (r) => <span className="text-fg-muted">{r.from}</span>,
      className: 'w-48',
    },
    {
      key: 'subject',
      label: 'Subject',
      sortable: true,
      sortValue: (r) => r.subject,
      render: (r) => (
        <div className="min-w-0">
          <p className={`truncate ${r.read ? 'text-fg-muted' : 'text-fg font-medium'}`}>
            {r.subject}
          </p>
          <p className="text-label uppercase tracking-wider text-fg-faint mt-1 truncate">
            {r.body.split('\n')[0] ?? ''}
          </p>
        </div>
      ),
    },
    {
      key: 'created_at',
      label: 'When',
      sortable: true,
      sortValue: (r) => r.created_at,
      render: (r) => (
        <span className="tnum text-fg-muted">{formatRelative(r.created_at, now)}</span>
      ),
      className: 'w-24',
      align: 'right',
    },
  ], [now]);

  const aliasLabel = useMemo(
    () => displayLabel(viewingAs.alias, OPERATOR_ALIAS),
    [viewingAs.alias],
  );

  const synopsis = useMemo(() => {
    const noun = box === 'inbox' ? 'inbox' : 'sent';
    if (items.length === 0) return `${capitalize(noun)} empty for ${aliasLabel}.`;
    const unread = box === 'inbox' ? items.filter((m) => !m.read).length : 0;
    if (unread > 0) return `${items.length} in ${noun}, ${unread} unread.`;
    return `${items.length} in ${noun}.`;
  }, [box, items, aliasLabel]);

  // Mail view key includes box so collapsed-project state is independent
  // between inbox and sent (different mental models).
  const filters = useListFilters<GcMailItem>({
    viewKey: `mail:${box}`,
    rows: items,
    projectOf: mailProject,
    searchOf: MAIL_SEARCH_FIELDS,
    chips: MAIL_CHIPS,
  });

  // Sent box has no unread concept; suppress those chips there.
  const visibleChips = box === 'sent' ? [] : MAIL_CHIPS;

  return (
    <section>
      <PageHeader
        title="Mail"
        synopsis={synopsis}
        meta={
          <>
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            <Button
              tone="accent"
              size="sm"
              onClick={() => setComposing(true)}
              disabled={!viewingAs.isOperator}
              title={
                viewingAs.isOperator
                  ? 'Compose a new message (sends as the operator)'
                  : 'Switch back to the operator to compose'
              }
            >
              Compose
            </Button>
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      <div className="flex gap-8 items-start">
        <AgentPanel
          buckets={aliasBuckets}
          loading={aliasesLoading}
          sessionsUnavailable={sessionsUnavailable}
          value={viewingAs.alias}
          onChange={setAlias}
          onReset={resetToOperator}
          isOperator={viewingAs.isOperator}
        />

        <div className="flex-1 min-w-0">
          <div className="mb-6">
            <BoxTabs box={box} onChange={setBox} />
          </div>

          <div className="mb-6 space-y-3">
            <ListSearchBar
              value={filters.search}
              onChange={filters.setSearch}
              placeholder="Search mail by sender, subject, rig"
              matchCount={filters.totalMatches}
              totalCount={items.length}
              ariaLabel="Search mail"
            />
            {visibleChips.length > 0 && (
              <FilterChips
                chips={visibleChips}
                activeIds={filters.activeChipIds}
                onToggle={filters.toggleChip}
                legend="Read state"
              />
            )}
          </div>

          <GroupedTable
            groups={filters.groups}
            columns={columns}
            rowKey={(r) => r.id}
            onToggleProject={filters.toggleProject}
            onRowClick={(r) => void openThread(r)}
            emptyMessage={
              filters.search.length > 0 || filters.activeChipIds.size > 0
                ? 'No messages match the current search or filter.'
                : `${box === 'inbox' ? 'Inbox' : 'Sent'} empty for ${aliasLabel}.`
            }
            perProjectEmpty="No messages in this project."
            initialSort={{ key: 'created_at', dir: 'desc' }}
          />
        </div>
      </div>

      <Modal
        open={threadFor !== null}
        onClose={() => setThreadFor(null)}
        title={threadFor?.subject ?? 'Thread'}
        caption={`Reading as ${aliasLabel}, ${threadItems.length} message(s)`}
        widthClass="max-w-3xl"
      >
        {threadLoading ? (
          <p className="text-fg-muted italic">Loading thread.</p>
        ) : threadItems.length === 0 && threadFor ? (
          <ThreadMessage message={threadFor} />
        ) : (
          <ol className="space-y-6">
            {threadItems.map((m) => (
              <li key={m.id}>
                <ThreadMessage message={m} />
              </li>
            ))}
          </ol>
        )}
      </Modal>

      <ComposeModal
        open={composing}
        onClose={() => setComposing(false)}
        onSent={() => {
          setComposing(false);
          if (box === 'sent') void refresh();
        }}
      />
    </section>
  );
}

function BoxTabs({ box, onChange }: { box: MailBox; onChange: (b: MailBox) => void }) {
  return (
    <div className="flex items-baseline gap-6">
      {(['inbox', 'sent'] as MailBox[]).map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => onChange(b)}
          className={`text-title transition-colors duration-150 ease-out-quart focus-mark rounded-sm ${
            box === b
              ? 'text-fg font-semibold'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          {capitalize(b)}
        </button>
      ))}
    </div>
  );
}

function ThreadMessage({ message }: { message: GcMailItem }) {
  return (
    <article className="space-y-3 pb-4 border-b border-rule last:border-0">
      <header className="flex items-baseline justify-between gap-3">
        <div className="text-label uppercase tracking-wider text-fg-muted truncate">
          <span className="text-fg font-medium">{message.from}</span>
          <span className="mx-1.5 text-fg-faint">→</span>
          <span>{message.to}</span>
        </div>
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          {formatAbsolute(message.created_at)}
        </span>
      </header>
      <p className="text-title font-semibold text-fg">{message.subject}</p>
      <StatusBadge tone="warn" label={PROMPT_INJECTION_NOTICE} />
      <pre className="text-body whitespace-pre-wrap leading-relaxed text-fg overflow-x-auto">
        {message.body}
      </pre>
    </article>
  );
}

function ComposeModal({
  open,
  onClose,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const { viewingAs } = useViewingAs();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTo('');
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open]);

  const onSend = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      await api.sendMail({ to, subject, body });
      onSent();
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'send failed';
      setError(msg);
    } finally {
      setSending(false);
    }
  }, [body, onSent, subject, to]);

  const canSend = viewingAs.isOperator && to.length > 0 && subject.length > 0 && body.length > 0 && !sending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New message"
      caption="Sends from the operator. Reading-as has no effect on the sender."
      widthClass="max-w-2xl"
      footer={
        <>
          <Button tone="quiet" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" size="sm" disabled={!canSend} onClick={() => void onSend()}>
            {sending ? 'Sending' : 'Send'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="From">
          <input
            type="text"
            value={
              viewingAs.isOperator
                ? displayLabel(OPERATOR_ALIAS, OPERATOR_ALIAS)
                : `${displayLabel(OPERATOR_ALIAS, OPERATOR_ALIAS)} (reading-as does not change sender)`
            }
            disabled
            className="w-full bg-transparent border-0 border-b border-rule pb-1 text-body text-fg-muted italic"
          />
        </Field>
        <Field label="To (alias)">
          <input
            type="text"
            autoFocus
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="mayor, mechanic, scix-worker, …"
            className="w-full bg-transparent border-0 border-b border-rule pb-1 text-body text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none transition-colors"
          />
        </Field>
        <Field label="Subject">
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            className="w-full bg-transparent border-0 border-b border-rule pb-1 text-body text-fg focus:border-accent focus:outline-none transition-colors"
          />
        </Field>
        <Field label="Body">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            maxLength={16 * 1024}
            className="w-full bg-surface-tint border border-rule rounded-sm px-3 py-2 text-body text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 resize-y"
          />
        </Field>
        {!viewingAs.isOperator && (
          <StatusBadge
            tone="warn"
            label={`Reading as ${displayLabel(viewingAs.alias, OPERATOR_ALIAS)}. Sends from this modal are structurally locked to the operator regardless.`}
          />
        )}
        {error && (
          <StatusBadge tone="stuck" label={error} />
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-label uppercase tracking-wider text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatAbsolute(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '·';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
