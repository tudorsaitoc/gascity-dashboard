import type {
  GcAgentList,
  GcSession,
  GcBead,
  GcMailItem,
  TranscriptResult,
  MailComposeRequest,
  MailSendResult,
  GitCommitList,
  GitView,
  DeployList,
  SystemHealth,
  DoltNomsTrend,
  MaintainerTriage,
  ContributorStat,
  ApiError,
  CityList,
  DashboardSnapshot,
  SourceName,
  DashboardRuntimeConfig,
  WorkflowDiffResponse,
  WorkflowRunDetail,
  WorkflowScopeKind,
  EntityLinkView,
} from 'gas-city-dashboard-shared';
import { readCsrfToken } from './csrf';
import { cityPath } from './cityBase';

// Typed fetch client for the admin backend's API. Shares types with the
// backend via the workspace 'gas-city-dashboard-shared' import so wire-shape
// drift produces compile errors instead of runtime undefined.
//
// gascity-dashboard-ucc: the request plane is split. City-scoped reads/writes
// address `/api/city/:cityName/*` via `cityPath()` (the active city is set by
// the router from the URL segment). Non-city endpoints — health, csrf, the
// city switcher list, client-error telemetry, git, builds — address `/api/*`
// directly because they are supervisor- or host-global, not per-city.

async function performRequest<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: object,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const token = readCsrfToken();
    if (token.status === 'available') headers['X-CSRF-Token'] = token.token;
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: 'same-origin',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    let payload: ApiError | null = null;
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiClientError(res.status, payload?.error ?? res.statusText, payload?.kind);
  }
  return (await res.json()) as T;
}

// In dev, `tsx watch` restarts the backend on every source edit, which
// rotates the in-process CSRF bootToken. The browser's cookie stays
// stale until the next GET response refreshes it, so the first
// mutation after a restart 403s with kind:'csrf'. Self-heal by doing a
// one-shot GET /api/csrf (which sets a fresh cookie) and replaying the
// original request exactly once. Only retries on the precise
// csrf-token mismatch — no other error class triggers a replay.
async function request<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: object,
): Promise<T> {
  try {
    return await performRequest<T>(method, url, body);
  } catch (err) {
    if (
      err instanceof ApiClientError &&
      err.status === 403 &&
      err.kind === 'csrf' &&
      method !== 'GET'
    ) {
      await fetch('/api/csrf', { credentials: 'same-origin' });
      return await performRequest<T>(method, url, body);
    }
    throw err;
  }
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly kind?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}


