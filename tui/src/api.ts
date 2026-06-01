// Thin read client of the backend /api/*. The TUI never talks to the gc
// supervisor directly — it inherits edge translation, sanitisation, timeouts
// and audit from the backend GcClient (backend/src/gc-client.ts) for free.
// Consumes the dashboard-owned DTOs; shared/ remains the single source of
// truth for the shapes, so a contract drift is a compile error here, not a
// runtime undefined.

import {
  OPERATOR_DISPLAY_ALIAS,
  type GcSession,
  type GcSessionList,
  type GcBead,
  type GcMailItem,
  type DashboardSnapshot,
  type RunLane,
} from 'gas-city-dashboard-shared';

export type { GcSession, GcBead, GcMailItem, DashboardSnapshot, RunLane };

function cityBase(baseUrl: string, city: string): string {
  return `${baseUrl}/api/city/${encodeURIComponent(city)}`;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET ${new URL(url).pathname} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** GET /api/city/:cityName/sessions → GcSessionList. */
export function fetchSessions(
  baseUrl: string,
  city: string,
  signal?: AbortSignal,
): Promise<GcSessionList> {
  return getJson<GcSessionList>(`${cityBase(baseUrl, city)}/sessions`, signal);
}

/** GET /api/city/:cityName/snapshot → DashboardSnapshot (system health + run lanes). */
export function fetchSnapshot(
  baseUrl: string,
  city: string,
  signal?: AbortSignal,
): Promise<DashboardSnapshot> {
  return getJson<DashboardSnapshot>(`${cityBase(baseUrl, city)}/snapshot`, signal);
}

interface BeadList {
  readonly items: GcBead[];
}

/** GET /api/city/:cityName/beads → bead list (associated to rigs by id prefix). */
export async function fetchBeads(
  baseUrl: string,
  city: string,
  signal?: AbortSignal,
): Promise<GcBead[]> {
  const list = await getJson<BeadList>(`${cityBase(baseUrl, city)}/beads`, signal);
  return list.items;
}

interface MailListResponse {
  readonly items: GcMailItem[];
}

/**
 * GET /api/city/:cityName/mail?box=inbox&alias=<operator> → the operator's
 * inbox. The backend resolves the operator's display alias to gc's wire alias
 * and filters server-side (see backend/src/routes/mail.ts); unread filtering
 * is applied in the view layer.
 */
export async function fetchMail(
  baseUrl: string,
  city: string,
  signal?: AbortSignal,
): Promise<GcMailItem[]> {
  const url = `${cityBase(baseUrl, city)}/mail?box=inbox&alias=${encodeURIComponent(
    OPERATOR_DISPLAY_ALIAS,
  )}`;
  const list = await getJson<MailListResponse>(url, signal);
  return list.items;
}

/** City-scoped SSE endpoint the backend proxies verbatim from the supervisor. */
export function eventsStreamUrl(baseUrl: string, city: string): string {
  return `${cityBase(baseUrl, city)}/events/stream`;
}
