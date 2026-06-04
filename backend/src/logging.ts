import { AsyncLocalStorage } from 'node:async_hooks';

export { errorMessage } from 'gas-city-dashboard-shared';

export type LogLevel = 'info' | 'warn' | 'error';

export const REQUEST_ID_HEADER = 'X-Request-ID';

export const LOG_COMPONENT = {
  admin: 'admin',
  adminAudit: 'admin-audit',
  agents: 'agents',
  beads: 'beads',
  builds: 'builds',
  client: 'client',
  doltNoms: 'dolt-noms',
  health: 'health',
  git: 'git',
  links: 'links',
  mail: 'mail',
  maintainer: 'maintainer',
  metrics: 'metrics',
  sessions: 'sessions',
  snapshot: 'snapshot',
  sse: 'sse',
  runs: 'runs',
} as const;

export const LOG_COMPONENTS = Object.values(LOG_COMPONENT);

export type LogComponent = (typeof LOG_COMPONENTS)[number];

export interface LogContext {
  requestId: string;
}

export type MetricValue = string | number | boolean;

const logContext = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return logContext.run(context, callback);
}

export function currentRequestId(): string | undefined {
  return logContext.getStore()?.requestId;
}

export function logInfo(component: LogComponent, message: string): void {
  writeLog('info', component, message);
}

export function logWarn(component: LogComponent, message: string): void {
  writeLog('warn', component, message);
}

export function logError(component: LogComponent, message: string): void {
  writeLog('error', component, message);
}

export function recordCounter(
  name: string,
  fields: Record<string, MetricValue | undefined> = {},
): void {
  writeLog('info', LOG_COMPONENT.metrics, metricLine(name, { kind: 'counter', ...fields }));
}

export function recordTimer(
  name: string,
  durationMs: number,
  fields: Record<string, MetricValue | undefined> = {},
): void {
  writeLog(
    'info',
    LOG_COMPONENT.metrics,
    metricLine(name, {
      kind: 'timer',
      duration_ms: durationMs,
      ...fields,
    }),
  );
}

/**
 * Replace CR/LF in a string with spaces so an externally-sourced value
 * (e.g. supervisor-reported `partial_errors[]`) cannot inject a forged
 * `[component] message` line into operator logs. Apply at the interpolation
 * site whenever the value originates outside the dashboard process.
 */
export function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}

function writeLog(level: LogLevel, component: LogComponent, message: string): void {
  const requestId = currentRequestId();
  const requestPrefix = requestId === undefined ? '' : ` request_id=${formatLogValue(requestId)}`;
  const line = `[${component}]${requestPrefix} ${message}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.info(line);
}

function metricLine(name: string, fields: Record<string, MetricValue | undefined>): string {
  return `metric name=${formatLogValue(name)} ${formatMetricFields(fields)}`;
}

function formatMetricFields(fields: Record<string, MetricValue | undefined>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, MetricValue] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
}

function formatLogValue(value: MetricValue): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(sanitizeForLog(value));
}
