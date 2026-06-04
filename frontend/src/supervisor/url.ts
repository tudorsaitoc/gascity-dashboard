export const SUPERVISOR_PROXY_BASE_URL = '/gc-supervisor';

export function resolveSupervisorBaseUrl(): string {
  const configured = import.meta.env.VITE_GC_SUPERVISOR_URL;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }
  return SUPERVISOR_PROXY_BASE_URL;
}

export function resolveClientBaseUrl(baseUrl: string): string {
  if (!baseUrl.startsWith('/')) return baseUrl;
  const origin = globalThis.location?.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') {
    return baseUrl;
  }
  return new URL(baseUrl, origin).toString().replace(/\/$/, '');
}

export function supervisorUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const search = new URLSearchParams(query).toString();
  const suffix = search.length > 0 ? `${path}?${search}` : path;
  if (normalizedBase.startsWith('/')) return `${normalizedBase}${suffix}`;
  return new URL(suffix, `${normalizedBase}/`).toString();
}
