import { Router } from 'express';
import type { StatusBody } from 'gas-city-dashboard-shared/gc-supervisor';
import type {
  SupervisorStatusReport,
  SupervisorStatusUnavailableReason,
} from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';

// gascity-dashboard-4bol: the interactive Health store-thresholds / dolt-usage /
// beads-usage widgets read the supervisor /status, which turns slow on a bloated
// city store and trips a short interactive timeout — surfacing "supervisor
// status unavailable" even while the 30s background samplers succeed. This
// periodic sampler reads /status on the same higher background ceiling and the
// route serves the cached snapshot, so a Health page load hits a fast local
// route instead of racing the slow supervisor. The route is the dolt-noms /
// rig-store-health sampler pattern; it serves the raw supervisor status wire
// shape (not a dashboard DTO mirror) wrapped in availability/freshness metadata.

const SAMPLE_INTERVAL_MS = 60 * 1_000;

/** Fetches the supervisor city status (the cached snapshot's source). */
export type FetchStatus = () => Promise<StatusBody>;

export interface SamplerTimer {
  unref(): void;
}

export interface SamplerRuntime {
  setInterval(callback: () => void, delayMs: number): SamplerTimer;
  clearInterval(timer: SamplerTimer): void;
}

const nodeRuntime: SamplerRuntime = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

export interface SupervisorStatusSampler {
  readonly running: boolean;
  start(): void;
  stop(): void;
  sampleOnce(): Promise<void>;
  report(): SupervisorStatusReport;
}

export interface SupervisorStatusSamplerOptions {
  fetchStatus: FetchStatus;
  runtime?: SamplerRuntime;
  intervalMs?: number;
  now?: () => string;
}

type SamplerTimerState = { status: 'idle' } | { status: 'scheduled'; timer: SamplerTimer };

export function createSupervisorStatusSampler(
  opts: SupervisorStatusSamplerOptions,
): SupervisorStatusSampler {
  const runtime = opts.runtime ?? nodeRuntime;
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;
  const now = opts.now ?? (() => new Date().toISOString());

  // Last successful snapshot, retained across a later failed read so the report
  // can still carry prior data (degraded, not blank) — mirrors rig-store-health.
  let lastStatus: StatusBody | null = null;
  let sampledAt: string | null = null;
  let available = false;
  let lastReason: SupervisorStatusUnavailableReason = 'not_sampled_yet';
  let timerState: SamplerTimerState = { status: 'idle' };

  const sampleOnce = async (): Promise<void> => {
    try {
      lastStatus = await opts.fetchStatus();
      sampledAt = now();
      available = true;
    } catch (err) {
      available = false;
      lastReason = 'status_read_failed';
      logWarn(LOG_COMPONENT.supervisorStatus, `sample failed: ${errorMessage(err)}`);
    }
  };

  return {
    get running() {
      return timerState.status === 'scheduled';
    },
    start() {
      if (timerState.status === 'scheduled') return;
      void sampleOnce();
      timerState = {
        status: 'scheduled',
        timer: runtime.setInterval(() => {
          void sampleOnce();
        }, intervalMs),
      };
      timerState.timer.unref();
    },
    stop() {
      if (timerState.status === 'idle') return;
      runtime.clearInterval(timerState.timer);
      timerState = { status: 'idle' };
    },
    sampleOnce,
    report(): SupervisorStatusReport {
      if (available && sampledAt !== null && lastStatus !== null) {
        return { available: true, sampledAt, status: lastStatus };
      }
      return { available: false, reason: lastReason, status: lastStatus };
    },
  };
}

export function supervisorStatusRouter(sampler: SupervisorStatusSampler): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const payload = sampler.report();
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/city/:cityName/supervisor-status',
      parsed_args: { available: String(payload.available) },
      duration_ms: 0,
    });
    res.json(payload);
  });
  return router;
}
