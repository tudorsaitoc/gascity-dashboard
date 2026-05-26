import { useEffect, useMemo, useState } from 'react';
import type { DeployRecord, GitCommit, GitView } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { Table, type TableColumn } from '../components/Table';
import { useCachedData } from '../hooks/useCachedData';
import { formatRelative } from '../hooks/time';

const VIEW_OPTIONS: ReadonlyArray<{ value: GitView; label: string }> = [
  { value: 'recent-main', label: 'Recent · main' },
  { value: 'recent-all', label: 'Recent · all' },
  { value: 'today', label: 'Last 24h' },
  { value: 'this-week', label: 'Last 7d' },
];

export function ActivityPage() {
  const [view, setView] = useState<GitView>('recent-main');
  // Tick state so relative timestamps refresh between data fetches. Mirrors
  // the Agents.tsx pattern: 15s interval (formatRelative's smallest unit is
  // seconds in [5,60); 1s would be gratuitous re-render), visibility-aware
  // so background tabs don't churn.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 15_000);
    return () => clearInterval(tick);
  }, []);

  const {
    data: commitsData,
    loading: loadingCommits,
    error: commitsError,
    refresh: refreshCommits,
  } = useCachedData(`commits:${view}`, () => api.listCommits(view));
  const {
    data: deploysData,
    loading: loadingDeploys,
    error: deploysError,
    refresh: refreshDeploys,
  } = useCachedData('builds', () => api.listBuilds());

  const commits = useMemo(() => commitsData?.items ?? [], [commitsData]);
  const deploys = useMemo(() => deploysData?.items ?? [], [deploysData]);
  const deployFailedMarker = deploysData?.failed_marker ?? false;
  const deploySource = deploysData?.source ?? null;
  // Surface whichever fetch most recently errored. Either-or is fine —
  // the operator reads one banner at the top of the page.
  const error = commitsError ?? deploysError ?? null;

  const commitColumns = useMemo<ReadonlyArray<TableColumn<GitCommit>>>(() => [
    {
      key: 'sha',
      label: 'SHA',
      render: (r) => <span className="text-fg-muted tnum">{r.short_sha}</span>,
      className: 'w-24',
    },
    {
      key: 'subject',
      label: 'Subject',
      sortable: true,
      sortValue: (r) => r.subject,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-fg truncate">{r.subject}</p>
          {r.refs && (
            <p className="text-label uppercase tracking-wider text-accent mt-1 truncate">
              {r.refs}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'author',
      label: 'Author',
      sortable: true,
      sortValue: (r) => r.author,
      render: (r) => <span className="text-fg-muted">{r.author}</span>,
      className: 'w-40',
    },
    {
      key: 'date',
      label: 'When',
      sortable: true,
      sortValue: (r) => r.date,
      render: (r) => <span className="tnum text-fg-muted">{formatRelative(r.date, now)}</span>,
      className: 'w-20',
      align: 'right',
    },
  ], [now]);

  const deployColumns = useMemo<ReadonlyArray<TableColumn<DeployRecord>>>(() => [
    {
      key: 'at',
      label: 'When',
      sortable: true,
      sortValue: (r) => r.at,
      render: (r) => <span className="tnum text-fg-muted">{formatRelative(r.at, now)}</span>,
      className: 'w-24',
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge tone={deployTone(r.status)} label={r.status} />,
      className: 'w-32',
    },
    {
      key: 'detail',
      label: 'Detail',
      render: (r) => (
        <pre className="text-body text-fg-muted whitespace-pre-wrap break-all">
          {r.detail}
        </pre>
      ),
    },
  ], [now]);

  const synopsis = useMemo(() => buildSynopsis(commits, deploys, now), [commits, deploys, now]);

  return (
    <section>
      <PageHeader
        title="Activity"
        synopsis={synopsis}
        meta={
          error ? (
            <span className="normal-case text-body text-accent" role="alert">
              {error}
            </span>
          ) : undefined
        }
      />

      <section className="mb-12">
        <header className="flex items-baseline justify-between gap-4 mb-4 pb-2 border-b border-rule flex-wrap">
          <div className="flex items-baseline gap-4 flex-wrap">
            <h2 className="text-headline font-semibold text-fg">Commits</h2>
            <div className="flex items-baseline gap-4">
              {VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setView(opt.value)}
                  className={`text-label uppercase tracking-wider transition-colors duration-150 ease-out-quart focus-mark rounded-sm ${
                    view === opt.value
                      ? 'text-fg font-medium'
                      : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" onClick={() => void refreshCommits()} disabled={loadingCommits}>
            {loadingCommits ? 'Loading' : 'Refresh'}
          </Button>
        </header>
        <Table
          columns={commitColumns}
          rows={commits}
          rowKey={(r) => r.sha}
          empty="No commits in this view."
          initialSort={{ key: 'date', dir: 'desc' }}
        />
      </section>

      <section>
        <header className="flex items-baseline justify-between gap-4 mb-4 pb-2 border-b border-rule flex-wrap">
          <div className="flex items-baseline gap-4 flex-wrap">
            <h2 className="text-headline font-semibold text-fg">Dev-deploy</h2>
            {deployFailedMarker && <StatusBadge tone="stuck" label="failed marker present" />}
            {deploySource && (
              <span className="text-label uppercase tracking-wider text-fg-faint truncate">
                {deploySource}
              </span>
            )}
          </div>
          <Button size="sm" onClick={() => void refreshDeploys()} disabled={loadingDeploys}>
            {loadingDeploys ? 'Loading' : 'Refresh'}
          </Button>
        </header>
        <Table
          columns={deployColumns}
          rows={deploys}
          rowKey={(r) => `${r.at}-${r.detail.slice(0, 24)}`}
          empty="No deploy log entries."
          initialSort={{ key: 'at', dir: 'desc' }}
        />
      </section>
    </section>
  );
}

function deployTone(status: string): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'failed':
      return 'stuck';
    case 'in-progress':
      return 'warn';
    default:
      return 'neutral';
  }
}

function buildSynopsis(
  commits: ReadonlyArray<GitCommit>,
  deploys: ReadonlyArray<DeployRecord>,
  now: number,
): string {
  const parts: string[] = [];
  const latestCommit = commits[0];
  if (latestCommit) {
    parts.push(`${commits.length} commits in view, latest ${formatRelative(latestCommit.date, now)}`);
  } else {
    parts.push('No commits in view');
  }
  const latestDeploy = deploys[0];
  if (latestDeploy) {
    parts.push(`last deploy ${formatRelative(latestDeploy.at, now)} (${latestDeploy.status})`);
  }
  return parts.join('; ') + '.';
}
