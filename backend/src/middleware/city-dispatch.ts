import type { NextFunction, Request, Response } from 'express';

import type { CityRegistry } from '../city/registry.js';
import type { CityRuntime } from '../city/runtime.js';
import { GcClient } from '../gc-client.js';
import { isValidCityName } from '../lib/cityName.js';
import { LOG_COMPONENT, logWarn } from '../logging.js';
import {
  routeInternalError,
  routeUpstreamError,
  routeValidationError,
  writeRouteError,
} from '../route-errors.js';

// The dispatch middleware injects the resolved runtime onto the request so
// downstream routers read gc/service off req instead of a boot closure. A
// module augmentation keeps it typed without an `any` cast at every read.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      cityRuntime?: CityRuntime;
    }
  }
}

/**
 * City-dispatch middleware (gascity-dashboard-ucc). Mounted at
 * `/api/city/:cityName`. Responsibilities, in order:
 *
 *  1. Validate `:cityName` against CITY_NAME_RE BEFORE any gc call or
 *     path.join — a traversal / malformed segment is rejected 400 without
 *     ever touching the supervisor or the filesystem.
 *  2. Get-or-create the city's runtime via the registry (which memoizes the
 *     in-flight construction so concurrent first-requests build exactly one
 *     runtime).
 *  3. Map the resolve outcome to an HTTP status — a not-running / unknown
 *     city surfaces a city-level error, NEVER a silent fallback to another
 *     city.
 *  4. Attach the runtime to `req.cityRuntime` and hand off to the city
 *     router.
 */
export function cityDispatch(registry: CityRegistry) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cityName = req.params.cityName;
    if (typeof cityName !== 'string' || !isValidCityName(cityName)) {
      // Rejected pre-gc, pre-path.join. No topology / no supervisor call.
      writeRouteError(res, routeValidationError('invalid city name'));
      return;
    }

    // `resolve` reports its EXPECTED outcomes (unknown / invalid /
    // upstream-error) via ResolveResult. An exception here is UNEXPECTED — a
    // synchronous throw out of runtime construction (CityRuntime.start() or a
    // module mount). Express 4 does not forward rejected async-middleware
    // promises to its error handler, so an unhandled rejection would hang the
    // request. Catch it and surface a 500 instead of leaving the client open.
    let result: Awaited<ReturnType<typeof registry.resolve>>;
    try {
      result = await registry.resolve(cityName);
    } catch (error) {
      writeRouteError(
        res,
        routeInternalError(error, {
          component: LOG_COMPONENT.admin,
          operation: 'city-dispatch resolve',
          responseError: 'failed to build city runtime',
          log: logWarn,
        }),
      );
      return;
    }
    switch (result.kind) {
      case 'ok':
        req.cityRuntime = result.runtime;
        next();
        return;
      case 'unknown':
        // Valid name, but not a city this supervisor manages. 404 — no
        // fallback to any other city.
        writeRouteError(res, {
          status: 404,
          body: { error: 'unknown city', kind: 'unknown-city' },
        });
        return;
      case 'invalid':
        // Belt-and-suspenders: registry re-validated and rejected. Mirrors
        // the step-1 guard so the contract holds even if a caller bypasses it.
        writeRouteError(res, routeValidationError('invalid city name'));
        return;
      case 'upstream-error': {
        // The /v0/cities lookup failed. Map timeouts to 504, everything else
        // to 502 — same contract the city-scoped routes use. NO silent
        // fallback; the operator sees the supervisor is unreachable.
        const wire = routeUpstreamError(result.error, {
          component: LOG_COMPONENT.admin,
          operation: 'city-dispatch resolve',
          responseError: 'gc supervisor city registry unreachable',
          isTimeout: GcClient.isTimeoutError,
          log: logWarn,
        });
        writeRouteError(res, wire);
        return;
      }
    }
  };
}
