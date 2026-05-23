import type { SourceName, SourceState } from 'gas-city-dashboard-shared';

// TTL + single-flight + stale-while-error + fixture-fallback cache.
// Ported from demo-dash src/server/cache.ts (gascity-dashboard-glw).
//
// Three invariants downstream beads need to know:
//
// 1. Single-flight is keyed by closure identity. One SourceCache instance
//    represents one source; two concurrent .get() calls coalesce because
//    they share `this.inFlight`. This is DIFFERENT from GcClient's
//    URL-keyed inflight map (backend/src/gc-client.ts): two SourceCache
//    instances for the same source name do NOT share a request.
//
// 2. snapshot() returns a synthetic status='error' state when the cache
//    has never been fetched. Callers that need to distinguish
//    "never tried" from "tried and failed" should check `fetchedAt !==
//    null`.
//
// 3. A successful live refresh wipes `fixtureEntry`. If the cache fell
//    back to fixture, then the next live load succeeds, the fixture is
//    forgotten; a subsequent failure that triggers fixture fallback will
//    re-invoke loadFixture(). This is intentional — fixtures are a
//    degraded-mode fallback, never a persistent shadow store. Note: once
//    `liveEntry` exists, the stale-while-error path takes precedence over
//    fixture fallback on the next failure, so fixture only re-activates
//    when there is no live entry at all (e.g., cold start or after a
//    forced cache reset by callers — none exist today).

export interface SourceCacheOptions<T> {
  source: SourceName;
  ttlMs: number;
  load: () => Promise<T> | T;
  loadFixture?: () => Promise<T> | T;
  useFixture?: boolean;
  now?: () => Date;
  /**
   * Sanitizer applied to the raw error before it lands in
   * SourceState.error (the wire shape served to the browser via
   * GET /api/snapshot).
   *
   * Three call modes (gascity-dashboard-4r5 inverted the default to
   * opt-out for security; a forgotten option must not leak):
   *
   *   - **omitted / `undefined`** — the default sanitizer fires,
   *     replacing the raw message with `${source} collection failed`.
   *     This is the safe default for any collector that touches local
   *     OS resources or external state of unknown shape.
   *   - **explicit `null`** — opt out of sanitization. The raw
   *     Error.message passes through unchanged. Reserved for
   *     collectors whose load() already throws a sanitized message
   *     (e.g. GcClient: `gc supervisor returned ${status}`).
   *   - **function** — custom sanitizer overrides the default. Useful
   *     when a collector wants a more specific generic message than
   *     the default.
   *
   * The raw error is still passed to the optional `onError` hook (if
   * present), so server-side logging can retain the full diagnostic
   * regardless of which wire-shape mode is selected.
   *
   * See gascity-dashboard-fhj (original resources ENOENT leak) and
   * gascity-dashboard-4r5 (default inversion).
   */
  sanitizeErrorMessage?: ((err: unknown) => string) | null;
  /**
   * Optional server-side observer for the raw error. Fires before
   * sanitization so the caller can log the full Error.message / stack
   * for operator debugging. Wire-shape SourceState.error is always
   * driven by `sanitizeErrorMessage` (default-on per
   * gascity-dashboard-4r5).
   */
  onError?: (source: SourceName, phase: 'load' | 'fixture', err: unknown) => void;
}

interface CacheEntry<T> {
  data: T;
  fetchedAtMs: number;
}

export class SourceCache<T> {
  private readonly source: SourceName;
  private readonly ttlMs: number;
  private readonly load: () => Promise<T> | T;
  private readonly loadFixture?: () => Promise<T> | T;
  private readonly useFixture: boolean;
  private readonly now: () => Date;
  private readonly sanitizeErrorMessage?: ((err: unknown) => string) | null;
  private readonly onError?: (
    source: SourceName,
    phase: 'load' | 'fixture',
    err: unknown,
  ) => void;
  private liveEntry: CacheEntry<T> | null = null;
  private fixtureEntry: CacheEntry<T> | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<SourceState<T>> | null = null;

