import {
  createClient as createGeneratedSupervisorClient,
  type Client as GeneratedSupervisorClient,
} from '@hey-api/client-fetch';
import { z } from 'zod';
import type { StatusBody } from './generated/gc-supervisor-client/types.gen.js';
import {
  getV0Cities,
  getV0CityByCityNameStatus,
} from './generated/gc-supervisor-client/sdk.gen.js';

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.GC_CLIENT_TIMEOUT_MS;
  if (typeof raw !== 'string') return 5_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
})();

type SupervisorFetchResult<RawValue> = {
  response?: Response | undefined;
  data?: RawValue | undefined;
  error?: unknown;
};

type ZodIssueLike = {
  code?: string;
  expected?: unknown;
  input?: unknown;
  path: ReadonlyArray<PropertyKey>;
};

type ZodErrorLike = {
  issues: readonly ZodIssueLike[];
};

export interface GcClientOptions {
  baseUrl: string;
  cityName: string;
  /** Per-request timeout for upstream supervisor calls. Defaults to GC_CLIENT_TIMEOUT_MS env, then 5000ms. */
  defaultTimeoutMs?: number;
}

/** Host-side city descriptor including the untrusted supervisor host path. */
export interface SupervisorCity {
  name: string;
  path: string;
  running: boolean;
}

// Minimal backend supervisor client for host-local capabilities only. Browser
// GC surfaces use frontend/src/supervisor/client.ts and the generated SDK.
export class GcClient {
  private readonly defaultTimeoutMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly supervisor: GeneratedSupervisorClient;

  constructor(private readonly opts: GcClientOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.supervisor = createGeneratedSupervisorClient({
      baseUrl: opts.baseUrl,
      headers: { Accept: 'application/json' },
      responseStyle: 'fields',
      throwOnError: false,
    });
  }

  static isTimeoutError(err: unknown): boolean {
    return err instanceof Error && err.name === 'TimeoutError';
  }

  async getStatus(signal?: AbortSignal): Promise<StatusBody> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameStatus'),
      'getStatus',
      (upstreamSignal) => getV0CityByCityNameStatus({
        client: this.supervisor,
        path: this.cityPathParams(),
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listSupervisorCities(
    signal?: AbortSignal,
  ): Promise<readonly SupervisorCity[]> {
    const body = await this.getOperation(
      this.operationKey('getV0Cities'),
      'listSupervisorCities',
      (upstreamSignal) => getV0Cities({
        client: this.supervisor,
        signal: upstreamSignal,
      }),
      signal,
    );
    return (body.items ?? []).map((city) => ({
      name: city.name,
      path: city.path,
      running: city.running,
    }));
  }

  private async getOperation<RawValue>(
    key: string,
    payloadName: string,
    fetcher: (
      signal: AbortSignal,
    ) => Promise<SupervisorFetchResult<RawValue>>,
    signal?: AbortSignal,
  ): Promise<RawValue> {
    if (signal?.aborted) {
      throw abortError();
    }
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return await this.withCallerAbort(existing as Promise<RawValue>, signal);
    }
    const promise = this.fetchOnce(payloadName, fetcher);
    this.inflight.set(key, promise);
    try {
      return await this.withCallerAbort(promise, signal);
    } finally {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    }
  }

  private async fetchOnce<RawValue>(
    payloadName: string,
    fetcher: (signal: AbortSignal) => Promise<SupervisorFetchResult<RawValue>>,
  ): Promise<RawValue> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(timeoutError()), this.defaultTimeoutMs);
    try {
      const result = await fetcher(controller.signal).catch((err: unknown) => {
        throw errorFromGeneratedClient(err, payloadName);
      });
      if (result.response !== undefined && !result.response.ok) {
        throw sanitizedSupervisorStatusError(result.response.status);
      }
      if (result.error !== undefined) {
        throw errorFromGeneratedClient(result.error, payloadName);
      }
      if (result.response !== undefined && result.data !== undefined &&
        isGeneratedEmptyJsonBody(result.response, result.data)) {
        throw new Error('gc supervisor returned an empty response body');
      }
      if (result.data === undefined) {
        throw new Error('gc supervisor returned an empty response body');
      }
      return result.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async withCallerAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal === undefined) {
      return await promise;
    }
    if (signal.aborted) {
      throw abortError();
    }
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private operationKey(
    operation: string,
    params: readonly (string | number | boolean | undefined)[] = [],
  ): string {
    return JSON.stringify([operation, ...params]);
  }

  private cityPathParams(): { cityName: string } {
    return { cityName: this.opts.cityName };
  }
}

function sanitizedSupervisorStatusError(status: number): Error {
  return new Error(`gc supervisor returned ${status}`);
}

function errorFromGeneratedClient(error: unknown, payloadName: string): Error {
  const zodError = zodErrorFromUnknown(error);
  if (zodError !== null) {
    return invalidSupervisorPayload(payloadName, zodError);
  }
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.length > 0) return new Error(error);
  return new Error('gc supervisor request failed');
}

function isGeneratedEmptyJsonBody(response: Response, data: unknown): boolean {
  if (response.status === 204) return false;
  if (response.headers.get('Content-Length') !== '0') return false;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  return Object.keys(data).length === 0;
}

function timeoutError(): DOMException {
  return new DOMException('gc supervisor request timed out', 'TimeoutError');
}

function abortError(): DOMException {
  return new DOMException('operation aborted', 'AbortError');
}

function zodErrorFromUnknown(error: unknown): ZodErrorLike | null {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) {
    return error.cause;
  }
  if (error instanceof Error && error.cause !== undefined) {
    const cause = zodErrorFromUnknown(error.cause);
    if (cause !== null) return cause;
  }
  if (typeof error !== 'object' || error === null) return null;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  const validIssues = issues.filter((issue): issue is ZodIssueLike => {
    if (typeof issue !== 'object' || issue === null) return false;
    const path = (issue as { path?: unknown }).path;
    return Array.isArray(path);
  });
  if (validIssues.length !== issues.length) return null;
  return { issues: validIssues };
}

function invalidSupervisorPayload(payload: string, error: ZodErrorLike): Error {
  const issue = error.issues[0];
  const path = issue ? zodPath(issue.path) : 'payload';
  const expected = issue ? zodExpected(issue) : 'valid';
  return new Error(
    `invalid gc supervisor ${payload} payload: ${path} must be ${expected}`,
  );
}

function zodPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return 'payload';
  return `payload${path.map((part) => {
    if (typeof part === 'number') return `[${part}]`;
    return `.${String(part).replace(/[\r\n]/g, '_')}`;
  }).join('')}`;
}

function zodExpected(issue: ZodIssueLike): string {
  if (issue.code === 'invalid_type' && issue.expected !== undefined) {
    if ('input' in issue && issue.input === undefined) return 'present';
    return String(issue.expected);
  }
  if (typeof issue.code === 'string') {
    return `valid (${issue.code})`;
  }
  return 'valid';
}
