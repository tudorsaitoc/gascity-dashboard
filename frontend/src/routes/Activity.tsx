import type {
  DeployList,
  DeployRecord,
  GitCommit,
  GitCommitList,
} from 'gas-city-dashboard-shared';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { getActiveCity } from '../api/cityBase';
import { useAttentionModel } from '../attention/context';
import {
  attentionRowProps,
  resourceAttentionSeverity,
} from '../attention/routeHighlight';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import type { TypedEventStreamEnvelope } from '../generated/gc-supervisor-client/types.gen';
import { formatClockTime, formatShortDate } from '../hooks/time';
import { useCachedData } from '../hooks/useCachedData';
import { useVisibleRefresh } from '../hooks/useVisibleRefresh';
import {
  listSupervisorEvents,
  type SupervisorEventList,
} from '../supervisor/eventReads';
import {
  supervisorEventDetail,
  supervisorEventSignal,
  type SupervisorEventSignal,
} from '../supervisor/eventSignals';

type ActivityMode = 'all' | 'events' | 'deploys' | 'commits';

interface ActivityBundle {
  commits: GitCommitList | null;
  deploys: DeployList | null;
  events: SupervisorEventList | null;
}

const MODES: ReadonlyArray<{ mode: ActivityMode; label: string }> = [
  { mode: 'all', label: 'All' },
  { mode: 'events', label: 'Events' },
  { mode: 'deploys', label: 'Deploys' },
  { mode: 'commits', label: 'Commits' },
];

export function ActivityPage() {
  const attention = useAttentionModel();
  const [searchParams] = useSearchParams();
  const mode = readMode(searchParams);
  const eventType = mode === 'events' ? normalizedParam(searchParams.get('type')) : null;
  const cityName = getActiveCity();
  const cacheKey = `activity:bundle:${cityName ?? 'no-city'}:${mode}:${eventType ?? 'all'}`;
  const { data, loading, error, refresh } = useCachedData(
    cacheKey,
    () => fetchActivityBundle(mode, eventType),
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

      <div className="mt-10 space-y-12">
        {shouldShow(mode, 'events') && (
          <EventsSection
            events={data?.events ?? null}
            loading={loading}
            attentionSeverity={(event) =>
              resourceAttentionSeverity(attention, 'activity', eventResourceId(event))
            }
          />
        )}
        {shouldShow(mode, 'deploys') && (
          <DeploysSection deploys={data?.deploys ?? null} loading={loading} />
        )}
        {shouldShow(mode, 'commits') && (
          <CommitsSection commits={data?.commits ?? null} loading={loading} />
        )}
      </div>
    </section>
  );
}

async function fetchActivityBundle(
  mode: ActivityMode,
  eventType: string | null,
): Promise<ActivityBundle> {
  const [events, deploys, commits] = await Promise.all([
    shouldShow(mode, 'events')
      ? fetchFilteredEvents(eventType)
      : Promise.resolve(null),
    shouldShow(mode, 'deploys') ? api.listBuilds() : Promise.resolve(null),
    shouldShow(mode, 'commits') ? api.listCommits('recent-all') : Promise.resolve(null),
  ]);
  return { commits, deploys, events };
}