  constructor(options: SourceCacheOptions<T>) {
    if (options.ttlMs <= 0 || !Number.isFinite(options.ttlMs)) {
      throw new Error('SourceCache ttlMs must be a positive finite number.');
    }

    this.source = options.source;
    this.ttlMs = options.ttlMs;
    this.load = options.load;
    this.loadFixture = options.loadFixture;
    this.useFixture = options.useFixture ?? false;
    this.now = options.now ?? (() => new Date());
    this.sanitizeErrorMessage = options.sanitizeErrorMessage;
    this.onError = options.onError;
  }

  async get(options: { force?: boolean } = {}): Promise<SourceState<T>> {
    const current = this.currentState();

    if (!options.force && current && current.status !== 'stale') {
      return current;
    }

    return await this.refresh();
  }

  async refresh(): Promise<SourceState<T>> {
    if (this.inFlight) {
      return await this.inFlight;
    }

    this.inFlight = this.refreshUnshared().finally(() => {
      this.inFlight = null;
    });

    return await this.inFlight;
  }

  snapshot(): SourceState<T> {
    return (
      this.currentState() ?? {
        source: this.source,
        status: 'error',
        fetchedAt: null,
        staleAt: null,
        error: this.lastError,
        data: null,
      }
    );
  }

  private async refreshUnshared(): Promise<SourceState<T>> {
    try {
      const data = await this.load();
      this.liveEntry = {
        data,
        fetchedAtMs: this.now().getTime(),
      };
      this.fixtureEntry = null;
      this.lastError = null;
      return this.stateFromEntry(this.liveEntry, 'fresh', null);
    } catch (error) {
      this.onError?.(this.source, 'load', error);
      this.lastError = this.sanitizedMessage(error);

      if (this.useFixture && this.loadFixture) {
        try {
          const data = await this.loadFixture();
          this.fixtureEntry = {
            data,
            fetchedAtMs: this.now().getTime(),
          };
          return this.stateFromEntry(this.fixtureEntry, 'fixture', this.lastError);
        } catch (fixtureError) {
          this.onError?.(this.source, 'fixture', fixtureError);
          this.lastError = `${this.lastError}; fixture failed: ${this.sanitizedMessage(fixtureError)}`;
        }
      }

      if (this.liveEntry) {
        return this.stateFromEntry(this.liveEntry, 'stale', this.lastError);
      }

      if (this.fixtureEntry) {
        return this.stateFromEntry(this.fixtureEntry, 'fixture', this.lastError);
      }

      return {
        source: this.source,
        status: 'error',
        fetchedAt: null,
        staleAt: null,
        error: this.lastError,
        data: null,
      };
    }
  }

  private currentState(): SourceState<T> | null {
    if (this.liveEntry) {
      const status =
        this.now().getTime() < this.liveEntry.fetchedAtMs + this.ttlMs
          ? 'fresh'
          : 'stale';
      return this.stateFromEntry(
        this.liveEntry,
        status,
        status === 'stale' ? this.lastError : null,
      );
    }

    if (this.fixtureEntry) {
      return this.stateFromEntry(this.fixtureEntry, 'fixture', this.lastError);
    }

    return null;
  }

  /**
   * Sanitize an error message at the cache boundary before it lands in
   * SourceState.error (the wire shape served to the browser).
   *
   * Default-on sanitization (gascity-dashboard-4r5): when the collector
   * omits `sanitizeErrorMessage`, the raw message — which may contain
   * OS-internal paths from local file reads — is replaced with a
   * generic `${source} collection failed`. Collectors opt out
   * explicitly with `sanitizeErrorMessage: null` (reserved for sources
   * whose load() already throws a sanitized message, e.g. GcClient's
   * `gc supervisor returned ${status}`).
   *
   * See gascity-dashboard-fhj (original resources ENOENT leak) and
   * gascity-dashboard-4r5 (default inversion to opt-out).
   */
  private sanitizedMessage(error: unknown): string {
    if (this.sanitizeErrorMessage === null) {
      return errorMessage(error);
    }
    if (this.sanitizeErrorMessage !== undefined) {
      return this.sanitizeErrorMessage(error);
    }
    return `${this.source} collection failed`;
  }

  private stateFromEntry(
    entry: CacheEntry<T>,
    status: SourceState<T>['status'],
    error: string | null,
  ): SourceState<T> {
    return {
      source: this.source,
      status,
      fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
      staleAt: new Date(entry.fetchedAtMs + this.ttlMs).toISOString(),
      error,
      data: entry.data,
    };
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
