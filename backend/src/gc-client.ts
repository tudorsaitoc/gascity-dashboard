import type {
  CityList,
  GcAgent,
  GcAgentList,
  GcSessionList,
  GcBead,
  GcBeadList,
  GcFormulaRunList,
  GcFormulaRunsResponse,
  GcMailList,
  GcEventList,
  GcFormulaDetail,
  GcOrderHistoryDetail,
  GcOrderHistoryList,
  GcOrdersFeedResponse,
  GcRigList,
  GcStatus,
  GcWorkflowSnapshot,
  SlingInput,
  SlingResponse,
  BeadUpdateInput,
  MailSendInput,
  MailSendResponse,
  SupervisorHealth,
  WorkflowScopeKind,
} from 'gas-city-dashboard-shared';
import createClient, { type Client } from 'openapi-fetch';
import {
  gcSupervisorDecoders,
  type GcDecoder,
  type GcTranscriptResponse,
  type SupervisorCity,
} from './gc-supervisor-decoders.js';
import type { paths } from './generated/gc-supervisor.js';

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

// Sling does real work upstream (creates a bead, attaches a wisp, dispatches
// to a rig — ~30s measured on this deployment). 60s gives ~2x headroom,
// matching the old execGcSling subprocess timeout (gascity-dashboard-mq2).
const SLING_TIMEOUT_MS = 60_000;

const SUPERVISOR_PATHS = {
  agent: '/v0/city/{cityName}/agent/{base}',
  agents: '/v0/city/{cityName}/agents',
  bead: '/v0/city/{cityName}/bead/{id}',
  // Non-city supervisor endpoint: the registry of managed cities. The
  // only path here that is NOT city-scoped (gascity-dashboard-ucc).
  cities: '/v0/cities',
  beads: '/v0/city/{cityName}/beads',
  events: '/v0/city/{cityName}/events',
  eventsStream: '/v0/city/{cityName}/events/stream',
  formulaDetail: '/v0/city/{cityName}/formulas/{name}',
  formulaRuns: '/v0/city/{cityName}/formulas/{name}/runs',
  formulasFeed: '/v0/city/{cityName}/formulas/feed',
  health: '/v0/city/{cityName}/health',
  mail: '/v0/city/{cityName}/mail',
  orderHistoryDetail: '/v0/city/{cityName}/order/history/{bead_id}',
  ordersFeed: '/v0/city/{cityName}/orders/feed',
  ordersHistory: '/v0/city/{cityName}/orders/history',
  rigs: '/v0/city/{cityName}/rigs',
  sessionStream: '/v0/city/{cityName}/session/{id}/stream',
  sessions: '/v0/city/{cityName}/sessions',
  sling: '/v0/city/{cityName}/sling',
  status: '/v0/city/{cityName}/status',
  transcript: '/v0/city/{cityName}/session/{id}/transcript',
  workflow: '/v0/city/{cityName}/workflow/{workflow_id}',
} as const satisfies Record<string, keyof paths>;

type SupervisorFetchResult<RawValue> = {
  response: Response;
  data?: RawValue;
  error?: unknown;
};

type SupervisorPath = keyof paths & string;

export interface GcClientOptions {
  baseUrl: string;
  cityName: string;
  /** Per-request timeout for upstream supervisor calls. Defaults to GC_CLIENT_TIMEOUT_MS env, then 5000ms. */
  defaultTimeoutMs?: number;
}

export class GcClient {
  private readonly defaultTimeoutMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly supervisor: Client<paths>;

  constructor(private readonly opts: GcClientOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.supervisor = createClient<paths>({
      baseUrl: opts.baseUrl,
      headers: { Accept: 'application/json' },
    });
  }

  /** Base URL of the gc supervisor (no trailing slash). Used for non-city endpoints (e.g. /v0/health) + frontend CSP connect-src. */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** City name this client is scoped to. */
  get cityName(): string {
    return this.opts.cityName;
  }

  private cityPath(suffix: string): string {
    return `${this.opts.baseUrl}/v0/city/${encodeURIComponent(this.opts.cityName)}${suffix}`;
  }

