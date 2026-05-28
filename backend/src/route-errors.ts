import type { ApiError } from 'gas-city-dashboard-shared';
import { toWireInternal500 } from './lib/sanitise-error.js';
import { HTTP_STATUS } from './lib/http-status.js';
import type { LogComponent } from './logging.js';
import { errorMessage, logError, logWarn } from './logging.js';

export interface RouteErrorWire {
  status: number;
  body: ApiError;
}

interface JsonResponse {
  status(status: number): {
    json(body: ApiError): unknown;
  };
}

export function routeValidationError(error: string): RouteErrorWire {
  return { status: HTTP_STATUS.badRequest, body: { error, kind: 'validation' } };
}

export interface RouteUpstreamErrorOptions {
  component: LogComponent;
  operation: string;
  responseError: string;
  isTimeout: (err: unknown) => boolean;
  timeoutError?: string;
  notFound?: { error: string; kind: string };
  log?: (component: LogComponent, message: string) => void;
}

export interface RouteInternalErrorOptions {
  component: LogComponent;
  operation: string;
  responseError: string;
  log?: (component: LogComponent, message: string) => void;
}

export function routeUpstreamError(
  err: unknown,
  options: RouteUpstreamErrorOptions,
): RouteErrorWire {
  if (options.isTimeout(err)) {
    return {
      status: HTTP_STATUS.gatewayTimeout,
      body: {
        error: options.timeoutError ?? 'gc supervisor did not respond in time',
        kind: 'upstream-timeout',
      },
    };
  }

  const message = errorMessage(err);
  if (options.notFound !== undefined && /\b404\b/.test(message)) {
    return {
      status: HTTP_STATUS.notFound,
      body: {
        error: options.notFound.error,
        kind: options.notFound.kind,
      },
    };
  }

  const log = options.log ?? logWarn;
  log(options.component, `${options.operation}: ${message}`);
  const wire = toWireInternal500(err, {
    status: HTTP_STATUS.badGateway,
    error: options.responseError,
    kind: 'upstream',
  });
  return wire;
}

export function routeInternalError(
  err: unknown,
  options: RouteInternalErrorOptions,
): RouteErrorWire {
  const message = errorMessage(err);
  const log = options.log ?? logError;
  log(options.component, `${options.operation}: ${message}`);
  const wire = toWireInternal500(err, {
    status: HTTP_STATUS.internalServerError,
    error: options.responseError,
    kind: 'internal',
  });
  return wire;
}

export function writeRouteError(res: JsonResponse, wire: RouteErrorWire): void {
  res.status(wire.status).json(wire.body);
}