export const api = {
  // ── Non-city (supervisor / host-global) endpoints ──────────────────────
  health(): Promise<{ ok: boolean; ts: string }> {
    return request('GET', '/api/health');
  },
  // The city switcher source. Lists every managed city (host path stripped
  // server-side). Not city-scoped — it is the registry the switcher reads.
  listCities(): Promise<CityList> {
    return request('GET', '/api/cities');
  },
  listCommits(view: GitView): Promise<GitCommitList> {
    return request('GET', `/api/git/commits?view=${encodeURIComponent(view)}`);
  },
  listBuilds(): Promise<DeployList> {
    return request('GET', '/api/builds');
  },

  // ── City-scoped endpoints (ride /api/city/:cityName/*) ─────────────────
  listSessions(): Promise<{ items: GcSession[] }> {
    return request('GET', cityPath('/sessions'));
  },
  // gascity-dashboard-ay6: canonical agent roster. Supersedes the
  // session-derived Agents-view path which under-counted configured
  // agents that were not currently running. Return type IS the shared
  // GcAgentList SSOT — `partial` + `partial_errors` are part of that
  // type and will widen automatically if upstream grows the envelope.
  listAgents(): Promise<GcAgentList> {
    return request('GET', cityPath('/agents'));
  },
  peekSession(id: string): Promise<TranscriptResult> {
    return request('POST', cityPath(`/sessions/${encodeURIComponent(id)}/peek`), {});
  },
  listBeads(showAll?: boolean): Promise<{
    items: GcBead[];
    total: number;
    upstream_total?: number;
    upstream_fetched?: number;
    fetch_limit?: number;
  }> {
    const qs = showAll ? '?showAll=1' : '';
    return request('GET', cityPath(`/beads${qs}`));
  },
  getBead(id: string): Promise<GcBead> {
    return request('GET', cityPath(`/beads/${encodeURIComponent(id)}`));
  },
  claimBead(id: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', cityPath(`/beads/${encodeURIComponent(id)}/claim`), {});
  },
  closeBead(id: string, reason?: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', cityPath(`/beads/${encodeURIComponent(id)}/close`), { reason });
  },
  nudgeBead(id: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', cityPath(`/beads/${encodeURIComponent(id)}/nudge`), {});
  },
  listMail(box: 'inbox' | 'sent' | 'all', alias: string): Promise<{ items: GcMailItem[]; total: number }> {
    const qs = new URLSearchParams({ box, alias }).toString();
    return request('GET', cityPath(`/mail?${qs}`));
  },
  getThread(threadId: string, alias: string): Promise<{ items: GcMailItem[] }> {
    const qs = new URLSearchParams({ alias }).toString();
    return request('GET', cityPath(`/mail/threads/${encodeURIComponent(threadId)}?${qs}`));
  },
  sendMail(payload: MailComposeRequest): Promise<MailSendResult> {
    // The client-side shape mirrors the server's: { to, subject, body }.
    // No `from` field. The architect's physical-separation rule means
    // this fetch hits a different router than reads.
    return request('POST', cityPath('/mail-send'), payload);
  },
  config(): Promise<DashboardRuntimeConfig> {
    return request('GET', cityPath('/config'));
  },
  systemHealth(): Promise<SystemHealth> {
    return request('GET', cityPath('/health/system'));
  },
  doltTrend(): Promise<DoltNomsTrend> {
    return request('GET', cityPath('/dolt-noms/trend'));
  },
  agentPrime(alias: string): Promise<{ agent: string; prompt: string; bytes: number }> {
    return request('GET', cityPath(`/agents/${encodeURIComponent(alias)}/prime`));
  },
  snapshot(): Promise<DashboardSnapshot> {
    return request('GET', cityPath('/snapshot'));
  },
  // Bypasses the backend's per-source TTL — POSTs through
  // SnapshotService.refresh which forces a fresh upstream load on the
  // listed sources (or all sources when `sources` is omitted). Used by
  // the /workflows live-updates path so SSE-triggered re-fetches see
  // genuinely fresh data (gascity-dashboard-bqn).
  snapshotRefresh(sources?: readonly SourceName[]): Promise<DashboardSnapshot> {
    // Backend rejects [] explicitly (snapshot.ts:83 — "sources must not
    // be empty; omit the field to refresh all"). Guard here so callers
    // get a TypeScript-side no-op rather than a 400 from a stray empty
    // array. Pass undefined / non-empty arrays through.
    const body = sources && sources.length > 0 ? { sources } : {};
    return request('POST', cityPath('/snapshot/refresh'), body);
  },
  workflowRun(
    workflowId: string,
    params?: { scopeKind?: WorkflowScopeKind; scopeRef?: string },
  ): Promise<WorkflowRunDetail> {
    const qs = workflowQuery(params);
    return request('GET', cityPath(`/workflows/${encodeURIComponent(workflowId)}${qs}`));
  },
  workflowDiff(
    workflowId: string,
    params?: { scopeKind?: WorkflowScopeKind; scopeRef?: string },
  ): Promise<WorkflowDiffResponse> {
    const qs = workflowQuery(params);
    return request('GET', cityPath(`/workflows/${encodeURIComponent(workflowId)}/diff${qs}`));
  },
  sessionStreamUrl(id: string): string {
    // Distinct from /sessions (REST) — the session SSE stream mounts under
    // its own /session-stream prefix on the backend (see city/runtime.ts).
    return cityPath(`/session-stream/${encodeURIComponent(id)}/stream`);
  },
  maintainerTriage(): Promise<MaintainerTriage> {
    return request('GET', cityPath('/maintainer/triage'));
  },
  maintainerRefresh(): Promise<MaintainerTriage> {
    return request('POST', cityPath('/maintainer/refresh'), {});
  },
  maintainerContributor(login: string): Promise<ContributorStat> {
    return request('GET', cityPath(`/maintainer/contributor/${encodeURIComponent(login)}`));
  },
  // gascity-dashboard-0nn: per-item sling dispatch. The bulk-sling
  // action bar fans out one call per selected item via Promise.allSettled
  // so a single 4xx/5xx doesn't block the rest of the batch.
  // Bead-ID cross-entity linked view (gascity-dashboard-j4x). `ref` is a
  // bead id, `pr/<n>`, `issue/<n>`, a session id, or a workflow id.
  entityLinks(ref: string): Promise<EntityLinkView> {
    return request('GET', cityPath(`/links/${encodeURIComponent(ref)}`));
  },
  maintainerSling(payload: {
    kind: 'pr' | 'issue';
    number: number;
    html_url: string;
    intent: 'review' | 'draft' | 'triage';
    target?: string;
  }): Promise<{ ok: true; bead_id?: string }> {
    return request('POST', cityPath('/maintainer/sling'), payload);
  },
};

function workflowQuery(params?: { scopeKind?: WorkflowScopeKind; scopeRef?: string }): string {
  const search = new URLSearchParams();
  if (params?.scopeKind && params.scopeRef) {
    search.set('scope_kind', params.scopeKind);
    search.set('scope_ref', params.scopeRef);
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}
