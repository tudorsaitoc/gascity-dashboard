export { errorMessage } from 'gas-city-dashboard-shared';

export type LogLevel = 'info' | 'warn' | 'error';

export const LOG_COMPONENT = {
  admin: 'admin',
  adminAudit: 'admin-audit',
  agents: 'agents',
  beads: 'beads',
  builds: 'builds',
  client: 'client',
  doltNoms: 'dolt-noms',
  git: 'git',
  health: 'health',
  links: 'links',
  mail: 'mail',
  mailSend: 'mail-send',
  maintainer: 'maintainer',
  sessions: 'sessions',
  snapshot: 'snapshot',
  sse: 'sse',
  runs: 'runs',
} as const;

export const LOG_COMPONENTS = Object.values(LOG_COMPONENT);

export type LogComponent = typeof LOG_COMPONENTS[number];

export function logInfo(component: LogComponent, message: string): void {
  writeLog('info', component, message);
}

export function logWarn(component: LogComponent, message: string): void {
  writeLog('warn', component, message);
}

export function logError(component: LogComponent, message: string): void {
  writeLog('error', component, message);
}

function writeLog(level: LogLevel, component: LogComponent, message: string): void {
  const line = `[${component}] ${message}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}
