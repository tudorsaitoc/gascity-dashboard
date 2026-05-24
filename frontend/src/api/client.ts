import type {
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
  KanbanResponse,
  MaintainerTriage,
  ContributorStat,
  ApiError,
  DashboardSnapshot,
} from 'gas-city-dashboard-shared';

// Typed fetch client for the admin backend's /api/*. Shares types with
// the backend via the workspace 'gas-city-dashboard-shared' import so wire-shape
// drift produces compile errors instead of runtime undefined.

const COOKIE_NAME = 'gascity_admin_csrf';

function readCsrfCookie(): string | null {
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  return decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
}

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
    const token = readCsrfCookie();
    if (token) headers['X-CSRF-Token'] = token;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
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
  listSessions(): Promise<{ items: GcSession[] }> {
    return request('GET', '/api/sessions');
  },
  peekSession(id: string): Promise<TranscriptResult> {
    return request('POST', `/api/sessions/${encodeURIComponent(id)}/peek`, {});
  },
  listBeads(showAll?: boolean): Promise<{
    items: GcBead[];
    total: number;
    upstream_total?: number;
    upstream_fetched?: number;
    fetch_limit?: number;
  }> {
    const qs = showAll ? '?showAll=1' : '';
    return request('GET', `/api/beads${qs}`);
  },
  getBead(id: string): Promise<GcBead> {
    return request('GET', `/api/beads/${encodeURIComponent(id)}`);
  },
  claimBead(id: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', `/api/beads/${encodeURIComponent(id)}/claim`, {});
  },
  closeBead(id: string, reason?: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', `/api/beads/${encodeURIComponent(id)}/close`, { reason });
  },
  nudgeBead(id: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', `/api/beads/${encodeURIComponent(id)}/nudge`, {});
  },
  listMail(box: 'inbox' | 'sent' | 'all', alias: string): Promise<{ items: GcMailItem[]; total?: number }> {
    const qs = new URLSearchParams({ box, alias }).toString();
    return request('GET', `/api/mail?${qs}`);
  },
  getThread(threadId: string, alias: string): Promise<{ items: GcMailItem[] }> {
    const qs = new URLSearchParams({ alias }).toString();
    return request('GET', `/api/mail/threads/${encodeURIComponent(threadId)}?${qs}`);
  },
  sendMail(payload: MailComposeRequest): Promise<MailSendResult> {
    // The client-side shape mirrors the server's: { to, subject, body }.
    // No `from` field. The architect's physical-separation rule means
    // this fetch hits a different router than reads.
    return request('POST', '/api/mail-send', payload);
  },
  health(): Promise<{ ok: boolean; ts: string }> {
    return request('GET', '/api/health');
  },
  listCommits(view: GitView): Promise<GitCommitList> {
    return request('GET', `/api/git/commits?view=${encodeURIComponent(view)}`);
  },
  listBuilds(): Promise<DeployList> {
    return request('GET', '/api/builds');
  },
  systemHealth(): Promise<SystemHealth> {
    return request('GET', '/api/system/system');
  },
  doltTrend(): Promise<DoltNomsTrend> {
    return request('GET', '/api/dolt-noms/trend');
  },
  agentPrime(alias: string): Promise<{ agent: string; prompt: string; bytes: number }> {
    return request('GET', `/api/agents/${encodeURIComponent(alias)}/prime`);
  },
  kanban(): Promise<KanbanResponse> {
    return request('GET', '/api/admin/kanban');
  },
  snapshot(): Promise<DashboardSnapshot> {
    return request('GET', '/api/snapshot');
  },
  maintainerTriage(): Promise<MaintainerTriage> {
    return request('GET', '/api/maintainer/triage');
  },
  maintainerRefresh(): Promise<MaintainerTriage> {
    return request('POST', '/api/maintainer/refresh', {});
  },
  maintainerContributor(login: string): Promise<ContributorStat> {
    return request('GET', `/api/maintainer/contributor/${encodeURIComponent(login)}`);
  },
  // gascity-dashboard-0nn: per-item sling dispatch. The bulk-sling
  // action bar fans out one call per selected item via Promise.allSettled
  // so a single 4xx/5xx doesn't block the rest of the batch.
  maintainerSling(payload: {
    kind: 'pr' | 'issue';
    number: number;
    html_url: string;
    intent: 'review' | 'draft' | 'triage';
    target?: string;
  }): Promise<{ ok: true; bead_id?: string }> {
    return request('POST', '/api/maintainer/sling', payload);
  },
};
