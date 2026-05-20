import type {
  GcSessionList,
  GcBeadList,
  GcMailList,
  GcEventList,
  TranscriptTurn,
} from 'gas-city-dashboard-shared';

interface GcTranscriptResponse {
  id?: string;
  template?: string;
  provider?: string;
  format?: string;
  turns?: TranscriptTurn[];
}

// Typed client for the gc supervisor HTTP API. All reads of supervisor
// state go through here; no other module fetches from supervisor
// directly. That keeps the wire-shape boundary in ONE place.
//
// Performance posture (gascity-dashboard-kz8):
//   - Every upstream call has a default timeout (DEFAULT_TIMEOUT_MS or
//     opts.defaultTimeoutMs). Without this, Node fetch waits indefinitely
//     and a hung supervisor surfaces as a >10s dashboard timeout.
//   - Concurrent identical GET requests are coalesced (single-flight) so
//     bursty load (multi-tab refresh, SSE-driven reload) collapses to one
//     upstream call. This is request de-duplication, not result caching:
//     once the inflight promise settles the slot is released; the very
//     next call hits upstream again.

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.GC_CLIENT_TIMEOUT_MS;
  if (typeof raw !== 'string') return 5_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
})();

export interface GcClientOptions {
  baseUrl: string;
  cityName: string;
  /** Per-request timeout for upstream supervisor calls. Defaults to GC_CLIENT_TIMEOUT_MS env, then 5000ms. */
  defaultTimeoutMs?: number;
}

export class GcClient {
  private readonly defaultTimeoutMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: GcClientOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Base URL of the gc supervisor (no trailing slash). Used for non-city endpoints (e.g. /v0/health) + frontend CSP connect-src. */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** City name this client is scoped to. */
  get cityName(): string {
    return this.opts.cityName;
  }

  /**
   * True if `err` is a fetch / abort that originated from a timeout
   * (either the per-request default or a caller-supplied AbortSignal).
   * Lets route handlers map upstream-timeout -> HTTP 504 cleanly.
   */
  static isTimeoutError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    // Node fetch wraps the underlying TypeError; the cause carries the real signal.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return cause.name === 'AbortError' || cause.name === 'TimeoutError';
    }
    return false;
  }

  private cityPath(suffix: string): string {
    const url = `${this.opts.baseUrl}/v0/city/${encodeURIComponent(this.opts.cityName)}${suffix}`;
    return url;
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    // Coalesce concurrent identical GETs. The cache key is the full URL —
    // different query strings get separate inflight slots (verified by
    // test). A caller-supplied signal does NOT change the slot: all
    // coalesced callers ride the same upstream request; if any caller
    // aborts they get the abort error, but the request itself continues
    // for the other waiters.
    const existing = this.inflight.get(url);
    if (existing) {
      return this.awaitWithSignal(existing as Promise<T>, signal);
    }

    const promise = this.fetchOnce<T>(url);
    this.inflight.set(url, promise);
    // Detach a no-throw cleanup so the slot is released on both settle
    // paths. Returning the original `promise` (not the .finally chain)
    // keeps the rejection surface attached to the caller's await — and
    // the .catch() here prevents the .finally chain from itself becoming
    // an unhandledRejection if the upstream call throws.
    promise.finally(() => {
      if (this.inflight.get(url) === promise) {
        this.inflight.delete(url);
      }
    }).catch(() => {
      /* swallowed; the actual rejection is delivered via the awaited promise above */
    });
    return this.awaitWithSignal(promise, signal);
  }

  private async awaitWithSignal<T>(
    p: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  private async fetchOnce<T>(url: string): Promise<T> {
    // Default timeout only. Caller-supplied signals are handled at the
    // `awaitWithSignal` layer so that one caller's abort does not kill a
    // coalesced fetch shared with other waiters.
    const timeoutSignal = AbortSignal.timeout(this.defaultTimeoutMs);
    const res = await fetch(url, {
      signal: timeoutSignal,
      // gc supervisor is a localhost service; no cross-origin headers needed.
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`gc supervisor returned ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  }

  async listSessions(signal?: AbortSignal): Promise<GcSessionList> {
    return this.getJson<GcSessionList>(this.cityPath('/sessions'), signal);
  }

  async listBeads(
    signal?: AbortSignal,
    params?: { limit?: number },
  ): Promise<GcBeadList> {
    // td-7t24i6 (the operator's corrected diagnosis): gc supervisor defaults
    // /beads to limit=50, which is far below the city's working set
    // (~2139 total, ~183 eng-only). The client-side spam filter then
    // operates on a 50-item window and the operator sees an undercount.
    // Pass an explicit large limit to cover the working set; the spam
    // filter shrinks back down on the client side.
    const search = new URLSearchParams();
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    const path = `/beads${qs.length > 0 ? `?${qs}` : ''}`;
    return this.getJson<GcBeadList>(this.cityPath(path), signal);
  }

  async listMail(
    signal?: AbortSignal,
    params?: { box?: 'inbox' | 'sent'; alias?: string; limit?: number },
  ): Promise<GcMailList> {
    // NOTE: per td-h3n2ar diagnosis, gc supervisor's `box` + `alias`
    // params are silently ignored upstream. We still pass them in case a
    // future supervisor version starts honoring them — the no-op today is
    // harmless. The actual sender/recipient filter happens in
    // routes/mail.ts::filterByBox.
    const search = new URLSearchParams();
    if (params?.box) search.set('box', params.box);
    if (params?.alias) search.set('alias', params.alias);
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    const path = `/mail${qs.length > 0 ? `?${qs}` : ''}`;
    return this.getJson<GcMailList>(this.cityPath(path), signal);
  }

  async listEvents(signal?: AbortSignal, after?: number): Promise<GcEventList> {
    const path = `/events${after !== undefined ? `?after=${after}` : ''}`;
    return this.getJson<GcEventList>(this.cityPath(path), signal);
  }

  /**
   * Architect addendum (td-wisp-ijk7g + mechanic td-wisp-e1v14): peek is an
   * HTTP endpoint, not shell-exec. Returns structured turns.
   */
  async fetchTranscript(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GcTranscriptResponse> {
    return this.getJson<GcTranscriptResponse>(
      this.cityPath(`/session/${encodeURIComponent(sessionId)}/transcript`),
      signal,
    );
  }
}