  /**
   * True if `err` originated from the per-request timeout. Caller-supplied
   * AbortSignals fire as AbortError and are NOT timeouts — they map to
   * client-disconnect handling, not 504.
   */
  static isTimeoutError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'TimeoutError') return true;
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error && cause.name === 'TimeoutError';
  }

  private async getOperation<RawValue, DecodedValue>(
    key: string,
    decoder: GcDecoder<RawValue, DecodedValue>,
    run: (signal: AbortSignal) => Promise<SupervisorFetchResult<RawValue>>,
    signal?: AbortSignal,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<DecodedValue> {
    // Coalesce concurrent identical GETs. The cache key is the generated
    // operation path plus semantic path/query params. A caller-supplied
    // signal does NOT change the slot: all coalesced callers ride the same
    // upstream request; if any caller aborts they get the abort error, but
    // the request itself continues for the other waiters.
    const existing = this.inflight.get(key);
    if (existing) {
      return this.awaitWithSignal(existing as Promise<DecodedValue>, signal);
    }

    const promise = this.fetchOnce(run, timeoutMs).then(decoder);
    this.inflight.set(key, promise);
    // Detach a no-throw cleanup so the slot is released on both settle
    // paths. Returning the original `promise` keeps the rejection surface
    // attached to the caller's await.
    const cleanup = () => {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    };
    void promise.then(cleanup, cleanup);
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

  private async fetchOnce<RawValue>(
    run: (signal: AbortSignal) => Promise<SupervisorFetchResult<RawValue>>,
    timeoutMs: number,
  ): Promise<RawValue> {
    // Default timeout only. Caller-supplied signals are handled at the
    // `awaitWithSignal` layer so that one caller's abort does not kill a
    // coalesced fetch shared with other waiters.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const result = await run(timeoutSignal);
    if (!result.response.ok) {
      throw sanitizedSupervisorStatusError(result.response.status);
    }
    if (result.data === undefined) {
      throw new Error('gc supervisor returned an empty response body');
    }
    return result.data;
  }

  private operationKey(
    path: SupervisorPath,
    params: readonly (string | number | boolean | undefined)[] = [],
  ): string {
    return JSON.stringify([path, ...params]);
  }

  private cityPathParams(): { cityName: string } {
    return { cityName: this.opts.cityName };
  }

  private cityUrl(
    path: SupervisorPath,
    pathParams: Record<string, string>,
    queryParams: Record<string, string> = {},
  ): URL {
    const renderedPath = path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = pathParams[key];
      if (value === undefined) {
        throw new Error(`missing gc supervisor path parameter ${key}`);
      }
      return encodeURIComponent(value);
    });
    const url = new URL(`${this.opts.baseUrl}${renderedPath}`);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  /**
   * Send a JSON body to a city-scoped write endpoint with the given HTTP
   * `method` (gascity-dashboard-mq2). Defaults to POST; bead-claim uses PATCH.
   * Deliberately NOT coalesced — single-flight is a read-side optimisation;
   * writes must each hit the supervisor. The `X-GC-Request` header is the
   * supervisor's anti-CSRF presence check (any non-empty value is accepted).
   *
   * `timeoutMs` overrides the read default because writes do real work
   * (a sling creates a bead, attaches a wisp, dispatches to a rig — ~30s
   * measured), far longer than a GET. Same redaction contract as
   * fetchOnce: the thrown message carries only the status, never the URL.
   */
  private async writeJson<T>(
    suffix: string,
    body: unknown,
    timeoutMs: number,
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<T> {
    const url = this.cityPath(suffix);
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-GC-Request': 'dashboard',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`gc supervisor returned ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /**
   * `POST /sling` — auto-creates a bead from `input.bead` text and routes it
   * to `input.target` (gascity-dashboard-mq2; replaces the `gc sling` CLI
   * subprocess). The caller reads `root_bead_id` off the response to record
   * slung-state, in place of the old `^Slung <id>` stdout parse.
   */
  async sling(input: SlingInput): Promise<SlingResponse> {
    return this.writeJson<SlingResponse>('/sling', input, SLING_TIMEOUT_MS);
  }

  /**
   * `PATCH /bead/{id}` — the bead-CLAIM path (gascity-dashboard-mq2; replaces
   * `gc bd update --status=in_progress --assignee=stephanie`). PATCH is the
   * canonical update verb per the supervisor's api-ops-design.md, which marks
   * the equivalent `POST /bead/{id}/update` deprecated; both take the same
   * `BeadUpdateBody`. The supervisor returns OKResponseBody{status}; the caller
   * ignores the body (success = 2xx). Unlike sling, this is a fast metadata
   * write, so it uses the read default timeout. Bead CLOSE + agent NUDGE stay
   * on the CLI (no reason field / no HTTP route respectively).
   */
  async updateBead(id: string, body: BeadUpdateInput): Promise<void> {
    await this.writeJson<{ status?: string }>(
      `/bead/${encodeURIComponent(id)}`,
      body,
      this.defaultTimeoutMs,
      'PATCH',
    );
  }

  /**
   * `POST /mail` — operator mail send (gascity-dashboard-mq2; replaces
   * `gc mail send ... --from human`). The supervisor returns 201 with the
   * created Message; the caller reads `id` off the response in place of the
   * old stdout `Sent <id>` parse. Fast write, so it uses the read default
   * timeout. `from` is pinned to 'human' by the caller (server.ts), never the
   * browser — the browser-facing shape has no `from` slot.
   */
  async sendMail(body: MailSendInput): Promise<MailSendResponse> {
    return this.writeJson<MailSendResponse>('/mail', body, this.defaultTimeoutMs);
  }

  async listSessions(signal?: AbortSignal): Promise<GcSessionList> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.sessions),
      gcSupervisorDecoders.listSessions,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.sessions, {
        params: { path: this.cityPathParams() },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/status` — supervisor city status. The dashboard
   * reads `store_health.size_bytes` off this for the dolt-noms on-disk size
   * trend (gascity-dashboard-x82). Mirrors `listSessions`: coalesced GET
   * through the typed client, decoded at the wire-shape edge, default
   * timeout. `store_health` is optional — a degraded supervisor omits it,
   * and the sampler signals unavailable rather than reporting a fake zero.
   */
  async getStatus(signal?: AbortSignal): Promise<GcStatus> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.status),
      gcSupervisorDecoders.getStatus,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.status, {
        params: { path: this.cityPathParams() },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/rigs` — list of configured rigs for this city.
   * Used by the cityStatus snapshot collector to source rigs from the
   * HTTP API instead of parsing city.toml off the host filesystem
   * (gascity-dashboard-19w). The supervisor's RigResponse carries more
   * fields (agent_count, running_count, git status, etc.); the decoder
   * narrows to name+path which is all the dashboard's CityRig contract
   * uses today.
   */
  async listRigs(signal?: AbortSignal): Promise<GcRigList> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.rigs),
      gcSupervisorDecoders.listRigs,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.rigs, {
        params: { path: this.cityPathParams() },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/cities` — the supervisor's registry of managed cities
   * (gascity-dashboard-ucc). This is the ONLY non-city-scoped GET on the
   * client: it takes no `cityName` path param (the operationKey carries no
   * cityName either, but that is harmless — a GcClient instance is bound to
   * a single supervisor baseUrl, and the cities list is identical for every
   * per-city client pointed at that supervisor). The decoder drops the
   * untrusted host `path` so it never reaches the browser.
   */
  async listCities(signal?: AbortSignal): Promise<CityList> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.cities),
      gcSupervisorDecoders.listCities,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.cities, {
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * Host-side variant of {@link listCities} that RETAINS the untrusted
   * supervisor host `path` on each city (gascity-dashboard-ucc). Used ONLY
   * by the per-city runtime registry to source each CityRuntime's rig root;
   * the path is kept host-side and never serialized to the browser. A
   * distinct operationKey from `listCities` so the two decodes don't share
   * an inflight slot (different decoded shapes).
   */
  async listSupervisorCities(
    signal?: AbortSignal,
  ): Promise<readonly SupervisorCity[]> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.cities, ['supervisor']),
      gcSupervisorDecoders.listSupervisorCities,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.cities, {
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/agents` — first-class agent roster
   * (gascity-dashboard-ay6). Supersedes the previous derive-from-sessions
   * path which under-counted agents that are configured but not currently
   * bound to a running session. Alias-keyed (each item's `name` is the
   * stable alias the operator types into `gc sling`). The Agents view
   * consumes this directly; the cityStatus snapshot collector now also
   * consumes this for sessionsByProvider (gascity-dashboard-sd4) because
   * /sessions doesn't carry provider for every entry.
   */
  async listAgents(signal?: AbortSignal): Promise<GcAgentList> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.agents),
      gcSupervisorDecoders.listAgents,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.agents, {
        params: { path: this.cityPathParams() },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/agent/{base}` — per-agent detail keyed by the
   * agent's alias (`base` in the supervisor's path naming, but it is the
   * agent's `name`, not a session id). gascity-dashboard-ay6. The caller
   * is responsible for URL-encoding any '/' inside qualified names
   * (e.g. 'thriva/devpipeline.architect') — openapi-fetch handles the
   * `{base}` substitution and applies encodeURIComponent.
   */
  async getAgent(base: string, signal?: AbortSignal): Promise<GcAgent> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.agent, [base]),
      gcSupervisorDecoders.getAgent,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.agent, {
        params: { path: { ...this.cityPathParams(), base } },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async getBead(id: string, signal?: AbortSignal): Promise<GcBead> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.bead, [id]),
      gcSupervisorDecoders.getBead,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.bead, {
        params: { path: { ...this.cityPathParams(), id } },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listBeads(
    signal?: AbortSignal,
    params?: {
      limit?: number;
      status?: string;
      type?: string;
      label?: string;
      assignee?: string;
      rig?: string;
      all?: boolean;
    },
  ): Promise<GcBeadList> {
    // td-7t24i6 (the operator's corrected diagnosis): gc supervisor defaults
    // /beads to limit=50, which is far below the city's working set
    // (~2139 total, ~183 eng-only). The client-side spam filter then
    // operates on a 50-item window and the operator sees an undercount.
    // Pass an explicit large limit to cover the working set; the spam
    // filter shrinks back down on the client side.
    const query: {
      limit?: number;
      status?: string;
      type?: string;
      label?: string;
      assignee?: string;
      rig?: string;
      all?: boolean;
    } = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    if (params?.status !== undefined) query.status = params.status;
    if (params?.type !== undefined) query.type = params.type;
    if (params?.label !== undefined) query.label = params.label;
    if (params?.assignee !== undefined) query.assignee = params.assignee;
    if (params?.rig !== undefined) query.rig = params.rig;
    if (params?.all !== undefined) query.all = params.all;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.beads, [
        params?.limit,
        params?.status,
        params?.type,
        params?.label,
        params?.assignee,
        params?.rig,
        params?.all,
      ]),
      gcSupervisorDecoders.listBeads,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.beads, {
        params: { path: this.cityPathParams(), query },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listMail(
    signal?: AbortSignal,
    params?: { box?: 'inbox' | 'sent'; alias?: string; limit?: number },
  ): Promise<GcMailList> {
    // td-h3n2ar: the supervisor's `/mail` endpoint silently ignores `box`
    // and `alias` query params today. We still accept them in the method
    // signature (and key the operation cache by them) so callers don't
    // need to change when a future supervisor version starts honoring the
    // filter upstream — the no-op today is harmless. The actual
    // sender/recipient filter happens in routes/mail.ts::filterByBox.
    const query: { limit?: number } = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.mail, [
        params?.box,
        params?.alias,
        params?.limit,
      ]),
      gcSupervisorDecoders.listMail,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.mail, {
        params: { path: this.cityPathParams(), query },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listEvents(signal?: AbortSignal, after?: number): Promise<GcEventList> {
    const query: { index?: string } = {};
    if (after !== undefined) query.index = String(after);
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.events, [after]),
      gcSupervisorDecoders.listEvents,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.events, {
        params: { path: this.cityPathParams(), query },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async getWorkflow(
    workflowId: string,
    signal?: AbortSignal,
    scope?: { scopeKind: WorkflowScopeKind; scopeRef: string },
  ): Promise<GcWorkflowSnapshot> {
    const query: { scope_kind?: string; scope_ref?: string } = {};
    if (scope !== undefined) {
      query.scope_kind = scope.scopeKind;
      query.scope_ref = scope.scopeRef;
    }
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.workflow, [
        workflowId,
        scope?.scopeKind,
        scope?.scopeRef,
      ]),
      gcSupervisorDecoders.getWorkflow,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.workflow, {
        params: {
          path: { ...this.cityPathParams(), workflow_id: workflowId },
          query,
        },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * Cross-rig discovery of formula runs the supervisor knows about.
   * Mirrors `GET /v0/city/<city>/formulas/feed`. Returns rig-stored
   * workflow roots that `listBeads` (city-scoped) does NOT return —
   * see gascity-dashboard-ej9y. The dashboard's workflows snapshot
   * collector uses this to bootstrap its rig set for downstream
   * per-rig listBeads queries.
   */
  async listFormulaRuns(
    scope: { scopeKind: WorkflowScopeKind; scopeRef: string },
    signal?: AbortSignal,
  ): Promise<GcFormulaRunList> {
    const query = {
      scope_kind: scope.scopeKind,
      scope_ref: scope.scopeRef,
    };
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.formulasFeed, [
        scope.scopeKind,
        scope.scopeRef,
      ]),
      gcSupervisorDecoders.listFormulaRuns,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.formulasFeed, {
        params: { path: this.cityPathParams(), query },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async getFormulaDetail(
    formulaName: string,
    scope: { scopeKind: WorkflowScopeKind; scopeRef: string },
    target: string,
    signal?: AbortSignal,
  ): Promise<GcFormulaDetail> {
    const query = {
      scope_kind: scope.scopeKind,
      scope_ref: scope.scopeRef,
      target,
    };
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.formulaDetail, [
        formulaName,
        scope.scopeKind,
        scope.scopeRef,
        target,
      ]),
      gcSupervisorDecoders.getFormulaDetail,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.formulaDetail, {
        params: {
          path: { ...this.cityPathParams(), name: formulaName },
          query,
        },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  // ── hvx: formula/order run history feeds ────────────────────────────
  //
  // These four methods mirror the supervisor's per-formula and order
  // history endpoints. They have no consumer in the dashboard today; they
  // pin the GcClient boundary so future formula-detail / orders pages
  // don't reinvent the decoder edge or duplicate scope+pagination
  // handling. Aligned with the existing listFormulaRuns (ej9y) pattern
  // for the cross-formula feed.
  //
  // SD4 coexistence: kept under a single named region so a parallel
  // worktree adding sibling methods to this class can merge into a
  // distinct block (or below) without textual conflict.

  /**
   * `GET /v0/city/{name}/formulas/{name}/runs` — recent runs for one named
   * formula (e.g. 'mol-adopt-pr-v2'). Distinct from `listFormulaRuns`
   * (the cross-formula `/formulas/feed`). Used by future formula-detail
   * pages and any reporting surface that needs per-formula history.
   * `scope` is optional in the supervisor's OpenAPI but always passed
   * here — runs are scope-keyed and unscoped requests return the city's
   * default scope, which is not what consumers reading a formula's
   * history want. `limit` accepts 0 to mean "supervisor default".
   */
  async listFormulaRunsByName(
    formulaName: string,
    scope: { scopeKind: WorkflowScopeKind; scopeRef: string },
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<GcFormulaRunsResponse> {
    const query: { scope_kind: string; scope_ref: string; limit?: number } = {
      scope_kind: scope.scopeKind,
      scope_ref: scope.scopeRef,
    };
    if (options.limit !== undefined) query.limit = options.limit;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.formulaRuns, [
        formulaName,
        scope.scopeKind,
        scope.scopeRef,
        options.limit,
      ]),
      gcSupervisorDecoders.listFormulaRunsByName,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.formulaRuns, {
        params: {
          path: { ...this.cityPathParams(), name: formulaName },
          query,
        },
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  /**
   * `GET /v0/city/{name}/orders/feed` — currently-active order runs (the
   * supervisor's recurring-job feed). Per-item shape is the same
   * `MonitorFeedItemResponse` as `/formulas/feed`; `type` discriminates
   * (`'order'` vs `'formula'`). Scope is optional — omitting it asks the
   * supervisor for the city-wide feed.
   */
  async listOrdersFeed(
    options: {
      scope?: { scopeKind: WorkflowScopeKind; scopeRef: string };
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<GcOrdersFeedResponse> {
    const query: { scope_kind?: string; scope_ref?: string; limit?: number } = {};
    if (options.scope !== undefined) {
      query.scope_kind = options.scope.scopeKind;
      query.scope_ref = options.scope.scopeRef;
    }
    if (options.limit !== undefined) query.limit = options.limit;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.ordersFeed, [
        options.scope?.scopeKind,
        options.scope?.scopeRef,
        options.limit,
      ]),
      gcSupervisorDecoders.listOrdersFeed,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.ordersFeed, {
        params: { path: this.cityPathParams(), query },
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  /**
   * `GET /v0/city/{name}/orders/history?scoped_name=<...>` — full history
   * for one named order. `scopedName` is the supervisor's scoped form
   * (e.g. `'city:check-mail'` or `'rig:gascity:check-mail'`); the
   * unscoped `name` alone is not enough because two rigs may register the
   * same order. `before` is an RFC3339 timestamp pagination cursor;
   * `limit=0` asks the supervisor for its default.
   */
  async listOrderHistory(
    scopedName: string,
    options: { limit?: number; before?: string; signal?: AbortSignal } = {},
  ): Promise<GcOrderHistoryList> {
    const query: { scoped_name: string; limit?: number; before?: string } = {
      scoped_name: scopedName,
    };
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.before !== undefined) query.before = options.before;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.ordersHistory, [
        scopedName,
        options.limit,
        options.before,
      ]),
      gcSupervisorDecoders.listOrderHistory,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.ordersHistory, {
        params: { path: this.cityPathParams(), query },
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  /**
   * `GET /v0/city/{name}/order/history/{bead_id}` — single historical
   * order-run detail (captured output + labels). `storeRef` is optional
   * but recommended: bead IDs are store-local, so without `store_ref` the
   * supervisor disambiguates against the city store by default and can
   * 404 on rig-stored runs.
   */
  async getOrderHistoryDetail(
    beadId: string,
    options: { storeRef?: string; signal?: AbortSignal } = {},
  ): Promise<GcOrderHistoryDetail> {
    const query: { store_ref?: string } = {};
    if (options.storeRef !== undefined) query.store_ref = options.storeRef;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.orderHistoryDetail, [
        beadId,
        options.storeRef,
      ]),
      gcSupervisorDecoders.getOrderHistoryDetail,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.orderHistoryDetail, {
        params: {
          path: { ...this.cityPathParams(), bead_id: beadId },
          query,
        },
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  async health(options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<SupervisorHealth> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.health, [timeoutMs]),
      gcSupervisorDecoders.health,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.health, {
        params: { path: this.cityPathParams() },
        signal: upstreamSignal,
      }),
      options.signal,
      timeoutMs,
    );
  }

  eventsStreamUrl(after?: string): URL {
    const query = after === undefined || after.length === 0 ? {} : { after };
    return this.cityUrl(
      SUPERVISOR_PATHS.eventsStream,
      this.cityPathParams(),
      query,
    );
  }

  sessionStreamUrl(sessionId: string, after?: string): URL {
    const query = after === undefined || after.length === 0 ? {} : { after };
    return this.cityUrl(
      SUPERVISOR_PATHS.sessionStream,
      { ...this.cityPathParams(), id: sessionId },
      query,
    );
  }

  /**
   * Architect addendum (td-wisp-ijk7g + mechanic td-wisp-e1v14): peek is an
   * HTTP endpoint, not shell-exec. Returns structured turns.
   */
  async fetchTranscript(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GcTranscriptResponse> {
    return this.getOperation(
      this.operationKey(SUPERVISOR_PATHS.transcript, [sessionId]),
      gcSupervisorDecoders.fetchTranscript,
      (upstreamSignal) => this.supervisor.GET(SUPERVISOR_PATHS.transcript, {
        params: { path: { ...this.cityPathParams(), id: sessionId } },
        signal: upstreamSignal,
      }),
      signal,
    );
  }
}

function sanitizedSupervisorStatusError(status: number): Error {
  // gascity-dashboard-ais: route handlers forward this message verbatim
  // into the 502 details.message field, so the message must not include
  // the supervisor URL (port + city name = topology leak to the browser).
  // The status code is enough: the route already labels the failure with
  // its own error string and kind:'upstream'.
  return new Error(`gc supervisor returned ${status}`);
}
