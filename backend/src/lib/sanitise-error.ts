import type { ExecError } from '../exec.js';
import type { LogComponent } from '../logging.js';
import { logWarn } from '../logging.js';

// Centralized error-redaction shapes shared by route catch arms. Keeping
// them here makes the wire contract unit-testable without an Express
// Response or a spawned subprocess.
//
// Why pure (no Response coupling): the redaction decision — "which bytes
// are safe to ship to the browser" — is the security-relevant logic, and
// it should be assertable in isolation. The call sites keep ownership of
// `res.status(...).json(...)` and of the site-specific `console.warn`
// (the full message still goes to journalctl there; that's a side effect,
// not part of the wire shape).

/**
 * Spawn-arm redaction (gascity-dashboard-473). The 'spawn' kind wraps
 * node's child_process `spawn <abs-path> ENOENT`, which leaks the
 * operator's binary layout / PATH. validation and timeout kinds carry
 * pre-authored safe strings by ExecError construction (see
 * backend/src/exec.ts), so their message passes through unchanged.
 *
 * Status is the caller's responsibility — sibling routes map the same
 * kinds to different codes (500 vs 502 on the non-validation/timeout
 * arm), so it's threaded in rather than hardcoded.
 *
 * The full `err.message` for the spawn case stays at the call site's
 * `console.warn` for journalctl; it must never reach this body.
 */
export function toWireExecError(
  err: ExecError,
  status: number,
): { status: number; body: { error: string; kind: ExecError['kind'] } } {
  const error = err.kind === 'spawn' ? 'subprocess could not be started' : err.message;
  return { status, body: { error, kind: err.kind } };
}

interface JsonResponse {
  status(status: number): {
    json(body: { error: string; kind: ExecError['kind'] }): unknown;
  };
}

interface WriteExecErrorOptions {
  fallbackStatus?: number;
  log?: (component: LogComponent, message: string) => void;
}

export function writeExecError(
  res: JsonResponse,
  err: ExecError,
  component: LogComponent,
  endpoint: string,
  options: WriteExecErrorOptions = {},
): void {
  const status =
    err.kind === 'validation'
      ? 400
      : err.kind === 'timeout'
        ? 504
        : (options.fallbackStatus ?? 500);
  if (err.kind === 'spawn') {
    const log = options.log ?? logWarn;
    log(component, `${endpoint} spawn failed: ${err.message}`);
  }
  const wire = toWireExecError(err, status);
  res.status(wire.status).json(wire.body);
}

interface Internal500Options {
  status: number;
  error: string;
  kind: string;
}

/**
 * Non-ExecError fallback redaction (gascity-dashboard-ayr / sr6). Raw
 * `err.message` from an unexpected throw can embed OS detail
 * (ECONNREFUSED, host:port, getaddrinfo paths); `details.name` (the Error
 * class) is the only safe channel for the browser. The human-facing
 * `error` string and `kind` are caller-supplied so each route keeps its
 * existing copy ('internal error'/'internal', 'failed to list
 * beads'/'upstream', …).
 *
 * `err` is typed `unknown` and narrowed with `instanceof Error` rather than
 * an unchecked `(err as Error)` cast (strict useUnknownInCatchVariables), so
 * a thrown non-Error value degrades to 'Error' rather than throwing. A real
 * Error with an empty `name` ('') also degrades to 'Error' so the wire
 * details name is always useful.
 */
export function toWireInternal500(
  err: unknown,
  { status, error, kind }: Internal500Options,
): {
  status: number;
  body: { error: string; kind: string; details: { name: string } };
} {
  const name = err instanceof Error && err.name ? err.name : 'Error';
  return { status, body: { error, kind, details: { name } } };
}
