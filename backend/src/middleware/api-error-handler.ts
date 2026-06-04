import type { ErrorRequestHandler } from 'express';
import { LOG_COMPONENT } from '../logging.js';
import { routeInternalError, writeRouteError } from '../route-errors.js';

export function apiErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    writeRouteError(
      res,
      routeInternalError(err, {
        component: LOG_COMPONENT.admin,
        operation: 'unhandled async route failure',
        responseError: 'dashboard route failed',
      }),
    );
  };
}
