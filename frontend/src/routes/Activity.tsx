import type { DeployList, DeployRecord, GitCommitList } from 'gas-city-dashboard-shared';
import { Fragment, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatApiError } from '../api/client';
import { getActiveCity } from '../api/cityBase';
import type { BadgeSeverity } from '../attention/compose';
import { useAttentionModel } from '../attention/context';
import {
  attentionListItemProps,
  attentionRowProps,
  resourceAttentionSeverity,
} from '../attention/routeHighlight';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import type { TypedEventStreamEnvelope } from 'gas-city-dashboard-shared/gc-supervisor';
import { formatClockTime, formatShortDate } from '../hooks/time';
import { useCachedData } from '../hooks/useCachedData';
import { useVisibleRefresh } from '../hooks/useVisibleRefresh';
import {
  DEFAULT_EVENT_WINDOW,
  listSupervisorEvents,
  type SupervisorEventList,
} from '../supervisor/eventReads';
import {
  supervisorEventDetail,
  supervisorEventSignal,
  type SupervisorEventSignal,
} from '../supervisor/eventSignals';

type ActivityMode = 'all' | 'events' | 'deploys' | 'commits';
type EventSignalFilter = SupervisorEventSignal | 'all';

interface ActivityBundle {
  commits: GitCommitList | null;
  commitsError?: string;
  deploys: DeployList | null;
  deploysError?: string;
  events: SupervisorEventList | null;
  eventsError?: string;
}

