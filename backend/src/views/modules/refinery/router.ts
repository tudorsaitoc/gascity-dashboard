// Refinery module router. One read endpoint: the assembled ledger-page DTO.
// Source failures are not 500s — the DTO carries per-source unavailable
// states so the page can say WHICH half is missing (fail-safe rule); only
// an unexpected throw in assembly itself routes through the 500 path.

import { Router } from 'express';
import { LOG_COMPONENT } from '../../../logging.js';
import { routeInternalError } from '../../../route-errors.js';
import type { RefinerySummaryState } from './state.js';

export function refineryRouter(state: RefinerySummaryState): Router {
  const router = Router();

  router.get('/summary', (_req, res) => {
    state
      .summary()
      .then((summary) => {
        res.json(summary);
      })
      .catch((err: unknown) => {
        const wire = routeInternalError(err, {
          component: LOG_COMPONENT.refinery,
          operation: 'refinery summary',
          responseError: 'refinery summary failed',
        });
        res.status(wire.status).json(wire.body);
      });
  });

  return router;
}
