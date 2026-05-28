import type { RequestHandler } from 'express';
import { LOG_COMPONENT, type LogComponent, logInfo } from '../logging.js';

export interface RequestLogOptions {
  log?: ((component: LogComponent, message: string) => void) | undefined;
}

export function requestLog(options: RequestLogOptions = {}): RequestHandler {
  const log = options.log ?? logInfo;
  return (req, res, next) => {
    if (req.path.startsWith('/api/snapshot')) {
      next();
      return;
    }

    const startedAt = Date.now();
    res.on('finish', () => {
      log(
        LOG_COMPONENT.admin,
        `${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`,
      );
    });
    next();
  };
}