const MODES: ReadonlyArray<{ mode: ActivityMode; label: string }> = [
  { mode: 'all', label: 'All' },
  { mode: 'events', label: 'Events' },
  { mode: 'deploys', label: 'Deploys' },
  { mode: 'commits', label: 'Commits' },
];
const EVENT_WINDOWS = [
  { value: '1h', label: 'Last hour' },
  { value: DEFAULT_EVENT_WINDOW, label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
] as const;
const EVENT_SIGNAL_FILTERS: ReadonlyArray<{ value: EventSignalFilter; label: string }> = [
  { value: 'all', label: 'All signals' },
  { value: 'attention', label: 'Attention' },
  { value: 'watch', label: 'Watch' },
  { value: 'event', label: 'Event' },
];

export function ActivityPage() {
  const attention = useAttentionModel();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = readMode(searchParams);
  const eventsVisible = shouldShow(mode, 'events');
  const eventType = eventsVisible ? normalizedParam(searchParams.get('type')) : null;
  const eventActor = eventsVisible ? normalizedParam(searchParams.get('actor')) : null;
  const eventWindow = eventsVisible ? readEventWindow(searchParams) : DEFAULT_EVENT_WINDOW;
  const eventSignal = eventsVisible ? readEventSignal(searchParams) : 'all';
  const textFilter = eventsVisible ? normalizedParam(searchParams.get('q')) : null;
  const cityName = getActiveCity();
  const cacheKey = [
    'activity:bundle',
    cityName ?? 'no-city',
    mode,
    eventType ?? 'all',
    eventActor ?? 'all',
    eventWindow,
    eventSignal,
    textFilter ?? '',
  ].join(':');
  const { data, loading, error, refresh } = useCachedData(cacheKey, () =>
    fetchActivityBundle(mode, eventType, eventActor, eventWindow, eventSignal, textFilter),
  );

  useVisibleRefresh(refresh, 30_000);

  return (
    <section>
      <PageHeader
        title="Activity"
        synopsis={activitySynopsis(mode, eventType)}
        meta={
          <>
            {error && (
              <span className="normal-case text-body text-accent" role="alert">
                {error}
              </span>
            )}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      <ActivityModeNav active={mode} eventType={eventType} />
      {eventsVisible && (
        <ActivityFilters
          eventType={eventType}
          eventActor={eventActor}
          eventWindow={eventWindow}
          eventSignal={eventSignal}
          searchParams={searchParams}
          setSearchParams={setSearchParams}
          textFilter={textFilter}
        />
      )}

      <div className="mt-10 space-y-12">
        {shouldShow(mode, 'events') && (
          <EventsSection
            events={data?.events ?? null}
            {...(data?.eventsError !== undefined ? { error: data.eventsError } : {})}
            filterActive={
              eventType !== null ||
              eventActor !== null ||
              eventSignal !== 'all' ||
              textFilter !== null
            }
            loading={loading}
            attentionSeverity={(event) =>
              resourceAttentionSeverity(attention, 'activity', eventResourceId(event))
            }
          />
        )}
        {shouldShow(mode, 'deploys') && (
          <DeploysSection
            deploys={data?.deploys ?? null}
            {...(data?.deploysError !== undefined ? { error: data.deploysError } : {})}
            loading={loading}
            attentionSeverity={(deploy) =>
              resourceAttentionSeverity(attention, 'activity', deployResourceId(deploy))
            }
          />
        )}
        {shouldShow(mode, 'commits') && (
          <CommitsSection
            commits={data?.commits ?? null}
            {...(data?.commitsError !== undefined ? { error: data.commitsError } : {})}
            loading={loading}
          />
        )}
      </div>
    </section>
  );
}

async function fetchActivityBundle(
  mode: ActivityMode,
  eventType: string | null,
  eventActor: string | null,
  eventWindow: string,
  eventSignal: EventSignalFilter,
  textFilter: string | null,
): Promise<ActivityBundle> {
  const [events, deploys, commits] = await Promise.allSettled([
    shouldShow(mode, 'events')
      ? fetchFilteredEvents(eventType, eventActor, eventWindow, eventSignal, textFilter)
      : Promise.resolve(null),
    shouldShow(mode, 'deploys') ? api.listBuilds() : Promise.resolve(null),
    shouldShow(mode, 'commits') ? api.listCommits('recent-all') : Promise.resolve(null),
  ]);
  return {
    commits: settledValue(commits),
    ...(commits.status === 'rejected'
      ? { commitsError: formatApiError(commits.reason, 'git commits unavailable') }
      : {}),
    deploys: settledValue(deploys),
    ...(deploys.status === 'rejected'
      ? { deploysError: formatApiError(deploys.reason, 'deploy history unavailable') }
      : {}),
    events: settledValue(events),
    ...(events.status === 'rejected'
      ? { eventsError: formatApiError(events.reason, 'event history unavailable') }
      : {}),
  };
}

async function fetchFilteredEvents(
  eventType: string | null,
  eventActor: string | null,
  eventWindow: string,
  eventSignal: EventSignalFilter,
  textFilter: string | null,
): Promise<SupervisorEventList> {
  const list = await listSupervisorEvents({
    since: eventWindow,
    ...(eventType === null ? {} : { type: eventType }),
    ...(eventActor === null ? {} : { actor: eventActor }),
  });
  const query = textFilter?.toLowerCase() ?? '';
  const items = list.items.filter((event) => {
    if (eventType !== null && event.type !== eventType) return false;
    if (eventActor !== null && event.actor !== eventActor) return false;
    if (eventSignal !== 'all' && supervisorEventSignal(event) !== eventSignal) return false;
    if (query.length === 0) return true;
    return searchableEventText(event).includes(query);
  });
  return { ...list, items, total: items.length };
}

function settledValue<T>(result: PromiseSettledResult<T | null>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function ActivityModeNav({
  active,
  eventType,
}: {
  active: ActivityMode;
  eventType: string | null;
}) {
  return (
    <nav aria-label="Activity modes">
      <ul className="flex flex-wrap gap-2">
        {MODES.map(({ mode, label }) => {
          const isActive = active === mode;
          return (
            <li key={mode}>
              <Link
                to={modeHref(mode, eventType)}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'inline-flex items-center rounded-sm border px-2.5 py-1 text-label uppercase tracking-wider transition-colors duration-150 ease-out-quart focus-mark',
                  isActive
                    ? 'border-fg text-fg'
                    : 'border-rule text-fg-muted hover:text-fg hover:bg-surface-tint',
                ].join(' ')}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ActivityFilters({
  eventActor,
  eventSignal,
  eventType,
  eventWindow,
  searchParams,
  setSearchParams,
  textFilter,
}: {
  eventActor: string | null;
  eventSignal: EventSignalFilter;
  eventType: string | null;
  eventWindow: string;
  searchParams: URLSearchParams;
  setSearchParams: ReturnType<typeof useSearchParams>[1];
  textFilter: string | null;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-end gap-4">
      <label className="grid gap-1 text-label uppercase tracking-wider text-fg-muted">
        Event window
        <select
          aria-label="Event window"
          value={eventWindow}
          onChange={(event) =>
            setActivitySearchParam(
              setSearchParams,
              searchParams,
              'since',
              event.currentTarget.value,
              DEFAULT_EVENT_WINDOW,
            )
          }
          className="min-w-36 rounded-sm border border-rule bg-surface px-2 py-1 text-body normal-case tracking-normal text-fg focus-mark"
        >
          {EVENT_WINDOWS.map((window) => (
            <option key={window.value} value={window.value}>
              {window.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-label uppercase tracking-wider text-fg-muted">
        Event type
        <input
          aria-label="Event type"
          value={eventType ?? ''}
          onChange={(event) =>
            setActivitySearchParam(setSearchParams, searchParams, 'type', event.currentTarget.value)
          }
          placeholder="session.crashed"
          className="min-w-44 rounded-sm border border-rule bg-surface px-2 py-1 text-body normal-case tracking-normal text-fg placeholder:text-fg-faint focus-mark"
        />
      </label>
      <label className="grid gap-1 text-label uppercase tracking-wider text-fg-muted">
        Event actor
        <input
          aria-label="Event actor"
          value={eventActor ?? ''}
          onChange={(event) =>
            setActivitySearchParam(
              setSearchParams,
              searchParams,
              'actor',
              event.currentTarget.value,
            )
          }
          placeholder="supervisor"
          className="min-w-40 rounded-sm border border-rule bg-surface px-2 py-1 text-body normal-case tracking-normal text-fg placeholder:text-fg-faint focus-mark"
        />
      </label>
      <label className="grid gap-1 text-label uppercase tracking-wider text-fg-muted">
        Signal severity
        <select
          aria-label="Signal severity"
          value={eventSignal}
          onChange={(event) =>
            setActivitySearchParam(
              setSearchParams,
              searchParams,
              'signal',
              event.currentTarget.value,
              'all',
            )
          }
          className="min-w-36 rounded-sm border border-rule bg-surface px-2 py-1 text-body normal-case tracking-normal text-fg focus-mark"
        >
          {EVENT_SIGNAL_FILTERS.map((signal) => (
            <option key={signal.value} value={signal.value}>
              {signal.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid min-w-56 flex-1 gap-1 text-label uppercase tracking-wider text-fg-muted">
        Search activity
        <input
          aria-label="Search activity"
          value={textFilter ?? ''}
          onChange={(event) =>
            setActivitySearchParam(setSearchParams, searchParams, 'q', event.currentTarget.value)
          }
          placeholder="actor, subject, or message"
          className="rounded-sm border border-rule bg-surface px-2 py-1 text-body normal-case tracking-normal text-fg placeholder:text-fg-faint focus-mark"
        />
      </label>
    </div>
  );
}

function EventsSection({
  error,
  events,
  filterActive,
  loading,
  attentionSeverity,
}: {
  error?: string;
  events: SupervisorEventList | null;
  filterActive: boolean;
  loading: boolean;
  attentionSeverity: (event: TypedEventStreamEnvelope) => 'attention' | 'watch' | null;
}) {
  const items = events?.items ?? [];
  const partialErrors = eventPartialErrors(events);
  return (
    <ActivitySection
      title="Supervisor events"
      meta={events === null ? null : `${events.total} events`}
    >
      {error !== undefined && (
        <p className="text-body text-accent" role="alert">
          Event history unavailable: {error}.
        </p>
      )}
      {events?.partial === true && (
        <p className="text-body text-warn">
          Event history incomplete{partialErrors.length > 0 ? `: ${partialErrors.join('; ')}` : '.'}
        </p>
      )}
      <ActivityRecordTable
        label="Supervisor events"
        rows={items}
        // Audit-forwarded events all arrive at seq 0; index breaks ties.
        rowKey={(event, index) => `${event.seq}:${event.type}:${index}`}
        attentionSeverity={attentionSeverity}
        columns={[
          {
            key: 'time',
            label: 'Time',
            render: (event) => (
              <span className="text-fg-muted">
                <TimeStamp ts={event.ts} />
              </span>
            ),
          },
          {
            key: 'signal',
            label: 'Signal',
            render: (event) => <EventSignalBadge signal={supervisorEventSignal(event)} />,
          },
          {
            key: 'type',
            label: 'Type',
            primary: true,
            render: (event) => <span className="font-medium text-fg">{event.type}</span>,
          },
          {
            key: 'subject',
            label: 'Subject',
            render: (event) => <span className="text-fg-muted">{event.subject ?? '·'}</span>,
          },
          {
            key: 'detail',
            label: 'Detail',
            render: (event) => (
              <span className="text-fg-muted">{supervisorEventDetail(event)}</span>
            ),
          },
        ]}
        empty={
          loading
            ? 'Reading supervisor events.'
            : error !== undefined
              ? 'Event history unavailable.'
              : filterActive
                ? 'No supervisor events match these filters.'
                : 'No supervisor events in this window.'
        }
      />
    </ActivitySection>
  );
}

function DeploysSection({
  deploys,
  error,
  loading,
  attentionSeverity,
}: {
  deploys: DeployList | null;
  error?: string;
  loading: boolean;
  attentionSeverity: (deploy: DeployRecord) => 'attention' | 'watch' | null;
}) {
  const items = deploys?.items ?? [];
  return (
    <ActivitySection
      title="Deploy history"
      meta={deploys?.failed_marker === true ? 'failed marker present' : (deploys?.source ?? null)}
    >
      {error !== undefined && (
        <p className="text-body text-accent" role="alert">
          Deploy history unavailable: {error}.
        </p>
      )}
      <ActivityRecordTable
        label="Deploy history"
        rows={items}
        rowKey={(deploy) => `${deploy.at}:${deploy.detail}`}
        attentionSeverity={attentionSeverity}
        columns={[
          {
            key: 'time',
            label: 'Time',
            render: (deploy) => (
              <span className="text-fg-muted">
                <TimeStamp ts={deploy.at} />
              </span>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            render: (deploy) => <DeployStatusBadge deploy={deploy} />,
          },
          {
            key: 'detail',
            label: 'Detail',
            primary: true,
            render: (deploy) => <span className="text-fg-muted">{deploy.detail}</span>,
          },
        ]}
        empty={loading ? 'Reading deploy history.' : 'No deploy records in this window.'}
      />
    </ActivitySection>
  );
}

function CommitsSection({
  commits,
  error,
  loading,
}: {
  commits: GitCommitList | null;
  error?: string;
  loading: boolean;
}) {
  const items = commits?.items ?? [];
  return (
    <ActivitySection title="Git commits" meta={commits === null ? null : commits.view}>
      {error !== undefined && (
        <p className="text-body text-accent" role="alert">
          Git commits unavailable: {error}.
        </p>
      )}
      <ActivityRecordTable
        label="Git commits"
        rows={items}
        rowKey={(commit) => commit.sha}
        columns={[
          {
            key: 'time',
            label: 'Time',
            render: (commit) => (
              <span className="text-fg-muted">
                <TimeStamp ts={commit.date} />
              </span>
            ),
          },
          {
            key: 'commit',
            label: 'Commit',
            render: (commit) => <span className="font-medium text-fg">{commit.short_sha}</span>,
          },
          {
            key: 'author',
            label: 'Author',
            render: (commit) => <span className="text-fg-muted">{commit.author}</span>,
          },
          {
            key: 'subject',
            label: 'Subject',
            primary: true,
            render: (commit) => <span className="text-fg-muted">{commit.subject}</span>,
          },
        ]}
        empty={loading ? 'Reading git commits.' : 'No commits in this window.'}
      />
    </ActivitySection>
  );
}

function ActivitySection({
  children,
  meta,
  title,
}: {
  children: ReactNode;
  meta: string | null;
  title: string;
}) {
  return (
    <section aria-labelledby={sectionId(title)} className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={sectionId(title)} className="text-headline font-semibold tracking-tight text-fg">
          {title}
        </h2>
        {meta !== null && (
          <span className="text-label uppercase tracking-wider text-fg-muted">{meta}</span>
        )}
      </div>
      {children}
    </section>
  );
}

// A typeset record list rendered two ways from one column model so the layouts
// cannot drift: the column grid table from sm: up, and — because that grid
// cannot fit a ~390px phone without an internal horizontal scroll — a dedicated
// stacked list below sm: (each record a typographic block separated by a
// hairline, never a card per DESIGN.md's Flat Page Rule). On mobile, columns
// marked `primary` lead as the headline; the rest fall to a label·value grid.
interface ActivityColumn<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  primary?: boolean;
}

function ActivityRecordTable<T>({
  attentionSeverity,
  columns,
  empty,
  label,
  rowKey,
  rows,
}: {
  attentionSeverity?: (row: T) => BadgeSeverity | null;
  columns: ReadonlyArray<ActivityColumn<T>>;
  empty: ReactNode;
  label: string;
  rowKey: (row: T, index: number) => string;
  rows: ReadonlyArray<T>;
}) {
  const primaryColumns = columns.filter((col) => col.primary === true);
  const detailColumns = columns.filter((col) => col.primary !== true);

  return (
    <>
      <ul role="list" aria-label={label} className="divide-y divide-rule sm:hidden">
        {rows.length === 0 ? (
          <li className="py-10 text-center text-fg-muted italic">{empty}</li>
        ) : (
          rows.map((row, index) => {
            const { className = '', ...severityProps } = attentionListItemProps(
              attentionSeverity?.(row) ?? null,
            );
            return (
              <li
                {...severityProps}
                key={rowKey(row, index)}
                className={`space-y-2 py-4 ${className}`}
              >
                {primaryColumns.map((col) => (
                  <div key={col.key}>{col.render(row)}</div>
                ))}
                {detailColumns.length > 0 && (
                  <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1">
                    {detailColumns.map((col) => (
                      <Fragment key={col.key}>
                        <dt className="text-label uppercase tracking-wider text-fg-faint">
                          {col.label}
                        </dt>
                        <dd className="min-w-0">{col.render(row)}</dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </li>
            );
          })
        )}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table aria-label={label} className="w-full text-body tnum">
          <thead>
            <tr className="border-b border-rule text-label uppercase tracking-wider text-fg-muted">
              {columns.map((col) => (
                <th key={col.key} scope="col" className="pb-3 pr-6 text-left font-medium">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-10 text-center text-fg-muted italic">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const { className = '', ...severityProps } = attentionRowProps(
                  attentionSeverity?.(row) ?? null,
                );
                return (
                  <tr
                    {...severityProps}
                    key={rowKey(row, index)}
                    className={`border-b border-rule ${className}`}
                  >
                    {columns.map((col) => (
                      <td key={col.key} className="py-3 pr-6 align-baseline">
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TimeStamp({ ts }: { ts: string }) {
  return <span title={formatShortDate(ts)}>{formatClockTime(ts)}</span>;
}

function EventSignalBadge({ signal }: { signal: SupervisorEventSignal }) {
  const tone: StatusTone =
    signal === 'attention' ? 'stuck' : signal === 'watch' ? 'warn' : 'neutral';
  return <StatusBadge tone={tone} label={signal} />;
}

function DeployStatusBadge({ deploy }: { deploy: DeployRecord }) {
  const tone: StatusTone =
    deploy.status === 'ok'
      ? 'ok'
      : deploy.status === 'failed'
        ? 'stuck'
        : deploy.status === 'in-progress'
          ? 'warn'
          : 'neutral';
  return <StatusBadge tone={tone} label={deploy.status} />;
}

function activitySynopsis(mode: ActivityMode, eventType: string | null): string {
  if (mode === 'events' && eventType !== null) return `Supervisor events filtered to ${eventType}.`;
  if (mode === 'events') return 'Supervisor event history from the active city.';
  if (mode === 'deploys') return 'Deploy history from dashboard-local project logs.';
  if (mode === 'commits') return 'Recent git commits from the local project checkout.';
  return 'Supervisor events, deploy history, and recent project commits.';
}

function eventResourceId(event: TypedEventStreamEnvelope): string {
  return `event:${String(event.seq)}:${event.type}`;
}

function deployResourceId(deploy: DeployRecord): string {
  if (deploy.status === 'failed' || deploy.status === 'in-progress') {
    return `deploy:${deploy.at}:${deploy.status}`;
  }
  return `deploy:${deploy.at}`;
}

function modeHref(mode: ActivityMode, eventType: string | null): string {
  if (mode === 'all') return '/activity';
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (mode === 'events' && eventType !== null) params.set('type', eventType);
  return `/activity?${params.toString()}`;
}

function shouldShow(active: ActivityMode, section: Exclude<ActivityMode, 'all'>): boolean {
  return active === 'all' || active === section;
}

function readMode(searchParams: URLSearchParams): ActivityMode {
  const mode = searchParams.get('mode');
  return mode === 'events' || mode === 'deploys' || mode === 'commits' ? mode : 'all';
}

function normalizedParam(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readEventWindow(searchParams: URLSearchParams): string {
  const raw = normalizedParam(searchParams.get('since'));
  return raw !== null && EVENT_WINDOWS.some((window) => window.value === raw)
    ? raw
    : DEFAULT_EVENT_WINDOW;
}

function readEventSignal(searchParams: URLSearchParams): EventSignalFilter {
  const raw = normalizedParam(searchParams.get('signal'));
  return raw === 'attention' || raw === 'watch' || raw === 'event' ? raw : 'all';
}

function setActivitySearchParam(
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  current: URLSearchParams,
  key: 'actor' | 'q' | 'signal' | 'since' | 'type',
  rawValue: string,
  defaultValue?: string,
): void {
  const next = new URLSearchParams(current);
  const value = rawValue.trim();
  if (value.length === 0 || value === defaultValue) {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  setSearchParams(next);
}

function searchableEventText(event: TypedEventStreamEnvelope): string {
  return [event.type, event.actor, event.subject, event.message, supervisorEventDetail(event)]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
}

function eventPartialErrors(events: SupervisorEventList | null): string[] {
  const errors = events?.partial_errors;
  return Array.isArray(errors)
    ? errors.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function sectionId(title: string): string {
  return `activity-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}
