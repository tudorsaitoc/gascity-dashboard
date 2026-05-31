import express, { type Express } from 'express';
import type { DashboardRuntimeConfig } from 'gas-city-dashboard-shared';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdminConfig } from './config.js';
import { GcClient } from './gc-client.js';
import { raceWithTimeout } from './lib/race-with-timeout.js';
import { LOG_COMPONENT, logInfo } from './logging.js';
import { MaintainerSseHub } from './maintainer/sse.js';
import {
  createMaintainerRefresher,
  type MaintainerRefresher,
} from './maintainer/worker.js';
import { apiErrorHandler } from './middleware/api-error-handler.js';
import { csrfIssueCookie, csrfValidate, getCsrfToken } from './middleware/csrf.js';
import { requestLog } from './middleware/request-log.js';
import {
  hostHeaderAllowlistFactory,
  originCheck,
  securityHeaders,
} from './middleware/security.js';
import { agentsRouter } from './routes/agents.js';
import { beadsRouter } from './routes/beads.js';
import { buildsRouter } from './routes/builds.js';
import { clientErrorsRouter } from './routes/client-errors.js';
import { createDoltNomsSampler, doltRouter } from './routes/dolt.js';
import { eventsRouter } from './routes/events.js';
import { gitRouter } from './routes/git.js';
import { healthRouter } from './routes/health.js';
import { linksRouter } from './routes/links.js';
import { mailSendRouter } from './routes/mail-send.js';
import { mailRouter } from './routes/mail.js';
import { maintainerRouter } from './routes/maintainer.js';
import { runsRouter } from './routes/runs.js';
import { sessionStreamRouter } from './routes/session-stream.js';
import { sessionsRouter } from './routes/sessions.js';
import { snapshotRouter } from './routes/snapshot.js';
import { createSnapshotService } from './snapshot/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type RefresherServerState =
  | { status: 'disabled' }
  | { status: 'active'; refresher: MaintainerRefresher };

export interface DashboardRuntime {
  start(): void;
  stop(): void;
}

export interface DashboardApp {
  app: Express;
  runtime: DashboardRuntime;
}

export function createDashboardApp(config: AdminConfig): DashboardApp {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLog());
  app.use(express.json({ limit: '64kb' }));

  app.use(hostHeaderAllowlistFactory(config.extraAllowedHosts));
  app.use(originCheck(config.port, config.extraAllowedHosts));
  app.use(securityHeaders());
  app.use(csrfIssueCookie);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get('/api/csrf', (_req, res) => {
    res.json({ token: getCsrfToken() });
  });

  const gc = new GcClient({
    baseUrl: config.gcSupervisorUrl,
    cityName: config.cityName,
  });
  const dashboardConfig: DashboardRuntimeConfig = {
    cityName: config.cityName,
    cityRoot: config.cityPath,
    githubRepo: config.maintainerRepo,
    useFixtures: config.useFixtures,
  };

  const writeRouter = express.Router();
  writeRouter.use(csrfValidate);
  writeRouter.get('/config', (_req, res) => {
    res.json(dashboardConfig);
  });
  writeRouter.use('/sessions', sessionsRouter(gc));
  writeRouter.use('/runs', runsRouter(gc, { rigRoot: config.cityPath }));
  writeRouter.use('/links', linksRouter(gc));
  writeRouter.use('/agents', agentsRouter(config.cityPath));
  writeRouter.use('/beads', beadsRouter(gc, config.cityPath));
  writeRouter.use('/mail', mailRouter(gc));
  writeRouter.use(
    '/mail-send',
    mailSendRouter({
      sendMail: (to, subject, body) =>
        gc.sendMail({ to, subject, body, from: 'human' }),
    }),
  );
  writeRouter.use('/git', gitRouter());
  writeRouter.use('/builds', buildsRouter());
  writeRouter.use('/system', healthRouter(gc));
  writeRouter.use('/client-errors', clientErrorsRouter());

  const doltNomsSampler = createDoltNomsSampler({ cityPath: config.cityPath });
  writeRouter.use('/dolt-noms', doltRouter(doltNomsSampler));

  const maintainerSlungStatePath = path.join(
    path.dirname(config.maintainerCachePath),
    'slung-state.json',
  );
  const maintainerSseHub = new MaintainerSseHub();
  writeRouter.use(
    '/maintainer',
    maintainerRouter({
      repo: config.maintainerRepo,
      cachePath: config.maintainerCachePath,
      slungStatePath: maintainerSlungStatePath,
      slingTarget: config.maintainerSlingTarget,
      triageTarget: config.maintainerTriageTarget,
      sling: (input) => gc.sling(input),
      listSessions: async () => {
        const { items } = await raceWithTimeout(gc.listSessions(), 3_000, 'maintainer sessions lookup');
        return items;
      },
      sseHub: maintainerSseHub,
    }),
  );

  const snapshotService = createSnapshotService({
    gc,
    config: dashboardConfig,
    cityPath: config.cityPath,
  });
  writeRouter.use('/snapshot', snapshotRouter(snapshotService));

  app.use('/api/sessions', sessionStreamRouter({ gc }));
  app.use('/api', writeRouter);
  app.use('/api/events', eventsRouter({ gc }));
  app.use(apiErrorHandler());

  const refresherState: RefresherServerState =
    config.maintainerRefreshIntervalMs > 0
      ? {
        status: 'active',
        refresher: createMaintainerRefresher({
          repo: config.maintainerRepo,
          cachePath: config.maintainerCachePath,
          slungStatePath: maintainerSlungStatePath,
          intervalMs: config.maintainerRefreshIntervalMs,
          sseHub: maintainerSseHub,
        }),
      }
      : { status: 'disabled' };

  mountFrontend(app, config.frontendDistPath);

  return {
    app,
    runtime: {
      start() {
        doltNomsSampler.start();
        if (refresherState.status === 'active') refresherState.refresher.start();
      },
      stop() {
        if (refresherState.status === 'active') refresherState.refresher.stop();
        doltNomsSampler.stop();
      },
    },
  };
}

function mountFrontend(app: Express, frontendDistPath: string): void {
  const distDir = path.resolve(__dirname, '..', frontendDistPath);
  if (!fs.existsSync(distDir)) {
    logInfo(LOG_COMPONENT.admin, `frontend dist not found at ${distDir} — API-only mode`);
    return;
  }

  app.use(
    express.static(distDir, {
      index: 'index.html',
      dotfiles: 'deny',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}
