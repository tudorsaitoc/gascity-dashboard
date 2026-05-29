import { Router } from 'express';

import type { SourceName } from 'gas-city-dashboard-shared';

import { recordAudit } from '../audit.js';
import { LOG_COMPONENT } from '../logging.js';
import {
  routeInternalError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';
import { isSourceName, type SnapshotService } from '../snapshot/service.js';

// /api/snapshot — aggregate read of the snapshot service for
// gascity-dashboard-8nj. GET is a pure read; POST /refresh is a
// state-changing operation (triggers upstream load() calls) and gets
// CSRF + audit treatment.

export function snapshotRouter(service: SnapshotService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    // Intentionally no recordAudit() here: /api/snapshot is the ambient-polling
    // surface for the dashboard. Auditing every poll would flood events.jsonl
    // with no operator-meaningful signal — the audit log exists to capture
    // operator-driven actions, not background telemetry reads. State-changing
    // routes (POST /refresh below, and the per-resource write endpoints)
    // still audit.
    try {
      const snapshot = await service.getSnapshot();
      res.json(snapshot);
    } catch (err) {
      // Per-source failures are absorbed by SourceCache and surface as
      // status='error' inside the envelope; reaching this catch means
      // SnapshotService itself broke (composition bug, JSON serialize).
      // Internal errors stay server-side — surfacing details would risk
      // leaking paths/symbol names to the browser.
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.snapshot,
        operation: 'failed to build snapshot',
        responseError: 'failed to build snapshot',
      }));
    }
  });

  router.post('/refresh', async (req, res) => {
    const validation = parseRefreshBody(req.body);
    if (validation.kind === 'invalid') {
      writeRouteError(res, routeValidationError(validation.error));
      return;
    }

    const startedAt = Date.now();
    try {
      const snapshot = await service.refresh(validation.sources);
      const durationMs = Date.now() - startedAt;
      await recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'POST /api/snapshot/refresh',
        parsed_args: validation.sources
          ? { sources: validation.sources.join(',') }
          : {},
        duration_ms: durationMs,
      });
      res.json(snapshot);
    } catch (err) {
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.snapshot,
        operation: 'failed to refresh snapshot',
        responseError: 'failed to refresh snapshot',
      }));
    }
  });

  return router;
}

type RefreshBodyResult =
  | { kind: 'valid'; sources: readonly SourceName[] | undefined }
  | { kind: 'invalid'; error: string };

function parseRefreshBody(body: unknown): RefreshBodyResult {
  // Empty body / no sources field → refresh all.
  if (body === undefined || body === null) {
    return { kind: 'valid', sources: undefined };
  }
  if (typeof body !== 'object') {
    return { kind: 'invalid', error: 'request body must be a JSON object' };
  }
  const raw = (body as { sources?: unknown }).sources;
  if (raw === undefined) {
    return { kind: 'valid', sources: undefined };
  }
  if (!Array.isArray(raw)) {
    return { kind: 'invalid', error: 'sources must be an array of source names' };
  }
  if (raw.length === 0) {
    return { kind: 'invalid', error: 'sources must not be empty (omit the field to refresh all)' };
  }
  const invalid = raw.filter((s) => !isSourceName(s));
  if (invalid.length > 0) {
    return {
      kind: 'invalid',
      error: `unknown source names: ${invalid.map((s) => String(s)).join(', ')}`,
    };
  }
  return { kind: 'valid', sources: raw as readonly SourceName[] };
}
