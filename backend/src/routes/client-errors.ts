import { Router } from 'express';
import type { ClientErrorReport } from 'gas-city-dashboard-shared';
import type { LogComponent } from '../logging.js';
import { LOG_COMPONENT, logWarn } from '../logging.js';
import {
  routeInternalError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

interface ClientErrorsRouterOptions {
  log?: (component: LogComponent, message: string) => void;
}

const MAX_FIELD_LENGTH = 240;

export function clientErrorsRouter(opts: ClientErrorsRouterOptions = {}): Router {
  const router = Router();
  const log = opts.log ?? logWarn;

  router.post('/', (req, res) => {
    const parsed = parseClientErrorEvent(req.body);
    if (parsed.status === 'invalid') {
      writeRouteError(res, routeValidationError(parsed.error));
      return;
    }

    try {
      const { component, operation, message } = parsed.event;
      log(LOG_COMPONENT.client, `${component} ${operation}: ${message}`);
      res.status(202).json({ ok: true });
    } catch (err) {
      writeRouteError(res, routeInternalError(err, {
        component: LOG_COMPONENT.client,
        operation: 'failed to record client error',
        responseError: 'failed to record client error',
      }));
    }
  });

  return router;
}

type ParseClientErrorEventResult =
  | { status: 'valid'; event: ClientErrorReport }
  | { status: 'invalid'; error: string };

function parseClientErrorEvent(body: unknown): ParseClientErrorEventResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'invalid', error: 'body must be an object' };
  }
  const record = body as Record<string, unknown>;
  const component = parseField(record.component, 'component');
  if (component.status === 'invalid') return component;
  const operation = parseField(record.operation, 'operation');
  if (operation.status === 'invalid') return operation;
  const message = parseField(record.message, 'message');
  if (message.status === 'invalid') return message;
  return {
    status: 'valid',
    event: {
      component: component.value,
      operation: operation.value,
      message: message.value,
    },
  };
}

type ParseFieldResult =
  | { status: 'valid'; value: string }
  | { status: 'invalid'; error: string };

function parseField(value: unknown, name: string): ParseFieldResult {
  if (typeof value !== 'string') {
    return { status: 'invalid', error: `${name} must be a non-empty string` };
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return { status: 'invalid', error: `${name} must be a non-empty string` };
  }
  if (normalized.length > MAX_FIELD_LENGTH) {
    return { status: 'invalid', error: `${name} must be ${MAX_FIELD_LENGTH} characters or fewer` };
  }
  return { status: 'valid', value: normalized };
}
