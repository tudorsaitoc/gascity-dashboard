import { Router } from 'express';
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

interface ClientErrorEvent {
  component: string;
  operation: string;
  message: string;
}

const MAX_FIELD_LENGTH = 240;

// Strip ANSI escape sequences (OSC + CSI) and control characters before
// whitespace normalization. Otherwise a browser-supplied error string
// containing `\x1b[31m... [admin] CRITICAL ...\x1b[0m` would survive the
// `\s+ → ' '` collapse below and forge a fake `[component] message`
// operator log line. Mirrors backend/src/exec.ts::sanitiseTerminalOutput;
// the threat model here is browser-originated input rather than
// supervisor output, but the same control-char surface applies.
const OSC_RE = /\x1b\][^\x07]*\x07/g;
const CSI_RE = /\x1b\[[?0-9;]*[a-zA-Z]/g;
// All control chars (<0x20 plus DEL); \t/\n/\r are dropped here too because
// the whitespace normalize below would collapse them anyway, and dropping
// them up front makes the strip-before-normalize ordering invariant
// uniform regardless of which control bytes the input carries.
const CTRL_RE = /[\x00-\x1f\x7f]/g;

function stripNonPrintable(value: string): string {
  return value.replace(OSC_RE, '').replace(CSI_RE, '').replace(CTRL_RE, '');
}

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
  | { status: 'valid'; event: ClientErrorEvent }
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
  const stripped = stripNonPrintable(value);
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return { status: 'invalid', error: `${name} must be a non-empty string` };
  }
  if (normalized.length > MAX_FIELD_LENGTH) {
    return { status: 'invalid', error: `${name} must be ${MAX_FIELD_LENGTH} characters or fewer` };
  }
  return { status: 'valid', value: normalized };
}
