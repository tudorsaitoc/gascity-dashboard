import type { RequestHandler } from 'express';
import crypto from 'node:crypto';
import {
  LOG_COMPONENT,
  REQUEST_ID_HEADER,
  type LogComponent,
  logInfo,
  runWithLogContext,
} from '../logging.js';

export interface RequestLogOptions {
  log?: ((component: LogComponent, message: string) => void) | undefined;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestLog(options: RequestLogOptions = {}): RequestHandler {
  const log = options.log ?? logInfo;
  return (req, res, next) => {
    const requestId = requestIdFromHeaders(req.headers);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const startedAt = Date.now();
    runWithLogContext({ requestId }, () => {
      res.on('finish', () => {
        log(
          LOG_COMPONENT.admin,
          `${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`,
        );
      });
      next();
    });
  };
}

function requestIdFromHeaders(headers: { [key: string]: string | string[] | undefined }): string {
  const raw = headers[REQUEST_ID_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && REQUEST_ID_RE.test(value)) return value;
  return crypto.randomUUID();
}
