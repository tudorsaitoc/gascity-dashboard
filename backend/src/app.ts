import express, { type Express } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BackgroundWorker,
  DashboardRuntimeConfig,
} from 'gas-city-dashboard-shared';

import type { AdminConfig } from './config.js';
import {
  hostHeaderAllowlistFactory,
  originCheck,
  securityHeaders,
} from './middleware/security.js';
import { csrfIssueCookie, csrfValidate, getCsrfToken } from './middleware/csrf.js';
import { GcClient } from './gc-client.js';
import { sessionsRouter } from './routes/sessions.js';
import { sessionStreamRouter } from './routes/session-stream.js';
import { agentsRouter } from './routes/agents.js';
import { beadsRouter } from './routes/beads.js';
import { workflowsRouter } from './routes/workflows.js';
import { linksRouter } from './routes/links.js';
import { mailRouter } from './routes/mail.js';
import { mailSendRouter } from './routes/mail-send.js';
import { gitRouter } from './routes/git.js';
import { buildsRouter } from './routes/builds.js';
import { createDoltNomsSampler, doltRouter } from './routes/dolt.js';
import { eventsRouter } from './routes/events.js';
import { clientErrorsRouter } from './routes/client-errors.js';
import { snapshotRouter } from './routes/snapshot.js';
import { createSnapshotService } from './snapshot/service.js';
import { ALL_MODULES } from './views/registry.js';
import { resolveEnabledFirstPartyIds } from './views/enabled.js';
import { bind, type CityContext } from './views/types.js';
import { LOG_COMPONENT, logInfo } from './logging.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DashboardRuntime {
  start(): void;
  /** Stop all background workers. Returns a Promise so workers that drain
   *  in-flight work (e.g. an SSE registry close in PR-B) can await cleanly.
   *  Callers without an await still benefit because the promise resolves
   *  synchronously when all workers' stop()s are synchronous. */
  stop(): Promise<void>;
}

export interface DashboardApp {
  app: Express;
  runtime: DashboardRuntime;
}

export function createDashboardApp(config: AdminConfig): DashboardApp {
  const app = express();
  app.disable('x-powered-by');
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
  // PR-C: resolve which firstParty modules are mounted BEFORE building the
  // wire-shape config so the frontend sees the same set the backend will
  // actually bind. `core` modules ignore the filter entirely. Compute once
  // here so the iterator below and the `/api/config` response cannot drift.
  const enabledFirstPartyIds = resolveEnabledFirstPartyIds(
    ALL_MODULES,
    config.enabledModules,
  );
  const mountedModules = ALL_MODULES.filter(
    (m) => m.kind === 'core' || enabledFirstPartyIds.has(m.id),
  );
  const dashboardConfig: DashboardRuntimeConfig = {
    cityName: config.cityName,
    cityRoot: config.cityPath,
    useFixtures: config.useFixtures,
    // null preserves the pre-PR-C "all firstParty enabled" semantics for the
    // frontend (it sees null → does not filter). When the operator sets
    // MODULES_ENABLED (even to empty) we ship the resolved list so the
    // frontend's filter matches the backend's mount set exactly.
    enabledModules:
      config.enabledModules === null ? null : [...enabledFirstPartyIds],
    defaultView: config.defaultView,
  };

  const writeRouter = express.Router();
  writeRouter.use(csrfValidate);
  writeRouter.get('/config', (_req, res) => {
    res.json(dashboardConfig);
  });
  writeRouter.use('/sessions', sessionsRouter(gc));
  writeRouter.use('/workflows', workflowsRouter(gc, { rigRoot: config.cityPath }));
  writeRouter.use('/links', linksRouter(gc));
  writeRouter.use('/agents', agentsRouter({ cityPath: config.cityPath, gc }));
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
  writeRouter.use('/client-errors', clientErrorsRouter());

  // Modular-dashboard registry iterator (docs/PRD-modular-dashboard.md §2).
  // PR-A wired health via this loop; PR-B2 adds maintainer and deletes the
  // last explicit module mount. Remaining routes (sessions, workflows,
  // mail, ...) stay explicitly mounted above pending later phases. The
  // CityContext is constructed once and threaded through the existential
  // bind<D>() wrapper, so the iterator never sees Deps — premortem #3
  // mitigation (forbids the type-erasure cast pattern in this file).
  const cityDataDir = path.join(
    os.homedir(),
    '.gascity-dashboard',
    'cities',
    config.cityName,
  );
  const cityContext: CityContext = {
    cityName: config.cityName,
    cityPath: config.cityPath,
    cityDataDir,
    gc,
    // audit-C8: modules read their slice via `ctx.config.modules.<id>`.
    // AdminConfig stays host-side only; never serialized.
    config,
  };
  const moduleWorkers: BackgroundWorker[] = [];
  for (const mod of mountedModules) {
    const bound = bind(mod, config);
    writeRouter.use(`/${bound.id}`, bound.mount(cityContext));
    const w = bound.worker?.(cityContext);
    if (w) moduleWorkers.push(w);
  }
  // Boot-time signal (premortem #4 + maintainer-coupling C7): log the
  // ACTUAL enabled/disabled module split AFTER the filter resolves so the
  // operator sees what mounted, not just what was requested. Emitted from
  // app.ts (not config.ts) because the registry-vs-env intersection is the
  // authoritative answer — config.ts only knows the env, not the registry.
  //
  // PR-C Phase-4 fix (MED-1 from security review): the log lists ALL
  // mounted modules (core + firstParty); the wire field
  // `/api/config.enabledModules` carries only the firstParty subset
  // (core always mounts and is not part of the operator's opt-in surface).
  // The trailing parenthetical is here so an operator comparing the log
  // line to the wire response sees both shapes at the same site.
  logInfo(
    LOG_COMPONENT.admin,
    `modules mounted=[${mountedModules.map((m) => m.id).join(',')}]` +
      ` disabled=[${ALL_MODULES.filter((m) => !mountedModules.includes(m))
        .map((m) => m.id)
        .join(',')}]` +
      ` (wire /api/config.enabledModules = firstParty subset only)`,
  );
  logInfo(
    LOG_COMPONENT.admin,
    `default-view: env=${config.defaultView ?? '(unset)'}` +
      ` — resolution applied on the frontend (descriptor / fallback chain)`,
  );

  const doltNomsSampler = createDoltNomsSampler({ cityPath: config.cityPath });
  writeRouter.use('/dolt-noms', doltRouter(doltNomsSampler));

  const snapshotService = createSnapshotService({
    gc,
    config: dashboardConfig,
  });
  writeRouter.use('/snapshot', snapshotRouter(snapshotService));

  app.use('/api/sessions', sessionStreamRouter({ gc }));
  app.use('/api', writeRouter);
  app.use('/api/events', eventsRouter({ gc }));

  mountFrontend(app, config.frontendDistPath);

  return {
    app,
    runtime: {
      start() {
        doltNomsSampler.start();
        for (const w of moduleWorkers) w.start();
      },
      async stop() {
        await Promise.all(moduleWorkers.map((w) => w.stop()));
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
