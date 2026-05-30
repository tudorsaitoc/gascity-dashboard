import type { BackgroundWorker, MaintainerTriage } from 'gas-city-dashboard-shared';
import { ExecError } from '../exec.js';
import { fetchTriage as defaultFetchTriage, collectItems } from './triage.js';
import { writeCache } from './storage.js';
import { purgeSlungKeys, slungKey } from './slung-state.js';
import { notifyRefresh, sendHeartbeat } from './sse.js';
import { LOG_COMPONENT, logError, logInfo, logWarn } from '../logging.js';

// Nightly enrichment worker (gascity-dashboard-ar9). In-process setInterval
// scheduler — no external cron. Runs once at boot (after a short delay so
// the HTTP server is listening first) and then on the configured cadence.
// On every successful pass: rewrite the cache, sweep purgeable slung-state
// entries (4jy — vetted items have already round-tripped), notify
// connected SSE clients, log a single line. On error: log + continue,
// never crash the backend.
//
// Heartbeats keep open EventSource connections from getting timed out
// by intermediaries — fired every 30s independent of the refresh
// cadence.

const HEARTBEAT_INTERVAL_MS = 30_000;
const STARTUP_DELAY_MS = 5_000;

export interface RefresherTimer {
  unref(): void;
}

export interface RefresherRuntime {
  startupDelayMs: number;
  heartbeatIntervalMs: number;
  setTimeout(callback: () => void, delayMs: number): RefresherTimer;
  setInterval(callback: () => void, delayMs: number): RefresherTimer;
  clearTimeout(timer: RefresherTimer): void;
  clearInterval(timer: RefresherTimer): void;
}

/** The refresher is both a `BackgroundWorker` (modular-dashboard contract,
 *  PR-A) and a Maintainer-specific runtime exposing `running` for tests
 *  and ops introspection. `stop()` returns a Promise per BackgroundWorker;
 *  no async cleanup is needed today (only synchronous timer clears) so the
 *  promise resolves immediately. The shape is forward-compatible: if a
 *  future stop path needs to drain an in-flight refresh, await it inside. */
export interface MaintainerRefresher extends BackgroundWorker {
  readonly running: boolean;
  start(): void;
  stop(): Promise<void>;
}

type TimerState =
  | { status: 'idle' }
  | { status: 'scheduled'; timer: RefresherTimer };

type RefreshState =
  | { status: 'idle' }
  | { status: 'running'; promise: Promise<void> };

const idleTimer = (): TimerState => ({ status: 'idle' });
const idleRefresh = (): RefreshState => ({ status: 'idle' });

const nodeRuntime: RefresherRuntime = {
  startupDelayMs: STARTUP_DELAY_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

export interface WorkerOptions {
  repo: string;
  cachePath: string;
  /**
   * Path to the active-sling-state JSON map (gascity-dashboard-9qs).
   * Must match the path the maintainer router writes to so the worker's
   * post-refresh purge (gascity-dashboard-4jy) hits the same file. The
   * server derives both from cachePath's directory so they stay in
   * lockstep.
   */
  slungStatePath: string;
  intervalMs: number;
  /**
   * Injected envelope fetcher. Defaults to the real `gh`-driven
   * fetchTriage from ./triage; tests pass a stub so runRefresh can be
   * exercised without subprocess calls. Mirrors the execGcSling DI
   * pattern in routes/maintainer.ts.
   */
  fetchTriage?: (repo: string) => Promise<MaintainerTriage>;
}

export function createMaintainerRefresher(
  opts: WorkerOptions,
  runtime: RefresherRuntime = nodeRuntime,
): MaintainerRefresher {
  let startupTimer: TimerState = idleTimer();
  let refreshTimer: TimerState = idleTimer();
  let heartbeatTimer: TimerState = idleTimer();
  let refreshState: RefreshState = idleRefresh();

  const triggerRefresh = () => {
    if (refreshState.status === 'running') {
      logWarn(LOG_COMPONENT.maintainer, 'refresh skipped because the previous run is still active');
      return;
    }
    const promise = runRefresh(opts).finally(() => {
      if (refreshState.status === 'running' && refreshState.promise === promise) {
        refreshState = idleRefresh();
      }
    });
    refreshState = { status: 'running', promise };
  };

  const clearScheduledTimer = (
    state: TimerState,
    clear: (timer: RefresherTimer) => void,
  ): TimerState => {
    if (state.status === 'idle') return state;
    clear(state.timer);
    return idleTimer();
  };

  return {
    get running() {
      return refreshTimer.status === 'scheduled';
    },
    start() {
      if (refreshTimer.status === 'scheduled') {
        return;
      }

      heartbeatTimer = {
        status: 'scheduled',
        timer: runtime.setInterval(sendHeartbeat, runtime.heartbeatIntervalMs),
      };
      heartbeatTimer.timer.unref();

      startupTimer = {
        status: 'scheduled',
        timer: runtime.setTimeout(triggerRefresh, runtime.startupDelayMs),
      };
      startupTimer.timer.unref();

      refreshTimer = {
        status: 'scheduled',
        timer: runtime.setInterval(triggerRefresh, opts.intervalMs),
      };
      refreshTimer.timer.unref();

      logInfo(LOG_COMPONENT.maintainer, `refresher started for ${opts.repo}, interval ${formatInterval(opts.intervalMs)}`);
    },
    async stop() {
      startupTimer = clearScheduledTimer(startupTimer, runtime.clearTimeout);
      refreshTimer = clearScheduledTimer(refreshTimer, runtime.clearInterval);
      heartbeatTimer = clearScheduledTimer(heartbeatTimer, runtime.clearInterval);
    },
  };
}

/**
 * Exported for testability (gascity-dashboard-4jy). Production code goes
 * through startMaintainerRefresher; tests drive runRefresh directly with
 * an injected fetchTriage so the slung-state purge can be exercised
 * without shelling out to `gh`.
 */
export async function runRefresh(opts: WorkerOptions): Promise<void> {
  const start = Date.now();
  const fetchTriage = opts.fetchTriage ?? defaultFetchTriage;
  try {
    const envelope = await fetchTriage(opts.repo);
    await writeCache(opts.cachePath, envelope);
    // Sweep slung-state entries for items that finished their triage
    // round-trip (triage_assessment != null means an agent has vetted
    // it). The serve-time overlay already nulls item.slung for vetted
    // items, so this is purely on-disk hygiene — without it the file
    // grows monotonically. Wrapped in its own try/catch because a
    // disk hiccup on bookkeeping must not poison the refresh signal:
    // the cache is already written and clients still need notifyRefresh.
    try {
      const vettedKeys = collectItems(envelope)
        .filter((item) => item.triage_assessment !== null)
        .map((item) => slungKey(item.kind, item.number));
      await purgeSlungKeys(opts.slungStatePath, vettedKeys);
    } catch (purgeErr) {
      logWarn(
        LOG_COMPONENT.maintainer,
        `slung-state purge failed (refresh succeeded): ${purgeErr instanceof Error ? purgeErr.message : 'unknown error'}`,
      );
    }
    notifyRefresh(envelope);
    const issues = envelope.totals.issues_open;
    const prs = envelope.totals.prs_open;
    logInfo(LOG_COMPONENT.maintainer, `refresh ok: ${issues} issues, ${prs} PRs in ${Date.now() - start}ms`);
  } catch (err) {
    const msg = err instanceof ExecError ? err.message : (err as Error).message;
    logError(LOG_COMPONENT.maintainer, `refresh failed: ${msg}`);
  }
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
