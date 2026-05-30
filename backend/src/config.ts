// Single place for env-driven knobs. Anything new goes here so SECURITY.md
// can audit the configurable surface.

import { AGENT_ALIAS_RE } from './exec.js';
import { LOG_COMPONENT, logWarn } from './logging.js';

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
   * Env: MAINTAINER_REPO. Default: gastownhall/gascity.
   */
  maintainerRepo: string;
  /**
   * Absolute path to the maintainer enrichment cache file. Env:
   * MAINTAINER_CACHE_PATH. Default: $HOME/.gascity-dashboard/maintainer-cache.json.
   * The dashboard atomically writes the cache after each refresh. Missing
   * cache is an explicit empty state; parse and shape errors are logged and
   * surfaced as maintainer-route errors.
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
   * Bad env values fall back to the default with an operational warning — a
   * typo in this single optional env should not dark the whole
   * dashboard. The exec wrapper re-validates target at request time.
   */
  maintainerSlingTarget: string;
  /**
   * Default agent alias for `gc sling` dispatch when intent='triage'.
   * Env: MAINTAINER_TRIAGE_TARGET. Default: 'mayor'.
   *
   * Why 'mayor': the mayor is the top-level dispatcher present in every
   * Gas City deployment, so a fresh install with no env override always
   * has a live agent to claim slings. Earlier this defaulted to
   * 'chief-of-staff', but that role can be suspended in a deployment's
   * agent roster (observed 2026-05-29 with oversight-rig.chief-of-staff:
   * suspended) — when suspended, the supervisor accepts the sling but
   * no agent ever claims it, so the work just ages on the maintainer
   * 'slung awaiting agent' panel.
   *
   * Deployments that DO provision a chief-of-staff (or other role) can
   * still opt in via MAINTAINER_TRIAGE_TARGET. Bad env values fall back
   * with the same warn pattern as maintainerSlingTarget.
   *
   * Note: roster-aware startup validation (refuse to start if the
   * configured target isn't a live agent) is a separate follow-up that
   * depends on gascity-dashboard-ay6's listAgents adoption.
   */
  maintainerTriageTarget: string;
  /**
   * Per-process kill-switch for snapshot fixture mode. When true, bead-3's
   * cache wiring should pass useFixture=true into each SourceCache so the
   * dashboard stays renderable when supervisor / upstream services fail.
   * Env: SNAPSHOT_USE_FIXTURES (set to '1' to enable). Default: false.
   * SourceCache's per-cache useFixture flag is still required — this config
   * gate is the global opt-in, not a substitute.
   */
  useFixtures: boolean;
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
  // Validate cityName: it lands in CityContext.cityDataDir as a path segment
  // (~/.gascity-dashboard/cities/<cityName>/) that modules write to. A
  // value containing `/`, `..`, or any path separator would let a
  // misconfigured GC_CITY_NAME escape the cities/ root via path.join's
  // normalization. Per the modular-dashboard PRD § premortem #5 +
  // security review.
  const cityName = env.GC_CITY_NAME ?? 'racoon-city';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(cityName)) {
    throw new Error(
      `Invalid GC_CITY_NAME: "${cityName}" — must be alphanumeric with hyphens, no path separators or leading/trailing hyphen`,
    );
  }
  return {
    port,
    bindHost: env.HOST ?? '127.0.0.1',
    extraAllowedHosts,
    gcSupervisorUrl: (env.GC_SUPERVISOR_URL ?? 'http://127.0.0.1:8372').replace(/\/+$/, ''),
    cityName,
    cityPath: env.GC_CITY_PATH ?? '',
    auditLogPath: env.ADMIN_AUDIT_LOG_PATH ?? defaultAuditLogPath(env),
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
    maintainerSlingTarget: parseSlingTarget(
      'MAINTAINER_SLING_TARGET',
      env.MAINTAINER_SLING_TARGET,
      'mayor',
    ),
    maintainerTriageTarget: parseSlingTarget(
      'MAINTAINER_TRIAGE_TARGET',
      env.MAINTAINER_TRIAGE_TARGET,
      'mayor',
    ),
    useFixtures: env.SNAPSHOT_USE_FIXTURES === '1',
  };
}

function parseSlingTarget(envName: string, raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.length === 0) return fallback;
  if (!AGENT_ALIAS_RE.test(raw)) {
    logWarn(
      LOG_COMPONENT.admin,
      `${envName}=${JSON.stringify(raw)} is not a valid agent alias; falling back to '${fallback}'`,
    );
    return fallback;
  }
  return raw;
}

function defaultAuditLogPath(env: NodeJS.ProcessEnv): string {
  return env.HOME ? `${env.HOME}/.gc/events.jsonl` : '.gc/events.jsonl';
}

function parseIntervalMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
