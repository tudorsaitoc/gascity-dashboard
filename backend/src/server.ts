import { loadConfig } from './config.js';
import { setAuditActor, setAuditLogPath } from './audit.js';
import { createDashboardApp } from './app.js';
import { LOG_COMPONENT, logError, logInfo } from './logging.js';

function main(): void {
  const config = loadConfig();

  if (config.disabled) {
    logError(LOG_COMPONENT.admin, 'ADMIN_DASHBOARD_DISABLED=1 — refusing to start');
    process.exit(0);
  }

  setAuditLogPath(config.auditLogPath);
  setAuditActor(config.operatorAlias);

  const { app, runtime } = createDashboardApp(config);
  runtime.start();

  const server = app.listen(config.port, config.bindHost, () => {
    logInfo(
      LOG_COMPONENT.admin,
      `listening on http://${config.bindHost}:${config.port} (city=${config.cityName}, supervisor=${config.gcSupervisorUrl})`,
    );
  });

  function shutdown(signal: string): void {
    logInfo(LOG_COMPONENT.admin, `${signal} received, shutting down`);
    void runtime.stop().finally(() => {
      server.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