async function fetchFilteredEvents(eventType: string | null): Promise<SupervisorEventList> {
  const list = await listSupervisorEvents(eventType === null ? {} : { type: eventType });
  if (eventType === null) return list;
  const items = list.items.filter((event) => event.type === eventType);
  return { ...list, items, total: items.length };
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

function EventsSection({
  events,
  loading,
  attentionSeverity,
}: {
  events: SupervisorEventList | null;
  loading: boolean;
  attentionSeverity: (event: TypedEventStreamEnvelope) => 'attention' | 'watch' | null;
}) {
  const items = events?.items ?? [];
  return (
    <ActivitySection
      title="Supervisor events"
      meta={events === null ? null : `${events.total} events`}
    >
      <ActivityTable label="Supervisor events">
        <thead>
          <tr className="border-b border-rule text-label uppercase tracking-wider text-fg-muted">
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Time</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Signal</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Type</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Subject</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={5}>
              {loading ? 'Reading supervisor events.' : 'No supervisor events in this window.'}
            </EmptyRow>
          ) : (
            items.map((event) => (
              <tr
                key={`${event.seq}:${event.type}`}
                {...attentionRowProps(attentionSeverity(event))}
                className={`border-b border-rule ${
                  attentionRowProps(attentionSeverity(event)).className ?? ''
                }`}
              >
                <td className="py-3 pr-6 align-baseline text-fg-muted">
                  <TimeStamp ts={event.ts} />
                </td>
                <td className="py-3 pr-6 align-baseline">
                  <EventSignalBadge signal={supervisorEventSignal(event)} />
                </td>
                <td className="py-3 pr-6 align-baseline font-medium text-fg">
                  {event.type}
                </td>
                <td className="py-3 pr-6 align-baseline text-fg-muted">
                  {event.subject ?? '·'}
                </td>
                <td className="py-3 pr-6 align-baseline text-fg-muted">
                  {supervisorEventDetail(event)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </ActivityTable>
    </ActivitySection>
  );
}

function DeploysSection({
  deploys,
  loading,
}: {
  deploys: DeployList | null;
  loading: boolean;
}) {
  const items = deploys?.items ?? [];
  return (
    <ActivitySection
      title="Deploy history"
      meta={deploys?.failed_marker === true ? 'failed marker present' : deploys?.source ?? null}
    >
      <ActivityTable label="Deploy history">
        <thead>
          <tr className="border-b border-rule text-label uppercase tracking-wider text-fg-muted">
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Time</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Status</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={3}>
              {loading ? 'Reading deploy history.' : 'No deploy records in this window.'}
            </EmptyRow>
          ) : (
            items.map((deploy) => (
              <tr key={`${deploy.at}:${deploy.detail}`} className="border-b border-rule">
                <td className="py-3 pr-6 align-baseline text-fg-muted">
                  <TimeStamp ts={deploy.at} />
                </td>
                <td className="py-3 pr-6 align-baseline">
                  <DeployStatusBadge deploy={deploy} />
                </td>
                <td className="py-3 pr-6 align-baseline text-fg-muted">
                  {deploy.detail}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </ActivityTable>
    </ActivitySection>
  );
}

function CommitsSection({
  commits,
  loading,
}: {
  commits: GitCommitList | null;
  loading: boolean;
}) {
  const items = commits?.items ?? [];
  return (
    <ActivitySection
      title="Git commits"
      meta={commits === null ? null : commits.view}
    >
      <ActivityTable label="Git commits">
        <thead>
          <tr className="border-b border-rule text-label uppercase tracking-wider text-fg-muted">
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Time</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Commit</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Author</th>
            <th scope="col" className="pb-3 pr-6 text-left font-medium">Subject</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={4}>
              {loading ? 'Reading git commits.' : 'No commits in this window.'}
            </EmptyRow>
          ) : (
            items.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))
          )}
        </tbody>
      </ActivityTable>
    </ActivitySection>
  );
}

function CommitRow({ commit }: { commit: GitCommit }) {
  return (
    <tr className="border-b border-rule">
      <td className="py-3 pr-6 align-baseline text-fg-muted">
        <TimeStamp ts={commit.date} />
      </td>
      <td className="py-3 pr-6 align-baseline font-medium text-fg">
        {commit.short_sha}
      </td>
      <td className="py-3 pr-6 align-baseline text-fg-muted">
        {commit.author}
      </td>
      <td className="py-3 pr-6 align-baseline text-fg-muted">
        {commit.subject}
      </td>
    </tr>
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
        <h2 id={sectionId(title)} className="text-title font-semibold tracking-tight text-fg">
          {title}
        </h2>
        {meta !== null && (
          <span className="text-label uppercase tracking-wider text-fg-muted">
            {meta}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function ActivityTable({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full text-body tnum">
        {children}
      </table>
    </div>
  );
}

function EmptyRow({
  children,
  colSpan,
}: {
  children: ReactNode;
  colSpan: number;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-10 text-center text-fg-muted italic">
        {children}
      </td>
    </tr>
  );
}

function TimeStamp({ ts }: { ts: string }) {
  return (
    <span title={formatShortDate(ts)}>
      {formatClockTime(ts)}
    </span>
  );
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
  return mode === 'events' || mode === 'deploys' || mode === 'commits'
    ? mode
    : 'all';
}

function normalizedParam(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sectionId(title: string): string {
  return `activity-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}
