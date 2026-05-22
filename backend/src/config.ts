// Single place for env-driven knobs. Anything new goes here so SECURITY.md
// can audit the configurable surface.

import { AGENT_ALIAS_RE } from './exec.js';

export interface AdminConfig {
  /** Listener port. Default 8081, side-by-side with gc dashboard at 8080. */
  port: number;
  /** Bind host. Default 127.0.0.1; override via HOST env for headless-VM workflows (e.g. HOST=0.0.0.0). */
  bindHost: string;
  /**
   * Extra hostnames allowed in the Host: header allow-list, on top of the
   * always-present floor ['127.0.0.1','localhost']. CSV via ADMIN_EXTRA_ALLOWED_HOSTS.
   * Used when bindHost=0.0.0.0 and clients reach the dashboard by LAN name/IP.
   */
  extraAllowedHosts: ReadonlyArray<string>;
  /** gc supervisor base URL (no trailing slash). */
  gcSupervisorUrl: string;
  /** Name of the city this admin dashboard manages. */
  cityName: string;
  /**
   * Optional absolute path to the city directory, passed as `gc prime --city=<path>`.
   * When unset, `gc` walks up from cwd to discover the city. Set via GC_CITY_PATH
   * for headless / systemd contexts where cwd is unrelated to the city tree.
   */
  cityPath: string;
  /** Path to .gc/events.jsonl for audit-log append. */
  auditLogPath: string;
  /** Path to the dist/ of the frontend build, served by express.static. */
  frontendDistPath: string;
  /** Kill-switch: set to '1' to refuse to start. */
  disabled: boolean;
  /**
   * Repo (owner/name) the maintainer triage view fetches issues + PRs from.
   * Env: MAINTAINER_REPO. Default: gastownhall/gascity. v0 single-repo;
   * a future bead can promote this to a CSV list when the maintainer
   * tracks multiple forks.
   */
  maintainerRepo: string;
  /**
   * Absolute path to the maintainer enrichment cache file. Env:
   * MAINTAINER_CACHE_PATH. Default: $HOME/.gascity-dashboard/maintainer-cache.json.
   * The dashboard atomically writes the cache after each refresh; reads
   * are best-effort (missing file → empty state, parse error → empty
   * state with a warning logged).
   */
  maintainerCachePath: string;
  /**
   * How often the in-process worker re-runs the triage refresh
   * (full gh fetch + classify + cluster). Env:
   * MAINTAINER_REFRESH_INTERVAL_MS. Default: 6 hours.
   * The frontend gets pushed an SSE 'refreshed' event after each
   * successful run so open tabs refetch without manual interaction.
   * 0 disables the worker (manual refresh only).
   */
  maintainerRefreshIntervalMs: number;
  /**
   * Default agent alias for `gc sling` dispatch from the maintainer view.
   * Env: MAINTAINER_SLING_TARGET. Default: 'mayor'.
   * Bad env values fall back to the default with a console.warn — a
   * typo in this single optional env should not dark the whole
   * dashboard. The exec wrapper re-validates target at request time.
   */
  maintainerSlingTarget: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const portRaw = env.PORT ?? '8081';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }
  const extraAllowedHosts = (env.ADMIN_EXTRA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return {
    port,
    bindHost: env.HOST ?? '127.0.0.1',
    extraAllowedHosts,
    gcSupervisorUrl: (env.GC_SUPERVISOR_URL ?? 'http://127.0.0.1:8372').replace(/\/+$/, ''),
    cityName: env.GC_CITY_NAME ?? 'gas-city',
    cityPath: env.GC_CITY_PATH ?? '',
    auditLogPath:
      env.ADMIN_AUDIT_LOG_PATH ?? process.env.HOME ? `${process.env.HOME}/.gc/events.jsonl` : '.gc/events.jsonl',
    frontendDistPath: env.ADMIN_FRONTEND_DIST ?? '../frontend/dist',
    disabled: env.ADMIN_DASHBOARD_DISABLED === '1',
    maintainerRepo: env.MAINTAINER_REPO ?? 'gastownhall/gascity',
    maintainerCachePath:
      env.MAINTAINER_CACHE_PATH ??
      (env.HOME
        ? `${env.HOME}/.gascity-dashboard/maintainer-cache.json`
        : '.gascity-dashboard/maintainer-cache.json'),
    maintainerRefreshIntervalMs: parseIntervalMs(
      env.MAINTAINER_REFRESH_INTERVAL_MS,
      6 * 60 * 60 * 1_000,
    ),
    maintainerSlingTarget: parseSlingTarget(env.MAINTAINER_SLING_TARGET, 'mayor'),
  };
}

function parseSlingTarget(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.length === 0) return fallback;
  if (!AGENT_ALIAS_RE.test(raw)) {
    console.error(
      `[admin] MAINTAINER_SLING_TARGET=${JSON.stringify(raw)} is not a valid agent alias; falling back to '${fallback}'`,
    );
    return fallback;
  }
  return raw;
}

function parseIntervalMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
